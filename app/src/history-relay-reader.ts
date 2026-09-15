import { matchFilters, type Filter } from 'nostr-tools/filter'
import type { Event } from 'nostr-tools/pure'
import type { HistoryReadResult, HistoryRelayReader } from '../../src/history-import.js'
import { normaliseRelayConfig } from '../../src/relay-pool.js'

/** A single bounded, read-only NIP-01 query. It deliberately does not share
 * the reconnecting live-chat pool: recovery needs a final answer for each
 * relay, while a chat subscription is supposed to survive a broken socket. */
export class NostrHistoryRelayReader {
  #serial = 0
  constructor(private readonly socket: (url: string) => WebSocket = url => new WebSocket(url), private readonly timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('invalid history relay deadline')
  }

  readonly read: HistoryRelayReader = async (relay, filter) => {
    const url = normaliseRelayConfig([{ url: relay, read: true, write: false }])[0]!.url
    const id = `history-${++this.#serial}`
    return new Promise<HistoryReadResult>(resolve => {
      let socket: WebSocket | undefined
      let finished = false
      const events: Event[] = []
      const finish = (result: HistoryReadResult) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try { socket?.close() } catch { /* A failed recovery read is still a receipt. */ }
        resolve(result)
      }
      const timer = setTimeout(() => finish({ terminal: 'timeout', events, detail: 'no EOSE before deadline' }), this.timeoutMs)
      try {
        socket = this.socket(url)
        socket.onopen = () => {
          try { socket!.send(JSON.stringify(['REQ', id, filter])) }
          catch { finish({ terminal: 'unavailable', events, detail: 'request could not be sent' }) }
        }
        socket.onerror = () => finish({ terminal: 'unavailable', events, detail: 'relay connection failed' })
        socket.onclose = () => finish({ terminal: 'unavailable', events, detail: 'relay connection closed before EOSE' })
        socket.onmessage = message => {
          if (typeof message.data !== 'string' || message.data.length > 128_000) return
          try {
            const frame: unknown = JSON.parse(message.data)
            if (!Array.isArray(frame) || frame[1] !== id) return
            if (frame[0] === 'EOSE' && frame.length === 2) finish({ terminal: 'complete', events })
            else if (frame[0] === 'CLOSED' && typeof frame[2] === 'string') finish({ terminal: 'closed', events, detail: frame[2].slice(0, 400) })
            else if (frame[0] === 'EVENT' && frame.length === 3 && matchFilters([filter], frame[2] as Event)) events.push(frame[2] as Event)
          } catch { /* Bad frames neither complete a request nor gain custody. */ }
        }
      } catch { finish({ terminal: 'unavailable', events, detail: 'relay connection could not be opened' }) }
    })
  }
}
