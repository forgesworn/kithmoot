/**
 * A deliberately simple NIP-01 publisher for public deletion requests.
 *
 * This does not use the reconnecting chat pool because a deletion receipt
 * needs one finite, attributable answer from every relay. An `OK` means only
 * that this relay accepted the request event; it is not evidence that bytes
 * were erased from the relay, another relay, or another client.
 *
 * A tidy-up sends one request per message, so this keeps one socket per
 * relay for as long as it has requests for it, and sends at most one request
 * a second to each. It used to open a socket per request: 600 messages on
 * three relays was 1,800 connections in a few minutes. A relay that answers
 * `rate-limited:` is sent nothing more by this writer, and every pool in the
 * process holds its writes to it (relay-dial-gate.ts). A socket nobody has
 * used for `IDLE_CLOSE_MS` closes by itself; `close()` ends them all now.
 */
import type { Event } from 'nostr-tools/pure'
import { normaliseRelayConfig } from '../../src/relay-pool.js'
import { verifyEventUncached } from '../../src/verify.js'
import { relayDials, relayReason, type RelayDialGate } from '../../src/relay-dial-gate.js'
import { publicRoomOperation } from './public-room-operation.js'

export type PublicDeletionRelayOutcome = {
  relay: string
  status: 'accepted' | 'refused' | 'timed-out' | 'unknown'
  detail?: string
}

/** The least time between two requests to one relay. */
export const DELETION_PACE_MS = 1_000
/** How long an unused socket stays open for the next request. */
export const IDLE_CLOSE_MS = 10_000
const SLOW_DOWN = 'rate-limited: not sent; this relay asked this device to slow down'

interface Link {
  socket?: WebSocket
  open: boolean
  /** Why the socket can no longer carry a request, once it cannot. */
  failure?: string
  /** Resolves when the socket opens or fails. */
  ready: Promise<void>
  settle: () => void
  /** Requests sent and waiting for their `OK`, by event id. */
  waiting: Map<string, (outcome: PublicDeletionRelayOutcome) => void>
  /** Requests take turns, one per `paceMs`. */
  turn: Promise<void>
  queued: number
  lastSentAt: number
  release?: () => Promise<void>
  idle?: ReturnType<typeof setTimeout>
}

export class NostrPublicDeletionRelayWriter {
  readonly #links = new Map<string, Link>()
  /** Relays this writer will not send to again: they asked us to slow
   *  down, or their socket failed while requests were waiting. */
  readonly #stopped = new Map<string, PublicDeletionRelayOutcome>()

  constructor(
    private readonly socket: (url: string) => WebSocket = url => new WebSocket(url),
    private readonly timeoutMs = 15_000,
    private readonly paceMs = DELETION_PACE_MS,
    private readonly gate: RelayDialGate = relayDials,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('invalid public deletion deadline')
    if (!Number.isSafeInteger(paceMs) || paceMs < 0 || paceMs > 60_000) throw new Error('invalid public deletion pace')
  }

