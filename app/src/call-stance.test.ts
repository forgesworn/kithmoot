// The one thing every call control now agrees on. The flicker this exists
// to stop is a browser-level fact, so test/desktop-room-layout.spec.ts
// records the join door's `hidden` through a real Leave; what is pinned
// here is the rule that makes the door stay shut in the first place.
import { expect, test } from 'vitest'
import { CALL_STANCE_LABELS, callPaneLive, callStance, joinDoorOpen } from './call-stance.js'

const resting = { mineOn: false, otherDevicesOn: 0, leaving: false }

test('nobody on a call offers to start one', () => {
  expect(callStance(resting)).toBe('start')
  expect(CALL_STANCE_LABELS[callStance(resting)]).toBe('Start call')
})

test('somebody else on a call offers to join it', () => {
  const stance = callStance({ ...resting, otherDevicesOn: 1 })
  expect(stance).toBe('join')
  expect(CALL_STANCE_LABELS[stance]).toBe('Join call')
})

test('on the call, the same control leaves it', () => {
  const stance = callStance({ ...resting, mineOn: true })
  expect(stance).toBe('leave')
  expect(CALL_STANCE_LABELS[stance]).toBe('Leave call')
  // Still Leave with other people on it: the button is about this device.
  expect(callStance({ mineOn: true, otherDevicesOn: 3, leaving: false })).toBe('leave')
})

test('a leave in flight never reads as being on the call', () => {
  expect(callStance({ mineOn: true, otherDevicesOn: 0, leaving: true })).toBe('start')
  expect(callStance({ mineOn: true, otherDevicesOn: 2, leaving: true })).toBe('join')
})

test('the join door is shut while leaving, whatever the roster still says', () => {
  // The exact shape of the flicker: this device has stopped saying it is on
  // the call, its own entry has not left the roster yet, and read naively
  // that is "a call is on and you are not on it".
  expect(joinDoorOpen({ mineOn: false, otherDevicesOn: 0, leaving: true })).toBe(false)
  expect(joinDoorOpen({ mineOn: true, otherDevicesOn: 2, leaving: true })).toBe(false)
  // And our own shadow is not a call to join even once the leave has
  // settled, because `otherDevicesOn` counts other devices only.
  expect(joinDoorOpen(resting)).toBe(false)
})

test('the join door opens for a call somebody else is on', () => {
  expect(joinDoorOpen({ mineOn: false, otherDevicesOn: 1, leaving: false })).toBe(true)
  // Not while on it: the pane carries Leave, and the door would be asking
  // somebody to join what they are already on.
  expect(joinDoorOpen({ mineOn: true, otherDevicesOn: 1, leaving: false })).toBe(false)
})

test('the call pane takes room for this device\'s own controls', () => {
  expect(callPaneLive(resting)).toBe(false)
  expect(callPaneLive({ ...resting, mineOn: true })).toBe(true)
  // Leaving collapses the pane at the press, not a frame later.
  expect(callPaneLive({ mineOn: true, otherDevicesOn: 0, leaving: true })).toBe(false)
})

test('the call pane takes room for pictures, and for nothing else', () => {
  expect(callPaneLive({ ...resting, showing: true })).toBe(true)
  // Somebody else on a call with everything switched off is a line in the
  // banner, not a column of empty pane.
  expect(callPaneLive({ ...resting, otherDevicesOn: 2 })).toBe(false)
  expect(callPaneLive({ ...resting, otherDevicesOn: 2, showing: true })).toBe(true)
  // Their pictures do not vanish because this device pressed Leave.
  expect(callPaneLive({ mineOn: true, otherDevicesOn: 1, leaving: true, showing: true })).toBe(true)
})
