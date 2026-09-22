export interface IncomingCall {
  id: string
  caller: string
}

export type IncomingCallChange =
  | { type: 'ring'; call: IncomingCall }
  | { type: 'stop' }

/**
 * Turns the room's repeated presence snapshots into one incoming-call edge.
 * A recipient's device rings once per call id, stops when that device joins
 * or the call ends, and never rings for a call started by another device of
 * the same person.
 */
export class IncomingCallTracker {
  #seen = new Set<string>()
  #ringing: string | undefined

  update(call: IncomingCall | undefined, self: string | undefined, joined: boolean): IncomingCallChange | undefined {
    if (!call || joined || call.caller === self) {
      if (call) this.#seen.add(call.id)
      if (this.#ringing === undefined) return undefined
      this.#ringing = undefined
      return { type: 'stop' }
    }
    if (this.#ringing === call.id || this.#seen.has(call.id)) return undefined
    this.#seen.add(call.id)
    this.#ringing = call.id
    return { type: 'ring', call }
  }

  reset(): IncomingCallChange | undefined {
    this.#seen.clear()
    if (this.#ringing === undefined) return undefined
    this.#ringing = undefined
    return { type: 'stop' }
  }
}
