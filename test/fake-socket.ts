import { matchFilters } from 'nostr-tools/filter'
import { normalizeURL } from 'nostr-tools/utils'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'

/**
 * An in-process NIP-01 relay behind a fake websocket, so `NostrRelayPool` can
 * be tested against the real `nostr-tools` client code with no network.
 *
 * `SimRelay` deliberately does not do this: it stands in for the transport
 * seam, so a session can be exercised without one. This stands in for a relay
 * *socket*, which is the only way to reach the pool's own behaviour - the
 * publish-everywhere rule, the hear-each-event-once rule, and the
 * `subscribeMap` fan-out that gives a multi-filter subscribe its NIP-01 OR
 * semantics.
 */
export class FakeRelayServer {
  /** Every raw frame this relay was sent, in order. */
  readonly frames: string[] = []
  /** Every event this relay holds. */
  readonly stored: Event[] = []
  /** Refuse every publish with `OK false`, the way a full or hostile relay does. */
  rejectPublishes = false

  readonly #subscriptions = new Map<string, { socket: FakeWebSocket; subId: string; filters: Filter[] }>()

  constructor(readonly url: string) {}

  /** The filter sets this relay has been asked to subscribe with, in order. */
  requestedFilters(): Filter[][] {
    return this.frames
      .map((f) => JSON.parse(f) as unknown[])
      .filter((m) => m[0] === 'REQ')
      .map((m) => m.slice(2) as Filter[])
  }

  /** Subscription ids this relay has been asked to close. */
  closedSubscriptions(): string[] {
    return this.frames
      .map((f) => JSON.parse(f) as unknown[])
      .filter((m) => m[0] === 'CLOSE')
      .map((m) => m[1] as string)
  }

  /** Put an event on this relay without anybody publishing it - the way a
   *  second relay ends up holding the same event as the first. */
  seed(event: Event): void {
    this.stored.push(event)
  }

  detach(socket: FakeWebSocket): void {
    for (const [key, sub] of this.#subscriptions) {
      if (sub.socket === socket) this.#subscriptions.delete(key)
    }
  }

  receive(socket: FakeWebSocket, frame: string): void {
    this.frames.push(frame)
    const message = JSON.parse(frame) as [string, ...unknown[]]

    if (message[0] === 'EVENT') {
      const event = message[1] as Event
      if (this.rejectPublishes) {
        socket.deliver(JSON.stringify(['OK', event.id, false, 'blocked: this relay refuses everything']))
        return
      }
      this.stored.push(event)
      socket.deliver(JSON.stringify(['OK', event.id, true, '']))
      for (const sub of this.#subscriptions.values()) {
        if (matchFilters(sub.filters, event)) sub.socket.deliver(JSON.stringify(['EVENT', sub.subId, event]))
      }
      return
    }

    if (message[0] === 'REQ') {
      const subId = message[1] as string
      const filters = message.slice(2) as Filter[]
      this.#subscriptions.set(this.#key(socket, subId), { socket, subId, filters })
      for (const event of this.stored) {
        if (matchFilters(filters, event)) socket.deliver(JSON.stringify(['EVENT', subId, event]))
      }
      socket.deliver(JSON.stringify(['EOSE', subId]))
      return
    }

    if (message[0] === 'CLOSE') {
      this.#subscriptions.delete(this.#key(socket, message[1] as string))
    }
  }

  #key(socket: FakeWebSocket, subId: string): string {
    return `${socket.id} ${subId}`
  }
}

const servers = new Map<string, FakeRelayServer>()
let nextSocketId = 0

/** Register a relay at `url`. The pool normalises urls, so this does too. */
export function fakeRelay(url: string): FakeRelayServer {
  const normalised = normalizeURL(url)
  const server = new FakeRelayServer(normalised)
  servers.set(normalised, server)
  return server
}

/** Forget every registered relay, so one test's relays are not another's. */
export function resetFakeRelays(): void {
  servers.clear()
}

/**
 * The websocket `nostr-tools` gets when `useWebSocketImplementation` is
 * pointed at it. A url with no registered relay behaves like a host that is
 * simply not there.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly id = ++nextSocketId
  readyState: number = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onclose: ((event: { message?: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  readonly #server: FakeRelayServer | undefined

  constructor(readonly url: string) {
    this.#server = servers.get(normalizeURL(url))
    queueMicrotask(() => {
      if (!this.#server) {
        this.readyState = FakeWebSocket.CLOSED
        this.onerror?.()
        return
      }
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(frame: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) return
    this.#server?.receive(this, frame)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.#server?.detach(this)
    this.onclose?.({ message: 'closed' })
  }

  /** Relay to client. */
  deliver(frame: string): void {
    this.onmessage?.({ data: frame })
  }
}
