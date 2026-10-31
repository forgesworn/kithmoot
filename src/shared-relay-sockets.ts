import { normalizeURL } from 'nostr-tools/utils'
import { handshakeObservedWebSocket } from './guarded-websocket.js'

/**
 * Room pools sharing real connections to a relay.
 *
 * Every `NostrRelayPool` used to hold its own socket to each of its relays,
 * and desktop holds a pool for every room it knows: thirty rooms meant about
 * thirty-seven sockets from one address to each default relay. Relays and the
 * proxies in front of them count connections per address, and that is what
 * gets an address rate-limited and then banned.
 *
 * `socketClass` is a WebSocket stand-in for nostr-tools. Each one it makes is
 * a lane: what one pool sees as its own connection. Lanes for the same relay
 * ride a small number of real sockets, called carriers here:
 *
 *  - Subscription ids are per pool (`sub:1` in every one of them), so each
 *    `REQ`, `COUNT` and `NEG-OPEN` gets a short id unique to its carrier, and
 *    replies are routed back to the one lane that asked, under its own id.
 *  - An `OK` goes to the lanes that sent that event. `NOTICE`, `AUTH` and
 *    anything else unaddressed go to every lane on the carrier; the dial
 *    gate already counts several pools hearing one complaint as one.
 *  - primal, ditto and offchain allow 20 live subscriptions per connection
 *    and quietly stop sending live events past that. A carrier takes at most
 *    `subscriptionsPerSocket` (16) and the next subscription goes to another
 *    carrier, opened if need be. A relay that says "too many" anyway marks
 *    its carrier full.
 *  - Closing a lane closes its subscriptions on the relay; a carrier nobody
 *    uses closes after a short linger, so a pool rebuilding itself does not
 *    redial. A carrier that drops takes every lane on it down too, and each
 *    pool's own recovery dials again, through the shared dial gate, onto one
 *    new carrier.
 *
 * Only pools without relay authentication share: NIP-42 binds a whole
 * connection to one key. The account's own pools keep their own sockets as
 * well, so no single connection carries both a person's account and their
 * rooms. The address is shared anyway; see `.claude/handover/inbox-spec.md`.
 */
export class SharedRelaySockets {
  readonly #Base: typeof WebSocket
  readonly #perSocket: number
  readonly #lingerMs: number
  readonly #carriers = new Map<string, Carrier[]>()
  readonly #now: () => number
  readonly socketClass: typeof WebSocket

