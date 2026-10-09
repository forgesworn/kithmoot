import { afterEach, expect, test, vi } from 'vitest'
import { CallRecorder } from './call-recorder.js'

// A browser changes state to inactive synchronously, then delivers the last
// data and stop events asynchronously. Keep that ordering in the fixture.
class Recorder extends EventTarget {
  static latest: Recorder
  static failCreation = false
  static isTypeSupported(): boolean { return true }
  state: RecordingState = 'inactive'
  constructor() {
    super()
    if (Recorder.failCreation) throw new Error('browser refused the muxer')
    Recorder.latest = this
  }
  start(): void { this.state = 'recording' }
  pause(): void { this.state = 'paused' }
  resume(): void { this.state = 'recording' }
  data(text: string): void {
    const event = new Event('dataavailable')
    Object.defineProperty(event, 'data', { value: new Blob([text]) })
    this.dispatchEvent(event)
  }
  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.data('last chunk')
      this.dispatchEvent(new Event('stop'))
    })
  }
}

afterEach(() => { Recorder.failCreation = false; vi.unstubAllGlobals() })

function setup(onLimit: (reason: string) => void): { recorder: CallRecorder; close: ReturnType<typeof vi.fn> } {
  vi.stubGlobal('MediaRecorder', Recorder)
  const close = vi.fn(async () => {})
  const context = {
    state: 'running', close,
    createMediaStreamDestination: () => ({ stream: {} }),
    createConstantSource: () => ({ offset: { value: 0 }, connect() {}, start() {} }),
  } as unknown as AudioContext
  return { recorder: new CallRecorder({ maxBytes: 5, onLimit, createContext: () => context }), close }
}

test('a size limit retains the final asynchronous chunk when the caller immediately stops an inactive recorder', async () => {
  let finished: Promise<Blob> | undefined
  const { recorder, close } = setup(() => { finished = recorder.stop() })
  Recorder.latest.data('first chunk')
  expect(Recorder.latest.state).toBe('inactive')
  expect(close).not.toHaveBeenCalled()
  const file = await finished!
  expect(await file.text()).toBe('first chunklast chunk')
  expect(close).toHaveBeenCalledOnce()
})

test('a browser error waits for final data before closing the audio context', async () => {
  let finished: Promise<Blob> | undefined
  const onLimit = vi.fn(() => { finished = recorder.stop() })
  const { recorder, close } = setup(onLimit)
  Recorder.latest.dispatchEvent(new Event('error'))
  expect(close).not.toHaveBeenCalled()
  expect(await (await finished!).text()).toBe('last chunk')
  expect(onLimit).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

test('a rejected muxer releases its audio context instead of leaving capture work alive', () => {
  vi.stubGlobal('MediaRecorder', Recorder)
  Recorder.failCreation = true
  const close = vi.fn(async () => {})
  const context = {
    state: 'running', close,
    createMediaStreamDestination: () => ({ stream: {} }),
    createConstantSource: () => ({ offset: { value: 0 }, connect() {}, start() {} }),
  } as unknown as AudioContext
  expect(() => new CallRecorder({ maxBytes: 5, createContext: () => context })).toThrow('browser refused the muxer')
  expect(close).toHaveBeenCalledOnce()
})
