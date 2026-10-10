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
  onSourceEnded?: () => void
  /** Start on this preset rather than `DEFAULT_VOICE_PRESET` - a
   *  remembered choice from `call-prefs.ts`. */
  preset?: VoicePreset
}

export interface MicState {
  preset: VoicePreset
  status: 'idle' | 'loading' | 'ready' | 'degraded'
  /** A failed selected mask must stay silent until deliberately reopened. */
  blocked: boolean
  /** Latency the masking itself adds, in milliseconds. */
  addedLatencyMs: number
  /** What the browser says its own output path costs, for context. */
  baseLatencyMs: number
  error?: string
}

/** How often the masking graph's clock is checked, and what it must have
 *  advanced by since the last check to count as running. Two misses in a
 *  row is a stopped clock; one is a busy moment. */
const CLOCK_CHECK_MS = 1_000
const MIN_CLOCK_ADVANCE_S = 0.2
const STALLED_CHECKS = 2
/** Bound graph startup without exposing an unmasked fallback. */
const START_BOUND_MS = 4_000

function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class MicPipeline {
  readonly #onStateChange?: (state: MicState) => void
  readonly #onSourceEnded?: () => void
  #recovery?: Promise<void>
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #node: AudioWorkletNode | null = null
  #destination: MediaStreamAudioDestinationNode | null = null
  #stream: MediaStream | null = null
  #stopped = false
  #preset: VoicePreset = DEFAULT_VOICE_PRESET
  #status: MicState['status'] = 'idle'
  #error: string | undefined
  #blocked = false
  #rendered = 0
  /** Raw audio is available only while the person explicitly selects Off. */
  #fallback: MediaStreamTrack | null = null
  #watchdog: ReturnType<typeof setInterval> | undefined
  /** Which microphone is feeding the pipeline right now, read off the raw
   *  track's own settings once it is open. */
  #deviceId: string | undefined

  constructor(opts: MicPipelineOptions = {}) {
    this.#onStateChange = opts.onStateChange
    this.#onSourceEnded = opts.onSourceEnded
    this.#preset = opts.preset ?? DEFAULT_VOICE_PRESET
  }

  /** The microphone actually in use, for `call-prefs.ts` to remember. */
  get deviceId(): string | undefined {
    return this.#deviceId
  }

  get preset(): VoicePreset {
    return this.#preset
  }

  /** A selected mask never exposes the raw capture as a publication track. */
  get track(): MediaStreamTrack | undefined {
    return (this.#preset === 'off' ? this.#fallback : undefined) ?? this.#destination?.stream.getAudioTracks()[0]
  }

  get state(): MicState {
    return {
      preset: this.#preset,
      status: this.#status,
      blocked: this.#blocked,
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
   * A failed selected mask rejects startup and mutes capture. Off may use
   * the raw microphone if the browser's audio graph is unavailable.
   */
  async start(opts: { deviceId?: string } = {}): Promise<MediaStreamTrack> {
    if (this.#stopped) throw new Error('Microphone was stopped.')
    if (this.#blocked) throw new Error(this.#failureMessage())
    if (this.track) return this.track
    const stream = await this.#openMic(opts.deviceId)
    if (this.#stopped) {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('Microphone was stopped.')
    }
    this.#stream = stream
    const raw = this.#stream.getAudioTracks()[0]
    if (!raw) throw new Error('the browser opened the microphone and gave back no audio track')
    this.#deviceId = raw.getSettings?.().deviceId
    this.#watchSource(raw)

    try {
      this.#setStatus('loading')
      const context = new AudioContext()
      this.#context = context
      // An unavailable output device must not change the selected preset.
      if (context.state !== 'running' && context.state !== 'closed') await withinMs(context.resume(), START_BOUND_MS, 'the audio device did not start')
      if (this.#stopped) throw new Error('Microphone was stopped.')
      await withinMs(context.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-worklet.js`), START_BOUND_MS, 'the audio worklet did not load')
      if (this.#stopped) throw new Error('Microphone was stopped.')
      this.#source = context.createMediaStreamSource(this.#stream)
      this.#destination = context.createMediaStreamDestination()
      this.#connectProcessor()
      this.#setStatus('ready')
      const track = this.#destination.stream.getAudioTracks()[0]
      if (!track) throw new Error('the audio graph produced no track')
      this.#watch(context)
      return track
    } catch (err) {
      if (this.#stopped) throw err
      this.#fail(err instanceof Error ? err.message : String(err))
      if (this.#blocked) throw new Error(this.#failureMessage())
      return raw // Only an explicitly selected Off can reach this path.
    }
  }

  /**
   * Notice a stopped clock or processor. A selected mask fails silently;
   * only an explicitly selected Off can bypass the failed graph.
   *
   * An AudioContext is clocked by the machine's audio OUTPUT device. When
   * that device is asleep, absent or stalled - measured on a Mac mini whose
   * output had wedged: `currentTime` advanced ten milliseconds in a second
   * and a half - the context still reports `running`, the worklet still
   * loads, and the destination track is `live`, unmuted and enabled, while
   * producing no samples at all. WebRTC then sends no audio, and nobody
   * hears the person. Processor progress is checked separately: a running
   * context does not prove that its masking worklet is still rendering.
   */
  #watch(context: AudioContext): void {
    let last = context.currentTime
    let rendered = this.#rendered
    let stalls = 0
    this.#watchdog = setInterval(() => {
      if (this.#context !== context) return
      // An OS interruption is temporary. Do not discard voice masking while
      // the page is hidden or the audio session belongs to another app.
      if (document.hidden || context.state !== 'running' || this.#recovery) {
        last = context.currentTime
        rendered = this.#rendered
        stalls = 0
        return
      }
      const now = context.currentTime
      const advanced = now - last
      last = now
      const processed = this.#rendered > rendered
      rendered = this.#rendered
      if (advanced >= MIN_CLOCK_ADVANCE_S && processed) {
        stalls = 0
        return
      }
      if (++stalls < STALLED_CHECKS) return
      this.#fail(advanced < MIN_CLOCK_ADVANCE_S ? 'the audio device stopped rendering' : 'the voice processor stopped rendering')
    }, CLOCK_CHECK_MS)
  }

  #failureMessage(): string {
    return `Microphone muted because voice masking failed: ${this.#error ?? 'the voice processor stopped'}. Try the microphone again, or choose Off to use your own voice.`
  }

  #fail(reason: string): void {
    if (this.#stopped) return
    if (this.#watchdog !== undefined) clearInterval(this.#watchdog)
    this.#watchdog = undefined
    this.#node?.disconnect()
    this.#source?.disconnect()
    this.#error = reason
    this.#blocked = this.#preset !== 'off'
    const raw = this.#stream?.getAudioTracks()[0]
    if (this.#blocked) {
      if (raw) raw.enabled = false
      for (const track of this.#destination?.stream.getAudioTracks() ?? []) track.enabled = false
      this.#fallback = null
    } else this.#fallback = raw ?? null
    this.#setStatus('degraded')
  }

  /** Configure the first render through processorOptions. Replacing only the
   * processor discards the old preset's buffered samples before reconnecting;
   * the published destination track stays the same. */
  #connectProcessor(): void {
    const context = this.#context
    if (!context || !this.#source || !this.#destination) throw new Error('the audio graph is unavailable')
    this.#source.disconnect()
    this.#node?.disconnect()
    this.#node?.port.postMessage({ type: 'stop' })
    this.#node?.port.close()
    const node = new AudioWorkletNode(context, WORKLET_NAME, { processorOptions: { settings: VOICE_PRESETS[this.#preset] } })
    this.#node = node
    this.#rendered = 0
    node.port.onmessage = (event: MessageEvent<{ type: string; frames: number }>) => {
      if (!this.#stopped && this.#node === node && event.data.type === 'rendered') this.#rendered = event.data.frames
    }
    node.addEventListener('processorerror', () => {
      if (!this.#stopped && this.#node === node) this.#fail('the voice processor failed')
    })
    this.#source.connect(node)
    node.connect(this.#destination)
  }

  #watchSource(raw: MediaStreamTrack): void {
    raw.addEventListener('ended', () => {
      if (!this.#stopped && this.#stream?.getAudioTracks()[0] === raw) this.#onSourceEnded?.()
    })
  }

  /** The microphone to open: a remembered device if one was given and
   *  still opens, the default microphone otherwise - see
   *  `CameraPipeline.#openInitialCamera` for the same fallback. */
  async #openMic(deviceId: string | undefined): Promise<MediaStream> {
    const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
      } catch {
        // The remembered microphone is gone. Fall through to the default
        // one rather than failing to join the call with audio at all.
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base })
  }

  /** Resume the existing graph and replace only an interrupted device source.
   * The published mute state and selected effect survive the replacement. */
  resume(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    if (this.#recovery) return this.#recovery
    this.#recovery = this.#resume().catch(err => {
      if (!this.#stopped && !this.#blocked && this.#preset !== 'off') this.#fail(err instanceof Error ? err.message : String(err))
      throw err
    }).finally(() => { this.#recovery = undefined })
    return this.#recovery
  }

  async #resume(): Promise<void> {
    if (this.#blocked) throw new Error(this.#failureMessage())
    const context = this.#context
    if (!this.#fallback && (context?.state === 'closed' || this.#destination?.stream.getAudioTracks()[0]?.readyState === 'ended')) {
      throw new Error('The microphone output ended. Switch the microphone off and on to reopen it.')
    }
    if (context && !this.#fallback && context.state !== 'running') {
      await withinMs(context.resume(), START_BOUND_MS, 'Tap Resume call media to restore audio.')
    }
    if (this.#stopped) return
    const raw = this.#stream?.getAudioTracks()[0]
    if (raw?.readyState === 'live' && !raw.muted) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (this.#stopped) { stream.getTracks().forEach(t => t.stop()); return }
    const next = stream.getAudioTracks()[0]
    if (!next) { stream.getTracks().forEach(t => t.stop()); throw new Error('No microphone track returned.') }
    const previous = this.#stream
    const enabled = this.track?.enabled ?? false
    this.#stream = stream
    this.#watchSource(next)
    if (this.#node && this.#context && !this.#fallback && this.#status !== 'degraded') {
      this.#source?.disconnect()
      this.#source = this.#context.createMediaStreamSource(stream)
      this.#source.connect(this.#node)
    } else {
      if (this.#preset !== 'off') { next.stop(); this.#fail('the masking graph is unavailable'); throw new Error(this.#failureMessage()) }
      next.enabled = enabled
      this.#fallback = next
    }
    previous?.getTracks().forEach(t => t.stop())
    this.#emit()
  }

  setPreset(preset: VoicePreset): void {
    this.#preset = preset
    if (this.#blocked && preset === 'off') {
      this.#blocked = false
      this.#fallback = this.#stream?.getAudioTracks()[0] ?? null
      // Deliberately choosing Off permits raw speech, but still requires unmute.
      if (this.#fallback) this.#fallback.enabled = false
    } else if (this.#fallback && preset !== 'off') {
      this.#fallback.enabled = false
      this.#fallback.stop()
      this.#fail('the masking graph needs reopening')
    } else if (!this.#blocked && this.#source && this.#destination) {
      try { this.#connectProcessor() }
      catch (err) { this.#fail(err instanceof Error ? err.message : String(err)) }
    }
    this.#emit()
  }

  stop(): void {
    this.#stopped = true
    if (this.#watchdog !== undefined) clearInterval(this.#watchdog)
    this.#watchdog = undefined
    this.#fallback = null
    this.#node?.port.postMessage({ type: 'stop' })
    this.#node?.port.close()
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
    if (this.#blocked) throw new Error(this.#failureMessage())
    const track = this.track
    if (!track) throw new Error('the microphone is not on')
    const stream = new MediaStream([track])
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

  #setStatus(status: MicState['status']): void {
    this.#status = status
    this.#emit()
  }

  #emit(): void {
    this.#onStateChange?.(this.state)
  }
}
