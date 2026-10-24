import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRealtimeDecoder, createRealtimeEncoder, MAX_REALTIME_FRAME_BYTES,
  probeRealtimeCodecs, REALTIME_CODEC_FAILED, REALTIME_CODEC_UNAVAILABLE,
  type RealtimeEncodedFrame,
} from './codec.js'
import { REALTIME_PCM_WORKLET_SOURCE } from './codec-worklet.js'

class Track {
  enabled = true
  stop = vi.fn()
  constructor(readonly kind: 'video' | 'audio') {}
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() { return this.tracks }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video') }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
}
function browser() {
  const pictures: Array<{ close: ReturnType<typeof vi.fn>; timestamp: number }> = []
  const audioData: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const encoders: FakeEncoder[] = [], decoders: FakeDecoder[] = [], contexts: Context[] = [], worklets: Worklet[] = []
  const videoTracks: Track[] = [], audioTracks: Track[] = []
  const videos: Array<{ pause: ReturnType<typeof vi.fn>; srcObject: unknown }> = []
  const drawing = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
  class Chunk {
    readonly byteLength: number
    constructor(readonly init: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: Uint8Array }) {
      this.byteLength = init.data.byteLength
    }
    get type() { return this.init.type }
    get timestamp() { return this.init.timestamp }
    get duration() { return this.init.duration }
    copyTo(destination: Uint8Array) { destination.set(this.init.data) }
  }
  class FakeEncoder {
    static supported = true
    static async isConfigSupported() { return { supported: this.supported } }
    state = 'unconfigured'
    encodeQueueSize = 0
    close = vi.fn(() => { this.state = 'closed' })
    configure = vi.fn(() => { this.state = 'configured' })
    encode = vi.fn((input: { timestamp: number }, options?: { keyFrame: boolean }) => {
      this.callbacks.output(new Chunk({ type: options?.keyFrame === false ? 'delta' : 'key', timestamp: input.timestamp,
        duration: 20_000, data: new Uint8Array([1, 2, 3]) }))
    })
    constructor(readonly callbacks: { output(chunk: Chunk): void }) { encoders.push(this) }
  }
  class FakeDecoder {
    static supported = true
    static async isConfigSupported() { return { supported: this.supported } }
    state = 'unconfigured'
    decodeQueueSize = 0
    close = vi.fn(() => { this.state = 'closed' })
    configure = vi.fn(() => { this.state = 'configured' })
    decode = vi.fn()
    reset = vi.fn(() => { this.decodeQueueSize = 0 })
    constructor(readonly callbacks: { output(frame: unknown): void }) { decoders.push(this) }
  }
  class Context {
    sampleRate = 48_000
    currentTime = 0
    state = 'running'
    destination = {}
    audioWorklet = { addModule: vi.fn(async () => {}) }
    sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: null | (() => void) }> = []
    input = { connect: vi.fn(), disconnect: vi.fn() }
    gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    resume = vi.fn(async () => {})
    close = vi.fn(async () => { this.state = 'closed' })
    createMediaStreamSource = vi.fn(() => this.input)
    createGain = vi.fn(() => this.gain)
    createMediaStreamDestination() {
      const track = new Track('audio'); audioTracks.push(track)
      return { stream: new Stream([track]) }
    }
    createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }))
    createBufferSource = vi.fn(() => {
      const source = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }
      this.sources.push(source); return source
    })
    constructor(readonly options?: AudioContextOptions) { contexts.push(this) }
  }
  class Worklet {
    port = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn(), close: vi.fn() }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor() { worklets.push(this) }
  }
  let now = 1000
  vi.stubGlobal('performance', { now: () => now++ })
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Worklet)
  vi.stubGlobal('VideoEncoder', FakeEncoder)
  vi.stubGlobal('AudioEncoder', FakeEncoder)
  vi.stubGlobal('VideoDecoder', FakeDecoder)
  vi.stubGlobal('AudioDecoder', FakeDecoder)
  vi.stubGlobal('EncodedVideoChunk', Chunk)
  vi.stubGlobal('EncodedAudioChunk', Chunk)
  vi.stubGlobal('VideoFrame', class {
    close = vi.fn()
    timestamp: number
    constructor(_canvas: unknown, init: { timestamp: number }) { this.timestamp = init.timestamp; pictures.push(this) }
  })
  vi.stubGlobal('AudioData', class {
    close = vi.fn()
    timestamp: number
    constructor(init: { timestamp: number }) { this.timestamp = init.timestamp; audioData.push(this) }
  })
  vi.stubGlobal('document', { createElement: (name: string) => {
    if (name === 'canvas') return { width: 0, height: 0, getContext: () => drawing, captureStream: () => {
      const track = new Track('video'); videoTracks.push(track); return new Stream([track])
    } }
    const video = { muted: false, playsInline: false, readyState: 2, videoWidth: 640, videoHeight: 360,
      srcObject: null, play: vi.fn(async () => {}), pause: vi.fn() }
    videos.push(video); return video
  } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:realtime-test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { encoders, decoders, contexts, worklets, pictures, audioData, drawing, videoTracks, audioTracks, videos,
    support: FakeEncoder, decoderSupport: FakeDecoder, Context }
}
function encoded(kind: 'video' | 'audio' = 'video', type: 'key' | 'delta' = 'key', timestampUs = 1000): RealtimeEncodedFrame {
  return { kind, type, timestampUs, durationUs: 20_000, data: new Uint8Array([1, 2, 3]) }
}
function decodedAudio(frames = 960) {
  return { timestamp: 1000, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: frames,
    copyTo: vi.fn((destination: Float32Array) => destination.fill(.1)), close: vi.fn() }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('realtime codec feature boundary', () => {
  it('uses null sinks for intermediate graphs while preserving exported audio and caller tracks', async () => {
    const b = browser(), input = new Track('audio')
    const encoder = await createRealtimeEncoder(new Stream([input]) as unknown as MediaStream, () => {})
    const decoder = await createRealtimeDecoder()
    expect(b.contexts.map(context => context.options)).toEqual([
      { sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } },
      { sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } },
    ])
    expect(decoder.stream.getAudioTracks()).toHaveLength(1)
    encoder.close(); decoder.close()
    expect(input.stop).not.toHaveBeenCalled()
    expect(b.audioTracks[0].stop).toHaveBeenCalledOnce()
    expect(b.contexts.every(context => context.close.mock.calls.length === 1)).toBe(true)
  })
  it('uses the ordinary processing graph when null-sink construction is unsupported', async () => {
    const b = browser(), attempts: (AudioContextOptions & { sinkId?: unknown })[] = [], input = new Track('audio')
    vi.stubGlobal('AudioContext', class extends b.Context {
      constructor(options: AudioContextOptions & { sinkId?: unknown }) {
        attempts.push(options)
        if (options.sinkId) throw new TypeError('This browser does not support a null sink')
        super(options)
      }
    })
    const encoder = await createRealtimeEncoder(new Stream([input]) as unknown as MediaStream, () => {})
    const decoder = await createRealtimeDecoder()
    expect(attempts).toHaveLength(4)
    expect(b.contexts.map(context => context.options)).toEqual([
      { sampleRate: 48000, latencyHint: 'interactive' }, { sampleRate: 48000, latencyHint: 'interactive' },
    ])
    expect(decoder.push(encoded('audio'))).toBe(true)
    expect(b.decoders[1].decode).toHaveBeenCalledOnce()
    encoder.close(); decoder.close(); expect(input.stop).not.toHaveBeenCalled()
  })
  it('refuses an unsupported decoder before touching capture or publishing raw media', async () => {
    const b = browser(); b.decoderSupport.supported = false
    const video = new Track('video'), onFrame = vi.fn()
    expect(await probeRealtimeCodecs()).toEqual({ supported: false, reason: REALTIME_CODEC_UNAVAILABLE })
    await expect(createRealtimeEncoder(new Stream([video]) as unknown as MediaStream, onFrame)).rejects.toThrow(REALTIME_CODEC_UNAVAILABLE)
    expect(b.encoders).toHaveLength(0); expect(b.videos).toHaveLength(0)
    expect(onFrame).not.toHaveBeenCalled(); expect(video.stop).not.toHaveBeenCalled()
  })
  it('refuses oversized configuration before probing or allocating video surfaces', async () => {
    const b = browser()
    await expect(createRealtimeDecoder({ config: { width: 10000, height: 180, framerate: 15, videoBitrate: 250000, audioBitrate: 32000 } })).rejects.toThrow(REALTIME_CODEC_UNAVAILABLE)
    expect(b.videoTracks).toHaveLength(0); expect(b.contexts).toHaveLength(0)
  })
})

