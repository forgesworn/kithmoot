import {
  DEFAULT_VOICE_PRESET,
  VOICE_PRESETS,
  latencySamples,
  type VoicePreset,
} from '../../src/voice-effects.js'

/**
 * The microphone, with masking wired into it.
 *
 * Same shape as `CameraPipeline` and for the same reason: the track that
 * gets published is the end of the graph, not the microphone, so changing
 * preset - including to and from "off" - never replaces a published track
 * and never renegotiates.
 *
 * ## What this is
 *
 * Voice masking. It shifts pitch and formants, which defeats casual
 * recognition. It does not defeat anyone holding a voiceprint, and it does
 * not survive a forensic comparison. Every string this module's UI shows
 * says so. See the header of `src/voice-effects.ts`.
 */

const WORKLET_NAME = 'kithmoot-voice-mask'
const PREVIEW_SECONDS = 3

export interface MicPipelineOptions {
  onStateChange?: (state: MicState) => void
}

export interface MicState {
  preset: VoicePreset
  status: 'idle' | 'loading' | 'ready' | 'degraded'
  /** Latency the masking itself adds, in milliseconds. */
  addedLatencyMs: number
  /** What the browser says its own output path costs, for context. */
  baseLatencyMs: number
  error?: string
}

export class MicPipeline {
  readonly #onStateChange?: (state: MicState) => void
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #node: AudioWorkletNode | null = null
  #destination: MediaStreamAudioDestinationNode | null = null
  #stream: MediaStream | null = null
  #preset: VoicePreset = DEFAULT_VOICE_PRESET
  #status: MicState['status'] = 'idle'
  #error: string | undefined

  constructor(opts: MicPipelineOptions = {}) {
    this.#onStateChange = opts.onStateChange
  }

  get preset(): VoicePreset {
    return this.#preset
  }

  get track(): MediaStreamTrack | undefined {
    return this.#destination?.stream.getAudioTracks()[0] ?? this.#stream?.getAudioTracks()[0]
  }

  get state(): MicState {
    return {
      preset: this.#preset,
      status: this.#status,
      addedLatencyMs: this.addedLatencyMs,
      baseLatencyMs: (this.#context?.baseLatency ?? 0) * 1000,
      error: this.#error,
    }
  }

  /** Milliseconds of delay the masking adds. Zero on `off`, because `off` is
   *  a real bypass rather than the vocoder configured to do nothing. */
  get addedLatencyMs(): number {
    const rate = this.#context?.sampleRate ?? 48_000
    return (latencySamples(VOICE_PRESETS[this.#preset]) / rate) * 1000
  }

  /**
   * Open the microphone and return the track to publish.
   *
   * If the worklet will not load, this returns the *unmasked* microphone
   * track rather than nothing: a broken effect must not take the call down.
   * The state goes to `degraded` and the UI says the voice is not masked,
   * which is the only honest thing to do with a control that has failed.
   */
  async start(): Promise<MediaStreamTrack> {
    if (this.track) return this.track
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const raw = this.#stream.getAudioTracks()[0]
    if (!raw) throw new Error('the browser opened the microphone and gave back no audio track')

    try {
      this.#setStatus('loading')
      const context = new AudioContext()
      this.#context = context
      if (context.state === 'suspended') await context.resume()
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-worklet.js`)
      this.#node = new AudioWorkletNode(context, WORKLET_NAME)
      this.#source = context.createMediaStreamSource(this.#stream)
      this.#destination = context.createMediaStreamDestination()
      this.#source.connect(this.#node)
      this.#node.connect(this.#destination)
      this.#post()
      this.#setStatus('ready')
      const track = this.#destination.stream.getAudioTracks()[0]
      if (!track) throw new Error('the audio graph produced no track')
      return track
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err)
      this.#setStatus('degraded')
      this.#preset = 'off'
      return raw
    }
  }

  setPreset(preset: VoicePreset): void {
    this.#preset = preset
    this.#post()
    this.#emit()
  }

  stop(): void {
    this.#node?.port.postMessage({ type: 'stop' })
    this.#node?.disconnect()
    this.#source?.disconnect()
    for (const t of this.#stream?.getTracks() ?? []) t.stop()
    for (const t of this.#destination?.stream.getTracks() ?? []) t.stop()
    void this.#context?.close()
    this.#node = null
    this.#source = null
    this.#destination = null
    this.#stream = null
    this.#context = null
    this.#status = 'idle'
  }

  /**
   * Record a few seconds of the outgoing, masked audio and hand back
   * something playable.
   *
   * Recorded and played back rather than monitored live, for two reasons:
   * live monitoring through speakers is a feedback loop, and a recording is
   * what the room actually hears rather than what your own skull tells you
   * it hears.
   */
  async preview(seconds = PREVIEW_SECONDS): Promise<Blob> {
    const stream = this.#destination?.stream ?? this.#stream
    if (!stream) throw new Error('the microphone is not on')
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('this browser cannot record, so there is no way to play your voice back to you')
    }
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    const done = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      recorder.onerror = () => reject(new Error('the recording failed'))
    })
    recorder.start()
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    recorder.stop()
    return done
  }

  #post(): void {
    this.#node?.port.postMessage({ type: 'settings', settings: VOICE_PRESETS[this.#preset] })
  }

  #setStatus(status: MicState['status']): void {
    this.#status = status
    this.#emit()
  }

  #emit(): void {
    this.#onStateChange?.(this.state)
  }
}
