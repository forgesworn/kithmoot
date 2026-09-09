import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { parseRoomPolicy } from './room.js'
import { QUIET_CANNOT_SEND, QUIET_DEVICE_SLOTS, isQuietPolicy, quietCounterRange, quietRoomTransport, type QuietRoomTransport, type QuietUsedState } from './quiet.js'
import type { RoomPolicy } from './types.js'
import type { RelayTransport } from './relay-pool.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(23)
const SLOT = 60

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function quietFor(relay: SimRelay, policy: RoomPolicy, participant: string, slot: number, clock: () => number, extra: Partial<Parameters<typeof quietRoomTransport>[1]> = {}): QuietRoomTransport {
  return quietRoomTransport(new SimTransport(relay), {
    policy, participant, slot, now: clock, intervalSeconds: SLOT, lookbackSeconds: 7200,
    schedule: () => () => {}, slotOffset: () => 0, ...extra,
  })
}

function member(relay: SimRelay, policy: RoomPolicy, sk: Uint8Array, slot: number, clock: () => number, extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}, quietExtra: Partial<Parameters<typeof quietRoomTransport>[1]> = {}) {
  const transport = quietFor(relay, policy, getPublicKey(sk), slot, clock, quietExtra)
  const session = new RoomSession({
    transport, secret: SECRET, identity: localIdentity(sk), deviceSk: generateSecretKey(),
    policy, now: clock, announceJitterMs: 0, epochSettleMs: 0, ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
  return { session, transport }
}

describe('a quiet policy', () => {
  const a = getPublicKey(generateSecretKey()), b = getPublicKey(generateSecretKey())
  it('rides the link with its members list and is refused without one', () => {
    expect(parseRoomPolicy({ tier: 'open', members: [a, b], quiet: true })).toEqual({ tier: 'open', members: [a, b], quiet: true })
    expect(() => parseRoomPolicy({ tier: 'open', quiet: true })).toThrow(/quiet room without a members list/)
    expect(() => parseRoomPolicy({ tier: 'open', members: [a], quiet: 'yes' })).toThrow(/quiet room/)
    expect(() => parseRoomPolicy({ tier: 'open', members: [a], quiet: false })).toThrow(/quiet room/)
    expect(parseRoomPolicy({ tier: 'open', members: [a] })).toEqual({ tier: 'open', members: [a] })
    expect(isQuietPolicy({ tier: 'open', members: [a], quiet: true })).toBe(true)
    expect(isQuietPolicy({ tier: 'open', quiet: true } as RoomPolicy)).toBe(false)
    expect(isQuietPolicy(undefined)).toBe(false)
  })
  it('gives each of two devices half the keys and a third none', () => {
    expect(QUIET_DEVICE_SLOTS).toBe(2)
    expect(quietCounterRange(0)).toEqual([0, 8])
    expect(quietCounterRange(1)).toEqual([8, 16])
    expect(quietCounterRange(2)).toBeUndefined()
    expect(quietCounterRange(-1)).toBeUndefined()
    expect(quietCounterRange(0.5)).toBeUndefined()
  })
  it('refuses to wrap a transport for a room that is not quiet', () => {
    expect(() => quietRoomTransport(new SimTransport(new SimRelay()), { policy: { tier: 'open', members: [a] }, participant: a, slot: 0 })).toThrow(/not a quiet room/)
  })
})

describe('a quiet room', () => {
  it('carries chat in gift wraps: no kind 1460 reaches the relay, and the other member reads it', async () => {
    const relay = new SimRelay({ replay: true })
    let now = NOW
    const clock = () => now
    const aliceSk = generateSecretKey(), bobSk = generateSecretKey()
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(aliceSk), getPublicKey(bobSk)], quiet: true }
    const alice = member(relay, policy, aliceSk, 0, clock, { name: 'Alice' })
    const bob = member(relay, policy, bobSk, 0, clock, { name: 'Bob' })
    await alice.session.join([], {})
    await bob.session.join([], {})
    await settle()

    const sent = alice.session.chat.send('hello, quietly')
    let resolved = false
    void sent.then(() => { resolved = true })
    await settle()
    // Nothing has left yet: the message waits for its slot.
    expect(resolved).toBe(false)
    expect(alice.transport.pending).toBe(1)
    expect(bob.session.chat.messages()).toEqual([])

    await alice.transport.tick()
    await sent
    expect(alice.transport.pending).toBe(0)
    expect(bob.session.chat.messages().map((m) => m.text)).toEqual(['hello, quietly'])
    expect(alice.session.chat.messages().map((m) => m.text)).toEqual(['hello, quietly'])

    // The relay holds the roster (ephemeral, in the open) and one wrap. No
    // chat kind, no channel tag, no device signature on what was said.
    expect(relay.published.some((e) => e.kind === KINDS.CHAT)).toBe(false)
    const wraps = relay.published.filter((e) => e.kind === 1059)
    expect(wraps.length).toBe(1)
    expect(wraps[0]!.tags.map((t) => t[0]).sort()).toEqual(['p'])
    expect(wraps[0]!.pubkey).not.toBe(alice.session.device)

    // A slot with nothing to say posts a filler the same size as a message.
    now += SLOT
    await alice.transport.tick()
    const [real, filler] = relay.published.filter((e) => e.kind === 1059)
    expect(filler!.content.length).toBe(real!.content.length)
    expect(bob.session.chat.messages().length).toBe(1)

    // A late joiner reads the history from the broadcast.
    const carol = quietFor(relay, policy, getPublicKey(bobSk), 1, clock)
    const seen: string[] = []
    carol.rekey(alice.session.epochKeys().key)
    carol.subscribe([{ kinds: [KINDS.CHAT] }], (e) => seen.push(e.id))
    expect(seen.length).toBe(1)
    alice.session.leave(); bob.session.leave(); carol.close()
  })

  it('follows a rekey: drops on the new key are matched from the first, and what waited for the old key is handed back', async () => {
    const relay = new SimRelay({ replay: true })
    let now = NOW
    const clock = () => now
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeperSk = generateSecretKey(), bobSk = generateSecretKey()
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(keeperSk), getPublicKey(bobSk)], quiet: true }
    const keeper = member(relay, policy, keeperSk, 0, clock, { authority })
    const bob = member(relay, policy, bobSk, 0, clock, { authority })
    await keeper.session.join([], {})
    await bob.session.join([], {})
    await settle()

    const stale = bob.session.chat.send('written for epoch 0')
    const swallowed = stale.catch((e: Error) => e.message)
    await keeper.session.rekey({ authoritySk })
    await settle()
    expect(keeper.session.epoch).toBe(1)
    expect(bob.session.epoch).toBe(1)
    expect(await swallowed).toMatch(/changed its key/)
    expect(bob.transport.pending).toBe(0)

    const fresh = bob.session.chat.send('written for epoch 1')
    await bob.transport.tick()
    await fresh
    expect(keeper.session.chat.messages().map((m) => m.text)).toEqual(['written for epoch 1'])
    // The stale message never went out under either key.
    expect(relay.published.filter((e) => e.kind === 1059).length).toBe(1)
    keeper.session.leave(); bob.session.leave()
  })

  it('a non-member reads and cannot post; so does a third device', async () => {
    const relay = new SimRelay({ replay: true })
    const clock = () => NOW
    const aliceSk = generateSecretKey(), bobSk = generateSecretKey(), strangerSk = generateSecretKey()
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(aliceSk), getPublicKey(bobSk)], quiet: true }
    const stranger = quietFor(relay, policy, getPublicKey(strangerSk), 0, clock)
    expect(stranger.canSend).toBe(false)
    const third = quietFor(relay, policy, getPublicKey(aliceSk), 2, clock)
    expect(third.canSend).toBe(false)
    const alice = member(relay, policy, aliceSk, 0, clock)
    await alice.session.join([], {})
    expect(alice.transport.canSend).toBe(true)
    const a = alice.session.chat.send('x')
    await alice.transport.tick()
    await a
    const seen: string[] = []
    third.rekey(alice.session.epochKeys().key)
    third.subscribe([{ kinds: [KINDS.CHAT] }], (e) => seen.push(e.id))
    expect(seen.length).toBe(1)
    third.rekey(alice.session.epochKeys().key)
    await expect(third.publish({ kind: KINDS.CHAT, id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: NOW, tags: [], content: '', sig: 'c'.repeat(128) })).rejects.toThrow(QUIET_CANNOT_SEND)
    stranger.rekey(alice.session.epochKeys().key)
    await expect(stranger.publish({ kind: KINDS.CHAT, id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: NOW, tags: [], content: '', sig: 'c'.repeat(128) })).rejects.toThrow(QUIET_CANNOT_SEND)
    alice.session.leave(); third.close(); stranger.close()
  })

  it('two devices of one member draw from disjoint halves, persist what they used, and a retry of a waiting message is one drop', async () => {
    const relay = new SimRelay({ replay: true })
    let now = NOW
    const clock = () => now
    const aliceSk = generateSecretKey(), bobSk = generateSecretKey()
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(aliceSk), getPublicKey(bobSk)], quiet: true }
    const saved: QuietUsedState[] = []
    const posted: (string | undefined)[] = []
    const laptop = member(relay, policy, aliceSk, 0, clock, {}, { onUsed: (s) => saved.push(s), onPosted: (e) => posted.push(e?.id) })
    const phone = member(relay, policy, aliceSk, 1, clock)
    await laptop.session.join([], {})
    await phone.session.join([], {})
    await settle()

    // Every counter the laptop can draw is below 8; the phone's are 8 and up.
    const draws = new Set<number>()
    for (let i = 0; i < 8; i++) {
      const p = laptop.session.chat.send(`m${i}`)
      await laptop.transport.tick()
      await p
      now += SLOT
    }
    for (const u of Object.values(laptop.transport.exportUsed())) for (const c of u.counters) draws.add(c)
    expect([...draws].every((c) => c < 8)).toBe(true)
    expect(draws.size).toBe(8)
    expect(saved.length).toBe(8)
    expect(posted.length).toBe(8)
    // The phone has seen every one of the laptop's drops and counts them spent too.
    const phoneUsed = Object.values(phone.transport.exportUsed()).flatMap((u) => u.counters).sort((x, y) => x - y)
    expect(phoneUsed).toEqual([...draws].sort((x, y) => x - y))
    // The laptop's half is spent this epoch: a ninth message waits for the next epoch.
    const ninth = laptop.session.chat.send('m8')
    await laptop.transport.tick()
    expect(laptop.transport.pending).toBe(1)
    expect(relay.published.filter((e) => e.kind === 1059).length).toBe(9) // eight drops and one filler
    // Restored on a reload from what onUsed saved, the counters stay spent.
    const again = quietFor(relay, policy, getPublicKey(aliceSk), 0, clock, { used: saved[saved.length - 1] })
    again.rekey(laptop.session.epochKeys().key)
    expect(Object.values(again.exportUsed()).flatMap((u) => u.counters).length).toBe(8)
    now += 3600 - 8 * SLOT
    await laptop.transport.tick()
    await ninth
    expect(phone.session.chat.messages().map((m) => m.text)).toContain('m8')
    laptop.session.leave(); phone.session.leave(); again.close()
  })

  it('a retry of a message still waiting is the same wait, and the queue is readable for persisting', async () => {
    const relay = new SimRelay({ replay: true })
    const clock = () => NOW
    const aliceSk = generateSecretKey(), bobSk = generateSecretKey()
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(aliceSk), getPublicKey(bobSk)], quiet: true }
    const alice = member(relay, policy, aliceSk, 0, clock)
    await alice.session.join([], {})
    const publish = alice.session.chat.prepareSend('once')
    const first = publish()
    const second = publish()
    expect(alice.transport.pending).toBe(1)
    expect(alice.transport.queued().length).toBe(1)
    await alice.transport.tick()
    await Promise.all([first, second])
    expect(relay.published.filter((e) => e.kind === 1059).length).toBe(1)
    expect(alice.transport.queued()).toEqual([])
    alice.session.leave()
  })

  it('an agent in a quiet room posts in drops', async () => {
    const relay = new SimRelay({ replay: true })
    const keeperSk = generateSecretKey(), agentSk = generateSecretKey()
    let now = NOW
    const clock = () => now
    const policy: RoomPolicy = { tier: 'open', members: [getPublicKey(keeperSk), getPublicKey(agentSk)], quiet: true }
    const transport = (): RelayTransport => new SimTransport(relay)
    const quietOpts = { intervalSeconds: SLOT, lookbackSeconds: 7200, schedule: () => () => {}, slotOffset: () => 0 }
    const keeper = await RoomAgent.create({ base: 'https://kithmoot.test/', name: 'Keeper', relays: ['wss://sim'], transport, announceJitterMs: 0, identity: localIdentity(keeperSk), policy, now: clock, quiet: quietOpts })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0, identity: localIdentity(agentSk), now: clock, quiet: quietOpts })
    await settle()
    const sent = ada.session.chat.send('reporting in')
    await settle()
    expect(keeper.session.chat.messages()).toEqual([])
    expect(ada.quiet?.canSend).toBe(true)
    // Whatever the agent said on arrival waits its own slot; one drop a slot.
    while (ada.quiet!.pending > 0) { await ada.quiet!.tick(); now += SLOT }
    await sent
    expect(keeper.session.chat.messages().map((m) => m.text)).toContain('reporting in')
    expect(relay.published.some((e) => e.kind === KINDS.CHAT)).toBe(false)
    await keeper.leave(); await ada.leave()
  })
})
