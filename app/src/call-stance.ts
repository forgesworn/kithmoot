/**
 * One answer to "what is this button for", for every control that offers a
 * call.
 *
 * There were three answers before this, worked out independently at the
 * point of painting: the room bar said Call / Join call / On call, the
 * banner decided for itself whether to ask this device to join, and the
 * desktop shell had no opinion at all. They disagreed for a moment on the
 * way out of a call, and the moment was visible: press Leave and the join
 * door painted itself before the resting state arrived.
 *
 * The cause is worth writing down, because it is not a race that a delay
 * would have fixed. Leaving is two steps - this device stops saying it is
 * on the call, and then the roster settles - and between them the roster
 * still carries this device's own entry. Read naively that is "a call is on
 * in this room and you are not on it", which is exactly the join door. It
 * was never somebody else's call; it was our own shadow.
 *
 * So the stance is computed from what other DEVICES say, never from the
 * roster's count of calls, and a leave in flight is stated rather than
 * inferred. No timers, no delays: the door is shut because there is nothing
 * to join, which is the truth throughout.
 */

export type CallStance = 'start' | 'join' | 'leave'

export interface CallStanceInput {
  /** This device says it is on a call - `session.call`, not "has a track". */
  mineOn: boolean
  /** Devices on the room's current call that are not this one. Own other
   *  devices count: a call taken on the laptop is one this phone may join. */
  otherDevicesOn: number
  /** Leave was pressed and has not settled yet. True from the moment of the
   *  press until the roster and the panes agree, so nothing paints a state
   *  that is already on its way out. */
  leaving: boolean
}

/** What the person is being offered, given who is on the call. */
export function callStance(input: CallStanceInput): CallStance {
  if (input.mineOn && !input.leaving) return 'leave'
  return input.otherDevicesOn > 0 ? 'join' : 'start'
}

/** The words on the control. The full sentence everywhere, including the
 *  accessible name: "Call" told a person nothing about what pressing it
 *  would do. */
export const CALL_STANCE_LABELS: Readonly<Record<CallStance, string>> = {
  start: 'Start call',
  join: 'Join call',
  leave: 'Leave call',
}

/** The line beside it, for a pane with room for one. */
export const CALL_STANCE_TITLES: Readonly<Record<CallStance, string>> = {
  start: 'Start a call in this room',
  join: 'A call is on in this room',
  leave: 'You are on the call',
}

/**
 * Whether the join door - the banner that asks this device to join a call -
 * may be painted at all.
 *
 * Never while leaving, whatever the roster currently says. This is the
 * no-flicker rule, and it is an assertion in test/desktop-room-layout.spec.ts
 * rather than a comment: a MutationObserver records every change to the
 * banner's `hidden` through a Leave and the case fails if it was ever shown.
 */
export function joinDoorOpen(input: CallStanceInput): boolean {
  return !input.leaving && callStance(input) === 'join'
}

/**
 * What the call pane is for, at this moment.
 *
 * "The call pane must take space only for what it has to show", and there
 * are exactly two things it can have: pictures, and this device's own call
 * controls. Somebody else being on a call is neither - a colleague who
 * joins from a train with everything switched off used to cost the
 * conversation a whole column to display nothing, with the banner above it
 * already saying the only thing there was to say.
 *
 * So there are three states rather than two:
 *
 *  - `resting`   nothing at all: one strip, and the way to start a call.
 *  - `controls`  a voice call. This device is on it and there is not a
 *                picture in the room, so the pane is a strip too - who is
 *                on the call as name chips, the four controls, and Leave -
 *                and the conversation is the main column beneath it. An
 *                empty video grid is not worth a column, and was the last
 *                place the owner's original complaint still showed.
 *  - `peek`      a picture exists, but this device is not on the call (or
 *                is on the way out of it). Watching without joining is not
 *                the same claim on the window as being on the call: the
 *                pane is a compact strip of thumbnails, one call away from
 *                the drawer, and the conversation stays the main column.
 *                This is the state a phone in the room and a desktop window
 *                just watching used to be shown as `live` - a whole row
 *                layout and a chat drawer for a call this device was never
 *                on, which was the second half of the owner's complaint.
 *  - `live`      a picture exists AND this device is on the call. The pane
 *                grows to the row layout and the conversation goes back to
 *                being a drawer beside it.
 */
export type CallPane = 'resting' | 'controls' | 'peek' | 'live'

export interface CallPaneInput extends CallStanceInput {
  /**
   * A picture exists somewhere in the room: a camera or a screen, either
   * advertised on the roster or live on this device.
   *
   * Adverts and local track state, never decoded frames. A tile whose video
   * is stalled for a moment, or re-binding after the mesh rebuilt a
   * connection, is still a picture the room has - and collapsing the pane
   * under it would take the conversation's layout with it and hand it back
   * a second later. The roster is the slower, steadier answer, and it is
   * the right one here.
   */
  pictures: boolean
}

export function callPane(input: CallPaneInput): CallPane {
  const onCall = input.mineOn && !input.leaving
  if (!input.pictures) return onCall ? 'controls' : 'resting'
  return onCall ? 'live' : 'peek'
}

/** How long a pane waits before shrinking. Long enough that a picture
 *  flickering out and back - a renegotiated connection, a camera swapped
 *  for another - never moves the conversation, short enough that a camera
 *  genuinely switched off gives the room back while the hand is still on
 *  the button. */
export const PANE_COLLAPSE_MS = 1000

/**
 * The pane the window actually draws, which is not always the pane the room
 * currently justifies.
 *
 * Growing is immediate: a picture has arrived and there is somewhere it has
 * to go. Shrinking waits, because shrinking is what costs a reader their
 * layout, and the thing that triggers it - a picture going away - is
 * exactly the thing that comes back on its own.
 *
 * Only a departure from `live` is waited on. Joining a call and leaving one
 * are deliberate acts by the person in front of the window, and making
 * those wait a second would read as lag rather than as steadiness.
 *
 * The clock is passed in rather than read, so the wait is a unit test and
 * not a `setTimeout` somebody has to sit through.
 */
export class PaneSettler {
  #shown: CallPane
  #since: number | undefined

  constructor(initial: CallPane = 'resting') {
    this.#shown = initial
  }

  /** What is on screen now. */
  get shown(): CallPane {
    return this.#shown
  }

  /** When this wants asking again, in the caller's own clock, or undefined
   *  when it has settled and nothing is pending. */
  get due(): number | undefined {
    return this.#since === undefined ? undefined : this.#since + PANE_COLLAPSE_MS
  }

  /** The pane to draw, given what the room justifies and the time now. */
  settle(target: CallPane, now: number): CallPane {
    if (target === this.#shown) {
      this.#since = undefined
      return this.#shown
    }
    if (target === 'live' || this.#shown !== 'live') {
      // Growing, or moving between the strips (resting, controls, peek) -
      // none of that waits.
      this.#since = undefined
      this.#shown = target
      return this.#shown
    }
    // Leaving `live`. The clock runs from the moment the pictures went, not
    // from the moment the answer last changed, so a target that wavers
    // between `controls` and `resting` cannot hold the pane open for ever.
    this.#since ??= now
    if (now - this.#since >= PANE_COLLAPSE_MS) {
      this.#since = undefined
      this.#shown = target
    }
    return this.#shown
  }
}
