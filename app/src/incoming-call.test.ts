import { expect, test } from 'vitest'
import { IncomingCallTracker, QUIET_AFTER_CALL_MS, RING_BANNER_SECONDS, ringBannerSeconds } from './incoming-call.js'

const call = { id: 'call-a', caller: 'alice' }

test('rings every recipient device once for a new call', () => {
  const phone = new IncomingCallTracker()
  const laptop = new IncomingCallTracker()
  expect(phone.update(call, false)).toEqual({ type: 'ring', call })
  expect(laptop.update(call, false)).toEqual({ type: 'ring', call })
  expect(phone.update(call, false)).toBeUndefined()
  expect(laptop.update(call, false)).toBeUndefined()
})

test('a call one of a person\'s devices is on rings none of their others, and answering on one stops the rest', () => {
  // The caller's own other devices see their person on the call: joined.
  const callersPhone = new IncomingCallTracker()
  expect(callersPhone.update(call, true)).toBeUndefined()
  expect(callersPhone.update(call, true)).toBeUndefined()
  // The person called rings on both devices until one of them answers,
  // and then neither rings again for that call.
  const phone = new IncomingCallTracker()
  const laptop = new IncomingCallTracker()
  expect(phone.update(call, false)).toEqual({ type: 'ring', call })
  expect(laptop.update(call, false)).toEqual({ type: 'ring', call })
  expect(laptop.update(call, true)).toEqual({ type: 'stop' })
  expect(phone.update(call, true)).toEqual({ type: 'stop' })
  expect(phone.update(call, false)).toBeUndefined()
})

test('stops when this device joins or the call ends', () => {
  const tracker = new IncomingCallTracker()
  tracker.update(call, false, 0)
  expect(tracker.update(call, true, 1_000)).toEqual({ type: 'stop' })
  expect(tracker.update(call, false, 2_000)).toBeUndefined()

  const later = 1_000 + QUIET_AFTER_CALL_MS
  const other = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(other, false, later)).toEqual({ type: 'ring', call: other })
  expect(tracker.update(undefined, false, later)).toEqual({ type: 'stop' })
})

test('reset lets a newly opened room ring for its current call', () => {
  const tracker = new IncomingCallTracker()
  tracker.update(call, false)
  expect(tracker.reset()).toEqual({ type: 'stop' })
  expect(tracker.update(call, false)).toEqual({ type: 'ring', call })
})

test('a new call straight after leaving one does not ring', () => {
  const tracker = new IncomingCallTracker()
  const first = { id: 'call-a', caller: 'alice' }
  const after = { id: 'call-b', caller: 'alice' }
  tracker.update(first, true, 1_000)
  tracker.update(undefined, false, 2_000)
  expect(tracker.update(after, false, 30_000)).toEqual({ type: 'quiet', call: after })
  // Kept quiet for good, not just for the minute.
  expect(tracker.update(after, false, 120_000)).toBeUndefined()
})

test('a new call well after leaving one rings', () => {
  const tracker = new IncomingCallTracker()
  tracker.update({ id: 'call-a', caller: 'alice' }, true, 1_000)
  tracker.update(undefined, false, 2_000)
  const later = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(later, false, 1_000 + QUIET_AFTER_CALL_MS)).toEqual({ type: 'ring', call: later })
})

test('a call in another room rings even straight after leaving one', () => {
  const tracker = new IncomingCallTracker()
  tracker.update({ id: 'call-a', caller: 'alice' }, true, 1_000)
  tracker.reset()
  const elsewhere = { id: 'call-b', caller: 'alice' }
  expect(tracker.update(elsewhere, false, 2_000)).toEqual({ type: 'ring', call: elsewhere })
})

test('the ring banner is for a call that has just started, and gives up after a minute', () => {
  const now = 1_000_000
  expect(ringBannerSeconds(now, now)).toBe(RING_BANNER_SECONDS)
  expect(ringBannerSeconds(now - 20, now)).toBe(RING_BANNER_SECONDS - 20)
  // A room opened while a call has been going for a while: nobody is calling.
  expect(ringBannerSeconds(now - RING_BANNER_SECONDS, now)).toBe(0)
  expect(ringBannerSeconds(now - 3600, now)).toBe(0)
  // A caller whose clock runs ahead still rings, for the whole minute.
  expect(ringBannerSeconds(now + 30, now)).toBe(RING_BANNER_SECONDS)
})