describe('realtime compressed publication', () => {
  it('publishes compressed frames, bounds pending encryption and preserves caller track ownership', async () => {
    vi.useFakeTimers(); const b = browser(), video = new Track('video')
    const onFrame = vi.fn((_frame: RealtimeEncodedFrame) => new Promise<void>(() => {}))
    const encoder = await createRealtimeEncoder(new Stream([video]) as unknown as MediaStream, onFrame)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFrame).toHaveBeenCalledTimes(4)
    expect(onFrame.mock.calls[0][0]).toMatchObject({ kind: 'video', type: 'key', data: new Uint8Array([1, 2, 3]) })
    expect(encoder.stats().droppedVideo).toBeGreaterThan(0)
    expect(b.pictures.every(frame => frame.close.mock.calls.length === 1)).toBe(true)
    encoder.close(); encoder.close()
    expect(b.encoders[0].close).toHaveBeenCalledOnce()
    expect(video.stop).not.toHaveBeenCalled()
    expect(b.videos[0].srcObject).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFrame).toHaveBeenCalledTimes(4)
  })
  it('requests a fresh keyframe after congestion and never copies a disabled source image', async () => {
    vi.useFakeTimers(); const b = browser(), video = new Track('video')
    const encoder = await createRealtimeEncoder(new Stream([video]) as unknown as MediaStream, () => {})
    await vi.advanceTimersByTimeAsync(70)
    expect(b.encoders[0].encode.mock.calls[0][1]).toEqual({ keyFrame: true })
    b.encoders[0].encodeQueueSize = 100
    await vi.advanceTimersByTimeAsync(70)
    b.encoders[0].encodeQueueSize = 0; video.enabled = false; b.drawing.drawImage.mockClear()
    await vi.advanceTimersByTimeAsync(70)
    expect(b.encoders[0].encode.mock.calls.at(-1)?.[1]).toEqual({ keyFrame: true })
    expect(b.drawing.drawImage).not.toHaveBeenCalled()
    encoder.close()
  })
  it('stops publication if reading the processed video source fails', async () => {
    vi.useFakeTimers(); const b = browser(), video = new Track('video'), onError = vi.fn(), onFrame = vi.fn()
    const encoder = await createRealtimeEncoder(new Stream([video]) as unknown as MediaStream, onFrame, { onError })
    b.drawing.drawImage.mockImplementation(() => { throw new Error('private source details') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledWith(REALTIME_CODEC_FAILED)
    expect(onFrame).not.toHaveBeenCalled(); expect(video.stop).not.toHaveBeenCalled()
    expect(b.encoders[0].close).toHaveBeenCalledOnce()
    encoder.close()
  })
  it('acknowledges bounded PCM, closes AudioData and tears down on publication failure', async () => {
    const b = browser(), audio = new Track('audio'), onError = vi.fn(), onFrame = vi.fn(() => Promise.reject(new Error('secret detail')))
    const encoder = await createRealtimeEncoder(new Stream([audio]) as unknown as MediaStream, onFrame, { onError })
    const port = b.worklets[0].port
    port.onmessage!({ data: { pcm: new ArrayBuffer(8), frame: 0 } })
    expect(b.audioData).toHaveLength(0)
    port.onmessage!({ data: { pcm: new ArrayBuffer(960 * 4), frame: 0 } })
    await Promise.resolve(); await Promise.resolve()
    expect(b.audioData[0].close).toHaveBeenCalledOnce()
    expect(port.postMessage).toHaveBeenCalledWith('ack')
    expect(port.postMessage).toHaveBeenCalledWith('stop')
    expect(onError).toHaveBeenCalledWith(REALTIME_CODEC_FAILED)
    expect(b.contexts[0].close).toHaveBeenCalledOnce()
    expect(audio.stop).not.toHaveBeenCalled()
    encoder.close()
  })
  it('drops a worklet block delayed by a stalled main thread instead of publishing stale sound', async () => {
    const b = browser(), onFrame = vi.fn()
    const encoder = await createRealtimeEncoder(new Stream([new Track('audio')]) as unknown as MediaStream, onFrame)
    b.contexts[0].currentTime = 5
    b.worklets[0].port.onmessage!({ data: { pcm: new ArrayBuffer(960 * 4), frame: 48000 } })
    expect(b.audioData).toHaveLength(0); expect(onFrame).not.toHaveBeenCalled()
    expect(encoder.stats().droppedAudio).toBe(1)
    expect(b.worklets[0].port.postMessage).toHaveBeenCalledWith('ack')
    encoder.close()
  })
})

