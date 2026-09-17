import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayTransport } from '../src/relay-pool.js'

/**
 * The unit-level sibling of `test/fault-relay.mjs`.
 *
 * That file is a real NIP-01 relay on a real socket, driven over HTTP by a
 * Playwright spec while three browsers are in a call. This one is the same
 * faults with none of the machinery: in process, synchronous, seeded, and
 * with a clock a test turns by hand, so a signalling bug can be pinned in
 * milliseconds instead of minutes. It deliberately does not reimplement the
 * relay - no signature checks, no storage, no OK frames - because what a unit
 * test needs from a relay is only which event reached whom, when, and how
 * many times.
 *
 * Faults are chosen by what a relay can actually see, exactly as the real one
 * does it: the kind, the `p` tag naming the recipient device, and which
 * transport published the event, which names the sender because a device only
 * ever publishes down its own socket.
 */

/** Which events a rule applies to. An absent field matches everything. */
export interface FaultMatch {
  /** The publishing device, i.e. which transport called `publish`. */
  from?: string
  /** The `p` tag on the event. */
  to?: string
  kind?: number
}

export interface FaultEffect {
  /** Probability, 0..1, that a matching event is dropped. `1` is a window. */
  drop?: number
  /** Drop exactly this many matching events, then stop. Applied before
   *  `drop`, and counted down as it fires. */
  dropNext?: number
  /** Hold a matching event for this many milliseconds of the hub's clock.
   *  Nothing is delivered until a test calls `advance()` or `flush()`. */
  delayMs?: number
  /** Probability that a matching event is delivered twice. */
  duplicate?: number
  /** Probability that a matching event is held back until the next event on
   *  the same directed pair overtakes it. */
  reorder?: number
}

export interface FaultRule extends FaultMatch, FaultEffect {}

export type FaultVerdict = 'delivered' | 'dropped' | 'delayed' | 'duplicated' | 'reordered' | 'disconnected'

export interface FaultLogEntry {
  at: number
  from: string
  to?: string
  kind: number
  id: string
  verdict: FaultVerdict
}

/** Deterministic, seeded, and cheap. The point is that a failing run is a
 *  failing run for ever, not a flake somebody re-runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    const values = event.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!(wanted as string[]).some((w) => values.includes(w))) return false
  }
  return true
}

function recipientOf(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === 'p')?.[1]
}

interface Subscription {
  device: string
  filters: Filter[]
  onEvent: (event: Event, via?: string) => void
}

/** How a transport is unplugged. */
export type DisconnectMode =
  /** The socket is still open as far as the client can tell: publishes
   *  resolve and go nowhere, nothing is delivered, nothing closes. This is
   *  the 44-second case from the spec. */
  | 'half-open'
  /** Publishes reject, which is what a relay that answers with an error
   *  looks like. Deliveries still stop. */
  | 'error'

/**
 * The hub. One per test; a transport per device.
 */
export class FaultRelay {
  readonly log: FaultLogEntry[] = []
  /** The hub's clock, in milliseconds. Only `advance()` moves it. */
  now = 0
  readonly #rules: FaultRule[] = []
  readonly #random: () => number
  readonly #subs = new Set<Subscription>()
  readonly #transports = new Map<string, FaultTransport>()
  /** Directed pair -> the event being held back for a reorder. */
  readonly #held = new Map<string, Event>()
  #queue: { at: number; seq: number; event: Event; from: string }[] = []
  #seq = 0

  constructor(opts: { seed?: number } = {}) {
    this.#random = mulberry32(opts.seed ?? 0x5eed)
  }

  /** A transport for one device. Calling twice returns the same one, so a
   *  test can reach the transport a session is using. */
  transport(device: string, relay = 'wss://fault.test'): FaultTransport {
    let transport = this.#transports.get(device)
    if (!transport) {
      transport = new FaultTransport(this, device, relay)
      this.#transports.set(device, transport)
    }
    return transport
  }

  /** Add a rule. The returned function removes it again. */
  fault(rule: FaultRule): () => void {
    this.#rules.push(rule)
    return () => {
      const index = this.#rules.indexOf(rule)
      if (index >= 0) this.#rules.splice(index, 1)
    }
  }

  clearFaults(): void {
    this.#rules.length = 0
    this.#held.clear()
  }

  /** Move the clock and deliver everything that has come due. */
  advance(ms: number): void {
    this.now += ms
    const due = this.#queue.filter((entry) => entry.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq)
    this.#queue = this.#queue.filter((entry) => entry.at > this.now)
    for (const entry of due) this.#deliver(entry.event, entry.from)
  }

