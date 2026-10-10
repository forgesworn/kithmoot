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
  const nodes: FakeNode[] = []
  class FakeNode extends EventTarget {
    port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor(_context: unknown, _name: string, readonly options?: AudioWorkletNodeOptions) { super(); nodes.push(this) }
  }
  vi.stubGlobal('document', { hidden: false })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } })
  vi.stubGlobal('AudioContext', class { constructor() { return context } })
  vi.stubGlobal('AudioWorkletNode', FakeNode)
  return { raw, output, context, capture, nodes, source }
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

describe('selected voice masks fail closed', () => {
  it('rejects failed worklet startup without publishing or previewing raw capture', async () => {
    const fake = setup()
    fake.context.audioWorklet.addModule.mockRejectedValue(new Error('worklet unavailable'))
    const pipeline = new MicPipeline({ preset: 'deep' })
    await expect(pipeline.start()).rejects.toThrow('Microphone muted because voice masking failed')
    expect(pipeline.track).toBeUndefined()
    expect(fake.raw.enabled).toBe(false)
    expect(pipeline.state).toMatchObject({ preset: 'deep', status: 'degraded', blocked: true })
    await expect(pipeline.preview()).rejects.toThrow('Microphone muted')
    pipeline.stop()
  })
  it('bounds an unavailable audio device without changing the selected mask', async () => {
    vi.useFakeTimers()
    const fake = setup()
    fake.context.state = 'suspended'
    fake.context.resume.mockImplementation(() => new Promise(() => {}))
    const pipeline = new MicPipeline({ preset: 'deep' })
    const rejected = expect(pipeline.start()).rejects.toThrow('Microphone muted')
    await vi.advanceTimersByTimeAsync(4000)
    await rejected
    expect(fake.raw.enabled).toBe(false)
    expect(pipeline.preset).toBe('deep')
    expect(pipeline.track).toBeUndefined()
    pipeline.stop()
  })
  it('disconnects and mutes a selected mask when the context clock stalls', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const pipeline = new MicPipeline({ preset: 'deep' })
    await pipeline.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(pipeline.track).toBe(fake.output)
    expect(fake.output.enabled).toBe(false)
    expect(fake.raw.enabled).toBe(false)
    expect(fake.source.disconnect).toHaveBeenCalled()
    expect(pipeline.state).toMatchObject({ preset: 'deep', blocked: true })
    await expect(pipeline.resume()).rejects.toThrow('Microphone muted')
    expect(fake.capture).toHaveBeenCalledOnce()
    pipeline.stop()
  })
  it('checks processor progress separately from a running context', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const pipeline = new MicPipeline({ preset: 'higher' })
    await pipeline.start()
    for (let second = 1; second <= 2; second++) {
      fake.context.currentTime = second
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(pipeline.state).toMatchObject({ preset: 'higher', blocked: true, error: 'the voice processor stopped rendering' })
    expect(fake.output.enabled).toBe(false)
    pipeline.stop()
  })
  it('mutes immediately on a processor error and permits Off only while still muted', async () => {
    const fake = setup()
    const pipeline = new MicPipeline({ preset: 'neutral' })
    await pipeline.start()
    fake.nodes[0]!.dispatchEvent(new Event('processorerror'))
    expect(pipeline.state.blocked).toBe(true)
    expect(fake.output.enabled).toBe(false)
    pipeline.setPreset('off')
    expect(pipeline.track).toBe(fake.raw)
    expect(fake.raw.enabled).toBe(false)
    expect(pipeline.state.blocked).toBe(false)
    pipeline.stop()
  })
  it('allows raw fallback for Off but stops it before selecting a mask', async () => {
    const fake = setup()
    fake.context.audioWorklet.addModule.mockRejectedValue(new Error('worklet unavailable'))
    const pipeline = new MicPipeline({ preset: 'off' })
    expect(await pipeline.start()).toBe(fake.raw)
    pipeline.setPreset('deep')
    expect(fake.raw.enabled).toBe(false)
    expect(fake.raw.readyState).toBe('ended')
    expect(pipeline.track).toBeUndefined()
    expect(pipeline.state.blocked).toBe(true)
    pipeline.stop()
  })
  it('configures the first masked render and discards old processor buffers on a preset change', async () => {
    const fake = setup()
    const pipeline = new MicPipeline({ preset: 'deep' })
    const track = await pipeline.start()
    expect(fake.nodes[0]!.options?.processorOptions.settings).toEqual({ semitones: -8, formantRatio: 0.78 })
    pipeline.setPreset('higher')
    expect(pipeline.track).toBe(track)
    expect(fake.nodes[0]!.disconnect).toHaveBeenCalled()
    expect(fake.nodes[0]!.port.close).toHaveBeenCalled()
    expect(fake.nodes[1]!.options?.processorOptions.settings).toEqual({ semitones: 4, formantRatio: 1.14 })
    // A late failure from a disconnected processor cannot disrupt the new one.
    fake.nodes[0]!.dispatchEvent(new Event('processorerror'))
    expect(pipeline.state.blocked).toBe(false)
    pipeline.stop()
  })
  it('keeps a rendering mask and the muted output through source recovery', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const pipeline = new MicPipeline({ preset: 'deep' })
    await pipeline.start()
    fake.output.enabled = false
    for (let second = 1; second <= 3; second++) {
      fake.context.currentTime = second
      fake.nodes[0]!.port.onmessage!({ data: { type: 'rendered', frames: second * 48000 } })
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(pipeline.state.blocked).toBe(false)
    fake.raw.stop()
    fake.capture.mockResolvedValue(stream())
    await pipeline.resume()
    expect(pipeline.preset).toBe('deep')
    expect(pipeline.track).toBe(fake.output)
    expect(fake.output.enabled).toBe(false)
    pipeline.stop()
  })
})