describe('realtime decoded playout', () => {
  it('refuses deltas until a keyframe, and requires another keyframe after loss', async () => {
    const b = browser(), onKeyFrameRequired = vi.fn()
    const decoder = await createRealtimeDecoder({ onKeyFrameRequired })
    expect(decoder.push(encoded('video', 'delta'))).toBe(false)
    expect(decoder.push(encoded('video', 'delta', 2000))).toBe(false)
    expect(onKeyFrameRequired).toHaveBeenCalledOnce()
    expect(decoder.push(encoded('video', 'key', 3000))).toBe(true)
    const frame = { timestamp: 3000, close: vi.fn() }
    b.decoders[0].callbacks.output(frame)
    expect(decoder.stats().videoFrames).toBe(1); expect(frame.close).toHaveBeenCalledOnce()
    decoder.discontinuity('video')
    expect(decoder.push(encoded('video', 'delta', 4000))).toBe(false)
    expect(onKeyFrameRequired).toHaveBeenCalledTimes(2)
    expect(decoder.push(encoded('video', 'key', 5000))).toBe(true)
    decoder.close()
  })
  it('drops stale or oversized input before decoder allocation and recovers on queue overflow', async () => {
    const b = browser(), decoder = await createRealtimeDecoder()
    expect(decoder.push({ ...encoded(), data: new Uint8Array(MAX_REALTIME_FRAME_BYTES + 1) })).toBe(false)
    expect(decoder.push({ ...encoded(), timestampUs: NaN })).toBe(false)
    expect(b.decoders[0].decode).not.toHaveBeenCalled()
    expect(decoder.push(encoded())).toBe(true)
    expect(decoder.push(encoded())).toBe(false)
    b.decoders[0].decodeQueueSize = 3
    expect(decoder.push(encoded('video', 'delta', 2000))).toBe(false)
    expect(b.decoders[0].reset).toHaveBeenCalledOnce()
    expect(decoder.push(encoded('video', 'delta', 3000))).toBe(false)
    expect(decoder.push(encoded('video', 'key', 4000))).toBe(true)
    decoder.close()
  })
  it('bounds audible scheduling, drops invalid decoded audio and stops only owned playout tracks', async () => {
    const b = browser(), decoder = await createRealtimeDecoder(), context = b.contexts[0]
    const invalid = decodedAudio(48000)
    b.decoders[1].callbacks.output(invalid)
    expect(invalid.close).toHaveBeenCalledOnce(); expect(context.createBuffer).not.toHaveBeenCalled()
    const frames = Array.from({ length: 20 }, () => decodedAudio())
    for (const frame of frames) b.decoders[1].callbacks.output(frame)
    expect(context.sources.length).toBeLessThanOrEqual(8)
    expect(decoder.stats().droppedAudio).toBeGreaterThan(10)
    expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true)
    decoder.discontinuity('audio')
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true)
    b.decoders[1].callbacks.output(decodedAudio())
    expect(context.sources.at(-1)?.start).toHaveBeenCalledWith(.01)
    decoder.close(); decoder.close()
    expect(b.videoTracks[0].stop).toHaveBeenCalledOnce()
    expect(b.audioTracks[0].stop).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(decoder.push(encoded())).toBe(false)
  })
})

