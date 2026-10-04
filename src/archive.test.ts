import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { archiveTag, compareArchived, olderThan, reseedCandidates, type ArchiveMeta, type ArchiveQuery, type EventArchive } from './archive.js'
import { CHAT_RETENTION_SECONDS, ChatLog, MAX_CHAT_MESSAGES, MAX_CHAT_MESSAGES_PER_MINUTE, encodeChatEvent, type ChatMessage } from './chat.js'
import type { Filter } from 'nostr-tools/filter'
import type { RoomPolicy } from './types.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { deriveRoom } from './room.js'
import { RoomSession } from './session.js'
import { KINDS } from './kinds.js'

const NOW = 1_800_000_000

/** The contract, in memory: what `app/src/room-archive.ts` does on disk. */
class MemoryArchive implements EventArchive {
  readonly events = new Map<string, Event>()
  readonly meta = new Map<string, ArchiveMeta | undefined>()
  released: string[] = []
  keep(event: Event, meta?: ArchiveMeta): void { this.events.set(event.id, event); this.meta.set(event.id, meta) }
  release(q: { kind: number; d: string }): void { this.released.push(q.d) }
  async read(q: ArchiveQuery): Promise<Event[]> {
    return [...this.events.values()]
      .filter(e => e.kind === q.kind && archiveTag(e) === q.d && (q.since === undefined || e.created_at >= q.since) && (!q.before || olderThan(e, q.before)))
      .sort(compareArchived).slice(0, q.limit)
  }
}

async function room(seed = 7) {
  const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(seed))
  const deviceSk = generateSecretKey()
  const credential = await createDeviceCredential({
    identity: localIdentity(generateSecretKey()), devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: NOW + 3600,
  })
  const message = (text: string, sentAt = NOW, id = `m-${text}`): Event => {
    const msg: ChatMessage = { id, participant: credential.pubkey, device: getPublicKey(deviceSk), credential, text, sentAt }
    return encodeChatEvent(msg, { roomId, roomKey, deviceSk })
  }
  return { roomId, roomKey, deviceSk, credential, message }
}

describe('reseed decisions', () => {
  const at = (n: number): Event => ({ id: n.toString(16).padStart(64, '0'), created_at: 1000 + n, kind: 1460, pubkey: '', tags: [['d', 'x']], content: '', sig: '' })

  it('hands back only what a relay that returned fewer is missing, newest first and bounded', () => {
    const archived = [at(1), at(2), at(3), at(4)]
    expect(reseedCandidates(archived, new Set([at(2).id]))).toEqual([at(4), at(3), at(1)])
    expect(reseedCandidates(archived, new Set([at(2).id]), 2)).toEqual([at(4), at(3)])
    expect(reseedCandidates(archived, new Set())).toHaveLength(4)
  })

  it('leaves alone a relay that returned as many as the archive holds, whatever it holds', () => {
    const archived = [at(1), at(2)]
    expect(reseedCandidates(archived, new Set([at(1).id, at(2).id]))).toEqual([])
    expect(reseedCandidates(archived, new Set([at(1).id, at(9).id]))).toEqual([])
    expect(reseedCandidates([], new Set())).toEqual([])
  })

  it('pages newest first with a strict cursor, a tie on the second broken on id', () => {
    const a = { created_at: 5, id: 'b' }, b = { created_at: 5, id: 'a' }, c = { created_at: 4, id: 'z' }
    expect([c, b, a].sort(compareArchived)).toEqual([a, b, c])
    expect(olderThan(b, { at: a.created_at, id: a.id })).toBe(true)
    expect(olderThan(a, { at: a.created_at, id: a.id })).toBe(false)
    expect(olderThan(c, { at: 5, id: '' })).toBe(true)
  })
})

