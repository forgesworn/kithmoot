import { stunFromTurnUrl } from '../../src/ice-defaults.js'
import { bytesToHex } from '@noble/hashes/utils'
import { RELAY_TEST_ANSWER_MS, RELAY_TEST_COOLDOWN_MS, RELAY_TEST_RUN_MS, relayTestFinding, relayTestVerdict,
  type RelayTestObservations, type RelayTestRequest, type RelayTestResult, type RelayTestStage, type RelayTestVerdict } from '../../src/relay-test.js'
import type { RemoteRelayTest } from '../../src/mesh.js'
import { callRelayPeerConnection, type CallRelay } from './call-relay.js'
import { relayOnlyIceConfiguration } from './relay-only.js'

/**
 * The outside test of a member's built-in call relay, on the tester's device
 * (docs/protocol.md, "Relay outside test").
 *
 * Peer A is relay-only on the host's relay. Peer B has no TURN and uses the
 * relay's listener as its STUN server, so it learns its own public address
 * and A's relay can let it in. B's checks then reach A's relayed address from
 * B's public address, through the host's allocation port, and a data-channel
 * echo plus the selected pairs prove listener and allocation inbound
 * together. Both peers are on this device; the only traffic leaving it goes
 * to the host's relay, which sees this device's address as it would on any
 * call through it. No capture, room identifiers, persistence or raw errors;
 * only the verdict leaves this function.
 */
export async function runRelayOutsideTest(relay: CallRelay, signal: AbortSignal, timeoutMs = RELAY_TEST_RUN_MS): Promise<RelayTestVerdict> {
  const seen: { -readonly [K in keyof RelayTestObservations]: RelayTestObservations[K] } & { reflexive: string[] } = {
    turnHost: turnHostOf(relay.urls) ?? '', relayed: false, reflexive: [], echoed: false, pathA: false, pathB: false,
  }
  const peers: RTCPeerConnection[] = []
  const channels: RTCDataChannel[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStopped: (reason: Error) => void = () => {}
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
  const stop = () => rejectStopped(new Error('stopped'))
  try {
    const attempt = async () => {
      if (signal.aborted) throw new Error('stopped')
      const udp = relay.urls.find(url => /^turn:[^?]+\?transport=udp$/i.test(url.trim()))
      const stun = udp ? stunFromTurnUrl(udp) : undefined
      const a = callRelayPeerConnection(relayOnlyIceConfiguration([{ urls: [...relay.urls], username: relay.username, credential: relay.credential }]))
      peers.push(a)
      const b = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [] })
      peers.push(b)
      const pendingA: RTCIceCandidate[] = [], pendingB: RTCIceCandidate[] = []
      const forward = (target: RTCPeerConnection, pending: RTCIceCandidate[], value: RTCIceCandidate) => {
        if (!target.remoteDescription) pending.push(value)
        else void target.addIceCandidate(value).catch(() => {})
      }
      a.onicecandidate = event => {
        if (!event.candidate) return
        if (event.candidate.type === 'relay') seen.relayed = true
        forward(b, pendingB, event.candidate)
      }
      b.onicecandidate = event => {
        if (!event.candidate) return
        const address = event.candidate.address
        if (event.candidate.type === 'srflx' && address && seen.reflexive.length < 16 && !seen.reflexive.includes(address)) seen.reflexive.push(address)
        forward(a, pendingA, event.candidate)
      }
      const sent = 'kithmoot-relay-outside-test'
      const channel = a.createDataChannel('relay-outside-test'); channels.push(channel)
      const echoed = new Promise<void>(resolve => {
        channel.onopen = () => channel.send(sent)
        channel.onmessage = event => { if (event.data === sent) resolve() }
        b.ondatachannel = event => {
          const remote = event.channel; channels.push(remote)
          remote.onmessage = message => { if (message.data === sent) remote.send(sent) }
        }
      })
      await a.setLocalDescription(await a.createOffer())
      if (signal.aborted || a.signalingState === 'closed') throw new Error('stopped')
      await b.setRemoteDescription(a.localDescription!)
      for (const value of pendingB.splice(0)) await b.addIceCandidate(value).catch(() => {})
      await b.setLocalDescription(await b.createAnswer())
      if (signal.aborted || b.signalingState === 'closed') throw new Error('stopped')
      await a.setRemoteDescription(b.localDescription!)
      for (const value of pendingA.splice(0)) await a.addIceCandidate(value).catch(() => {})
      await echoed
      seen.echoed = true
      const pathA = await selectedPath(a), pathB = await selectedPath(b)
      seen.pathA = pathA?.localType === 'relay'
      seen.pathB = !!pathB && pathB.localType !== 'relay'
      if (pathB?.localAddress) seen.local = pathB.localAddress
    }
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(stop, timeoutMs)
    await Promise.race([attempt(), stopped])
  } catch { /* The verdict says which part did not work. */ }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    for (const pc of peers) { pc.onicecandidate = null; pc.ondatachannel = null; pc.close() }
    for (const channel of channels) { channel.onopen = null; channel.onmessage = null; channel.close() }
  }
  return relayTestVerdict(seen)
}

