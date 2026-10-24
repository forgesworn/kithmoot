import { REALTIME_PCM_WORKLET_NAME, REALTIME_PCM_WORKLET_SOURCE } from './codec-worklet.js'
import { createRealtimeProcessingAudioContext } from './audio-context.js'

/** Only compressed media crosses this boundary. The caller encrypts it. */
export interface RealtimeEncodedFrame {
  kind: 'video' | 'audio'
  type: 'key' | 'delta'
  timestampUs: number
  durationUs: number
  data: Uint8Array
}

export interface RealtimeCodecConfig {
  width: number
  height: number
  framerate: number
  videoBitrate: number
  audioBitrate: number
}

export const DEFAULT_REALTIME_CODEC_CONFIG: Readonly<RealtimeCodecConfig> = Object.freeze({
  width: 320, height: 180, framerate: 15, videoBitrate: 250_000, audioBitrate: 32_000,
})
export const MAX_REALTIME_FRAME_BYTES = 512 * 1024
export const REALTIME_CODEC_UNAVAILABLE = 'This browser does not support the realtime call codecs'
export const REALTIME_CODEC_FAILED = 'Realtime media processing stopped'
const AUDIO_RATE = 48_000
const AUDIO_BLOCK_FRAMES = 960
const MAX_CODEC_QUEUE = 3
const MAX_PUBLICATIONS = 4
const MAX_AUDIO_AHEAD_SECONDS = .15

interface Closable { close(): void }
interface CodecChunk {
  readonly type: 'key' | 'delta'
  readonly timestamp: number
  readonly duration?: number | null
  readonly byteLength: number
  copyTo(destination: Uint8Array): void
}
interface AudioBlock extends Closable {
  readonly timestamp: number
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly numberOfFrames: number
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void
}
interface VideoPicture extends Closable { readonly timestamp: number }
interface Encoder extends Closable {
  readonly state: string
  readonly encodeQueueSize: number
  configure(config: object): void
  encode(input: Closable, options?: { keyFrame: boolean }): void
}
interface Decoder extends Closable {
  readonly state: string
  readonly decodeQueueSize: number
  configure(config: object): void
  decode(chunk: CodecChunk): void
  reset(): void
}
interface EncoderConstructor {
  new (callbacks: { output(chunk: CodecChunk): void; error(error: unknown): void }): Encoder
  isConfigSupported(config: object): Promise<{ supported?: boolean }>
}
interface DecoderConstructor<T> {
  new (callbacks: { output(frame: T): void; error(error: unknown): void }): Decoder
  isConfigSupported(config: object): Promise<{ supported?: boolean }>
}
interface CodecRuntime {
  VideoEncoder: EncoderConstructor
  AudioEncoder: EncoderConstructor
  VideoDecoder: DecoderConstructor<VideoPicture>
  AudioDecoder: DecoderConstructor<AudioBlock>
  VideoFrame: new (source: HTMLCanvasElement, init: { timestamp: number; duration: number }) => Closable
  AudioData: new (init: { format: 'f32-planar'; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array }) => AudioBlock
  EncodedVideoChunk: new (init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) => CodecChunk
  EncodedAudioChunk: new (init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) => CodecChunk
}

export interface RealtimeCodecStats {
  videoFrames: number
  audioFrames: number
  droppedVideo: number
  droppedAudio: number
}
export interface RealtimeMediaEncoder {
  readonly config: Readonly<RealtimeCodecConfig>
  requestKeyFrame(): void
  stats(): Readonly<RealtimeCodecStats>
  close(): void
}
export interface RealtimeMediaDecoder {
  readonly stream: MediaStream
  push(frame: RealtimeEncodedFrame): boolean
  discontinuity(kind: 'video' | 'audio'): void
  stats(): Readonly<RealtimeCodecStats>
  close(): void
}

