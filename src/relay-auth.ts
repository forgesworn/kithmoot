import { normalizeURL } from 'nostr-tools/utils'
import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity, UnsignedEvent } from './identity.js'
import { verifyEventUncached } from './verify.js'

/** Permission to identify as this key to exactly this relay, for this session.
 * A room invitation or circle label never creates this permission. */
export interface RelayAuthentication {
  url: string
  /** null keeps this endpoint disconnected after consent is withdrawn. */
  identity: ParticipantIdentity | null
}
export interface RelayPoolOptions {
  authentication?: readonly RelayAuthentication[]
  /** Per-pool injection, including Node or a separately verified carrier. */
  websocketImplementation?: typeof WebSocket
  authenticationTimeoutMs?: number
}
export const AUTH_TIMEOUT_MS = 30_000

export interface AuthenticationGrant {
  readonly pubkey: string
  readonly sign: ParticipantIdentity['signEvent']
}

/** Adapt the callback interface consumed by nostr-tools. Delay its `open`
 * notification until NIP-42 succeeds, so its ordinary publish/subscribe path
 * never enters the dependency's authentication-retry path. No room frames
 * are queued here and no authentication event reaches its event store. */
export function authenticatedWebSocket(
  Base: typeof WebSocket,
  grantFor: (url: string) => AuthenticationGrant | undefined,
  active: (url: string) => boolean,
  failed: (url: string, reason: string) => void,
  timeoutMs: number,
): typeof WebSocket {
  class AuthSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    onopen: ((event: EventLike) => void) | null = null
    onmessage: ((event: MessageLike) => void) | null = null
    onerror: ((event: EventLike) => void) | null = null
    onclose: ((event: CloseLike) => void) | null = null
    readyState = 0
    readonly url: string
    #socket?: WebSocket
    #grant?: AuthenticationGrant
    #timer?: ReturnType<typeof setTimeout>
    #challenge?: string
    #authId?: string
    #finished = false

    constructor(url: string) {
      this.url = normalizeURL(url)
      this.#grant = grantFor(this.url)
      // A failed grant is latched by the pool: recovery cannot repeatedly
      // prompt a signer who declined. Creating another socket stays closed.
      if (!active(this.url)) { queueMicrotask(() => this.#finish('Connection cancelled')); return }
      try {
        this.#socket = new Base(url)
      } catch {
        queueMicrotask(() => this.#finish('Connection failed'))
        return
      }
      this.#socket.onopen = event => {
        if (!this.#current()) { this.close(); return }
        if (!this.#grant) { this.readyState = 1; this.onopen?.(event); return }
        this.#timer = setTimeout(() => this.#refuse('Relay authentication timed out; retry to try again'), timeoutMs)
      }
      this.#socket.onmessage = event => {
        if (!this.#current()) { this.close(); return }
        if (!this.#grant) { this.onmessage?.(event); return }
        if (typeof event.data !== 'string' || event.data.length > 264_192) {
          this.#refuse('Invalid relay authentication response'); return
        }
        let frame: unknown
        try { frame = JSON.parse(event.data) } catch { this.#refuse('Invalid relay response'); return }
        if (!Array.isArray(frame)) { this.#refuse('Invalid relay response'); return }
        if (frame[0] === 'AUTH') {
          const challenge = frame[1]
          if (frame.length !== 2 || typeof challenge !== 'string' || !challenge || challenge.length > 1024) {
            this.#refuse('Invalid relay authentication challenge'); return
          }
          if (this.#challenge !== undefined) {
            if (challenge !== this.#challenge || this.readyState === 1) this.#refuse('Relay authentication challenge changed; reconnect to try again')
            return
          }
          this.#challenge = challenge
          void this.#sign(challenge)
          return
        }
        if (this.readyState === 1) { this.onmessage?.(event); return }
        if (frame[0] === 'OK' && frame[1] === this.#authId && this.#authId) {
          if (frame.length !== 4 || frame[2] !== true || typeof frame[3] !== 'string') {
            this.#refuse('Relay refused this authentication key'); return
          }
          clearTimeout(this.#timer)
          this.readyState = 1
          this.onopen?.({ type: 'open' })
        }
        // Ignore notices and unsolicited events while authenticating. They
        // cannot disclose room filters or make history appear complete.
      }
      this.#socket.onerror = () => {
        if (!this.#finished) this.onerror?.({ type: 'error' })
      }
      this.#socket.onclose = event => this.#finish(event.reason || 'Connection closed', event.code)
    }

    #current(): boolean { return !this.#finished && active(this.url) && (!this.#grant || grantFor(this.url) === this.#grant) }

    async #sign(challenge: string): Promise<void> {
      const grant = this.#grant!
      const template: UnsignedEvent = {
        kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '',
        tags: [['relay', this.url], ['challenge', challenge]],
      }
      const expected = JSON.stringify(template)
      try {
        const signed = await grant.sign(template)
        if (!this.#current()) return
        // Keep only canonical event fields. Extra signer properties and a
        // cached verification verdict must never cross this wire boundary.
        const statement: UnsignedEvent = JSON.parse(expected)
        const sameTags = Array.isArray(signed.tags) && signed.tags.length === 2 && signed.tags.every((tag, i) =>
          Array.isArray(tag) && tag.length === 2 && tag[0] === statement.tags[i]![0] && tag[1] === statement.tags[i]![1])
        const event: Event = { ...statement, id: signed.id, pubkey: signed.pubkey, sig: signed.sig }
        if (signed.pubkey !== grant.pubkey || signed.kind !== statement.kind || signed.created_at !== statement.created_at ||
            signed.content !== statement.content || !sameTags || !verifyEventUncached(event)) {
          this.#refuse('Signer returned an invalid relay authentication event'); return
        }
        this.#authId = event.id
        this.#socket?.send(JSON.stringify(['AUTH', event]))
      } catch {
        if (this.#current()) this.#refuse('Relay authentication was not approved; retry to try again')
      }
    }

    #refuse(reason: string): void {
      if (this.#finished) return
      failed(this.url, reason)
      this.#finish(reason, 4003)
      this.#socket?.close()
    }
    #finish(reason: string, code = 1006): void {
      if (this.#finished) return
      this.#finished = true
      clearTimeout(this.#timer)
      this.readyState = 3
      this.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 })
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      // WebSocket discards writes once closing/closed. The dependency may
      // schedule CLOSE after cancellation; it must not revive the connection.
      if (!this.#current()) { this.close(); return }
      if (this.readyState !== 1) throw new Error('Relay is not authenticated or connected')
      this.#socket?.send(data)
    }
    close(code?: number, reason?: string): void {
      this.#finish(reason || 'Connection cancelled', code ?? 1000)
      this.#socket?.close(code, reason)
    }
  }
  // nostr-tools consumes only this callback socket interface, also used by
  // its Node implementations. This is not a general DOM WebSocket polyfill.
  return AuthSocket as unknown as typeof WebSocket
}
type EventLike = { type?: string }
type MessageLike = { data: unknown }
type CloseLike = { type?: string; code?: number; reason?: string; wasClean?: boolean }
