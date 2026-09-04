import { describe, expect, it, vi } from 'vitest'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { parseForwarderRef } from './descriptor.js'
import { KINDS } from './kinds.js'

const BASE = 'https://example.test/j/'
const transportFor = (relay: SimRelay) => () => new SimTransport(relay)
const FWD = { url: 'wss://relay.example', pubkey: getPublicKey(generateSecretKey()), label: 'the box' }

/**
 * Drains the queued work. The quarter-second on the end is only for the claim
 * that no descriptor is published at all: that needs a window to pass, and
 * nothing shorter than a real wait can show an absence. Where the claim is
 * that a descriptor arrived, `vi.waitFor` waits for the descriptor itself.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 250))
}

describe('a keeper publishes the forwarder descriptor', () => {
  it('at start, again for an arrival, and again under the new key after a rekey', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, forwarders: [FWD] })
    const published = () => relay.published.filter((e) => e.kind === KINDS.DESCRIPTOR)
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    expect(keeper.forwarders).toEqual([FWD])

    // A joiner arrives after the start-time descriptor, which is ephemeral
    // and was sent to nobody: the keeper says it again, and the joiner has it.
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    await vi.waitFor(() => {
      expect(published().length).toBeGreaterThanOrEqual(2)
      expect(ada.session.descriptor?.forwarders).toEqual([FWD])
    })
    expect(ada.session.descriptor?.participant).toBe(keeper.participant)

    // A rekey: the descriptor rides the epoch key, so it is published again
    // under the new epoch's tag, and the member who moved still has it.
    const before = published().length
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    await keeper.remove(bob.participant)
    await vi.waitFor(() => expect(published().length).toBeGreaterThan(before))
    const after = published()
    const epochId = keeper.session.epochKeys().id
    expect(after.at(-1)!.tags[0]).toEqual(['d', epochId])
    expect(epochId).not.toBe(keeper.roomId)
    expect(ada.session.epoch).toBe(1)
    expect(ada.session.descriptor?.forwarders).toEqual([FWD])
    // Bob, removed, cannot even find it.
    expect(bob.session.epoch).toBe(0)
    for (const a of [keeper, ada, bob]) a.leave()
  })

  it('a keeper with no forwarder publishes no descriptor', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    expect(relay.published.filter((e) => e.kind === KINDS.DESCRIPTOR)).toHaveLength(0)
    expect(ada.session.descriptor).toBeUndefined()
    keeper.leave()
    ada.leave()
  })

  it('a malformed forwarder is refused before anything is joined', async () => {
    const relay = new SimRelay()
    const start = (forwarders: unknown[]) =>
      RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, forwarders: forwarders as never })
    await expect(start([{ pubkey: FWD.pubkey }])).rejects.toThrow(/needs a url/)
    await expect(start([{ url: 'https://relay.example' }])).rejects.toThrow(/ws: or wss:/)
    await expect(start([{ url: 'wss://relay.example', pubkey: 'short' }])).rejects.toThrow(/64 hex/)
    await expect(start(['wss://relay.example'])).rejects.toThrow(/object/)
    expect(relay.published).toHaveLength(0)
    // What the forwarder prints parses, and case on the key is canonicalised.
    expect(parseForwarderRef({ url: 'wss://relay.example', pubkey: FWD.pubkey.toUpperCase(), label: 'box' })).toEqual({ url: 'wss://relay.example', pubkey: FWD.pubkey, label: 'box' })
    expect(parseForwarderRef({ url: 'ws://127.0.0.1:7777', label: '' })).toEqual({ url: 'ws://127.0.0.1:7777' })
  })
})