  constructor(Base: typeof WebSocket, options: SharedRelaySocketsOptions = {}) {
    const refused = options.refusedUpgrade
    this.#Base = handshakeObservedWebSocket(Base, refused && (url => refused(key(url))))
    this.#perSocket = options.subscriptionsPerSocket ?? SUBSCRIPTIONS_PER_SOCKET
    this.#lingerMs = options.lingerMs ?? LINGER_MS
    this.#now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.#perSocket) || this.#perSocket < 1) throw new Error('Invalid subscription budget')
    if (!Number.isFinite(this.#lingerMs) || this.#lingerMs < 0) throw new Error('Invalid linger')
    const registry = this
    this.socketClass = class SharedRelaySocket extends Lane {
      constructor(url: string | URL) { super(registry, String(url)) }
    } as unknown as typeof WebSocket
  }

  /** Real sockets open or opening to `url`, or to every relay. */
  connections(url?: string): number {
    if (url !== undefined) return this.#carriers.get(key(url))?.length ?? 0
    let total = 0
    for (const carriers of this.#carriers.values()) total += carriers.length
    return total
  }

  /** When any real socket to `url` last heard anything from the relay. A
   *  pool deciding whether its connection has gone quiet asks this, not its
   *  own record: another pool's traffic proves the socket alive as well. */
  lastHeard(url: string): number {
    let heard = 0
    for (const carrier of this.#carriers.get(key(url)) ?? []) heard = Math.max(heard, carrier.heardAt)
    return heard
  }

  /** A pool found `url` unresponsive. Close every real socket to it that has
   *  heard nothing from the relay since `since`, so its lanes all reconnect;
   *  one that has heard something since is alive and is left alone. Merely
   *  closing the pool's own lane would put it straight back on the same dead
   *  socket. */
  condemnQuiet(url: string, since: number): void {
    for (const carrier of [...this.#carriers.get(key(url)) ?? []]) {
      if (carrier.heardAt < since) this.#drop(carrier, 'relay stopped answering')
    }
  }

  /** @internal A lane's first carrier: one with room to spare, else new. */
  attach(url: string): Carrier {
    return this.#roomy(url) ?? this.#open(url)
  }

  /** @internal Where a lane's next subscription goes: a carrier it already
   *  uses with room, then any with room, then a new one. */
  place(url: string, preferred: Iterable<Carrier>): Carrier {
    for (const carrier of preferred) if (carrier.state !== 'closed' && carrier.hasRoom()) return carrier
    return this.#roomy(url) ?? this.#open(url)
  }

  /** @internal A carrier with nobody on it closes after the linger. */
  idle(carrier: Carrier): void {
    if (carrier.members.size !== 0 || carrier.state === 'closed') return
    clearTimeout(carrier.linger)
    carrier.linger = setTimeout(() => {
      if (carrier.members.size === 0) this.#drop(carrier, 'idle')
    }, this.#lingerMs)
    ;(carrier.linger as unknown as { unref?: () => void }).unref?.()
  }

  #roomy(url: string): Carrier | undefined {
    return this.#carriers.get(key(url))?.find(carrier => carrier.state !== 'closed' && carrier.hasRoom())
  }

  #open(url: string): Carrier {
    const carrier = new Carrier(url, this.#perSocket, this.#now)
    const list = this.#carriers.get(carrier.key) ?? []
    list.push(carrier); this.#carriers.set(carrier.key, list)
    let socket: WebSocket
    try { socket = new this.#Base(url) }
    catch {
      // A socket that cannot even be made fails its lanes the way a refused
      // connection does, once they have their handlers.
      setTimeout(() => this.#drop(carrier, 'connection failed'), 0)
      return carrier
    }
    carrier.socket = socket
    socket.onopen = () => {
      if (carrier.state !== 'connecting') return
      carrier.state = 'open'
      for (const frame of carrier.queue.splice(0)) socket.send(frame)
      for (const lane of [...carrier.members]) lane.carrierOpened(carrier)
      this.idle(carrier)
    }
    socket.onmessage = (event: MessageEvent) => {
      if (carrier.state === 'closed') return
      carrier.heardAt = this.#now()
      if (typeof event.data === 'string') carrier.receive(event.data)
    }
    socket.onerror = () => this.#drop(carrier, 'connection failed')
    socket.onclose = () => this.#drop(carrier, 'relay connection closed')
    return carrier
  }

  #drop(carrier: Carrier, reason: string): void {
    if (carrier.state === 'closed') return
    carrier.state = 'closed'
    clearTimeout(carrier.linger)
    const list = this.#carriers.get(carrier.key)
    if (list) {
      const index = list.indexOf(carrier)
      if (index !== -1) list.splice(index, 1)
      if (list.length === 0) this.#carriers.delete(carrier.key)
    }
    const socket = carrier.socket
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
      try { if (socket.readyState === 0 || socket.readyState === 1) socket.close() } catch { /* already gone */ }
    }
    carrier.queue.length = 0
    const lanes = [...carrier.members]
    carrier.members.clear(); carrier.subscriptions.clear(); carrier.pending.clear()
    for (const lane of lanes) lane.carrierLost(carrier, reason)
  }
}

export interface SharedRelaySocketsOptions {
  /** Live subscriptions one real socket carries before the next goes to
   *  another. `SUBSCRIPTIONS_PER_SOCKET` unless set. */
  subscriptionsPerSocket?: number
  /** How long a real socket nobody uses stays open. `LINGER_MS` unless set. */
  lingerMs?: number
  /** Told when a relay refuses the upgrade with 429 or 503 (Node only). */
  refusedUpgrade?: (url: string) => void
  now?: () => number
}

/** Below the 20 subscriptions per connection that primal, ditto and
 *  offchain allow (NIP-11, 30 October 2026), leaving room for a pool's
 *  short-lived lookups and probes. */
export const SUBSCRIPTIONS_PER_SOCKET = 16

/** Short lookups by id a full socket still takes: 16 + 3 stays under 20. */
const LOOKUP_HEADROOM = 3

/** How long a real socket stays open after its last lane closes: long
 *  enough for a pool that is rebuilding itself to come back to it. */
export const LINGER_MS = 3_000

/** How long a published event's lanes wait for its `OK`. */
const PENDING_OK_MS = 60_000

type Kind = 'subscription' | 'count' | 'negentropy'
type Place = { carrier: Carrier; wire: string; kind: Kind }

const ADDRESSED = /^(\s*\[\s*"(EVENT|EOSE|CLOSED|COUNT|NEG-MSG|NEG-ERR)"\s*,\s*)"([^"\\]*)"/
const ACKNOWLEDGED = /^\s*\[\s*"OK"\s*,\s*"([0-9a-f]{64})"/
const OVER_BUDGET = /too many (concurrent )?(reqs|subscriptions)/i

function key(url: string): string {
  try { return normalizeURL(url) } catch { return url }
}

/** @internal One real socket and what rides it. */
export class Carrier {
  readonly key: string
  socket?: WebSocket
  state: 'connecting' | 'open' | 'closed' = 'connecting'
  readonly queue: string[] = []
  readonly members = new Set<Lane>()
  /** Live subscriptions by the id the relay knows them by. */
  readonly subscriptions = new Map<string, { lane: Lane; id: string; kind: Kind }>()
  /** Lanes waiting on an `OK`, by event id. */
  readonly pending = new Map<string, { lanes: Set<Lane>; at: number }>()
  heardAt = 0
  linger?: ReturnType<typeof setTimeout>
  #budget: number
  #serial = 0

  constructor(readonly url: string, budget: number, private readonly now: () => number) {
    this.key = key(url)
    this.#budget = budget
  }

  hasRoom(headroom = 0): boolean { return this.subscriptions.size < this.#budget + headroom }

  nextId(): string { return `k${(++this.#serial).toString(36)}` }

  write(frame: string): void {
    if (this.state === 'open') { try { this.socket!.send(frame) } catch { /* the close handler takes it from here */ } }
    else if (this.state === 'connecting') this.queue.push(frame)
  }

  awaitOk(id: string, lane: Lane): void {
    const now = this.now()
    if (this.pending.size > 256) {
      for (const [event, entry] of this.pending) if (now - entry.at > PENDING_OK_MS) this.pending.delete(event)
    }
    const entry = this.pending.get(id)
    if (entry) { entry.lanes.add(lane); entry.at = now }
    else this.pending.set(id, { lanes: new Set([lane]), at: now })
  }

  receive(data: string): void {
    const addressed = ADDRESSED.exec(data)
    if (addressed) {
      const [whole, prefix, type, wire] = addressed
      const owner = this.subscriptions.get(wire!)
      // Not ours, or one a lane has already closed: nobody is listening.
      if (!owner) return
      if (type === 'CLOSED' || type === 'NEG-ERR' || (type === 'COUNT' && owner.kind === 'count')) owner.lane.forget(this, wire!, owner.id)
      owner.lane.deliver(prefix + JSON.stringify(owner.id) + data.slice(whole!.length))
      return
    }
    const acknowledged = ACKNOWLEDGED.exec(data)
    if (acknowledged) {
      const entry = this.pending.get(acknowledged[1]!)
      if (!entry) return
      this.pending.delete(acknowledged[1]!)
      for (const lane of entry.lanes) lane.deliver(data)
      return
    }
    // The relay refused the last subscription's live half. Place nothing
    // more here; the pool's resend logic deals with what it lost.
    if (/^\s*\[\s*"NOTICE"/.test(data) && OVER_BUDGET.test(data)) this.#budget = Math.max(1, this.subscriptions.size - 1)
    for (const lane of [...this.members]) lane.deliver(data)
  }
}

/** @internal What one pool sees as its connection to a relay. */
class Lane {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = 0
  readonly url: string
  binaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  readonly #registry: SharedRelaySockets
  readonly #home: Carrier
  readonly #carriers = new Set<Carrier>()
  /** Where each of this lane's subscriptions lives, by the pool's own id. */
  readonly #ids = new Map<string, Place>()

  constructor(registry: SharedRelaySockets, url: string) {
    this.url = url
    this.#registry = registry
    this.#home = registry.attach(url)
    this.#join(this.#home)
    // Handlers are assigned after the constructor returns; tell them later.
    if (this.#home.state === 'open') queueMicrotask(() => this.carrierOpened(this.#home))
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === 0) throw new Error('Shared relay socket is still connecting')
    if (this.readyState !== 1 || typeof data !== 'string') return
    let message: unknown
    try { message = JSON.parse(data) } catch { this.#home.write(data); return }
    if (!Array.isArray(message) || typeof message[0] !== 'string') { this.#home.write(data); return }
    const [type, id] = message as [string, unknown]
    switch (type) {
      case 'REQ': case 'COUNT': case 'NEG-OPEN': {
        if (typeof id !== 'string') return
        let place = this.#ids.get(id)
        if (!place || place.carrier.state === 'closed') {
          if (place) this.#ids.delete(id)
          // A lookup by id answers at once and ends: a liveness probe or a
          // read-back. It goes on this lane's own socket, into the headroom
          // under the relay's cap, so a probe tests the socket it is about
          // and never opens another.
          const lookup = type === 'REQ' && message.length > 2 && message.slice(2).every(filter => Array.isArray((filter as { ids?: unknown } | null)?.ids))
          const carrier = lookup && this.#home.state !== 'closed' && this.#home.hasRoom(LOOKUP_HEADROOM) ? this.#home
            : this.#registry.place(this.url, [this.#home, ...this.#carriers])
          const kind: Kind = type === 'COUNT' ? 'count' : type === 'NEG-OPEN' ? 'negentropy' : 'subscription'
          place = { carrier, wire: carrier.nextId(), kind }
          carrier.subscriptions.set(place.wire, { lane: this, id, kind })
          this.#ids.set(id, place)
          this.#join(carrier)
        }
        message[1] = place.wire
        place.carrier.write(JSON.stringify(message))
        return
      }
      case 'CLOSE': case 'NEG-CLOSE': case 'NEG-MSG': {
        if (typeof id !== 'string') return
        const place = this.#ids.get(id)
        if (!place) return
        message[1] = place.wire
        place.carrier.write(JSON.stringify(message))
        if (type !== 'NEG-MSG') this.forget(place.carrier, place.wire, id)
        return
      }
      case 'EVENT': case 'AUTH': {
        const event = message[1] as { id?: unknown } | undefined
        if (typeof event?.id === 'string') this.#home.awaitOk(event.id, this)
        this.#home.write(data)
        return
      }
      default:
        this.#home.write(data)
    }
  }

  close(): void {
    if (this.readyState >= 2) return
    const wasConnecting = this.readyState === 0
    this.readyState = 3
    // The relay keeps a subscription until it hears CLOSE or the socket
    // goes; this socket stays, so say it.
    this.#release()
    for (const carrier of this.#carriers) {
      carrier.members.delete(this)
      this.#registry.idle(carrier)
    }
    this.#carriers.clear()
    const onclose = this.onclose
    if (onclose && !wasConnecting) setTimeout(() => onclose.call(this, closeEvent(1000, '', true)), 0)
    else if (onclose) setTimeout(() => onclose.call(this, closeEvent(1006, 'closed before open', false)), 0)
  }

  /** @internal */
  carrierOpened(carrier: Carrier): void {
    if (carrier !== this.#home || this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.call(this, { type: 'open' } as Event)
  }

  /** @internal Any carrier this lane uses dropping takes the lane with it:
   *  a pool cannot tell which of its subscriptions went. */
  carrierLost(carrier: Carrier, reason: string): void {
    if (this.readyState >= 2) return
    const wasOpen = this.readyState === 1
    this.readyState = 3
    this.#release(carrier)
    for (const other of this.#carriers) if (other !== carrier) { other.members.delete(this); this.#registry.idle(other) }
    this.#carriers.clear()
    if (!wasOpen) this.onerror?.call(this, { type: 'error' } as Event)
    this.onclose?.call(this, closeEvent(1006, reason, false))
  }

  /** @internal */
  deliver(data: string): void {
    if (this.readyState === 1) this.onmessage?.call(this, { type: 'message', data } as MessageEvent)
  }

  /** @internal A subscription ended, by the relay or by this lane. */
  forget(carrier: Carrier, wire: string, id: string): void {
    carrier.subscriptions.delete(wire)
    if (this.#ids.get(id)?.wire === wire) this.#ids.delete(id)
    // Keep the home carrier for publishing; let go of an overflow one.
    if (carrier !== this.#home && ![...this.#ids.values()].some(place => place.carrier === carrier)) {
      this.#carriers.delete(carrier)
      carrier.members.delete(this)
      this.#registry.idle(carrier)
    }
  }

  /** End every subscription this lane holds, except on `lost`, which has
   *  already gone. */
  #release(lost?: Carrier): void {
    for (const place of this.#ids.values()) {
      if (place.carrier === lost) continue
      place.carrier.subscriptions.delete(place.wire)
      if (place.kind !== 'count') place.carrier.write(JSON.stringify([place.kind === 'negentropy' ? 'NEG-CLOSE' : 'CLOSE', place.wire]))
    }
    this.#ids.clear()
  }

  #join(carrier: Carrier): void {
    clearTimeout(carrier.linger)
    carrier.members.add(this)
    this.#carriers.add(carrier)
  }
}

function closeEvent(code: number, reason: string, wasClean: boolean): CloseEvent {
  return { type: 'close', code, reason, wasClean, message: reason } as unknown as CloseEvent
}
