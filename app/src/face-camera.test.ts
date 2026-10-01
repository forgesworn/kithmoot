import { describe, expect, it } from 'vitest'
import { CameraClock, faceCamera } from './face-camera.js'

const LAPTOP = 'a'.repeat(64)
const PHONE = 'b'.repeat(64)
const TABLET = 'c'.repeat(64)

describe('faceCamera', () => {
  it('shows nothing for a person with no camera', () => {
    expect(faceCamera({ mic: PHONE, cameras: [] })).toBeUndefined()
  })

  it('shows the only camera there is, wherever the mic is', () => {
    expect(faceCamera({ mic: PHONE, cameras: [{ device: LAPTOP, since: 1 }] })).toBe(LAPTOP)
    expect(faceCamera({ cameras: [{ device: LAPTOP }] })).toBe(LAPTOP)
  })

  it('shows the camera on the device holding the mic, however old it is', () => {
    // The report: a laptop camera filming an empty chair, and the person on
    // their phone, talking into it.
    expect(faceCamera({
      mic: PHONE,
      cameras: [{ device: LAPTOP, since: 9_000 }, { device: PHONE, since: 1_000 }],
    })).toBe(PHONE)
  })

  it('falls back to the newest camera when the mic device has none', () => {
    expect(faceCamera({
      mic: TABLET,
      cameras: [{ device: PHONE, since: 2_000 }, { device: LAPTOP, since: 5_000 }],
    })).toBe(LAPTOP)
    expect(faceCamera({
      cameras: [{ device: LAPTOP, since: 5_000 }, { device: PHONE, since: 7_000 }],
    })).toBe(PHONE)
  })

  it('breaks a tie by device id, whatever order the devices come in', () => {
    const together = [{ device: PHONE, since: 3_000 }, { device: LAPTOP, since: 3_000 }]
    expect(faceCamera({ cameras: together })).toBe(LAPTOP)
    expect(faceCamera({ cameras: [...together].reverse() })).toBe(LAPTOP)
    expect(faceCamera({ cameras: [{ device: PHONE }, { device: LAPTOP }] })).toBe(LAPTOP)
  })

  it('ranks a camera with no time below one with a time', () => {
    expect(faceCamera({ cameras: [{ device: LAPTOP }, { device: PHONE, since: 0 }] })).toBe(PHONE)
  })

  it('gives the same answer for your own tile: your other device when it holds the mic', () => {
    // On the laptop, its own camera is one candidate and the phone's is the
    // other; the phone has the mic, so the laptop's own tile shows the phone.
    const here = LAPTOP
    const face = faceCamera({ mic: PHONE, cameras: [{ device: here, since: 1 }, { device: PHONE, since: 2 }] })
    expect(face).toBe(PHONE)
    expect(face === here).toBe(false)
    // Take the mic here and the laptop's own camera is the face again.
    expect(faceCamera({ mic: here, cameras: [{ device: here, since: 1 }, { device: PHONE, since: 2 }] })).toBe(here)
  })
})

describe('CameraClock', () => {
  it('keeps the first time a camera was seen, not the latest', () => {
    const clock = new CameraClock()
    expect(clock.since(LAPTOP, 't1', 100)).toBe(100)
    expect(clock.since(LAPTOP, 't1', 900)).toBe(100)
  })

  it('treats a camera turned off and on again as a new camera', () => {
    const clock = new CameraClock()
    clock.since(LAPTOP, 't1', 100)
    clock.since(PHONE, 'p1', 200)
    // The laptop's camera comes back with a new track id: newest again.
    const laptop = clock.since(LAPTOP, 't2', 300)
    const phone = clock.since(PHONE, 'p1', 300)
    expect(faceCamera({ cameras: [{ device: LAPTOP, since: laptop }, { device: PHONE, since: phone }] })).toBe(LAPTOP)
  })

  it('forgets cameras that are no longer running', () => {
    const clock = new CameraClock()
    clock.since(LAPTOP, 't1', 100)
    clock.since(PHONE, 'p1', 200)
    clock.retain([[PHONE, 'p1']])
    expect(clock.since(LAPTOP, 't1', 500)).toBe(500)
    expect(clock.since(PHONE, 'p1', 500)).toBe(200)
  })
})
