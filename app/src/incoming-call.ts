export interface IncomingCall {
  id: string
  caller: string
}

export type IncomingCallChange =
  | { type: 'ring'; call: IncomingCall }
  | { type: 'stop' }
  /** A new call that would have rung, kept quiet because this device was
   *  on a call in this room moments ago. Said, not swallowed, so it can be
   *  written down - see `QUIET_AFTER_CALL_MS`. */
  | { type: 'quiet'; call: IncomingCall }

/**
 * How long after this device was last on a call in the room a new call
 * there does not ring.
 *
 * A call nobody started is the one ring worse than none. When a call
 * breaks up, a device still running an older build - or one whose relays
 * are a beat behind and so cannot see the call it was on - could declare a
 * fresh call on its own, and every phone in the room rang with its owner's
 * name while nobody was calling. A minute covers that tail. A call somebody
 * really does start straight after still shows in the room; it just does
 * not ring the people who have only just put the last one down.
 */
export const QUIET_AFTER_CALL_MS = 60_000

/**
 * Turns the room's repeated presence snapshots into one incoming-call edge.
 * A recipient's device rings once per call id, stops when that device joins
 * or the call ends, and never rings for a call started by another device of
 * the same person, nor for a new call within `QUIET_AFTER_CALL_MS` of this
 * device being on one.
 */
export class IncomingCallTracker {
  #seen = new Set<string>()
  #ringing: string | undefined
  #lastOnAt: number | undefined

  update(call: IncomingCall | undefined, self: string | undefined, joined: boolean, now = Date.now()): IncomingCallChange | undefined {
    if (joined) this.#lastOnAt = now
    if (!call || joined || call.caller === self) {
      if (call) this.#seen.add(call.id)
      if (this.#ringing === undefined) return undefined
      this.#ringing = undefined
      return { type: 'stop' }
    }
    if (this.#ringing === call.id || this.#seen.has(call.id)) return undefined
    this.#seen.add(call.id)
    if (this.#lastOnAt !== undefined && now - this.#lastOnAt < QUIET_AFTER_CALL_MS) return { type: 'quiet', call }
    this.#ringing = call.id
    return { type: 'ring', call }
  }

  /** Another room: nothing seen there yet, and no call there just left. */
  reset(): IncomingCallChange | undefined {
    this.#seen.clear()
    this.#lastOnAt = undefined
    if (this.#ringing === undefined) return undefined
    this.#ringing = undefined
    return { type: 'stop' }
  }
}