/** The single IPv4 literal of the relay's `turn:` URLs. */
function turnHostOf(urls: readonly string[]): string | undefined {
  const hosts = new Set(urls.map(url => /^turns?:([0-9.]+):\d+(?:\?|$)/i.exec(url.trim())?.[1]).filter((host): host is string => !!host))
  return hosts.size === 1 ? [...hosts][0] : undefined
}

/** The nominated, succeeded pair that received bytes: its local candidate's
 *  type and address. */
async function selectedPath(pc: RTCPeerConnection): Promise<{ localType?: string; localAddress?: string } | undefined> {
  const stats = await pc.getStats()
  let found: { localType?: string; localAddress?: string } | undefined
  stats.forEach(stat => {
    if (found || stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || !stat.nominated || !(stat.bytesReceived > 0)) return
    const local = stats.get(stat.localCandidateId)
    found = { localType: local?.candidateType, localAddress: typeof local?.address === 'string' ? local.address : undefined }
  })
  return found
}

/** What a host hears back from one request. */
export type RelayTestOutcome =
  | { answered: true; device: string; participant: string; at: number; ok: boolean; stage?: RelayTestStage; sameNetwork?: true;
      finding: ReturnType<typeof relayTestFinding> }
  | { answered: false; device: string }

/** The room session surface the tests use. */
export interface RelayTestSession {
  readonly device: string
  sendRelayTest(device: string, message: { type: 'relay-test'; relayTest: RelayTestRequest } | { type: 'relay-test-result'; relayTest: RelayTestResult }): boolean
  onRelayTest(cb: (message: RemoteRelayTest) => void): () => void
}

/** The room's Spry surface the tests use (`SpryRoom`). */
export interface RelayTestRelay {
  hostedEndpoint(): string | undefined
  testOffer(endpoint: string): { host: string | undefined; usable: boolean } | undefined
  testCredential(endpoint: string): Promise<CallRelay>
}

export interface RelayOutsideTestsOptions {
  run?: typeof runRelayOutsideTest
  answerMs?: number
  cooldownMs?: number
  /** Milliseconds; injectable for tests. */
  now?: () => number
}

export const RELAY_TEST_NOT_HOSTING = 'This device is not sharing its own built-in call relay in this room.'
export const RELAY_TEST_NOT_PRESENT = 'That device is not in the room now.'
/** Requests a host may have outstanding at once. */
const MAX_PENDING = 4

/**
 * Both sides of the relay outside test for one room session.
 *
 * As host: `ask(device)` sends one request to one device and resolves with
 * its result, or `answered: false` after `RELAY_TEST_ANSWER_MS`. Nothing is
 * stored; what to show and keep is the caller's.
 *
 * As tester: a request is honoured only from a device whose participant is
 * the one member offering that built-in relay in this room, and only for a
 * standard offer this device holds. Anything else is ignored without a
 * word. A genuine host is answered `declined` when a test is already
 * running, when a test for it ran within the last minute, or when this device may
 * not use its relay (Hide my IP address on and no choice made for it);
 * `credentials` when its node refused a login; otherwise the verdict.
 */
