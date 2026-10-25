import { expect, test } from 'vitest'
import { HIDDEN_CAMERA_FRAME_INTERVAL_MS, HiddenCameraScheduler } from './hidden-camera-scheduler.js'

test('an initial or unsuccessful hidden render is retried at low cadence', () => {
  const scheduler = new HiddenCameraScheduler()
  expect(scheduler.next(0)).toBe('render')
  expect(scheduler.next(HIDDEN_CAMERA_FRAME_INTERVAL_MS - 1)).toBeNull()
  expect(scheduler.next(HIDDEN_CAMERA_FRAME_INTERVAL_MS)).toBe('render')
})

test('a complete safe frame permits one keep-alive per interval', () => {
  const scheduler = new HiddenCameraScheduler()
  scheduler.rendered(100)
  expect(scheduler.next(100)).toBeNull()
  expect(scheduler.next(1_099)).toBeNull()
  expect(scheduler.next(1_100)).toBe('keep-alive')
  expect(scheduler.next(2_099)).toBeNull()
  expect(scheduler.next(2_100)).toBe('keep-alive')
})

test('invalidation requires a fresh render before keep-alive resumes', () => {
  const scheduler = new HiddenCameraScheduler()
  scheduler.rendered(0)
  scheduler.invalidate()
  expect(scheduler.next(1_000)).toBe('render')
  expect(scheduler.next(2_000)).toBe('render')
  scheduler.rendered(2_000)
  expect(scheduler.next(3_000)).toBe('keep-alive')
})