describe('audio-thread backpressure', () => {
  it('never queues more PCM while the main thread is stalled and resumes after acknowledgement', () => {
    interface WorkletInstance {
      port: { onmessage(event: { data: string }): void }
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
    }
    let Processor: { new (): WorkletInstance } | undefined
    const posted: Array<{ pcm: ArrayBuffer; frame: number }> = []
    const realm = { AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (message: { pcm: ArrayBuffer; frame: number }) => posted.push(message) }
    }, sampleRate: 48000, currentFrame: 0, Float32Array,
      registerProcessor: (_name: string, value: { new (): WorkletInstance }) => { Processor = value } }
    runInNewContext(REALTIME_PCM_WORKLET_SOURCE, realm)
    if (!Processor) throw new Error('Worklet was not registered')
    const worklet = new Processor(), block = new Float32Array(128).fill(.2), output = new Float32Array(128).fill(1)
    for (let i = 0; i < 1000; i++) { realm.currentFrame += 128; expect(worklet.process([[block]], [[output]])).toBe(true) }
    expect(posted).toHaveLength(1)
    expect(new Float32Array(posted[0].pcm)).toHaveLength(960)
    expect(output.every(sample => sample === 0)).toBe(true)
    worklet.port.onmessage({ data: 'ack' })
    for (let i = 0; i < 8; i++) { realm.currentFrame += 128; worklet.process([[block]], [[output]]) }
    expect(posted).toHaveLength(2)
    expect(posted[1].frame).toBeGreaterThan(posted[0].frame)
    worklet.port.onmessage({ data: 'stop' })
    expect(worklet.process([[block]], [[output]])).toBe(false)
  })
})
