/**
 * Read positions, kept the same on every device that holds the identity.
 *
 * One record per room, signed by the participant key and encrypted to it,
 * the way bookmarks are kept - see `src/read-position.ts` and
 * `docs/messages.md`. This class follows the records for the rooms this
 * device knows, merges what arrives with what the device already knew,
 * and publishes when the device is ahead. It never publishes from a
 * device that is behind, so two devices converge on the furthest position
 * rather than fighting over the newest event.
 */
import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import {
  decodeReadPositions,
  encodeReadPositions,
  mergeReadPositions,
  readPositionId,
  READ_POSITION_KIND,
  READ_POSITION_LABEL,
  type ReadPositions,
  type SelfCrypt,
} from '../../src/read-position.js'

/**
 * When a device says where it has read to: at a random point in this window
 * after the first read that moved it on, however many reads follow inside it.
 *
 * It was four seconds after every message read while the room was on
 * screen. The record is signed by the account and its `d` tag is one every
 * member can derive (see `readPositionId`), so anybody in the room could
 * subscribe to it and watch, to within a few seconds, when this person read
 * each message - a read receipt nobody had agreed to send. A long, random
 * window still keeps devices in step for the purpose it exists for, picking
 * up on the phone where the laptop left off, and says nothing about which
 * message was read when.
 */
export const PUBLISH_WINDOW_MS: readonly [number, number] = [30_000, 90_000]

/**
 * The window instead, once the person leaves the room or hides the tab: the
 * moment another device is most likely to be picked up next. Random, and
 * not at once, so it is not a signal of the leaving itself.
 */
export const HURRY_WINDOW_MS: readonly [number, number] = [2_000, 10_000]

export interface ReadPositionTiming {
  random?: () => number
  setTimer?: (ms: number, run: () => void) => unknown
  clearTimer?: (handle: unknown) => void
  nowMs?: () => number
  /** Whether this device shares its read positions at all. Read on every
   *  schedule, so turning it off stops what is pending. Defaults to on. */
  sharing?: () => boolean
}

interface Followed {
  roomKey: Uint8Array
  /** A conference room's end: each record published lapses with the room. */
  expiresAt?: number
  positions: ReadPositions
  off: () => void
  timer?: unknown
  /** When the pending publish is due, on `nowMs`. */
  dueAt?: number
  /** Ahead of anything this device has published, and not yet published. */
  dirty: boolean
  busy: boolean
  again: boolean
  /** The room is gone from this browser: a record already being signed must
   *  not reach a relay. Leaving, forgetting or tidying a room up all delete
   *  what is on the relays, and a marker that lands after the deletion is
   *  newer than it, so NIP-09 does not reach it. */
  dropped: boolean
  /** `created_at` of the last record this device published, so a relay
   *  replaying something older does not provoke the same record again. */
  publishedAt?: number
}

export class ReadPositionSync {
  readonly #rooms = new Map<string, Followed>()
  /** Publishes this sync started that have not finished. `settle()` waits
   *  for them, so a caller that is about to delete these records knows
   *  nothing of its own is still on the way. */
  readonly #inFlight = new Set<Promise<void>>()
  #closed = false

  constructor(
    private readonly identity: ParticipantIdentity,
    private readonly crypt: SelfCrypt,
    private readonly relay: RelayTransport,
    /** The record moved this device on: apply it locally. */
    private readonly onRemoteAhead: (roomId: string, positions: ReadPositions) => void,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    timing: ReadPositionTiming = {},
  ) {
    this.#random = timing.random ?? Math.random
    this.#setTimer = timing.setTimer ?? ((ms, run) => setTimeout(run, ms))
    this.#clearTimer = timing.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#nowMs = timing.nowMs ?? (() => Date.now())
    this.#sharing = timing.sharing ?? (() => true)
  }

  readonly #random: () => number
  readonly #setTimer: (ms: number, run: () => void) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #nowMs: () => number
  readonly #sharing: () => boolean

