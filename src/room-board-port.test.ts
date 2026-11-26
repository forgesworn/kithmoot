import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import * as Y from 'yjs'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { base64 } from '@scure/base'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { decodeChatEvent, deriveChannel, encodeChatEvent } from './chat.js'
import { deriveRoom } from './room.js'
import { KINDS } from './kinds.js'
import type { RoomBoardLog } from './room-board-log.js'
import { ROOM_BOARD_CHANNEL, memoryRoomBoardStorage, roomBoardRecordId, validBoardPart } from './room-board-wire.js'
import { openRoomBoardOverPort, ROOM_BOARD_PORT_MAX_MESSAGE, type RoomBoardOverPort } from './room-board-port.js'

const BASE = 'https://example.test/j/'
const FAST = { flushMs: 5, flushMaxMs: 25, settleMs: [5, 15] as const, retryMs: 20, persistMs: 1 }

const agents: RoomAgent[] = []
const closers: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const agent of agents.splice(0)) agent.leave()
})

/** A relay connection whose sends can be made to fail, as a phone with no network. */
function connection(relay: SimRelay) {
  const state = { down: false }
  const transport = () => {
    const t = new SimTransport(relay)
    const publish = t.publish.bind(t)
    t.publish = async event => {
      if (event.kind === KINDS.CHAT && state.down) throw new Error('No relay accepted the event')
      await publish(event)
    }
    return t
  }
  return { transport, state }
}

async function room() {
  const relay = new SimRelay({ replay: true })
  const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', agent: false, relays: ['wss://sim'], transport: connection(relay).transport, announceJitterMs: 0 })
  agents.push(keeper)
  const { roomId, roomKey } = deriveRoom(keeper.keeperState!.secret)
  /** A member on the web: the room's own `RoomBoardLog`. */
  const web = async (name: string): Promise<{ agent: RoomAgent; log: RoomBoardLog }> => {
    const agent = await RoomAgent.join({ link: keeper.url, name, identity: localIdentity(generateSecretKey()), agent: false, transport: connection(relay).transport, announceJitterMs: 0 })
    agents.push(agent)
    const log = await agent.session.board(memoryRoomBoardStorage(), { timing: FAST })
    closers.push(() => log.close())
    return { agent, log }
  }
  return { relay, keeper, roomId, roomKey, web }
}

/**
 * The app's side of the port, doing only what the app will do: it holds the
 * room's key, this device's key and credential and a relay connection; opens
 * and checks each board event with the room's own reader, and hands over the
 * part; seals, signs and checks what the page asks it to send; keeps the
 * copy; takes a card's file. Every message is recorded, both ways.
 */
