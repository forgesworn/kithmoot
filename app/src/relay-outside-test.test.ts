import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRelayTest } from '../../src/mesh.js'
import type { RelayTestRequest, RelayTestResult } from '../../src/relay-test.js'
import { RELAY_TEST_NOT_HOSTING, RELAY_TEST_NOT_PRESENT, RelayOutsideTests, runRelayOutsideTest, type RelayTestRelay, type RelayTestSession } from './relay-outside-test.js'

class Channel {
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  other?: Channel
  send(data: string) { this.other?.onmessage?.({ data }) }
  close() {}
}

/** Peer A is the first connection made (relay-only), peer B the second. */
class Connection {
  static instances: Connection[] = []
  static connect = true
  static relayed = true
  static reflexive = '198.51.100.7'
  static bHost = '192.168.1.20'
  static bLocal = { candidateType: 'host', address: '192.168.1.20' }
  signalingState = 'stable'
  remoteDescription?: { type: string }
  localDescription?: { type: string }
  onicecandidate: ((event: { candidate: object | null }) => void) | null = null
  ondatachannel: ((event: { channel: Channel }) => void) | null = null
  channel?: Channel
  closed = false
  constructor(public config: RTCConfiguration) { Connection.instances.push(this) }
  get role() { return Connection.instances.indexOf(this) === 0 ? 'a' : 'b' }
  createDataChannel() { return this.channel = new Channel() }
  async createOffer() { return { type: 'offer' } }
  async createAnswer() { return { type: 'answer' } }
  async setLocalDescription(description: { type: string }) {
    this.localDescription = description
    if (this.role === 'a' && Connection.relayed) this.onicecandidate?.({ candidate: { type: 'relay', address: '203.0.113.9' } })
    if (this.role === 'b') this.onicecandidate?.({ candidate: { type: 'host', address: Connection.bHost } })
    if (this.role === 'b' && Connection.reflexive) this.onicecandidate?.({ candidate: { type: 'srflx', address: Connection.reflexive } })
  }
  async setRemoteDescription(description: { type: string }) {
    this.remoteDescription = description
    if (description.type === 'answer' && Connection.connect) {
      const [a, b] = Connection.instances
      const remote = new Channel()
      a.channel!.other = remote; remote.other = a.channel
      b.ondatachannel?.({ channel: remote as unknown as Channel })
      queueMicrotask(() => a.channel!.onopen?.())
    }
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, bytesReceived: 64, localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', this.role === 'a' ? { candidateType: 'relay', address: '203.0.113.9' } : Connection.bLocal],
      ['remote', { candidateType: 'host' }],
    ])
  }
  close() { this.closed = true }
}

const relay = { urls: ['turn:203.0.113.9:51000?transport=udp', 'turn:203.0.113.9:51001?transport=tcp'], username: 'fixture', credential: 'fixture-password' }

describe('relay outside test run', () => {
  beforeEach(() => {
    Connection.instances = []; Connection.connect = true; Connection.relayed = true
    Connection.reflexive = '198.51.100.7'; Connection.bHost = '192.168.1.20'; Connection.bLocal = { candidateType: 'host', address: '192.168.1.20' }
    vi.stubGlobal('RTCPeerConnection', Connection)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('puts A on the relay only and B on the relay\'s listener as STUN, and passes on an echo over both paths', async () => {
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 1000)).resolves.toEqual({ ok: true })
    const [a, b] = Connection.instances
    expect(a.config.iceTransportPolicy).toBe('relay')
    expect(a.config.iceServers).toEqual([{ urls: relay.urls, username: 'fixture', credential: 'fixture-password' }])
    expect(b.config).toEqual({ iceServers: [{ urls: 'stun:203.0.113.9:51000' }] })
    expect(Connection.instances.every(pc => pc.closed && pc.onicecandidate === null)).toBe(true)
  })
  it('says the tester was on the host\'s network when its outside address is the relay\'s', async () => {
    Connection.reflexive = '203.0.113.9'
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 1000)).resolves.toEqual({ ok: true, sameNetwork: true })
  })
  it('names the part that failed when nothing comes back', async () => {
    Connection.connect = false
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 50)).resolves.toEqual({ ok: false, stage: 'inbound' })
    Connection.instances = []; Connection.reflexive = ''
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 50)).resolves.toEqual({ ok: false, stage: 'stun' })
    Connection.instances = []; Connection.relayed = false
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 50)).resolves.toEqual({ ok: false, stage: 'allocate' })
    expect(Connection.instances.every(pc => pc.closed)).toBe(true)
  })
  it('says so when the tester runs on the relay\'s own machine, where the relay refuses it as a peer', async () => {
    Connection.connect = false; Connection.reflexive = ''; Connection.bHost = '203.0.113.9'
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 50)).resolves.toEqual({ ok: false, stage: 'inbound', sameNetwork: true })
  })
  it('fails a B path that went through a relay', async () => {
    Connection.bLocal = { candidateType: 'relay', address: '203.0.113.9' }
    await expect(runRelayOutsideTest(relay, new AbortController().signal, 1000)).resolves.toMatchObject({ ok: false, stage: 'inbound' })
  })
  it('stops when aborted', async () => {
    Connection.connect = false
    const abort = new AbortController()
    const run = runRelayOutsideTest(relay, abort.signal, 60_000)
    abort.abort()
    await expect(run).resolves.toMatchObject({ ok: false })
    expect(Connection.instances.every(pc => pc.closed)).toBe(true)
  })
})