  /** Follow one room's record, starting from what this device knows. */
  follow(roomId: string, roomKey: Uint8Array, local: ReadPositions, expiresAt?: number): void {
    if (this.#closed || this.#rooms.has(roomId)) return
    const followed: Followed = { roomKey, positions: { ...local }, off: () => {}, dirty: false, busy: false, again: false, dropped: false, ...(expiresAt !== undefined ? { expiresAt } : {}) }
    this.#rooms.set(roomId, followed)
    followed.off = this.relay.subscribe(
      [{ kinds: [READ_POSITION_KIND], authors: [this.identity.pubkey], '#d': [readPositionId(roomKey)], '#l': [READ_POSITION_LABEL] }],
      (event) => { void this.#receive(roomId, event) },
    )
  }

  /** This device read to here. Merged, and published if it is ahead. */
  note(roomId: string, positions: ReadPositions): void {
    const followed = this.#rooms.get(roomId)
    if (!followed || this.#closed) return
    const { merged, localAhead } = mergeReadPositions(positions, followed.positions)
    if (!localAhead) return
    followed.positions = merged
    followed.dirty = true
    this.#schedule(roomId, followed)
  }

  /** What this device holds for a room, merged from every source. */
  positions(roomId: string): ReadPositions | undefined {
    return this.#rooms.get(roomId)?.positions
  }

  /** Stop following a room. Nothing more is published for it, including a
   *  record that was already being signed when this was called. */
  forget(roomId: string): void {
    const followed = this.#rooms.get(roomId)
    if (!followed) return
    followed.dropped = true
    followed.again = false
    followed.off()
    this.#cancel(followed)
    this.#rooms.delete(roomId)
  }

  /**
   * The person left the room or hid the tab: whatever is still to be said
   * goes out sooner, at a random point in `HURRY_WINDOW_MS`, for one room or
   * every room. Never later than it was already due.
   */
  hurry(roomId?: string): void {
    if (this.#closed) return
    const rooms = roomId === undefined ? [...this.#rooms] : [[roomId, this.#rooms.get(roomId)] as const]
    for (const [id, followed] of rooms) {
      if (!followed || !followed.dirty) continue
      this.#schedule(id, followed, HURRY_WINDOW_MS)
    }
  }

  /**
   * The sharing switch moved. Off cancels anything pending - positions keep
   * merging locally, and records from other devices are still applied here -
   * and on schedules whatever this device learned meanwhile.
   */
  sharingChanged(): void {
    if (this.#closed) return
    for (const [id, followed] of this.#rooms) {
      if (!this.#sharing()) this.#cancel(followed)
      else if (followed.dirty) this.#schedule(id, followed)
    }
  }

  close(): void {
    this.#closed = true
    for (const roomId of [...this.#rooms.keys()]) this.forget(roomId)
  }

  /** Resolves when nothing this sync started is still on its way to a relay.
   *  Call it after `forget` or `close` before deleting these records: a
   *  publish that was already sent has to be counted, not raced.
   *
   *  The wait is bounded, because a publish keeps retrying an unreachable
   *  relay for twenty seconds and a tab that is leaving cannot hold a
   *  tidy-up up for that long. A record that never reaches a relay is not
   *  on one to be deleted; one that lands late is caught by the tidy-up
   *  asking the relays again after its request. */
  async settle(waitMs = 2_000): Promise<void> {
    if (this.#inFlight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), waitMs) })
    try {
      while (this.#inFlight.size > 0) {
        if (await Promise.race([Promise.allSettled([...this.#inFlight]).then(() => 'done' as const), late]) === 'late') return
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async #receive(roomId: string, event: Event): Promise<void> {
    const followed = this.#rooms.get(roomId)
    if (!followed || this.#closed) return
    const record = await decodeReadPositions(event, { participant: this.identity.pubkey, roomId, roomKey: followed.roomKey, crypt: this.crypt })
    if (!record || !this.#rooms.has(roomId)) return
    const { merged, localAhead, remoteAhead } = mergeReadPositions(followed.positions, record.read)
    followed.positions = merged
    if (remoteAhead) this.onRemoteAhead(roomId, merged)
    // Ahead of a record older than our own last one is not news to anybody:
    // what we published already replaced it.
    if (localAhead && (followed.publishedAt === undefined || event.created_at > followed.publishedAt)) {
      followed.dirty = true
      this.#schedule(roomId, followed)
    }
  }

  #cancel(followed: Followed): void {
    if (followed.timer !== undefined) this.#clearTimer(followed.timer)
    followed.timer = undefined
    followed.dueAt = undefined
  }

  /** Arm a publish at a random point in `window`, unless one is already due
   *  sooner: reads inside a window coalesce into the one record. */
  #schedule(roomId: string, followed: Followed, window: readonly [number, number] = PUBLISH_WINDOW_MS): void {
    if (followed.dropped || this.#closed || !this.#sharing()) return
    const [low, high] = window
    const delay = low + Math.floor(this.#random() * (high - low + 1))
    const dueAt = this.#nowMs() + delay
    if (followed.timer !== undefined && followed.dueAt !== undefined && followed.dueAt <= dueAt) return
    this.#cancel(followed)
    followed.dueAt = dueAt
    followed.timer = this.#setTimer(delay, () => {
      followed.timer = undefined
      followed.dueAt = undefined
      if (!this.#sharing()) return
      const publishing = this.#publish(roomId, followed)
      this.#inFlight.add(publishing)
      void publishing.finally(() => this.#inFlight.delete(publishing))
    })
  }

  async #publish(roomId: string, followed: Followed): Promise<void> {
    if (this.#closed || followed.dropped) return
    if (followed.busy) { followed.again = true; return }
    followed.busy = true
    try {
      const event = await encodeReadPositions(followed.positions, {
        roomId,
        roomKey: followed.roomKey,
        identity: this.identity,
        crypt: this.crypt,
        createdAt: this.now(),
        expiresAt: followed.expiresAt,
      })
      // Signing can take as long as the signer wants. The room may have been
      // left, forgotten or tidied up in the meantime, and a marker published
      // now would outlive the deletion that was meant to cover it.
      if (this.#closed || followed.dropped) return
      // Still owed something only if a read landed while this was on its
      // way: that read is ahead of this record and has scheduled the next.
      const published = followed.positions
      await this.relay.publish(event)
      followed.publishedAt = event.created_at
      if (followed.positions === published) followed.dirty = false
    } catch {
      // A signer that declined, or relays that are away: the local position
      // stands and the next read tries again.
    } finally {
      followed.busy = false
      if (followed.again && !followed.dropped) {
        followed.again = false
        this.#schedule(roomId, followed)
      }
    }
  }
}