function configuration(value: RealtimeCodecConfig = DEFAULT_REALTIME_CODEC_CONFIG): RealtimeCodecConfig {
  const config = { ...value }
  for (const key of ['width', 'height', 'framerate', 'videoBitrate', 'audioBitrate'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(REALTIME_CODEC_UNAVAILABLE)
  }
  if (config.width > 1920 || config.height > 1080 || config.framerate > 60 ||
      config.videoBitrate > 8_000_000 || config.audioBitrate > 128_000) throw new Error(REALTIME_CODEC_UNAVAILABLE)
  return Object.freeze(config)
}
function videoConfig(config: RealtimeCodecConfig) {
  return { codec: 'vp8', width: config.width, height: config.height, framerate: config.framerate,
    bitrate: config.videoBitrate, latencyMode: 'realtime', bitrateMode: 'variable' }
}
function audioConfig(config: RealtimeCodecConfig) {
  return { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 1, bitrate: config.audioBitrate }
}
function runtime(): CodecRuntime { return globalThis as unknown as CodecRuntime }
function freshStats(): RealtimeCodecStats { return { videoFrames: 0, audioFrames: 0, droppedVideo: 0, droppedAudio: 0 } }
function closeCodec(codec: Encoder | Decoder | undefined) { if (codec && codec.state !== 'closed') codec.close() }

/** Probe encode and decode explicitly. Unsupported browsers fail closed. */
export async function probeRealtimeCodecs(config?: RealtimeCodecConfig): Promise<{ supported: boolean; reason?: string }> {
  try {
    const c = configuration(config), r = runtime()
    if (typeof document === 'undefined' || typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined' ||
        !r.VideoFrame || !r.AudioData || !r.EncodedVideoChunk || !r.EncodedAudioChunk) throw new Error()
    const results = await Promise.all([
      r.VideoEncoder.isConfigSupported(videoConfig(c)), r.AudioEncoder.isConfigSupported(audioConfig(c)),
      r.VideoDecoder.isConfigSupported({ codec: 'vp8', codedWidth: c.width, codedHeight: c.height }),
      r.AudioDecoder.isConfigSupported(audioConfig(c)),
    ])
    if (!results.every(result => result.supported)) throw new Error()
    return { supported: true }
  } catch { return { supported: false, reason: REALTIME_CODEC_UNAVAILABLE } }
}

export interface RealtimeEncoderOptions {
  config?: RealtimeCodecConfig
  onError?(message: string): void
}

/** The input must already have the caller's privacy processing applied. */
export async function createRealtimeEncoder(
  stream: MediaStream,
  onFrame: (frame: RealtimeEncodedFrame) => void | Promise<void>,
  options: RealtimeEncoderOptions = {},
): Promise<RealtimeMediaEncoder> {
  const config = configuration(options.config)
  if (!(await probeRealtimeCodecs(config)).supported) throw new Error(REALTIME_CODEC_UNAVAILABLE)
  if (!stream.getAudioTracks().length && !stream.getVideoTracks().length) throw new Error(REALTIME_CODEC_UNAVAILABLE)
  const r = runtime(), stats = freshStats()
  let closed = false, pending = 0, needsInputKey = true, needsOutputKey = true
  let videoEncoder: Encoder | undefined, audioEncoder: Encoder | undefined
  let video: HTMLVideoElement | undefined, context: AudioContext | undefined
  let worklet: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined, mute: GainNode | undefined
  let timer: ReturnType<typeof setInterval> | undefined, lastKeyUs = -Infinity
  const close = () => {
    if (closed) return
    closed = true; clearInterval(timer)
    closeCodec(videoEncoder); closeCodec(audioEncoder)
    if (video) { video.pause(); video.srcObject = null }
    if (worklet) { worklet.port.onmessage = null; worklet.port.postMessage('stop'); worklet.port.close(); worklet.disconnect() }
    source?.disconnect(); mute?.disconnect()
    if (context) void context.close().catch(() => {})
    // Never stop the caller's camera, microphone or protected-share tracks.
  }
  const fail = () => { if (!closed) { close(); options.onError?.(REALTIME_CODEC_FAILED) } }
  const drop = (kind: 'video' | 'audio') => {
    if (kind === 'video') { stats.droppedVideo++; needsInputKey = true; needsOutputKey = true }
    else stats.droppedAudio++
  }
  const publish = (kind: 'video' | 'audio', chunk: CodecChunk) => {
    if (closed) return
    if (pending >= MAX_PUBLICATIONS || !Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0 ||
        !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > MAX_REALTIME_FRAME_BYTES ||
        (kind === 'video' && needsOutputKey && chunk.type !== 'key')) { drop(kind); return }
    const data = new Uint8Array(chunk.byteLength)
    try { chunk.copyTo(data) } catch { fail(); return }
    const duration = chunk.duration ?? (kind === 'audio' ? 20_000 : Math.round(1_000_000 / config.framerate))
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 1_000_000) { drop(kind); return }
    if (kind === 'video') { stats.videoFrames++; needsOutputKey = false } else stats.audioFrames++
    pending++
    try {
      Promise.resolve(onFrame({ kind, type: chunk.type, timestampUs: chunk.timestamp, durationUs: duration, data }))
        .catch(fail).finally(() => { pending-- })
    } catch { pending--; fail() }
  }
  try {
    if (stream.getVideoTracks().length) {
      const canvas = document.createElement('canvas'); canvas.width = config.width; canvas.height = config.height
      const drawing = canvas.getContext('2d', { alpha: false })
      if (!drawing) throw new Error()
      video = document.createElement('video'); video.muted = true; video.playsInline = true
      video.srcObject = new MediaStream(stream.getVideoTracks())
      videoEncoder = new r.VideoEncoder({ output: chunk => publish('video', chunk), error: fail })
      videoEncoder.configure(videoConfig(config))
      await video.play()
      timer = setInterval(() => {
        if (closed || !videoEncoder || !video || video.readyState < 2) return
        if (videoEncoder.encodeQueueSize >= MAX_CODEC_QUEUE || pending >= MAX_PUBLICATIONS) { drop('video'); return }
        try {
          const timestamp = Math.round(performance.now() * 1000)
          drawing.fillStyle = '#000'; drawing.fillRect(0, 0, config.width, config.height)
          if (stream.getVideoTracks()[0]?.enabled && video.videoWidth && video.videoHeight) {
            const scale = Math.min(config.width / video.videoWidth, config.height / video.videoHeight)
            const width = video.videoWidth * scale, height = video.videoHeight * scale
            drawing.drawImage(video, (config.width - width) / 2, (config.height - height) / 2, width, height)
          }
          const frame = new r.VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / config.framerate) })
          try {
            const keyFrame = needsInputKey || timestamp - lastKeyUs >= 1_000_000
            videoEncoder.encode(frame, { keyFrame }); needsInputKey = false
            if (keyFrame) lastKeyUs = timestamp
          } finally { frame.close() }
        } catch { fail() }
      }, 1000 / config.framerate)
    }
    if (stream.getAudioTracks().length) {
      context = createRealtimeProcessingAudioContext()
      if (context.sampleRate !== AUDIO_RATE || !context.audioWorklet) throw new Error()
      audioEncoder = new r.AudioEncoder({ output: chunk => publish('audio', chunk), error: fail })
      audioEncoder.configure(audioConfig(config))
      const url = URL.createObjectURL(new Blob([REALTIME_PCM_WORKLET_SOURCE], { type: 'text/javascript' }))
      try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
      const audioContext = context
      worklet = new AudioWorkletNode(context, REALTIME_PCM_WORKLET_NAME, { numberOfInputs: 1,
        numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' })
      worklet.port.onmessage = event => {
        if (closed || !audioEncoder || !worklet) return
        try {
          const message: unknown = event.data
          if (!message || typeof message !== 'object') return
          const { pcm, frame } = message as { pcm?: unknown; frame?: unknown }
          if (!(pcm instanceof ArrayBuffer) || pcm.byteLength !== AUDIO_BLOCK_FRAMES * 4 ||
              typeof frame !== 'number' || !Number.isSafeInteger(frame) || frame < 0) return
          // A stalled main thread can leave one old worklet message waiting.
          // Compare against the audio clock before sending it into encryption.
          const ageSeconds = audioContext.currentTime - frame / AUDIO_RATE
          if (ageSeconds > .15 || ageSeconds < -.02) { drop('audio'); return }
          if (audioEncoder.encodeQueueSize >= MAX_CODEC_QUEUE || pending >= MAX_PUBLICATIONS) { drop('audio'); return }
          const audio = new r.AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE,
            numberOfFrames: AUDIO_BLOCK_FRAMES, numberOfChannels: 1,
            timestamp: Math.round(performance.now() * 1000 - ageSeconds * 1_000_000), data: new Float32Array(pcm) })
          try { audioEncoder.encode(audio) } finally { audio.close() }
        } catch { fail() } finally { worklet?.port.postMessage('ack') }
      }
      source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
      mute = context.createGain(); mute.gain.value = 0
      source.connect(worklet); worklet.connect(mute); mute.connect(context.destination)
      await context.resume()
      if (context.state !== 'running') throw new Error()
    }
    return { config, requestKeyFrame: () => { needsInputKey = true; needsOutputKey = true },
      stats: () => ({ ...stats }), close }
  } catch { close(); throw new Error(REALTIME_CODEC_FAILED) }
}

