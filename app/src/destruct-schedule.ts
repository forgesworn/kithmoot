/**
 * When a self-destructing room's tidy-up may be tried again after it failed.
 *
 * The rooms list redraws every 5 s and starts every due tidy-up it finds. A
 * tidy-up that cannot finish (a relay that will not answer, or refuses) left
 * the room due, so it started again 5 s later: history reads to every room
 * relay and a deletion request per message, over and over, until something
 * changed. Relays count that against this address.
 *
 * Now a room whose tidy-up failed waits 1 minute, then 2, 4 and so on
 * (doubling to at most 6 hours), and after `DESTRUCT_AUTO_ATTEMPTS` failures
 * is not tried by itself again in this page: opening the room, or reloading,
 * tries again. Held in memory only, so a reload is a fresh start.
 */
import { doublingBackoff } from '../../src/relay-dial-gate.js'

export const DESTRUCT_RETRY_MS = 60_000
export const DESTRUCT_RETRY_MAX_MS = 6 * 60 * 60_000
export const DESTRUCT_AUTO_ATTEMPTS = 8

export class DestructSchedule {
  readonly #rooms = new Map<string, { failures: number; nextAt: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Whether a tidy-up of `roomId` may start by itself now. */
  ready(roomId: string): boolean {
    const room = this.#rooms.get(roomId)
    return !room || (room.failures < DESTRUCT_AUTO_ATTEMPTS && this.now() >= room.nextAt)
  }

  /** Whether `roomId` has failed so often that only the person can start it. */
  manualOnly(roomId: string): boolean {
    return (this.#rooms.get(roomId)?.failures ?? 0) >= DESTRUCT_AUTO_ATTEMPTS
  }

  /** When the next automatic try of `roomId` is due; 0 when it is due now. */
  nextAt(roomId: string): number { return this.#rooms.get(roomId)?.nextAt ?? 0 }

  failed(roomId: string): void {
    const failures = (this.#rooms.get(roomId)?.failures ?? 0) + 1
    this.#rooms.set(roomId, { failures, nextAt: this.now() + doublingBackoff(failures, DESTRUCT_RETRY_MS, DESTRUCT_RETRY_MAX_MS) })
  }

  /** It finished, or the person asked for it again: start from nothing. */
  reset(roomId: string): void { this.#rooms.delete(roomId) }
}