const HOST = 'a1'.repeat(32), GUEST = 'b2'.repeat(32), OTHER = 'c3'.repeat(32)
const HOST_DEVICE = 'a3'.repeat(32), GUEST_DEVICE = 'b4'.repeat(32), OTHER_DEVICE = 'c5'.repeat(32)
const ENDPOINT = `spry://${'1b'.repeat(32)}?relay=${encodeURIComponent('wss://relay.example/')}`

type Sent = { to: string; type: string; relayTest: RelayTestRequest | RelayTestResult }
function pair() {
  const sent: Sent[] = []
  const listeners = new Map<string, (message: RemoteRelayTest) => void>()
  const session = (device: string): RelayTestSession => ({
    device,
    sendRelayTest: (to, message) => { sent.push({ to, ...message }); return [HOST_DEVICE, GUEST_DEVICE, OTHER_DEVICE].includes(to) },
    onRelayTest: cb => { listeners.set(device, cb); return () => listeners.delete(device) },
  })
  /** Deliver a message to `device` as if it came from `from`. */
  const deliver = (device: string, from: string, participant: string, message: Pick<RemoteRelayTest, 'type' | 'relayTest'>) =>
    listeners.get(device)?.({ participant, device: from, createdAt: 1_800_000_000, ...message } as RemoteRelayTest)
  return { sent, session, deliver }
}
const relayFor = (over: Partial<RelayTestRelay> = {}): RelayTestRelay => ({
  hostedEndpoint: () => ENDPOINT,
  testOffer: endpoint => endpoint === ENDPOINT ? { host: HOST, usable: true } : undefined,
  testCredential: async () => relay,
  ...over,
})

