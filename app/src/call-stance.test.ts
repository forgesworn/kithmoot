// The one thing every call control now agrees on. The flicker this exists
// to stop is a browser-level fact, so test/desktop-room-layout.spec.ts
// records the join door's `hidden` through a real Leave; what is pinned
// here is the rule that makes the door stay shut in the first place.
import { expect, test } from 'vitest'
import { CALL_STANCE_LABELS, PANE_COLLAPSE_MS, PaneSettler, callPane, callStance, joinDoorOpen } from './call-stance.js'

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

const quiet = { ...resting, pictures: false }

test('nothing to show at all is the resting strip', () => {
  expect(callPane(quiet)).toBe('resting')
  // Somebody else on a call with everything switched off is a line in the
  // banner, not a column of empty pane.
  expect(callPane({ ...quiet, otherDevicesOn: 2 })).toBe('resting')
  // And a leave in flight rests at the press, not a frame later.
  expect(callPane({ mineOn: true, otherDevicesOn: 0, leaving: true, pictures: false })).toBe('resting')
})

test('a voice call is the controls strip, not an empty video grid', () => {
  expect(callPane({ ...quiet, mineOn: true })).toBe('controls')
  expect(callPane({ ...quiet, mineOn: true, otherDevicesOn: 3 })).toBe('controls')
})

test('a picture with this device on the call is the live pane', () => {
  expect(callPane({ ...quiet, mineOn: true, pictures: true })).toBe('live')
})

test('a picture with this device off the call is the peek strip, not the drawer', () => {
  // Nobody on this device is on the call, but somebody has a camera on: a
  // compact strip of thumbnails, not the full row layout and chat drawer -
  // this device is not the one making the claim on the window.
  expect(callPane({ ...quiet, pictures: true })).toBe('peek')
  // Off the call, watching somebody else's camera: still a picture to show,
  // still not this device's call.
  expect(callPane({ ...quiet, otherDevicesOn: 1, pictures: true })).toBe('peek')
  // Leaving: the pictures do not vanish, but this device is on its way out,
  // so it reads as peek rather than holding the drawer open underneath it.
  expect(callPane({ mineOn: true, otherDevicesOn: 1, leaving: true, pictures: true })).toBe('peek')
})

test('a pane grows the moment a picture arrives', () => {
  const settler = new PaneSettler('controls')
  expect(settler.settle('live', 0)).toBe('live')
  expect(settler.due).toBeUndefined()
})

test('a pane waits before it shrinks, and the wait is the whole point', () => {
  const settler = new PaneSettler('live')
  expect(settler.settle('controls', 1000)).toBe('live')
  expect(settler.due).toBe(1000 + PANE_COLLAPSE_MS)
  expect(settler.settle('controls', 1000 + PANE_COLLAPSE_MS - 1)).toBe('live')
  expect(settler.settle('controls', 1000 + PANE_COLLAPSE_MS)).toBe('controls')
  expect(settler.due).toBeUndefined()
})

test('a picture that flickers out and back never moves the layout', () => {
  const settler = new PaneSettler('live')
  // The mesh rebuilt a connection: the advert goes for 300ms and returns.
  expect(settler.settle('controls', 0)).toBe('live')
  expect(settler.settle('live', 300)).toBe('live')
  expect(settler.due).toBeUndefined()
  // And the clock starts afresh for the next one, rather than the pane
  // shrinking the instant a second flicker begins.
  expect(settler.settle('controls', 400)).toBe('live')
  expect(settler.settle('controls', 400 + PANE_COLLAPSE_MS - 1)).toBe('live')
  expect(settler.settle('controls', 400 + PANE_COLLAPSE_MS)).toBe('controls')
})

test('a wavering target cannot hold the pane open for ever', () => {
  // Leaving `live` for `controls`, then for `resting` a moment later: the
  // wait runs from when the pictures went, not from the last change of mind.
  const settler = new PaneSettler('live')
  expect(settler.settle('controls', 0)).toBe('live')
  expect(settler.settle('resting', 900)).toBe('live')
  expect(settler.settle('resting', PANE_COLLAPSE_MS)).toBe('resting')
})

test('peek is a small strip like controls: growing to it never waits, and shrinking from live to it waits', () => {
  const settler = new PaneSettler('resting')
  expect(settler.settle('peek', 0)).toBe('peek')
  expect(settler.due).toBeUndefined()
  // Straight from live to peek - somebody watched a call leave the last
  // camera on without ever joining it themselves.
  const fromLive = new PaneSettler('live')
  expect(fromLive.settle('peek', 1000)).toBe('live')
  expect(fromLive.due).toBe(1000 + PANE_COLLAPSE_MS)
  expect(fromLive.settle('peek', 1000 + PANE_COLLAPSE_MS)).toBe('peek')
  // And moving between the small strips themselves is always immediate.
  const betweenStrips = new PaneSettler('peek')
  expect(betweenStrips.settle('controls', 0)).toBe('controls')
  expect(betweenStrips.settle('resting', 1)).toBe('resting')
  expect(betweenStrips.due).toBeUndefined()
})

test('joining and leaving a call never wait', () => {
  const settler = new PaneSettler('resting')
  expect(settler.settle('controls', 0)).toBe('controls')
  expect(settler.settle('resting', 1)).toBe('resting')
  expect(settler.due).toBeUndefined()
})

test('a settled pane has nothing pending and asks for no clock', () => {
  const settler = new PaneSettler('live')
  expect(settler.settle('live', 0)).toBe('live')
  expect(settler.due).toBeUndefined()
  expect(settler.shown).toBe('live')
})