describe('a chat log over an archive', () => {
  it('opens on what the device kept when every relay has forgotten', async () => {
    const r = await room()
    const archive = new MemoryArchive()
    for (const text of ['one', 'two', 'three']) archive.keep(r.message(text))
    const log = new ChatLog({ ...r, transport: new SimTransport(new SimRelay()), archive, now: () => NOW })
    await expect.poll(() => log.messages().length).toBe(3)
    expect(log.messages().map(m => m.text).sort()).toEqual(['one', 'three', 'two'])
    expect(log.messages()[0]!.lane).toBeUndefined()
    log.close()
  })

  it('decodes an archived event by the same rules as a relay one: forged, foreign and gated are refused', async () => {
    const r = await room()
    const other = await room(8)
    const archive = new MemoryArchive()
    const good = r.message('good')
    archive.keep(good)
    // Same d tag, but under another room's key.
    archive.keep({ ...other.message('foreign'), tags: [['d', r.roomId]] })
    // A valid event whose signature no longer matches its body.
    const forged = r.message('forged')
    archive.keep({ ...forged, content: good.content })
    // Signed by a device that the credential inside does not name.
    const stranger = generateSecretKey()
    archive.keep(finalizeEvent({ kind: KINDS.CHAT, created_at: NOW, tags: [['d', r.roomId]], content: forged.content }, stranger))
    const log = new ChatLog({ ...r, transport: new SimTransport(new SimRelay()), archive, now: () => NOW })
    await expect.poll(() => log.hasOlder).toBe(true)
    expect(log.messages().map(m => m.text)).toEqual(['good'])

    // A gated room refuses the same archived message it would refuse from a relay.
    const gated = new ChatLog({ ...r, transport: new SimTransport(new SimRelay()), archive, now: () => NOW,
      policy: { tier: 'kith', admitted: [getPublicKey(generateSecretKey())] } })
    await expect.poll(() => gated.hasOlder).toBe(true)
    expect(gated.messages()).toEqual([])
    log.close(); gated.close()
  })

  it('shows the lane once a relay copy of an archived message arrives', async () => {
    const r = await room()
    const archive = new MemoryArchive()
    const event = r.message('seen before')
    archive.keep(event)
    const relay = new SimRelay()
    const inner = new SimTransport(relay)
    const transport = {
      publish: (e: Event) => inner.publish(e),
      subscribe: (fs: Filter[], on: (e: Event, via?: string) => void, eose?: () => void) => inner.subscribe(fs, e => on(e, 'wss://relay.example'), eose),
      close: () => inner.close(),
      describe: () => [{ url: 'wss://relay.example', read: true, write: true }],
    }
    const log = new ChatLog({ ...r, transport, archive, now: () => NOW })
    await expect.poll(() => log.messages().length).toBe(1)
    expect(log.messages()[0]!.lane).toBeUndefined()
    relay.publish(event)
    expect(log.messages()[0]!.lane).toBe('public')
    log.close()
    expect(archive.released).toEqual([r.roomId])
  })

  it('keeps nothing the rate limit refused, and marks what a quiet room said', async () => {
    const r = await room()
    const relay = new SimRelay()
    const archive = new MemoryArchive()
    const log = new ChatLog({ ...r, transport: new SimTransport(relay), archive, now: () => NOW })
    for (let i = 0; i < MAX_CHAT_MESSAGES_PER_MINUTE + 5; i++) relay.publish(r.message(`flood ${i}`))
    expect(log.messages()).toHaveLength(MAX_CHAT_MESSAGES_PER_MINUTE)
    expect(archive.events.size).toBe(MAX_CHAT_MESSAGES_PER_MINUTE)
    log.close()

    const quietArchive = new MemoryArchive()
    const policy: RoomPolicy = { tier: 'open', quiet: true, members: [r.credential.pubkey] }
    const quiet = new ChatLog({ ...r, transport: new SimTransport(new SimRelay()), archive: quietArchive, policy, now: () => NOW })
    await quiet.send('hush')
    expect([...quietArchive.meta.values()]).toEqual([{ quiet: true }])
    quiet.close()
  })

  it('keeps every event it accepts, its own sends included, and nothing it refused', async () => {
    const r = await room()
    const relay = new SimRelay()
    const archive = new MemoryArchive()
    const log = new ChatLog({ ...r, transport: new SimTransport(relay), archive, now: () => NOW })
    await log.send('mine')
    relay.publish(r.message('theirs'))
    relay.publish(finalizeEvent({ kind: KINDS.CHAT, created_at: NOW, tags: [['d', r.roomId]], content: 'rubbish' }, generateSecretKey()))
    expect([...archive.events.values()]).toHaveLength(2)
    expect(log.messages().map(m => m.text).sort()).toEqual(['mine', 'theirs'])
    log.close()
  })

  it('pages back past the retention window and the message cap, a page at a time', async () => {
    const r = await room()
    const archive = new MemoryArchive()
    const old = NOW - CHAT_RETENTION_SECONDS - 90 * 24 * 60 * 60
    const total = MAX_CHAT_MESSAGES + 150
    // Spread over the window and far past it: 100 inside, the rest older.
    // Three seconds apart, inside the per-sender rate every message obeys.
    for (let i = 0; i < total; i++) archive.keep(r.message(`n${i}`, i < total - 100 ? old + 3 * i : NOW - 3 * (total - i)))
    const log = new ChatLog({ ...r, transport: new SimTransport(new SimRelay()), archive, now: () => NOW })
    await expect.poll(() => log.messages().length, { timeout: 30_000 }).toBe(100)
    expect(log.hasOlder).toBe(true)
    let read = 0
    for (let step = 0; step < 20 && log.hasOlder; step++) read += await log.loadOlder()
    expect(read).toBe(total - 100)
    expect(log.hasOlder).toBe(false)
    expect(log.messages()).toHaveLength(total)
    expect(log.messages()[0]!.text).toBe('n0')
    expect(await log.loadOlder()).toBe(0)
    log.close()
    // Six hundred signatures and credentials, twice: slow on a busy machine.
  }, 60_000)

  it('a session that a relay forgot still reaches its epoch and its history from the archive', async () => {
    const secret = new Uint8Array(32).fill(21)
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const aliceKeys = { identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey() }
    const archive = new MemoryArchive()
    const base = { secret, now: () => NOW, announceJitterMs: 0, authority, epochSettleMs: 0 }
    const relay = new SimRelay({ replay: true })
    const keeper = new RoomSession({ ...base, transport: new SimTransport(relay), identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), name: 'Keeper' })
    // Kept beside the device key: the rekey copy for Alice is sealed to them.
    const sealKeys: Uint8Array[] = []
    const alice = new RoomSession({
      ...base,
      ...aliceKeys,
      transport: new SimTransport(relay),
      name: 'Alice',
      archive,
      onCredential: (_credential: unknown, sealSk?: Uint8Array) => { if (sealSk) sealKeys.push(sealSk) },
    })
    await keeper.join([], {})
    await alice.join([], {})
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
    await keeper.rekey({ authoritySk })
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(alice.epoch).toBe(1)
    await keeper.chat.send('said in epoch 1')
    expect(alice.chat.messages().map(m => m.text)).toEqual(['said in epoch 1'])
    expect([...archive.events.values()].some(e => e.kind === KINDS.ROOM_REKEY)).toBe(true)
    alice.leave(); keeper.leave()

    // Every relay forgot: the rekey and the chat are only on Alice's device.
    const again = new RoomSession({ ...base, ...aliceKeys, sealKeys, transport: new SimTransport(new SimRelay({ replay: true })), name: 'Alice', archive })
    await again.join([], {})
    await expect.poll(() => again.chat.messages().length).toBe(1)
    expect(again.epoch).toBe(1)
    expect(again.chat.messages().map(m => m.text)).toEqual(['said in epoch 1'])
    again.leave()
  }, 30_000)
})
