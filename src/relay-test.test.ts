import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { relayTestFinding, relayTestVerdict, validRelayTestRequest, validRelayTestResult, RELAY_TEST_SIGNALS_PER_WINDOW, type RelayTestObservations } from './relay-test.js'
import { unwrapSignalEvent, wrapSignal, type SignalBody } from './signal.js'
import { Mesh, type MeshSession, type RemoteRelayTest } from './mesh.js'
import type { ParticipantView } from './session.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const ROOM = 'd'.repeat(64)
const NODE = getPublicKey(new Uint8Array(32).fill(1))
const ENDPOINT = `spry://${NODE}?relay=${encodeURIComponent('wss://relay.example/')}`
const ID = '0123456789abcdef'

describe('relay test messages', () => {
  it('accepts a request of exactly id and endpoint', () => {
    expect(validRelayTestRequest({ id: ID, endpoint: ENDPOINT })).toBe(true)
    expect(validRelayTestRequest({ endpoint: ENDPOINT, id: ID })).toBe(true)
  })
  it.each([
    ['upper-case id', { id: ID.toUpperCase(), endpoint: ENDPOINT }],
    ['short id', { id: ID.slice(1), endpoint: ENDPOINT }],
    ['https endpoint', { id: ID, endpoint: 'https://relay.example' }],
    ['endpoint not a spry key', { id: ID, endpoint: 'spry://nope?relay=wss%3A%2F%2Frelay.example%2F' }],
    ['an extra key', { id: ID, endpoint: ENDPOINT, address: '1.2.3.4' }],
    ['no endpoint', { id: ID }],
    ['an array', [ID, ENDPOINT]],
    ['a result shape', { id: ID, endpoint: ENDPOINT, ok: true }],
  ])('refuses a request with %s', (_, value) => {
    expect(validRelayTestRequest(value)).toBe(false)
  })
  it('accepts a pass, a hairpin pass and every failure stage', () => {
    expect(validRelayTestResult({ id: ID, endpoint: ENDPOINT, ok: true })).toBe(true)
    expect(validRelayTestResult({ id: ID, endpoint: ENDPOINT, ok: true, sameNetwork: true })).toBe(true)
    for (const stage of ['declined', 'credentials', 'allocate', 'stun', 'inbound']) {
      expect(validRelayTestResult({ id: ID, endpoint: ENDPOINT, ok: false, stage }), stage).toBe(true)
    }
    expect(validRelayTestResult({ id: ID, endpoint: ENDPOINT, ok: false, stage: 'inbound', sameNetwork: true })).toBe(true)
  })
  it.each([
    ['a stage on a pass', { id: ID, endpoint: ENDPOINT, ok: true, stage: 'inbound' }],
    ['no stage on a failure', { id: ID, endpoint: ENDPOINT, ok: false }],
    ['an unknown stage', { id: ID, endpoint: ENDPOINT, ok: false, stage: 'firewall' }],
    ['sameNetwork false', { id: ID, endpoint: ENDPOINT, ok: true, sameNetwork: false }],
    ['sameNetwork on a declined test', { id: ID, endpoint: ENDPOINT, ok: false, stage: 'declined', sameNetwork: true }],
    ['sameNetwork on a refused login', { id: ID, endpoint: ENDPOINT, ok: false, stage: 'credentials', sameNetwork: true }],
    ['ok as a string', { id: ID, endpoint: ENDPOINT, ok: 'true' }],
    ['an address', { id: ID, endpoint: ENDPOINT, ok: true, address: '1.2.3.4' }],
    ['a time', { id: ID, endpoint: ENDPOINT, ok: true, at: 1_800_000_000 }],
  ])('refuses a result with %s', (_, value) => {
    expect(validRelayTestResult(value)).toBe(false)
  })
})

describe('relay test verdict', () => {
  const base: RelayTestObservations = { turnHost: '203.0.113.9', relayed: true, reflexive: ['198.51.100.7'], hosts: ['192.168.1.20'], local: '192.168.1.20', echoed: true, pathA: true, pathB: true }
  it('passes only with the echo and both paths', () => {
    expect(relayTestVerdict(base)).toEqual({ ok: true })
    expect(relayTestVerdict({ ...base, pathB: false })).toEqual({ ok: false, stage: 'inbound' })
    expect(relayTestVerdict({ ...base, echoed: false, pathA: false, pathB: false })).toEqual({ ok: false, stage: 'inbound' })
  })
  it('names the first part that did not work', () => {
    expect(relayTestVerdict({ ...base, relayed: false, echoed: false })).toEqual({ ok: false, stage: 'allocate' })
    expect(relayTestVerdict({ ...base, reflexive: [], echoed: false })).toEqual({ ok: false, stage: 'stun' })
  })
  it('marks a test from the host\'s own network, pass or fail, and never calls it reachable', () => {
    const hairpin = relayTestVerdict({ ...base, reflexive: ['203.0.113.9'] })
    expect(hairpin).toEqual({ ok: true, sameNetwork: true })
    expect(relayTestFinding(hairpin)).toBe('same-network')
    expect(relayTestVerdict({ ...base, reflexive: [], local: '203.0.113.9' })).toEqual({ ok: true, sameNetwork: true })
    expect(relayTestVerdict({ ...base, reflexive: [], local: '203.0.113.9', echoed: false })).toEqual({ ok: false, stage: 'inbound', sameNetwork: true })
    // On the relay's own machine: a host address is the relay's, and the relay refuses it as a peer.
    expect(relayTestVerdict({ ...base, reflexive: [], hosts: ['203.0.113.9'], local: undefined, echoed: false, pathA: false, pathB: false }))
      .toEqual({ ok: false, stage: 'inbound', sameNetwork: true })
  })
  it('says reachable only for a pass from another network', () => {
    expect(relayTestFinding({ ok: true })).toBe('reachable')
    expect(relayTestFinding({ ok: false, stage: 'inbound' })).toBe('unreachable')
    expect(relayTestFinding({ ok: false, stage: 'declined' })).toBe('not-run')
    expect(relayTestFinding({ ok: false, stage: 'credentials' })).toBe('not-run')
  })
})