export class RelayOutsideTests {
  #pending = new Map<string, { device: string; endpoint: string; finish: (outcome: RelayTestOutcome) => void; timer: ReturnType<typeof setTimeout> }>()
  #running = false
  #lastRun = new Map<string, number>()
  #abort = new AbortController()
  #closed = false
  #unsub: () => void
  #run: typeof runRelayOutsideTest
  #answerMs: number
  #cooldownMs: number
  #now: () => number
  constructor(private session: RelayTestSession, private relay: RelayTestRelay, options: RelayOutsideTestsOptions = {}) {
    this.#run = options.run ?? runRelayOutsideTest
    this.#answerMs = options.answerMs ?? RELAY_TEST_ANSWER_MS
    this.#cooldownMs = options.cooldownMs ?? RELAY_TEST_COOLDOWN_MS
    this.#now = options.now ?? Date.now
    this.#unsub = session.onRelayTest(message => {
      if (this.#closed || message.device === session.device) return
      if (message.type === 'relay-test') void this.#answer(message.device, message.participant, message.relayTest)
      else this.#heard(message.device, message.participant, message.createdAt, message.relayTest)
    })
  }

  /** Ask one other device in the room to test this device's built-in relay from outside. */
  ask(device: string): Promise<RelayTestOutcome> {
    const endpoint = this.relay.hostedEndpoint()
    if (this.#closed || !endpoint) return Promise.reject(new Error(RELAY_TEST_NOT_HOSTING))
    if (device === this.session.device || this.#pending.size >= MAX_PENDING) return Promise.reject(new Error(RELAY_TEST_NOT_PRESENT))
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
    return new Promise<RelayTestOutcome>((resolve, reject) => {
      const finish = (outcome: RelayTestOutcome) => {
        const pending = this.#pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        resolve(outcome)
      }
      const timer = setTimeout(() => finish({ answered: false, device }), this.#answerMs)
      this.#pending.set(id, { device, endpoint, finish, timer })
      if (!this.session.sendRelayTest(device, { type: 'relay-test', relayTest: { id, endpoint } })) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error(RELAY_TEST_NOT_PRESENT))
      }
    })
  }

  #heard(device: string, participant: string, at: number, result: RelayTestRequest | RelayTestResult): void {
    const pending = this.#pending.get(result.id)
    if (!pending || pending.device !== device || pending.endpoint !== result.endpoint || !('ok' in result)) return
    pending.finish({ answered: true, device, participant, at, ok: result.ok,
      ...(result.stage ? { stage: result.stage } : {}), ...(result.sameNetwork ? { sameNetwork: true as const } : {}), finding: relayTestFinding(result) })
  }

  async #answer(device: string, participant: string, request: RelayTestRequest | RelayTestResult): Promise<void> {
    if ('ok' in request) return
    const offer = this.relay.testOffer(request.endpoint)
    // Only the member who offers this relay may ask; anyone else hears nothing.
    if (!offer || offer.host === undefined || offer.host !== participant) return
    const reply = (verdict: RelayTestVerdict) => {
      if (this.#closed) return
      this.session.sendRelayTest(device, { type: 'relay-test-result', relayTest: { id: request.id, endpoint: request.endpoint, ...verdict } })
    }
    const last = this.#lastRun.get(device)
    if (this.#running || !offer.usable || (last !== undefined && this.#now() - last < this.#cooldownMs)) { reply({ ok: false, stage: 'declined' }); return }
    this.#running = true
    try {
      let login: CallRelay
      try { login = await this.relay.testCredential(request.endpoint) } catch { reply({ ok: false, stage: 'credentials' }); return }
      if (this.#closed) return
      // The minute starts with traffic to the relay, not with a refused login.
      this.#lastRun.set(device, this.#now())
      if (this.#lastRun.size > 64) this.#lastRun.delete(this.#lastRun.keys().next().value!)
      reply(await this.#run(login, this.#abort.signal))
    } finally { this.#running = false }
  }

  close(): void {
    this.#closed = true
    this.#abort.abort()
    this.#unsub()
    for (const pending of [...this.#pending.values()]) pending.finish({ answered: false, device: pending.device })
  }
}