async function phone(f: Awaited<ReturnType<typeof room>>, name: string, copy = new Map<string, Uint8Array>()) {
  const identity = localIdentity(generateSecretKey()), deviceSk = generateSecretKey()
  const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(deviceSk), roomId: f.roomId, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  const link = connection(f.relay)
  const transport = link.transport()
  const channel = new MessageChannel()
  const native = channel.port1
  const toPage: string[] = [], toNative: string[] = []
  const statuses: Array<{ ready: boolean; pending: boolean; error?: string }> = []
  const files: Array<{ name: string; type: string; bytes: Uint8Array }> = []
  const opened: unknown[] = []
  const said: unknown[] = []
  const sealed = new Map<string, Event>()
  const adding = new Map<string, string[]>()
  const receiving = new Map<string, { name: string; type: string; size: number; pieces: Uint8Array[]; got: number }>()
  let listening: { gen: number; stop: () => void } | undefined
  const send = (message: Record<string, unknown>) => { const raw = JSON.stringify({ v: 1, ...message }); toPage.push(raw); native.postMessage(raw) }
  const now = () => Math.floor(Date.now() / 1000)
  const options = () => ({ roomId: f.roomId, roomKey: f.roomKey, channel: ROOM_BOARD_CHANNEL, now: now() })
  native.onmessage = async (event: MessageEvent) => {
    const raw = event.data as string
    toNative.push(raw)
    const m = JSON.parse(raw)
    const reply = (body: Record<string, unknown>) => send({ t: 'reply', re: m.re, ...body })
    switch (m.t) {
      case 'ready':
        send({ t: 'start', self: identity.pubkey, invite: false, assign: false, files: true })
        send({ t: 'members', members: [{ pubkey: identity.pubkey, name }] })
        return
      case 'listen': {
        listening?.stop()
        const { id } = deriveChannel(f.roomId, f.roomKey, ROOM_BOARD_CHANNEL)
        const gen = m.gen
        const stop = transport.subscribe([{ kinds: [KINDS.CHAT], '#d': [id] }], outer => {
          const message = decodeChatEvent(outer, options())
          if (message?.board) send({ t: 'part', gen, event: outer.id, device: message.device, sentAt: message.sentAt, part: message.board })
        }, () => send({ t: 'caughtUp', gen }))
        listening = { gen, stop }
        return
      }
      case 'unlisten':
        if (listening && listening.gen === m.gen) { listening.stop(); listening = undefined }
        return
      case 'seal': {
        // The page can ask for a board part and nothing else.
        if (!validBoardPart(m.part)) return reply({ ok: false, error: 'Not a board change' })
        const verdict = verifyDeviceCredential(credential, { roomId: f.roomId, now: now() })
        if (!verdict.ok) return reply({ ok: false, error: "This device's access to the room ran out, so the board change was not sent" })
        const outer = encodeChatEvent({ id: bytesToHex(randomBytes(16)), participant: verdict.participant, device: getPublicKey(deviceSk), credential, text: 'Board update', sentAt: now(), board: m.part, name },
          { roomId: f.roomId, roomKey: f.roomKey, deviceSk, channel: ROOM_BOARD_CHANNEL })
        if (!decodeChatEvent(outer, options())?.board) return reply({ ok: false, error: 'Room access changed, so the board change was not sent' })
        sealed.set(outer.id, outer)
        return reply({ ok: true, event: outer.id, createdAt: outer.created_at })
      }
      case 'publish': {
        const outer = sealed.get(m.event)
        if (!outer) return reply({ ok: false, error: 'Nothing sealed under that name' })
        try { await transport.publish(outer); sealed.delete(m.event); return reply({ ok: true }) }
        catch (e) { return reply({ ok: false, error: (e as Error).message }) }
      }
      case 'copy.read':
        for (const [record, update] of copy) {
          const count = Math.max(1, Math.ceil(update.byteLength / 30_000))
          for (let index = 0; index < count; index++) send({ t: 'copy.record', re: m.re, record, index, count, data: base64.encode(update.subarray(index * 30_000, (index + 1) * 30_000)) })
        }
        return reply({ ok: true, unread: 0 })
      case 'copy.add': {
        const pieces = adding.get(m.re) ?? []
        pieces[m.index] = m.data
        adding.set(m.re, pieces)
        if (pieces.filter(Boolean).length < m.count) return
        adding.delete(m.re)
        const update = Uint8Array.from(pieces.flatMap(piece => [...base64.decode(piece)]))
        const record = roomBoardRecordId(bytesToHex(update))
        copy.set(record, update)
        return reply({ ok: true, record })
      }
      case 'copy.remove':
        for (const record of m.records) copy.delete(record)
        return reply({ ok: true })
      case 'status':
        statuses.push({ ready: m.ready, pending: m.pending, ...(m.error ? { error: m.error } : {}) })
        return
      case 'file.add':
        receiving.set(m.re, { name: m.name, type: m.type, size: m.size, pieces: [], got: 0 })
        return
      case 'file.chunk': {
        const entry = receiving.get(m.re)!
        const piece = base64.decode(m.data)
        entry.pieces.push(piece); entry.got += piece.byteLength
        send({ t: 'file.ack', re: m.re, offset: m.offset })
        if (entry.got < entry.size) return
        receiving.delete(m.re)
        files.push({ name: entry.name, type: entry.type, bytes: Uint8Array.from(entry.pieces.flatMap(p => [...p])) })
        send({ t: 'file.said', re: m.re, words: 'Uploading…' })
        return reply({ ok: true, file: { hash: 'a'.repeat(64), key: 'k'.repeat(64), name: entry.name, type: entry.type, size: entry.size, encryptedSize: 65_536, servers: ['https://files.example/'] } })
      }
      case 'file.open':
        opened.push(m.file)
        return
      case 'discuss': case 'pendingEdits': case 'flushed': case 'closed':
        said.push(m)
        return
    }
  }
  const page = await openRoomBoardOverPort(channel.port2 as unknown as Parameters<typeof openRoomBoardOverPort>[0], { timing: FAST })
  closers.push(async () => { await page.close(); listening?.stop(); native.close() })
  const secrets = [bytesToHex(f.roomKey), bytesToHex(deviceSk), credential.sig]
  return { page, native, send, link, toPage, toNative, statuses, files, opened, said, copy, identity, secrets }
}