describe('relay test on the signalling envelope', () => {
  const senderSk = generateSecretKey(), recipientSk = generateSecretKey()
  const recipient = getPublicKey(recipientSk)
  const roundTrip = (body: SignalBody) => unwrapSignalEvent(wrapSignal(body, { senderSk, recipientPubkey: recipient }), { recipientSk, roomId: ROOM })?.body
  it('carries a request and a result to one device', () => {
    const request: SignalBody = { type: 'relay-test', roomId: ROOM, relayTest: { id: ID, endpoint: ENDPOINT } }
    const result: SignalBody = { type: 'relay-test-result', roomId: ROOM, relayTest: { id: ID, endpoint: ENDPOINT, ok: false, stage: 'inbound' } }
    expect(roundTrip(request)).toEqual(request)
    expect(roundTrip(result)).toEqual(result)
  })
  it('refuses a malformed or swapped body whole', () => {
    expect(roundTrip({ type: 'relay-test', roomId: ROOM, relayTest: { id: ID, endpoint: ENDPOINT, ok: true } })).toBeUndefined()
    expect(roundTrip({ type: 'relay-test-result', roomId: ROOM, relayTest: { id: ID, endpoint: ENDPOINT } })).toBeUndefined()
    expect(roundTrip({ type: 'relay-test', roomId: ROOM })).toBeUndefined()
  })
})

class FakeSession implements MeshSession {
  #views: ParticipantView[] = []
  #listeners = new Set<(views: ParticipantView[]) => void>()
  participants(): ParticipantView[] { return this.#views }
  onChange(cb: (views: ParticipantView[]) => void): () => void { this.#listeners.add(cb); return () => this.#listeners.delete(cb) }
  setViews(views: ParticipantView[]): void { this.#views = views; for (const listener of this.#listeners) listener(views) }
}

describe('relay test through the mesh', () => {
  it('reaches an admitted device without a connection, and only from admitted devices, within its own budget', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      const relay = new SimRelay()
      const key = () => { const sk = generateSecretKey(); return { sk, pub: getPublicKey(sk) } }
      const host = key(), tester = key(), stranger = key()
      const hostParticipant = key().pub, testerParticipant = key().pub
      const make = (who: { sk: Uint8Array; pub: string }, participant: string) => {
        const session = new FakeSession()
        // A chat-only device: no media, so no peer is ever opened.
        const mesh = new Mesh({ session, factory: createFakeFactory(), localDevice: who.pub, localParticipant: participant, deviceSk: who.sk, transport: new SimTransport(relay), roomId: ROOM, now: () => 1_800_000_000 })
        return { session, mesh }
      }
      const h = make(host, hostParticipant), t = make(tester, testerParticipant), s = make(stranger, key().pub)
      const roster = [{ participant: hostParticipant, devices: [host.pub], tracks: [] }, { participant: testerParticipant, devices: [tester.pub], tracks: [] }]
      h.session.setViews(roster); t.session.setViews(roster); s.session.setViews(roster)
      const heard: RemoteRelayTest[] = []
      t.mesh.onRelayTest(message => heard.push(message))

      expect(h.mesh.sendRelayTest(tester.pub, { type: 'relay-test', relayTest: { id: ID, endpoint: ENDPOINT } })).toBe(true)
      expect(heard).toEqual([{ participant: hostParticipant, device: host.pub, createdAt: 1_800_000_000, type: 'relay-test', relayTest: { id: ID, endpoint: ENDPOINT } }])
      // A device outside the roster is neither sent to nor heard.
      expect(h.mesh.sendRelayTest(stranger.pub, { type: 'relay-test', relayTest: { id: ID, endpoint: ENDPOINT } })).toBe(false)
      // A stranger who knows the tester's device key is not in the tester's roster.
      expect(s.mesh.sendRelayTest(tester.pub, { type: 'relay-test', relayTest: { id: 'fedcba9876543210', endpoint: ENDPOINT } })).toBe(true)
      expect(heard).toHaveLength(1)
      // Its own small budget per sender.
      for (let i = 0; i < 20; i++) h.mesh.sendRelayTest(tester.pub, { type: 'relay-test', relayTest: { id: i.toString(16).padStart(16, '0'), endpoint: ENDPOINT } })
      expect(heard).toHaveLength(RELAY_TEST_SIGNALS_PER_WINDOW)
      for (const { mesh } of [h, t, s]) mesh.close()
    } finally { clock.mockRestore() }
  })
})