export interface RealtimeDecoderOptions {
  config?: RealtimeCodecConfig
  onKeyFrameRequired?(): void
  onError?(message: string): void
}

export async function createRealtimeDecoder(options: RealtimeDecoderOptions = {}): Promise<RealtimeMediaDecoder> {
  const config = configuration(options.config)
  if (!(await probeRealtimeCodecs(config)).supported) throw new Error(REALTIME_CODEC_UNAVAILABLE)
  const r = runtime(), stats = freshStats()
  const canvas = document.createElement('canvas'); canvas.width = config.width; canvas.height = config.height
  const drawing = canvas.getContext('2d', { alpha: false })
  if (!drawing || typeof canvas.captureStream !== 'function') throw new Error(REALTIME_CODEC_UNAVAILABLE)
  drawing.fillStyle = '#000'; drawing.fillRect(0, 0, config.width, config.height)
  const videoStream = canvas.captureStream(config.framerate)
  let context: AudioContext | undefined, videoDecoder: Decoder | undefined, audioDecoder: Decoder | undefined
  let closed = false, needsVideoKey = true, nextAudioTime = 0, lastVideoUs = -1, lastAudioUs = -1
  let requestedKey = false
  const playing = new Set<AudioBufferSourceNode>()
  const stopAudio = () => {
    for (const node of playing) { node.onended = null; try { node.stop() } catch {} node.disconnect() }
    playing.clear(); nextAudioTime = 0
  }
  let stream: MediaStream | undefined
  const close = () => {
    if (closed) return
    closed = true; closeCodec(videoDecoder); closeCodec(audioDecoder); stopAudio()
    for (const track of stream?.getTracks() ?? videoStream.getTracks()) track.stop()
    if (context) void context.close().catch(() => {})
  }
  const fail = () => { if (!closed) { close(); options.onError?.(REALTIME_CODEC_FAILED) } }
  const requestKey = () => {
    needsVideoKey = true
    if (!requestedKey) { requestedKey = true; options.onKeyFrameRequired?.() }
  }
  const discontinuity = (kind: 'video' | 'audio') => {
    if (closed) return
    if (kind === 'video') {
      videoDecoder?.reset(); videoDecoder?.configure({ codec: 'vp8', codedWidth: config.width, codedHeight: config.height })
      lastVideoUs = -1; requestKey()
      drawing.fillStyle = '#000'; drawing.fillRect(0, 0, config.width, config.height)
    } else {
      audioDecoder?.reset(); audioDecoder?.configure(audioConfig(config)); stopAudio(); lastAudioUs = -1
    }
  }
  try {
    context = createRealtimeProcessingAudioContext()
    const audioContext = context, destination = context.createMediaStreamDestination()
    stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()])
    videoDecoder = new r.VideoDecoder({ error: fail, output: frame => {
      try {
        if (closed || needsVideoKey) return
        drawing.drawImage(frame as unknown as CanvasImageSource, 0, 0, config.width, config.height)
        stats.videoFrames++
      } catch { fail() } finally { frame.close() }
    } })
    audioDecoder = new r.AudioDecoder({ error: fail, output: frame => {
      try {
        if (closed) return
        if (frame.sampleRate !== AUDIO_RATE || frame.numberOfChannels !== 1 || frame.numberOfFrames < 1 ||
            frame.numberOfFrames > AUDIO_RATE / 5 || playing.size >= 12) { stats.droppedAudio++; return }
        if (nextAudioTime - audioContext.currentTime > MAX_AUDIO_AHEAD_SECONDS) { stats.droppedAudio++; return }
        const pcm = new Float32Array(frame.numberOfFrames)
        frame.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' })
        const buffer = audioContext.createBuffer(1, frame.numberOfFrames, AUDIO_RATE)
        buffer.copyToChannel(pcm, 0)
        const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(destination)
        source.onended = () => { playing.delete(source); source.disconnect() }
        playing.add(source)
        const start = Math.max(audioContext.currentTime + .01, nextAudioTime)
        nextAudioTime = start + frame.numberOfFrames / AUDIO_RATE
        source.start(start); stats.audioFrames++
      } catch { fail() } finally { frame.close() }
    } })
    videoDecoder.configure({ codec: 'vp8', codedWidth: config.width, codedHeight: config.height })
    audioDecoder.configure(audioConfig(config))
    await context.resume()
    if (context.state !== 'running') throw new Error()
    return {
      stream,
      push(frame) {
        if (closed || !frame || typeof frame !== 'object') return false
        if ((frame.kind !== 'video' && frame.kind !== 'audio') || (frame.type !== 'key' && frame.type !== 'delta') ||
            !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0 || !Number.isSafeInteger(frame.durationUs) ||
            frame.durationUs <= 0 || frame.durationUs > 1_000_000 || !(frame.data instanceof Uint8Array) ||
            frame.data.byteLength < 1 || frame.data.byteLength > MAX_REALTIME_FRAME_BYTES) return false
        const video = frame.kind === 'video', decoder = video ? videoDecoder! : audioDecoder!
        if (frame.timestampUs <= (video ? lastVideoUs : lastAudioUs)) { if (video) stats.droppedVideo++; else stats.droppedAudio++; return false }
        if (decoder.decodeQueueSize >= MAX_CODEC_QUEUE) {
          if (video) { stats.droppedVideo++; discontinuity('video') } else stats.droppedAudio++
          return false
        }
        if (video && needsVideoKey && frame.type !== 'key') { stats.droppedVideo++; requestKey(); return false }
        try {
          const Chunk = video ? r.EncodedVideoChunk : r.EncodedAudioChunk
          const chunk = new Chunk({ type: frame.type, timestamp: frame.timestampUs, duration: frame.durationUs, data: frame.data })
          if (video) { needsVideoKey = false; requestedKey = false; lastVideoUs = frame.timestampUs } else lastAudioUs = frame.timestampUs
          decoder.decode(chunk); return true
        } catch { if (video) { stats.droppedVideo++; discontinuity('video') } else stats.droppedAudio++; return false }
      },
      discontinuity, stats: () => ({ ...stats }), close,
    }
  } catch { close(); throw new Error(REALTIME_CODEC_FAILED) }
}
