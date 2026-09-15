import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicPipeline } from './voice-pipeline.js'

class Track extends EventTarget {
  enabled = true
  muted = false
  readyState = 'live'
  stop() { this.readyState = 'ended' }
}
function stream(track = new Track()) {
  return { getTracks: () => [track], getAudioTracks: () => [track] }
}
function setup() {
  const raw = new Track()
  const output = new Track()
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    state: 'running', currentTime: 0, baseLatency: 0, sampleRate: 48000,
    resume: vi.fn(async () => { context.state = 'running' }), close: vi.fn(async () => {}),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: () => ({ stream: stream(output) }),
  }
  const capture = vi.fn(async () => stream(raw))
  vi.stubGlobal('document', { hidden: false })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } })
  vi.stubGlobal('AudioContext', class { constructor() { return context } })
  vi.stubGlobal('AudioWorkletNode', class { port = { postMessage: vi.fn() }; connect = vi.fn(); disconnect = vi.fn() })
  return { raw, output, context, capture }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('microphone interruption recovery', () => {
  it('resumes an interrupted graph without replacing a live source', async () => {
    const fake = setup()
    const pipeline = new MicPipeline()
    const published = await pipeline.start()
    fake.context.state = 'interrupted'
    await pipeline.resume()
    expect(fake.context.resume).toHaveBeenCalledOnce()
    expect(fake.capture).toHaveBeenCalledOnce()
    expect(pipeline.track).toBe(published)
    pipeline.stop()
  })
  it('replaces an ended source while retaining the muted output and effect', async () => {
    const fake = setup()
    const pipeline = new MicPipeline()
    await pipeline.start()
    const preset = pipeline.preset
    fake.output.enabled = false
    fake.raw.stop()
    const replacement = stream()
    fake.capture.mockResolvedValue(replacement)
    await Promise.all([pipeline.resume(), pipeline.resume()])
    expect(fake.capture).toHaveBeenCalledTimes(2)
    expect(pipeline.track).toBe(fake.output)
    expect(pipeline.track?.enabled).toBe(false)
    expect(pipeline.preset).toBe(preset)
    expect(fake.context.createMediaStreamSource).toHaveBeenLastCalledWith(replacement)
    pipeline.stop()
  })
  it('reports an ended output instead of claiming capture recovered', async () => {
    const fake = setup()
    const pipeline = new MicPipeline()
    await pipeline.start()
    fake.output.stop()
    await expect(pipeline.resume()).rejects.toThrow('microphone output ended')
    pipeline.stop()
  })
  it('stops a late capture after leaving while recovery was waiting', async () => {
    const fake = setup()
    const pipeline = new MicPipeline()
    await pipeline.start()
    fake.raw.stop()
    let finish!: (value: ReturnType<typeof stream>) => void
    fake.capture.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const recovery = pipeline.resume()
    pipeline.stop()
    const late = stream()
    finish(late)
    await recovery
    expect(late.getTracks()[0]!.readyState).toBe('ended')
    expect(pipeline.track).toBeUndefined()
  })
  it('does not discard voice masking during an OS interruption', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const pipeline = new MicPipeline()
    await pipeline.start()
    const preset = pipeline.preset
    fake.context.state = 'interrupted'
    await vi.advanceTimersByTimeAsync(5000)
    expect(pipeline.state.status).toBe('ready')
    expect(pipeline.preset).toBe(preset)
    expect(pipeline.track).toBe(fake.output)
    pipeline.stop()
  })
})