  /** Deliver everything still in flight, whatever the clock says. */
  flush(): void {
    const due = this.#queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
    this.#queue = []
    for (const entry of due) this.#deliver(entry.event, entry.from)
    // A reorder with nothing behind it would otherwise never arrive.
    for (const [key, event] of [...this.#held]) {
      this.#held.delete(key)
      this.#deliver(event, key.split('->')[0]!)
    }
  }

  /** How many events are waiting on the clock. */
  get inFlight(): number {
    return this.#queue.length + this.#held.size
  }

  // -------------------------------------------------------------- internals

  /** @internal */
  _publish(from: string, event: Event): void {
    const to = recipientOf(event)
    const effect = this.#effectFor({ from, to, kind: event.kind })
    const record = (verdict: FaultVerdict) => {
      this.log.push({ at: this.now, from, to, kind: event.kind, id: event.id, verdict })
    }

    if (effect.dropNextRule && effect.dropNextRule.dropNext! > 0) {
      effect.dropNextRule.dropNext! -= 1
      record('dropped')
      return
    }
    if (effect.drop > 0 && this.#random() < effect.drop) {
      record('dropped')
      return
    }

    const pair = `${from}->${to ?? '*'}`
    let overtaking: Event | undefined
    if (effect.reorder > 0 && !this.#held.has(pair) && this.#random() < effect.reorder) {
      this.#held.set(pair, event)
      record('reordered')
      return
    }
    if (this.#held.has(pair)) {
      overtaking = this.#held.get(pair)
      this.#held.delete(pair)
    }

    const copies = effect.duplicate > 0 && this.#random() < effect.duplicate ? 2 : 1
    record(copies === 2 ? 'duplicated' : effect.delayMs > 0 ? 'delayed' : 'delivered')

    for (let i = 0; i < copies; i++) {
      if (effect.delayMs > 0) this.#queue.push({ at: this.now + effect.delayMs, seq: this.#seq++, event, from })
      else this.#deliver(event, from)
    }
    // The held event arrives behind the one that overtook it.
    if (overtaking) {
      if (effect.delayMs > 0) this.#queue.push({ at: this.now + effect.delayMs, seq: this.#seq++, event: overtaking, from })
      else this.#deliver(overtaking, from)
    }
  }

  #effectFor(match: FaultMatch): { drop: number; delayMs: number; duplicate: number; reorder: number; dropNextRule?: FaultRule } {
    const out = { drop: 0, delayMs: 0, duplicate: 0, reorder: 0 } as {
      drop: number
      delayMs: number
      duplicate: number
      reorder: number
      dropNextRule?: FaultRule
    }
    for (const rule of this.#rules) {
      if (rule.from !== undefined && rule.from !== match.from) continue
      if (rule.to !== undefined && rule.to !== match.to) continue
      if (rule.kind !== undefined && rule.kind !== match.kind) continue
      if (rule.dropNext !== undefined && rule.dropNext > 0 && !out.dropNextRule) out.dropNextRule = rule
      out.drop = Math.max(out.drop, rule.drop ?? 0)
      out.delayMs = Math.max(out.delayMs, rule.delayMs ?? 0)
      out.duplicate = Math.max(out.duplicate, rule.duplicate ?? 0)
      out.reorder = Math.max(out.reorder, rule.reorder ?? 0)
    }
    return out
  }

  #deliver(event: Event, from: string): void {
    for (const sub of [...this.#subs]) {
      const transport = this.#transports.get(sub.device)
      if (transport?.connected === false) {
        this.log.push({ at: this.now, from, to: recipientOf(event), kind: event.kind, id: event.id, verdict: 'disconnected' })
        continue
      }
      if (!sub.filters.some((filter) => matches(event, filter))) continue
      transport?.received.push(event)
      sub.onEvent(event, transport?.relay)
    }
  }

  /** @internal */
  _subscribe(sub: Subscription): () => void {
    this.#subs.add(sub)
    return () => this.#subs.delete(sub)
  }
}

/** One device's socket into the hub. */
export class FaultTransport implements RelayTransport {
  /** Everything this transport actually handed to the hub, dropped or not. */
  readonly published: Event[] = []
  /** Everything delivered to this transport's subscriptions. */
  readonly received: Event[] = []
  connected = true
  #mode: DisconnectMode = 'half-open'
  #closed = false

  constructor(readonly hub: FaultRelay, readonly device: string, readonly relay: string) {}

  async publish(event: Event): Promise<void> {
    if (this.#closed) throw new Error('transport is closed')
    if (!this.connected) {
      // Half-open: the write goes into a socket nobody is reading and the
      // client is told nothing. This is the hole a reliable channel has to
      // flush out of on reconnect.
      if (this.#mode === 'error') throw new Error('relay is unreachable')
      this.hub.log.push({ at: this.hub.now, from: this.device, to: undefined, kind: event.kind, id: event.id, verdict: 'disconnected' })
      return
    }
    this.published.push(event)
    this.hub._publish(this.device, event)
  }

  subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void): () => void {
    if (this.#closed) throw new Error('transport is closed')
    const off = this.hub._subscribe({ device: this.device, filters, onEvent })
    if (this.connected) onEose?.()
    return off
  }

  /** Unplug without closing: subscriptions stay registered and come back
   *  when `reconnect()` is called, with nothing replayed - a real relay does
   *  not re-send an ephemeral kind either. */
  disconnect(mode: DisconnectMode = 'half-open'): void {
    this.connected = false
    this.#mode = mode
  }

  reconnect(): void {
    this.connected = true
  }

  close(): void {
    this.#closed = true
    this.connected = false
  }

  describe(): { url: string; read: boolean; write: boolean }[] {
    return [{ url: this.relay, read: true, write: true }]
  }
}
