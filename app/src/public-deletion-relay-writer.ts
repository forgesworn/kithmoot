/**
 * A deliberately one-shot NIP-01 publisher for public deletion requests.
 *
 * This does not use the reconnecting chat pool because a deletion receipt
 * needs one finite, attributable answer from every relay. An `OK` means only
 * that this relay accepted the request event; it is not evidence that bytes
 * were erased from the relay, another relay, or another client.
 */
import type { Event } from 'nostr-tools/pure'
import { normaliseRelayConfig } from '../../src/relay-pool.js'
import { verifyEventUncached } from '../../src/verify.js'

export type PublicDeletionRelayOutcome = {
  relay: string
  status: 'accepted' | 'refused' | 'timed-out' | 'unknown'
  detail?: string
}

export class NostrPublicDeletionRelayWriter {
  constructor(private readonly socket: (url: string) => WebSocket = url => new WebSocket(url), private readonly timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('invalid public deletion deadline')
  }

  /** Sends one already-signed kind-5 event to every named relay. Results stay
   * in the input's canonical relay order, including failures. */
  async publish(relays: readonly string[], event: Event): Promise<PublicDeletionRelayOutcome[]> {
    if (event.kind !== 5 || !verifyEventUncached(event)) throw new Error('Public deletion needs a verified signed kind-5 event.')
    if (relays.length === 0) throw new Error('Choose at least one public relay for a deletion request.')
    const urls = normaliseRelayConfig(relays.map(url => ({ url, read: false, write: true }))).map(relay => relay.url)
    return await Promise.all(urls.map(async relay => await this.#publish(relay, event)))
  }

  #publish(relay: string, event: Event): Promise<PublicDeletionRelayOutcome> {
    return new Promise(resolve => {
      let socket: WebSocket | undefined
      let finished = false
      const finish = (outcome: PublicDeletionRelayOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try { socket?.close() } catch { /* The acknowledgement is already recorded. */ }
        resolve(outcome)
      }
      const unknown = (detail: string) => finish({ relay, status: 'unknown', detail })
      const timer = setTimeout(() => finish({ relay, status: 'timed-out', detail: 'no OK acknowledgement before deadline' }), this.timeoutMs)
      try {
        socket = this.socket(relay)
        socket.onopen = () => {
          try { socket!.send(JSON.stringify(['EVENT', event])) }
          catch { unknown('deletion request could not be sent') }
        }
        socket.onerror = () => unknown('relay connection failed before an OK acknowledgement')
        socket.onclose = () => unknown('relay connection closed before an OK acknowledgement')
        socket.onmessage = message => {
          if (typeof message.data !== 'string' || message.data.length > 128_000) return
          try {
            const frame: unknown = JSON.parse(message.data)
            if (!Array.isArray(frame) || frame.length !== 4 || frame[0] !== 'OK' || frame[1] !== event.id || typeof frame[2] !== 'boolean' || typeof frame[3] !== 'string') return
            finish({ relay, status: frame[2] ? 'accepted' : 'refused', ...(frame[3] ? { detail: frame[3].slice(0, 400) } : {}) })
          } catch { /* A malformed frame cannot change an unknown result into acceptance. */ }
        }
      } catch { unknown('relay connection could not be opened') }
    })
  }
}
