import type { Event } from 'nostr-tools/pure'
import { KIND_DM_RELAYS, MAX_DM_RELAYS } from '../../src/dm-relays.js'
import { NostrRelayPool, normaliseRelayConfig, type NostrRelayPoolOptions, type RelayConfig } from '../../src/relay-pool.js'
import { VMLS_REVOCATION_GIFT_WRAP_KIND, type VmlsRevocationPublication, type VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'
import { verifyEventUncached } from '../../src/verify.js'
import { publicRoomOperation } from './public-room-operation.js'

const hex32 = /^[0-9a-f]{64}$/
const DIRECTORY_EVENT_LIMIT = 8
const DEFAULT_LOOKUP_MS = 8_000
const DEFAULT_DRAIN_MS = 2_000

type RevocationPool = Pick<NostrRelayPool, 'publish' | 'settled' | 'close'>
type PoolFactory = (relays: readonly RelayConfig[], options: NostrRelayPoolOptions) => RevocationPool
type SocketFactory = (url: string) => WebSocket

export interface NostrVmlsRevocationTransportOptions {
  socket?: SocketFactory
  pool?: PoolFactory
  lookupMs?: number
  drainMs?: number
}

function verifiedDirectoryEvent(event: Event, keeper: string): boolean {
  try { return event.kind === KIND_DM_RELAYS && event.pubkey === keeper && verifyEventUncached(event) } catch { return false }
}

function verifiedPublication(publication: VmlsRevocationPublication): boolean {
  try {
    const { event } = publication
    return publication.authenticate === false && publication.relays.length >= 1 && publication.relays.length <= MAX_DM_RELAYS &&
      event.kind === VMLS_REVOCATION_GIFT_WRAP_KIND && verifyEventUncached(event) && event.tags.length === 1 &&
      event.tags[0]?.length === 2 && event.tags[0][0] === 'p' && hex32.test(event.tags[0][1] ?? '')
  } catch { return false }
}

/**
 * Finite public relay transport for a member's P3-08 request.
 *
 * Directory reads send only a bounded NIP-01 request. The gift-wrap write
 * uses a fresh pool with an explicit empty authentication set. A successful
 * write means one relay returned `OK true`; it says nothing about keeper
 * receipt or performed revocation.
 */
export class NostrVmlsRevocationTransport implements VmlsRevocationTransport {
  readonly #directoryRelays: RelayConfig[]
  readonly #socket: SocketFactory
  readonly #makePool: PoolFactory
  readonly #lookupMs: number
  readonly #drainMs: number
  #serial = 0
  constructor(discoveryRelays: readonly string[], options: NostrVmlsRevocationTransportOptions = {}) {
    if (discoveryRelays.length < 1 || discoveryRelays.length > MAX_DM_RELAYS) throw new Error(`Use between one and ${MAX_DM_RELAYS} directory relays.`)
    this.#directoryRelays = normaliseRelayConfig(discoveryRelays.map(url => ({ url, read: true, write: false })))
    this.#socket = options.socket ?? (url => new WebSocket(url))
    this.#makePool = options.pool ?? ((relays, poolOptions) => new NostrRelayPool(relays, undefined, poolOptions))
    this.#lookupMs = options.lookupMs ?? DEFAULT_LOOKUP_MS
    this.#drainMs = options.drainMs ?? DEFAULT_DRAIN_MS
    if (!Number.isSafeInteger(this.#lookupMs) || this.#lookupMs < 100 || this.#lookupMs > 120_000) throw new Error('Invalid revocation directory deadline.')
    if (!Number.isSafeInteger(this.#drainMs) || this.#drainMs < 0 || this.#drainMs > 20_000) throw new Error('Invalid revocation relay drain deadline.')
  }

  async directory(keeper: string): Promise<readonly Event[]> {
    if (!hex32.test(keeper)) throw new Error('Invalid room keeper identity.')
    const sockets = new Set<WebSocket>()
    let routeChanged = false
    let release: (() => Promise<void>) | undefined
    try {
      const permission = publicRoomOperation(() => {
        routeChanged = true
        for (const socket of sockets) try { socket.close() } catch { /* The lookup is already uncertain. */ }
      })
      if (permission) release = await permission
      if (routeChanged) throw new Error('Room routing changed during the keeper directory lookup.')
      const results = await Promise.all(this.#directoryRelays.map(relay => this.#readDirectory(relay.url, keeper, sockets)))
      if (routeChanged) throw new Error('Room routing changed during the keeper directory lookup.')
      const events = new Map<string, Event>()
      for (const result of results) for (const event of result.events) events.set(event.id, event)
      if (!events.size && !results.some(result => result.complete)) {
        throw new Error('The keeper directory lookup did not complete. No revocation request was sent.')
      }
      return [...events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, DIRECTORY_EVENT_LIMIT)
    } finally {
      for (const socket of sockets) try { socket.close() } catch { /* The lookup result is already fixed. */ }
      await release?.()
    }
  }

  #readDirectory(relay: string, keeper: string, sockets: Set<WebSocket>): Promise<{ events: Event[]; complete: boolean }> {
    const id = `vmls-revocation-${++this.#serial}`
    return new Promise(resolve => {
      let socket: WebSocket | undefined
      let finished = false
      const events = new Map<string, Event>()
      const finish = (complete: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (socket) sockets.delete(socket)
        try { socket?.close() } catch { /* The bounded result is already fixed. */ }
        resolve({ events: [...events.values()], complete })
      }
      const timer = setTimeout(() => finish(false), this.#lookupMs)
      try {
        socket = this.#socket(relay)
        sockets.add(socket)
        socket.onopen = () => {
          try { socket!.send(JSON.stringify(['REQ', id, { kinds: [KIND_DM_RELAYS], authors: [keeper], limit: DIRECTORY_EVENT_LIMIT }])) }
          catch { finish(false) }
        }
        socket.onerror = () => finish(false)
        socket.onclose = () => finish(false)
        socket.onmessage = message => {
          if (typeof message.data !== 'string' || message.data.length > 128_000) return
          try {
            const frame: unknown = JSON.parse(message.data)
            if (!Array.isArray(frame) || frame[1] !== id) return
            if (frame[0] === 'EOSE' && frame.length === 2) finish(true)
            else if (frame[0] === 'CLOSED' && frame.length >= 2) finish(false)
            else if (frame[0] === 'EVENT' && frame.length === 3 && events.size < DIRECTORY_EVENT_LIMIT &&
                verifiedDirectoryEvent(frame[2] as Event, keeper)) events.set((frame[2] as Event).id, frame[2] as Event)
          } catch { /* Malformed relay material cannot complete or fill the bounded result. */ }
        }
      } catch { finish(false) }
    })
  }

  async publish(publication: VmlsRevocationPublication): Promise<void> {
    const { event } = publication
    if (!verifiedPublication(publication)) throw new Error('Invalid VMLS revocation publication.')
    const relays = normaliseRelayConfig(publication.relays.map(url => ({ url, read: false, write: true })))
    const pool = this.#makePool(relays, { authentication: [] })
    let routeChanged = false
    let release: (() => Promise<void>) | undefined
    try {
      const permission = publicRoomOperation(() => { routeChanged = true; pool.close() })
      if (permission) release = await permission
      if (routeChanged) throw new Error('Room routing changed before the revocation request was sent.')
      await pool.publish(event)
      await pool.settled(this.#drainMs)
      if (routeChanged) throw new Error('Room routing changed while the revocation request was being sent.')
    } finally {
      pool.close()
      await release?.()
    }
  }
}