  /** Sends one already-signed kind-5 event to every named relay. Results stay
   * in the input's canonical relay order, including failures. */
  async publish(relays: readonly string[], event: Event): Promise<PublicDeletionRelayOutcome[]> {
    if (event.kind !== 5 || !verifyEventUncached(event)) throw new Error('Public deletion needs a verified signed kind-5 event.')
    if (relays.length === 0) throw new Error('Choose at least one public relay for a deletion request.')
    const urls = normaliseRelayConfig(relays.map(url => ({ url, read: false, write: true }))).map(relay => relay.url)
    return await Promise.all(urls.map(async relay => await this.#publish(relay, event)))
  }

  /** Close every socket now. Requests still waiting are answered `unknown`. */
  close(): void {
    for (const [relay, link] of [...this.#links]) this.#end(relay, link, 'deletion writer closed before an OK acknowledgement')
  }

  #publish(relay: string, event: Event): Promise<PublicDeletionRelayOutcome> {
    const stopped = this.#held(relay)
    if (stopped) return Promise.resolve(stopped)
    const link = this.#link(relay)
    link.queued++
    if (link.idle) { clearTimeout(link.idle); link.idle = undefined }
    const result = new Promise<PublicDeletionRelayOutcome>(resolve => {
      link.turn = link.turn.then(async () => {
        const wait = link.lastSentAt + this.paceMs - Date.now()
        if (wait > 0 && link.lastSentAt > 0) await new Promise(next => setTimeout(next, wait))
        resolve(await this.#send(relay, link, event))
      })
    })
    void result.finally(() => { link.queued--; this.#maybeIdle(relay, link) })
    return result
  }

  #held(relay: string): PublicDeletionRelayOutcome | undefined {
    const stopped = this.#stopped.get(relay)
    if (stopped) return { ...stopped }
    if (this.gate.writeHeld(relay)) return { relay, status: 'refused', detail: SLOW_DOWN }
    return undefined
  }

  #send(relay: string, link: Link, event: Event): Promise<PublicDeletionRelayOutcome> {
    return new Promise(resolve => {
      let finished = false
      const finish = (outcome: PublicDeletionRelayOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        link.waiting.delete(event.id)
        resolve(outcome)
      }
      const timer = setTimeout(() => finish({ relay, status: 'timed-out', detail: 'no OK acknowledgement before deadline' }), this.timeoutMs)
      void (async () => {
        await link.ready
        if (finished) return
        // Asked to slow down by an earlier answer, or held by another pool.
        const stopped = this.#held(relay)
        if (stopped) { finish(stopped); return }
        if (link.failure || !link.open || !link.socket) { finish({ relay, status: 'unknown', detail: link.failure ?? 'relay connection could not be opened' }); return }
        link.waiting.set(event.id, finish)
        try {
          link.socket.send(JSON.stringify(['EVENT', event]))
          link.lastSentAt = Date.now()
        } catch { finish({ relay, status: 'unknown', detail: 'deletion request could not be sent' }) }
      })()
    })
  }

  #link(relay: string): Link {
    const existing = this.#links.get(relay)
    if (existing && !existing.failure) return existing
    let settle!: () => void
    const ready = new Promise<void>(resolve => { settle = resolve })
    const link: Link = { open: false, ready, settle, waiting: new Map(), turn: Promise.resolve(), queued: 0, lastSentAt: 0 }
    this.#links.set(relay, link)
    const fail = (detail: string) => {
      if (link.failure) return
      link.failure = detail
      link.open = false
      // A socket that failed with requests on it is not dialled again by
      // this writer: the next request would only fail the same way.
      if (link.waiting.size || link.queued) this.#stopped.set(relay, { relay, status: 'unknown', detail })
      for (const finish of [...link.waiting.values()]) finish({ relay, status: 'unknown', detail })
      link.waiting.clear()
      settle()
      if (this.#links.get(relay) === link) this.#links.delete(relay)
      clearTimeout(link.idle)
      void link.release?.()
    }
    void (async () => { try {
      const permission = publicRoomOperation(() => this.#end(relay, link, 'room routing changed'))
      if (permission) link.release = once(await permission)
      if (link.failure) { await link.release?.(); return }
      const socket = this.socket(relay)
      link.socket = socket
      socket.onopen = () => { link.open = true; settle() }
      socket.onerror = () => fail('relay connection failed before an OK acknowledgement')
      socket.onclose = () => fail('relay connection closed before an OK acknowledgement')
      socket.onmessage = message => {
        if (typeof message.data !== 'string' || message.data.length > 128_000) return
        try {
          const frame: unknown = JSON.parse(message.data)
          if (!Array.isArray(frame) || frame.length !== 4 || frame[0] !== 'OK' || typeof frame[1] !== 'string' || typeof frame[2] !== 'boolean' || typeof frame[3] !== 'string') return
          const finish = link.waiting.get(frame[1])
          if (!finish) return
          if (!frame[2] && relayReason(frame[3]) === 'rate-limited') {
            this.gate.throttled(relay)
            this.#stopped.set(relay, { relay, status: 'refused', detail: SLOW_DOWN })
          }
          finish({ relay, status: frame[2] ? 'accepted' : 'refused', ...(frame[3] ? { detail: frame[3].slice(0, 400) } : {}) })
        } catch { /* A malformed frame cannot change an unknown result into acceptance. */ }
      }
    } catch { fail('relay connection could not be opened') } })()
    return link
  }

  #maybeIdle(relay: string, link: Link): void {
    if (link.queued > 0 || link.waiting.size || link.failure || this.#links.get(relay) !== link) return
    clearTimeout(link.idle)
    link.idle = setTimeout(() => this.#end(relay, link, 'deletion writer closed before an OK acknowledgement'), IDLE_CLOSE_MS)
    ;(link.idle as unknown as { unref?: () => void }).unref?.()
  }

  /** Close one relay's socket on our own account. */
  #end(relay: string, link: Link, detail: string): void {
    if (this.#links.get(relay) === link) this.#links.delete(relay)
    clearTimeout(link.idle)
    const socket = link.socket
    if (socket) { socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null }
    if (!link.failure) {
      link.failure = detail
      link.open = false
      for (const finish of [...link.waiting.values()]) finish({ relay, status: 'unknown', detail })
      link.waiting.clear()
    }
    link.settle()
    try { socket?.close() } catch { /* Already closed. */ }
    void link.release?.()
  }
}

function once(release: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined
  return () => (done ??= release())
}
