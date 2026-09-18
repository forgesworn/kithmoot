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
 * Whether the call pane has anything to show.
 *
 * "The call pane must take space only for what it has to show", and there
 * are exactly two things it can have: this device's own call controls, and
 * pictures. Somebody else being on a call is neither. A colleague who joins
 * from a train with everything switched off used to cost the conversation a
 * whole column to display nothing, with the banner above it already saying
 * the only thing there was to say. So `showing` is the room's own answer -
 * `#whoIsHere`, which is hidden precisely when nobody is offering anything -
 * and the pane follows it.
 */
export function callPaneLive(input: CallStanceInput & { showing?: boolean }): boolean {
  if (input.mineOn && !input.leaving) return true
  return input.showing === true
}
