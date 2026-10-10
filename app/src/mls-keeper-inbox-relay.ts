import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { normaliseRelayConfig, type RelayConfig } from '../../src/relay-pool.js'
import { verifyEventUncached } from '../../src/verify.js'
import { VMLS_REVOCATION_GIFT_WRAP_KIND } from '../../src/vmls-revocation-request.js'
import { publicRoomOperation } from './public-room-operation.js'

export interface MlsKeeperInboxPage {
  events: Event[]
  complete: boolean
}
export interface MlsKeeperInboxQuery {
  relay: RelayConfig
  keeper: string
  since: number
  until: number
  /** Bind the account, foreground state and any relay AUTH permission. */
  current(): boolean
  /** Explicit permission to identify the keeper to this selected relay.
   * A public AUTH challenge alone does not invoke this signer. */
  authentication?: ParticipantIdentity
}
const PAGE_SIZE = 64, MAX_FRAMES = 128, MAX_FRAME_CHARS = 128_000, MAX_TOTAL_CHARS = 3_000_000
const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function verifiedMlsKeeperInboxWrap(candidate: Event, keeper: string, since: number, until: number): boolean {
  try { return !!candidate && candidate.kind === VMLS_REVOCATION_GIFT_WRAP_KIND && time(candidate.created_at) && candidate.created_at >= since && candidate.created_at <= until &&
    JSON.stringify(candidate.tags) === JSON.stringify([['p', keeper]]) && typeof candidate.content === 'string' && candidate.content.length <= 40_000 &&
    new TextEncoder().encode(candidate.content).length <= 40_000 && verifyEventUncached(candidate) } catch { return false }
}

/** One finite stored-event page. This has no polling, cursor, decryption,
 * grant or room capability. A witnessed caller must separately budget pages
 * and decryptions and must not advance a cursor for incomplete results. */
