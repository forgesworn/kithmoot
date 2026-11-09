import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let resumes: Array<() => void>
let oscillators: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  resumes = []
  oscillators = vi.fn(() => ({
    type: '', frequency: { value: 0 }, connect: vi.fn((node: unknown) => node), disconnect: vi.fn(),
    start: vi.fn(), stop: vi.fn(), onended: undefined,
  }))
  vi.stubGlobal('AudioContext', class {
    state = 'suspended'
    currentTime = 0
    destination = {}
    resume() {
      return new Promise<void>(resolve => resumes.push(() => { this.state = 'running'; resolve() }))
    }
    createOscillator = oscillators
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(), disconnect: vi.fn(),
      }
    }
  })
})

afterEach(async () => {
  const { stopCallRing } = await import('./zen-chime.js')
  stopCallRing()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('answering or leaving while audio unlocks prevents a delayed ring', async () => {
  const { startCallRing, stopCallRing } = await import('./zen-chime.js')
  const starting = startCallRing()
  expect(resumes).toHaveLength(1)
  stopCallRing()
  resumes[0]!()
  await starting
  await vi.advanceTimersByTimeAsync(9_000)
  expect(oscillators).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('concurrent ring requests share one repeating ring that can be stopped', async () => {
  const { startCallRing, stopCallRing } = await import('./zen-chime.js')
  const first = startCallRing()
  const second = startCallRing()
  for (const resume of resumes) resume()
  await Promise.all([first, second])
  expect(oscillators).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(oscillators).toHaveBeenCalledTimes(4)
  stopCallRing()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(oscillators).toHaveBeenCalledTimes(4)
  expect(vi.getTimerCount()).toBe(0)
})

test('a ring from the previous room cannot replace a newer pending ring', async () => {
  const { startCallRing, stopCallRing } = await import('./zen-chime.js')
  const previous = startCallRing()
  stopCallRing()
  const current = startCallRing()
  expect(resumes).toHaveLength(2)
  resumes[0]!()
  await previous
  expect(oscillators).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  resumes[1]!()
  await current
  expect(oscillators).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
})