describe('relay outside tests in a room', () => {
  it('a host asks one device and hears its result, and only that device\'s result for that request', async () => {
    const { sent, session, deliver } = pair()
    const host = new RelayOutsideTests(session(HOST_DEVICE), relayFor())
    const asked = host.ask(GUEST_DEVICE)
    expect(sent).toEqual([{ to: GUEST_DEVICE, type: 'relay-test', relayTest: { id: expect.stringMatching(/^[0-9a-f]{16}$/), endpoint: ENDPOINT } }])
    const id = sent[0]!.relayTest.id
    deliver(HOST_DEVICE, OTHER_DEVICE, OTHER, { type: 'relay-test-result', relayTest: { id, endpoint: ENDPOINT, ok: true } })
    deliver(HOST_DEVICE, GUEST_DEVICE, GUEST, { type: 'relay-test-result', relayTest: { id: 'f'.repeat(16), endpoint: ENDPOINT, ok: true } })
    deliver(HOST_DEVICE, GUEST_DEVICE, GUEST, { type: 'relay-test-result', relayTest: { id, endpoint: ENDPOINT, ok: false, stage: 'inbound' } })
    await expect(asked).resolves.toEqual({ answered: true, device: GUEST_DEVICE, participant: GUEST, at: 1_800_000_000, ok: false, stage: 'inbound', finding: 'unreachable' })
    host.close()
  })
  it('a host that shares no built-in relay here cannot ask, and nobody answering is said plainly', async () => {
    vi.useFakeTimers()
    try {
      const { session } = pair()
      const none = new RelayOutsideTests(session(HOST_DEVICE), relayFor({ hostedEndpoint: () => undefined }))
      await expect(none.ask(GUEST_DEVICE)).rejects.toThrow(RELAY_TEST_NOT_HOSTING)
      const host = new RelayOutsideTests(session(HOST_DEVICE), relayFor(), { answerMs: 1000 })
      await expect(host.ask('d6'.repeat(32))).rejects.toThrow(RELAY_TEST_NOT_PRESENT)
      const asked = host.ask(GUEST_DEVICE)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(asked).resolves.toEqual({ answered: false, device: GUEST_DEVICE })
    } finally { vi.useRealTimers() }
  })
  it('a member tests only for the member who offers that relay, and answers that member alone', async () => {
    const { sent, session, deliver } = pair()
    const run = vi.fn(async () => ({ ok: true as const, sameNetwork: true as const }))
    const tester = new RelayOutsideTests(session(GUEST_DEVICE), relayFor(), { run })
    deliver(GUEST_DEVICE, OTHER_DEVICE, OTHER, { type: 'relay-test', relayTest: { id: '1'.repeat(16), endpoint: ENDPOINT } })
    deliver(GUEST_DEVICE, HOST_DEVICE, HOST, { type: 'relay-test', relayTest: { id: '2'.repeat(16), endpoint: ENDPOINT.replace('1b', '2c') } })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(0))
    expect(sent).toEqual([])
    deliver(GUEST_DEVICE, HOST_DEVICE, HOST, { type: 'relay-test', relayTest: { id: '3'.repeat(16), endpoint: ENDPOINT } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(run).toHaveBeenCalledWith(relay, expect.any(AbortSignal))
    expect(sent).toEqual([{ to: HOST_DEVICE, type: 'relay-test-result', relayTest: { id: '3'.repeat(16), endpoint: ENDPOINT, ok: true, sameNetwork: true } }])
    tester.close()
  })
  it('a member declines while testing, when asked again within a minute, and while it may not use the relay', async () => {
    const { sent, session, deliver } = pair()
    let release: () => void = () => {}
    const run = vi.fn(() => new Promise<{ ok: true }>(resolve => { release = () => resolve({ ok: true }) }))
    let now = 1_000_000
    const tester = new RelayOutsideTests(session(GUEST_DEVICE), relayFor(), { run, now: () => now })
    const ask = (id: string) => deliver(GUEST_DEVICE, HOST_DEVICE, HOST, { type: 'relay-test', relayTest: { id: id.repeat(16), endpoint: ENDPOINT } })
    ask('1')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    ask('2')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.relayTest).toEqual({ id: '2'.repeat(16), endpoint: ENDPOINT, ok: false, stage: 'declined' })
    release()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    ask('3')
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]!.relayTest).toMatchObject({ ok: false, stage: 'declined' })
    now += 60_000
    ask('4')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    release()
    tester.close()

    const blocked = pair()
    const refusing = new RelayOutsideTests(blocked.session(GUEST_DEVICE), relayFor({ testOffer: () => ({ host: HOST, usable: false }) }), { run })
    blocked.deliver(GUEST_DEVICE, HOST_DEVICE, HOST, { type: 'relay-test', relayTest: { id: '5'.repeat(16), endpoint: ENDPOINT } })
    await vi.waitFor(() => expect(blocked.sent).toHaveLength(1))
    expect(blocked.sent[0]!.relayTest).toMatchObject({ ok: false, stage: 'declined' })
    expect(run).toHaveBeenCalledTimes(2)
    refusing.close()
  })
  it('a member says when the host\'s node gave it no login', async () => {
    const { sent, session, deliver } = pair()
    const run = vi.fn()
    const tester = new RelayOutsideTests(session(GUEST_DEVICE), relayFor({ testCredential: async () => { throw new Error('refused') } }), { run })
    deliver(GUEST_DEVICE, HOST_DEVICE, HOST, { type: 'relay-test', relayTest: { id: '6'.repeat(16), endpoint: ENDPOINT } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.relayTest).toEqual({ id: '6'.repeat(16), endpoint: ENDPOINT, ok: false, stage: 'credentials' })
    expect(run).not.toHaveBeenCalled()
    tester.close()
  })
})