export class NostrMlsKeeperInboxTransport {
  #serial = 0
  constructor(private socket: (url: string) => WebSocket = url => new WebSocket(url),
    private deadlineMs = 5_000, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 5_000) throw new Error('Invalid keeper inbox deadline.')
  }
  async page(input: MlsKeeperInboxQuery): Promise<MlsKeeperInboxPage> {
    const relay = normaliseRelayConfig([input.relay])[0]!, query = { ...input, relay: { ...relay }, current: input.current.bind(input),
      authentication: input.authentication ? { pubkey: input.authentication.pubkey, signEvent: input.authentication.signEvent.bind(input.authentication) } : undefined }
    if (!relay.read || !hex(query.keeper) || !time(query.since) || !time(query.until) || query.until < query.since ||
        query.authentication && query.authentication.pubkey !== query.keeper) throw new Error('Invalid keeper inbox query.')
    if (relay.circle && !query.authentication) throw new Error('This circle relay needs explicit keeper authentication before reading.')
    let stopped = false, stop: (() => void) | undefined, release: (() => Promise<void>) | undefined
    const live = () => { try { return !stopped && query.current() } catch { return false } }
    try {
      if (!live()) return { events: [], complete: false }
      const permission = publicRoomOperation(() => { stopped = true; stop?.() })
      if (permission) release = await permission
      if (!live()) return { events: [], complete: false }
      return await new Promise<MlsKeeperInboxPage>(resolve => {
        const expires = performance.now() + this.deadlineMs
        let socket: WebSocket | undefined, finished = false, frames = 0, chars = 0
        let id = '', challenge: string | undefined, authId: string | undefined, signing = false, authenticated = false, refused = false, retried = false
        const events = new Map<string, Event>()
        const finish = (complete: boolean) => {
          if (finished) return
          finished = true; clearTimeout(timer); clearInterval(guard)
          try { if (id) socket?.send(JSON.stringify(['CLOSE', id])) } catch { /* The page is already fixed. */ }
          try { socket?.close() } catch { /* The page is already fixed. */ }
          resolve({ events: live() ? [...events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)) : [], complete: complete && live() && performance.now() < expires })
        }
        stop = () => finish(false)
        const timer = setTimeout(() => finish(false), this.deadlineMs)
        const guard = setInterval(() => { if (!live()) finish(false) }, 25)
        const sendQuery = () => {
          if (finished || !live() || performance.now() >= expires) { finish(false); return }
          id = `vmls-keeper-inbox-${++this.#serial}`
          socket!.send(JSON.stringify(['REQ', id, { kinds: [VMLS_REVOCATION_GIFT_WRAP_KIND], '#p': [query.keeper], since: query.since, until: query.until, limit: PAGE_SIZE }]))
        }
        const authenticate = async () => {
          if (finished || !live() || signing || authId || !challenge || !query.authentication) return
          signing = true
          const created_at = this.now(), template = { kind: 22242, created_at, content: '', tags: [['relay', relay.url], ['challenge', challenge]] }
          const expected = structuredClone(template)
          try {
            if (!time(created_at)) throw new Error('Untrusted authentication time')
            const signed = await query.authentication.signEvent(template)
            if (finished || !live()) return
            const event: Event = { ...expected, id: signed.id, pubkey: signed.pubkey, sig: signed.sig }
            if (signed.pubkey !== query.keeper || signed.kind !== expected.kind || signed.created_at !== expected.created_at || signed.content !== '' ||
                JSON.stringify(signed.tags) !== JSON.stringify(expected.tags) || !verifyEventUncached(event)) throw new Error('Invalid keeper authentication statement')
            authId = event.id; socket!.send(JSON.stringify(['AUTH', event]))
          } catch { if (!finished) finish(false) }
        }
        try {
          socket = this.socket(relay.url)
          socket.onopen = () => { try { if (!relay.circle) sendQuery() } catch { finish(false) } }
          socket.onerror = () => finish(false); socket.onclose = () => finish(false)
          socket.onmessage = message => {
            if (finished || !live()) { finish(false); return }
            if (++frames > MAX_FRAMES || typeof message.data !== 'string' || message.data.length > MAX_FRAME_CHARS || (chars += message.data.length) > MAX_TOTAL_CHARS) { finish(false); return }
            try {
              const frame: unknown = JSON.parse(message.data)
              if (!Array.isArray(frame)) { finish(false); return }
              if (frame[0] === 'AUTH') {
                if (frame.length !== 2 || typeof frame[1] !== 'string' || !frame[1] || frame[1].length > 1024 || challenge !== undefined && challenge !== frame[1]) { finish(false); return }
                challenge = frame[1]
                if (relay.circle || refused) void authenticate()
              } else if (frame[0] === 'OK' && authId && frame[1] === authId) {
                if (frame.length !== 4 || frame[2] !== true || typeof frame[3] !== 'string' || authenticated) { finish(false); return }
                authenticated = true
                if (refused) { if (retried) { finish(false); return }; retried = true; events.clear() }
                sendQuery()
              } else if (id && frame[1] === id) {
                if (frame[0] === 'CLOSED') {
                  if (frame.length !== 3 || typeof frame[2] !== 'string' || !frame[2].startsWith('auth-required:') || !query.authentication || authenticated || retried) { finish(false); return }
                  refused = true; void authenticate()
                } else if (!refused || authenticated) {
                  if (frame[0] === 'EOSE') { finish(frame.length === 2); return }
                  if (frame[0] === 'EVENT' && frame.length === 3) {
                    const candidate = frame[2] as Event
                    // Signature verification precedes page deduplication. A
                    // forged copy cannot reserve a legitimate wrap's id.
                    if (!verifiedMlsKeeperInboxWrap(candidate, query.keeper, query.since, query.until)) return
                    if (!events.has(candidate.id) && events.size >= PAGE_SIZE) { finish(false); return }
                    events.set(candidate.id, { id: candidate.id, pubkey: candidate.pubkey, sig: candidate.sig, kind: candidate.kind, created_at: candidate.created_at, content: candidate.content, tags: [['p', query.keeper]] })
                  }
                }
              }
            } catch { finish(false) }
          }
        } catch { finish(false) }
      })
    } finally { stopped = true; stop?.(); await release?.() }
  }
}
