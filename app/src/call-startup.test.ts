import { afterEach, expect, it, vi } from 'vitest'
import type { RoomSession } from '../../src/session.js'
import { waitForExistingCall } from './call-startup.js'

afterEach(() => vi.useRealTimers())

it('lets a returning guest join the call announced after room admission', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  let notify = () => {}, present = false
  const session = { closed: false, calls: () => present ? [{}] : [], onChange: (cb: () => void) => { notify = cb; return stop } } as unknown as RoomSession
  let ready = false
  const opening = waitForExistingCall(session, Date.now() + 2500).then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(200)
  expect(ready).toBe(false)
  present = true; notify()
  await opening
  expect(ready).toBe(true)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds the wait for a first caller and releases the presence listener', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  const session = { closed: false, calls: () => [], onChange: () => stop } as unknown as RoomSession
  const opening = waitForExistingCall(session, Date.now() + 2500)
  await vi.advanceTimersByTimeAsync(2500)
  await opening
  expect(stop).toHaveBeenCalledTimes(1)
})
