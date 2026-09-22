import { expect, test } from 'vitest'
import { IncomingCallTracker } from './incoming-call.js'

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
  tracker.update(call, 'bob', false)
  expect(tracker.update(call, 'bob', true)).toEqual({ type: 'stop' })
  expect(tracker.update(call, 'bob', false)).toBeUndefined()

  const other = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(other, 'bob', false)).toEqual({ type: 'ring', call: other })
  expect(tracker.update(undefined, 'bob', false)).toEqual({ type: 'stop' })
})

test('reset lets a newly opened room ring for its current call', () => {
  const tracker = new IncomingCallTracker()
  tracker.update(call, 'bob', false)
  expect(tracker.reset()).toEqual({ type: 'stop' })
  expect(tracker.update(call, 'bob', false)).toEqual({ type: 'ring', call })
})
