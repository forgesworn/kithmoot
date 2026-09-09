/**
 * Quiet rooms: chat that a relay cannot see being said.
 *
 * A room's chat is already encrypted to the room key, but every message is
 * a kind 1460 with the channel's `d` tag, signed by a device key, stamped
 * when it was sent. A relay holding the room's events knows the room
 * exists, how busy it is, when each device speaks and how many of them
 * there are. A quiet room hands its chat to `nostr-deaddrop` instead: each
 * message rides inside a kind 1059 gift wrap addressed to a key derived
 * from the epoch key, the member and a counter, posted on a fixed cadence
 * with fillers when nobody has anything to say, and read back by pulling
 * the whole 1059 stream. What the relay then holds is one wrap per slot
 * per device, each to a key it never sees again, in a stream shared with
 * every other gift wrap on Nostr.
 *
 * The switch is `RoomPolicy.quiet`, and it rides the link with `members`
 * so that everyone in the room derives the same keys and agrees on how the
 * room talks: a member that joined from the link cannot be in the open
 * while the rest are in drops. Live traffic (roster, signalling, pairing,
 * epochs) stays in the open, because a slot of delay would end a call;
 * what quiet hides is what was said, by whom, and when. Being in the room
 * still shows while you are in it.
 *
 * Two devices of one participant draw from disjoint halves of the
 * member's counter space, so no drop key is ever used twice: the device
 * holding the identity takes the first half, the device it paired the
 * second. A third device reads and cannot post. A counter seen on the wire
 * for this member is spent for this device as well, so two devices that
 * hold the identity outside pairing repeat a key only inside the relay's
 * propagation delay; that is the backstop, the halves are the rule.
 */
import { QuietTransport, RumorTooLarge, MAX_PER_EPOCH_ROOM, DEFAULT_LOOKBACK_SECONDS, type UsedCounters } from 'nostr-deaddrop'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { KINDS } from './kinds.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { RelayConfig, RelayTransport } from './relay-pool.js'
import type { RoomPolicy } from './types.js'

/** Seconds between slots. Every slot posts one wrap, a message or a filler,
 *  so this is both how long a message waits and how often a device speaks
 *  to the relay whether or not it has anything to say. */
export const QUIET_SLOT_SECONDS = 300
/** The kinds that ride in drops. Chat, and everything that rides chat: named
 *  channels, assignments, reactions, read positions carried as messages. */
export const QUIET_KINDS: readonly number[] = [KINDS.CHAT]
/** How many of one participant's devices may post: the identity's device and
 *  the one it paired. Each takes half the member's keys per epoch. */
export const QUIET_DEVICE_SLOTS = 2
/** How far back a quiet room's history reaches from a relay: the drop
 *  keys are derived this far back, so nothing older can be matched. Older
 *  history lives on the devices that were there for it. */
export const QUIET_HISTORY_SECONDS = DEFAULT_LOOKBACK_SECONDS
/** Every drop in a quiet room is padded to this many bytes of plaintext
 *  before it is wrapped, whatever the message says. One size for every
 *  message, because a size that varied with the text would say how long
 *  the text was. A chat event carries its device credential, so it starts
 *  at about 1.7 KB; this leaves room for the text a message may carry.
 *  The wrap comes out at about 5.6 KB, larger than most gift wraps on a
 *  public relay and the same as every other wrap in the room. */
export const QUIET_BUCKET_BYTES = 4096
/** The reason a message that does not fit the bucket is refused. */
export const QUIET_TOO_LONG = 'This message is too long for a quiet room. Every message in a quiet room is padded to one size, and this one does not fit. Shorten it, or send it in parts.'
/** The reason a device that cannot post is given. */
export const QUIET_CANNOT_SEND = 'This device cannot post in a quiet room. Two devices per person can: the one holding your identity and the one it paired. Others read.'
const REKEYED = 'This conversation has closed or changed its key. Copy your message into the current conversation to send it.'

export function isQuietPolicy(policy: RoomPolicy | undefined): boolean {
  return policy?.quiet === true && Array.isArray(policy.members) && policy.members.length > 0
}

/** The part of the member's counter space one device draws from, or
 *  undefined for a device that gets none. Slot 0 is the device holding the
 *  identity, slot 1 the device it paired. */
export function quietCounterRange(slot: number): [number, number] | undefined {
  if (!Number.isInteger(slot) || slot < 0 || slot >= QUIET_DEVICE_SLOTS) return undefined
  const width = MAX_PER_EPOCH_ROOM / QUIET_DEVICE_SLOTS
  return [slot * width, (slot + 1) * width]
}

export type QuietUsedState = Record<string, UsedCounters>

