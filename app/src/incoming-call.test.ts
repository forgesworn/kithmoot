import { expect, test } from 'vitest'
import { IncomingCallTracker, QUIET_AFTER_CALL_MS } from './incoming-call.js'

const call = { id: 'call-a', caller: 'alice' }

test('rings every recipient device once for a new call', () => {
  const phone = new IncomingCallTracker()
  const laptop = new IncomingCallTracker()
  expect(phone.update(call, 'bob', false)).toEqual({ type: 'ring', call })
  expect(laptop.update(call, 'bob', false)).toEqual({ type: 'ring', call })
  expect(phone.update(call, 'bob', false)).toBeUndefined()
  expect(laptop.update(call, 'bob', false)).toBeUndefined()
})

test('does not ring the callers other devices', () => {
  const tracker = new IncomingCallTracker()
  expect(tracker.update(call, 'alice', false)).toBeUndefined()
})

test('stops when this device joins or the call ends', () => {
  const tracker = new IncomingCallTracker()
  tracker.update(call, 'bob', false, 0)
  expect(tracker.update(call, 'bob', true, 1_000)).toEqual({ type: 'stop' })
  expect(tracker.update(call, 'bob', false, 2_000)).toBeUndefined()

  const later = 1_000 + QUIET_AFTER_CALL_MS
  const other = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(other, 'bob', false, later)).toEqual({ type: 'ring', call: other })
  expect(tracker.update(undefined, 'bob', false, later)).toEqual({ type: 'stop' })
})

test('reset lets a newly opened room ring for its current call', () => {
  const tracker = new IncomingCallTracker()
  tracker.update(call, 'bob', false)
  expect(tracker.reset()).toEqual({ type: 'stop' })
  expect(tracker.update(call, 'bob', false)).toEqual({ type: 'ring', call })
})

test('a new call straight after leaving one does not ring', () => {
  const tracker = new IncomingCallTracker()
  const first = { id: 'call-a', caller: 'alice' }
  const after = { id: 'call-b', caller: 'alice' }
  tracker.update(first, 'bob', true, 1_000)
  tracker.update(undefined, 'bob', false, 2_000)
  expect(tracker.update(after, 'bob', false, 30_000)).toEqual({ type: 'quiet', call: after })
  // Kept quiet for good, not just for the minute.
  expect(tracker.update(after, 'bob', false, 120_000)).toBeUndefined()
})

test('a new call well after leaving one rings', () => {
  const tracker = new IncomingCallTracker()
  tracker.update({ id: 'call-a', caller: 'alice' }, 'bob', true, 1_000)
  tracker.update(undefined, 'bob', false, 2_000)
  const later = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(later, 'bob', false, 1_000 + QUIET_AFTER_CALL_MS)).toEqual({ type: 'ring', call: later })
})

test('a call in another room rings even straight after leaving one', () => {
  const tracker = new IncomingCallTracker()
  tracker.update({ id: 'call-a', caller: 'alice' }, 'bob', true, 1_000)
  tracker.reset()
  const elsewhere = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(elsewhere, 'bob', false, 2_000)).toEqual({ type: 'ring', call: elsewhere })
})
