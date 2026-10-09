/**
 * The call's authorised sound and optional composed video, recorded here.
 *
 * One mix, not a track per speaker: every voice this device is allowed to
 * play, and its own microphone, summed in one `AudioContext` into one
 * `MediaRecorder`, optionally alongside a local compositor output. A track
 * per speaker would sound better and has to be lined up afterwards; a mix
 * is what a person means by "a recording of the call",
 * and it is small - Opus at 32 kbit/s is about 14 MB an hour, far inside the
 * 256 MiB a room will seal and upload.
 *
 * What it records is decided by the caller, who hands over the tracks it is
 * playing on every render. A voice the meeting policy keeps off the speakers
 * is never handed over, so it is never recorded either: the recording hears
 * what the room hears, and nothing a hostile client sends past the stage.
 *
 * Nothing here posts the notice that a recording is running; the caller does
 * that first and starts this only once it is out. See src/meeting.ts.
 */

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
const VIDEO_MIME_TYPES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']
const AUDIO_BITS_PER_SECOND = 32_000

export interface CallRecorderOptions {
  /** Stop on our own past this many bytes, so the result can still be sealed. */
  maxBytes: number
  /** Called once if the recorder stops itself: size cap, or the browser's
   *  own error. The caller still calls `stop()` for the result. */
  onLimit?: (reason: string) => void
  /** The local compositor's owned output, never a raw capture track. */
  video?: MediaStreamTrack
  /** Injected for a test. */
  createContext?: () => AudioContext
}

/** The media type this browser can record into, or undefined if none. */
export function recordingMimeType(video = false): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return (video ? VIDEO_MIME_TYPES : MIME_TYPES).find(type => MediaRecorder.isTypeSupported(type))
}

/** A file name for a recording made at `startedAt`, in the right extension
 *  for the media type it was made in. */
export function recordingFileName(startedAt: Date, mimeType: string): string {
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : mimeType.startsWith('audio/mp4') ? 'm4a' : mimeType.startsWith('audio/ogg') ? 'ogg' : 'webm'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}`
  return `call-recording-${stamp}.${ext}`
}

export class CallRecorder {
  readonly mimeType: string
  readonly startedAt = new Date()
  readonly #context: AudioContext
  readonly #destination: MediaStreamAudioDestinationNode
  readonly #recorder: MediaRecorder
  readonly #sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>()
  readonly #chunks: Blob[] = []
  readonly #maxBytes: number
  readonly #onLimit?: (reason: string) => void
  readonly #stopped: Promise<void>
  #bytes = 0
  #limited = false
  #elapsedMs = 0
  #resumedAt: number | undefined

  constructor(options: CallRecorderOptions) {
    const mimeType = recordingMimeType(!!options.video)
    if (!mimeType) throw new Error(`This browser cannot record ${options.video ? 'video with audio' : 'audio'}.`)
    this.mimeType = mimeType
    this.#maxBytes = options.maxBytes
    this.#onLimit = options.onLimit
    this.#context = options.createContext?.() ?? new AudioContext()
    try {
      this.#destination = this.#context.createMediaStreamDestination()
      // A silent source keeps the recorder's clock running through a pause
      // with nobody connected, so the file's timeline matches the call's.
      const silence = this.#context.createConstantSource()
      silence.offset.value = 0
      silence.connect(this.#destination)
      silence.start()
      const stream = options.video ? new MediaStream([...this.#destination.stream.getAudioTracks(), options.video]) : this.#destination.stream
      this.#recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND, ...(options.video ? { videoBitsPerSecond: 640_000 } : {}) })
      // Subscribe before any stop (including an automatic limit). Final data
      // arrives asynchronously after state has already become inactive.
      this.#stopped = new Promise(resolve => this.#recorder.addEventListener('stop', () => resolve(), { once: true }))
      this.#recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size) return
        this.#chunks.push(event.data)
        this.#bytes += event.data.size
        if (this.#bytes >= this.#maxBytes) this.#limit('it reached the largest file a room can share')
      })
      this.#recorder.addEventListener('error', () => this.#limit('the browser stopped it'))
      if (this.#context.state !== 'running') void this.#context.resume().catch(() => {})
      this.#recorder.start(10_000)
      this.#resumedAt = performance.now()
    } catch (error) {
      void this.#context.close().catch(() => {})
      throw error
    }
  }

  /** Bytes recorded so far. */
  get bytes(): number {
    return this.#bytes
  }

  get recording(): boolean {
    return this.#recorder.state === 'recording'
  }

  get paused(): boolean {
    return this.#recorder.state === 'paused'
  }

  get canPause(): boolean {
    return typeof this.#recorder.pause === 'function' && typeof this.#recorder.resume === 'function'
  }

  /** Captured time. Paused intervals are omitted from the exported timeline. */
  get elapsedMs(): number {
    return this.#elapsedMs + (this.#resumedAt === undefined ? 0 : performance.now() - this.#resumedAt)
  }

  pause(): void {
    if (!this.canPause || !this.recording) return
    this.#recorder.pause()
    this.#holdClock()
  }

  resume(): void {
    if (!this.canPause || !this.paused) return
    this.#recorder.resume()
    this.#resumedAt = performance.now()
  }

  #holdClock(): void {
    if (this.#resumedAt === undefined) return
    this.#elapsedMs += performance.now() - this.#resumedAt
    this.#resumedAt = undefined
  }

  /**
   * Exactly these tracks, from now on: new ones joined into the mix, ones no
   * longer listed taken out. Safe to call on every render.
   */
  setTracks(tracks: Iterable<MediaStreamTrack>): void {
    const want = new Set([...tracks].filter(track => track.kind === 'audio' && track.readyState === 'live'))
    for (const [track, source] of this.#sources) {
      if (want.has(track)) continue
      try { source.disconnect() } catch { /* Already gone with its context. */ }
      this.#sources.delete(track)
    }
    for (const track of want) {
      if (this.#sources.has(track)) continue
      try {
        const source = this.#context.createMediaStreamSource(new MediaStream([track]))
        source.connect(this.#destination)
        this.#sources.set(track, source)
      } catch {
        // A track this context cannot open is a voice missing from the
        // recording, not a reason to stop recording everybody else.
      }
    }
  }

  /** Stop, and hand back everything recorded. */
  async stop(): Promise<Blob> {
    this.#holdClock()
    if (this.#recorder.state !== 'inactive') {
      this.#recorder.stop()
    }
    await this.#stopped
    this.setTracks([])
    void this.#context.close().catch(() => {})
    return new Blob(this.#chunks, { type: this.mimeType })
  }

  #limit(reason: string): void {
    if (this.#limited) return
    this.#limited = true
    this.#holdClock()
    if (this.#recorder.state !== 'inactive') this.#recorder.stop()
    this.#onLimit?.(reason)
  }
}