/** Random bytes past the 65,536 that one call to the system's generator gives. */
const noise = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65_536) bytes.set(randomBytes(Math.min(65_536, length - offset)), offset)
  return bytes
}
const titles = (doc: Y.Doc): string[] => [...doc.getMap('records').values()].map(card => (card as Y.Map<unknown>).get('title') as string).sort()
function addCard(doc: Y.Doc, title: string): void {
  doc.transact(() => {
    const card = new Y.Map<unknown>()
    card.set('title', title)
    doc.getMap('records').set(bytesToHex(randomBytes(8)), card)
  })
}
/** A card added as Girnel's view adds one: to its own copy, then pushed. */
function addCardFromView(page: RoomBoardOverPort, title: string, signal = new AbortController().signal): void {
  const host = page.view(signal)
  const view = new Y.Doc()
  Y.applyUpdate(view, host.state())
  const before = Y.encodeStateVector(view)
  addCard(view, title)
  host.push(Y.encodeStateAsUpdate(view, before))
}
const settled = (...boards: Array<{ status(): { ready: boolean; pending: boolean; error?: string } }>) => vi.waitFor(() => {
  for (const board of boards) expect(board.status()).toEqual({ ready: true, pending: false })
}, { timeout: 4_000 })

describe('the room board over a message port', () => {
  it('keeps one board between the web and a phone, and the last to arrive on each side reads it after the writers have gone', async () => {
    const f = await room()
    const ada = await f.web('Ada')
    const bob = await phone(f, 'Bob')
    addCard(ada.log.doc, 'Book the hall')
    await vi.waitFor(() => expect(titles(bob.page.sync.doc)).toEqual(['Book the hall']))
    addCardFromView(bob.page, 'Print the notices')
    await vi.waitFor(() => expect(titles(ada.log.doc)).toEqual(['Book the hall', 'Print the notices']))
    await settled(ada.log, bob.page.sync)
    // The app was told, as the board went, where it stands.
    expect(bob.statuses.at(-1)).toEqual({ ready: true, pending: false })

    await ada.log.close(); ada.agent.leave()
    await bob.page.close()
    await vi.waitFor(() => expect(bob.said).toContainEqual(expect.objectContaining({ t: 'closed' })))

    const carol = await f.web('Carol')
    await vi.waitFor(() => expect(titles(carol.log.doc)).toEqual(['Book the hall', 'Print the notices']))
    await carol.log.close(); carol.agent.leave()
    const dan = await phone(f, 'Dan')
    await vi.waitFor(() => expect(titles(dan.page.sync.doc)).toEqual(['Book the hall', 'Print the notices']))
    await settled(dan.page.sync)

    for (const side of [bob, dan]) {
      for (const raw of [...side.toPage, ...side.toNative]) {
        expect(raw.length).toBeLessThanOrEqual(ROOM_BOARD_PORT_MAX_MESSAGE)
        for (const secret of side.secrets) expect(raw).not.toContain(secret)
        expect(raw).not.toContain('wss://')
        expect(raw).not.toContain('"credential"')
      }
      // What the page asked of the app: reading, sealing and sending board parts, its copy, and where it stands.
      for (const raw of side.toNative) expect(['ready', 'listen', 'unlisten', 'seal', 'publish', 'copy.read', 'copy.add', 'copy.remove', 'status', 'closed']).toContain(JSON.parse(raw).t)
    }
  })

  it('opens a phone’s board from its own copy, then sends what the room lacks', async () => {
    const f = await room()
    const first = await phone(f, 'Bob')
    // Written with no network: kept on the phone, not yet the room's.
    first.link.state.down = true
    await settled(first.page.sync)
    addCardFromView(first.page, 'Written on the bus')
    await vi.waitFor(() => expect(first.statuses.at(-1)).toEqual({ ready: true, pending: true, error: 'No relay accepted the event' }))
    await vi.waitFor(() => expect(first.copy.size).toBeGreaterThan(0))
    await first.page.close()
    const again = await phone(f, 'Bob', first.copy)
    expect(titles(again.page.sync.doc)).toEqual(['Written on the bus'])
    await settled(again.page.sync)
    const ada = await f.web('Ada')
    await vi.waitFor(() => expect(titles(ada.log.doc)).toEqual(['Written on the bus']))
  })

  it('takes nothing from a reading the room has moved on from', async () => {
    const f = await room()
    const ada = await f.web('Ada')
    addCard(ada.log.doc, 'Said before the move')
    await settled(ada.log)
    const bob = await phone(f, 'Bob')
    await vi.waitFor(() => expect(titles(bob.page.sync.doc)).toEqual(['Said before the move']))
    const listens = () => bob.toNative.map(raw => JSON.parse(raw)).filter(m => m.t === 'listen').map(m => m.gen as number)
    const old = listens().at(-1)!
    bob.send({ t: 'rekey' })
    await vi.waitFor(() => expect(listens().at(-1)).toBeGreaterThan(old))
    expect(bob.toNative.map(raw => JSON.parse(raw))).toContainEqual({ v: 1, t: 'unlisten', gen: old })
    // A late event under the old reading's number is not this board's any more.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, bob.page.sync.state())
    const before = Y.encodeStateVector(doc)
    addCard(doc, 'Arrived too late')
    const part = { v: 1, kind: 'update', blob: bytesToHex(randomBytes(16)), index: 0, count: 1, data: base64.encode(Y.encodeStateAsUpdate(doc, before)) }
    bob.send({ t: 'part', gen: old, event: bytesToHex(randomBytes(32)), device: 'b'.repeat(64), sentAt: Math.floor(Date.now() / 1000), part })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(titles(bob.page.sync.doc)).toEqual(['Said before the move'])
  })

  it('hands a card’s file to the app in acknowledged pieces, and opens one through it', async () => {
    const f = await room()
    const bob = await phone(f, 'Bob')
    const host = bob.page.view(new AbortController().signal)
    const bytes = noise(70_000)
    const words: string[] = []
    const picked = Object.assign(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/plain' }), { name: 'notes.txt' })
    const reference = await host.files!.add(picked, new AbortController().signal, said => words.push(said))
    expect(reference).toEqual({ hash: 'a'.repeat(64), key: 'k'.repeat(64), name: 'notes.txt', type: 'text/plain', size: 70_000, encryptedSize: 65_536, servers: ['https://files.example/'] })
    expect(words).toEqual(['Uploading…'])
    expect(bob.files).toHaveLength(1)
    expect(bytesToHex(bob.files[0]!.bytes)).toBe(bytesToHex(bytes))
    const pieces = bob.toNative.map(raw => JSON.parse(raw)).filter(m => m.t === 'file.chunk')
    expect(pieces.map(m => m.offset)).toEqual([0, 30_000, 60_000])
    host.files!.open(reference, 'open')
    await vi.waitFor(() => expect(bob.opened).toEqual([reference]))
  })

  it('stops sending a file when the person stops it, and says nothing was uploaded', async () => {
    const f = await room()
    const bob = await phone(f, 'Bob')
    // This app never acknowledges, as one whose upload is stuck.
    const silent = bob.native.onmessage
    bob.native.onmessage = event => { if (JSON.parse(event.data as string).t !== 'file.chunk') void silent?.call(bob.native, event) }
    const host = bob.page.view(new AbortController().signal)
    const stop = new AbortController()
    const adding = host.files!.add(Object.assign(new Blob([noise(90_000) as Uint8Array<ArrayBuffer>]), { name: 'big.bin' }), stop.signal, () => {})
    await vi.waitFor(() => expect(bob.toPage.length).toBeGreaterThan(0))
    stop.abort()
    await expect(adding).rejects.toThrow('Stopped. Nothing was uploaded.')
  })

  it('never lets a view’s own edit come back to it, and refuses edits once its view has gone', async () => {
    const f = await room()
    const bob = await phone(f, 'Bob')
    const ended = new AbortController()
    const host = bob.page.view(ended.signal)
    const heard: Uint8Array[] = []
    host.subscribe(update => heard.push(update))
    const view = new Y.Doc()
    Y.applyUpdate(view, host.state())
    const before = Y.encodeStateVector(view)
    addCard(view, 'From this view')
    host.push(Y.encodeStateAsUpdate(view, before))
    expect(titles(bob.page.sync.doc)).toEqual(['From this view'])
    expect(heard).toHaveLength(0)
    ended.abort()
    expect(() => host.push(Y.encodeStateAsUpdate(view))).toThrow('The room changed, so this edit was not saved.')
  })

  it('brings nothing to the page that signs, seals, opens or checks', async () => {
    const result = await build({ entryPoints: ['src/room-board-port.ts'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter(path => path.startsWith('src/')).sort()).toEqual(['src/room-board-port.ts', 'src/room-board-sync.ts', 'src/room-board-wire.ts'])
    expect(inputs.filter(path => /nostr-tools|@noble\/curves|@noble\/ciphers|hkdf|hmac|nip44|secp256k1|schnorr/.test(path))).toEqual([])
  })
})