export interface QuietRoomOptions {
  /** The room's policy: must be quiet, and lists the members whose keys are derived. */
  policy: RoomPolicy
  /** This participant, as the room knows it. Sends go on its keys when it is a member. */
  participant: string
  /** Which of the participant's devices this is. See `quietCounterRange`. */
  slot: number
  /** Called with the counters used so far whenever one is spent, to persist
   *  across a reload. Hand it back as `used` next time. */
  onUsed?: (state: QuietUsedState) => void
  /** What `onUsed` gave last time, restored before the first send. */
  used?: QuietUsedState
  /** Called when a queued event is posted, or when a slot posts a filler
   *  (`undefined`), so a caller can persist what is still waiting. */
  onPosted?: (inner: Event | undefined) => void
  /** A slot's publish failed (the same wrap is retried next tick) or a queued event could not be wrapped (it was dropped). */
  onError?: (error: unknown) => void
  intervalSeconds?: number
  lookbackSeconds?: number
  pageSize?: number
  maxPages?: number
  now?: () => number
  /** Override the timer (tests). */
  schedule?: (tick: () => void, everyMs: number) => () => void
  /** Where inside each slot this device posts (tests pass `() => 0`). */
  slotOffset?: (slot: number) => number
}

export interface QuietRoomTransport extends RelayTransport {
  readonly quiet: true
  /** Whether this device may post. False for a non-member and for a third device. */
  readonly canSend: boolean
  /** Events queued and not yet posted, oldest first. Persist them: a reload
   *  loses the queue, and the person believes those were sent. */
  queued(): Event[]
  /** How many are waiting. */
  readonly pending: number
  rekey(key: Uint8Array): void
  exportUsed(): QuietUsedState
  /** Post whatever the current slot owes, if its moment has come. Driven by the timer; exposed for tests. */
  tick(): Promise<void>
}

/**
 * Wrap a relay transport so the quiet kinds ride in drops. `publish` of a
 * quiet kind resolves when the relay has taken the drop, which is up to a
 * slot later, so a sender's outbox is honest about what has left the
 * device; it rejects if the room moves to a new key first, since the event
 * was encrypted for the old one, and the caller re-sends under the new.
 * Everything else goes straight through.
 */
export function quietRoomTransport(inner: RelayTransport, opts: QuietRoomOptions): QuietRoomTransport {
  if (!isQuietPolicy(opts.policy)) throw new Error('not a quiet room: the policy needs quiet and a members list')
  const participant = normaliseHex(opts.participant)
  const members = opts.policy.members!.map(normaliseHex)
  const range = quietCounterRange(opts.slot)
  const canSend = range !== undefined && members.some((m) => hexEquals(m, participant))
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const waiting = new Map<string, { event: Event; resolve: () => void; reject: (e: Error) => void }>()
  const order: string[] = []
  let closed = false

  const quiet = new QuietTransport(inner, {
    // Corrected by the session through `rekey` before anything moves.
    roomKey: new Uint8Array(32),
    member: participant,
    members,
    kinds: [...QUIET_KINDS],
    bucket: QUIET_BUCKET_BYTES,
    intervalSeconds: opts.intervalSeconds ?? QUIET_SLOT_SECONDS,
    lookbackSeconds: opts.lookbackSeconds ?? QUIET_HISTORY_SECONDS,
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
    ...(range ? { counterRange: range } : {}),
    now,
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
    ...(opts.slotOffset ? { slotOffset: opts.slotOffset } : {}),
    onError: (e) => opts.onError?.(e),
    onPosted: ({ inner: posted }) => {
      if (posted) {
        settle(posted.id, undefined)
        opts.onUsed?.(quiet.exportUsed())
      }
      opts.onPosted?.(posted)
    },
  })

  function settle(id: string, error: Error | undefined): void {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    const i = order.indexOf(id)
    if (i >= 0) order.splice(i, 1)
    if (error) w.reject(error)
    else w.resolve()
  }

  let keyed = false
  const transport: QuietRoomTransport = {
    quiet: true,
    canSend,
    get pending() { return waiting.size },
    queued: () => order.map((id) => waiting.get(id)!.event),
    rekey(key) {
      quiet.rekey(key)
      if (keyed) {
        // Whatever waited was written for the key just left.
        for (const id of [...order]) { quiet.drop(id); settle(id, new Error(REKEYED)) }
      } else {
        keyed = true
        if (opts.used) quiet.importUsed(opts.used)
      }
    },
    async publish(event) {
      if (!QUIET_KINDS.includes(event.kind)) return inner.publish(event)
      if (closed) throw new Error('this conversation has closed')
      if (!canSend) throw new Error(QUIET_CANNOT_SEND)
      if (!keyed) throw new Error('quiet transport has no key yet')
      // A retry of an event still waiting is the same wait, not a second drop.
      const already = waiting.get(event.id)
      if (already) return new Promise<void>((resolve, reject) => { const r = already.resolve, j = already.reject; already.resolve = () => { r(); resolve() }; already.reject = (e) => { j(e); reject(e) } })
      return new Promise<void>((resolve, reject) => {
        waiting.set(event.id, { event, resolve, reject })
        order.push(event.id)
        quiet.publish(event).catch((e: unknown) => settle(event.id, e instanceof RumorTooLarge ? new Error(QUIET_TOO_LONG) : e instanceof Error ? e : new Error(String(e))))
      })
    },
    subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void) {
      return quiet.subscribe(filters, onEvent, onEose)
    },
    describe(): RelayConfig[] {
      return inner.describe?.() ?? []
    },
    exportUsed: () => quiet.exportUsed(),
    tick: () => quiet.tick(),
    close() {
      closed = true
      for (const id of [...order]) settle(id, new Error('this conversation has closed'))
      quiet.close()
    },
  }
  return transport
}
