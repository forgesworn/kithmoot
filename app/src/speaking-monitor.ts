import { SpeakingSet, rmsFromByteTimeDomain, SPEAKING, type SpeakingThresholds } from '../../src/index.js'

/**
 * Taps every audio track in the room and says who is talking.
 *
 * The decision lives in `SpeakingSet` (in the library, and unit tested with
 * numbers); this is the browser half - one `AnalyserNode` per track, polled
 * on a timer, feeding levels in.
 *
 * **The analyser is connected to a silent sink on purpose.** Web Audio only
 * guarantees a node is processed when there is a path from it to a
 * destination. An analyser hanging off a source with nothing downstream can
 * simply never run, and the failure is silent: `getByteTimeDomainData` keeps
 * answering with the buffer's initial 128s, which reads as perfect silence,
 * so nobody ever lights up and there is nothing in the console to explain
 * it. Routing through a gain of zero makes the graph real without making a
 * sound. It also must be zero rather than absent: the remote audio is
 * already playing through its own `<audio>` element, and a second path to
 * the speakers would double every voice in the room.
 */
export interface SpeakingMonitorOptions {
  /** Injected so a test can hand in a fake, and so a caller can share a
   *  context rather than open a second one. */
  createContext?: () => AudioContext
  thresholds?: SpeakingThresholds
  /** How often to read the analysers. 50ms is twenty reads a second: fast
   *  enough that the light lands with the voice, cheap enough that twenty
   *  tracks cost nothing measurable. */
  intervalMs?: number
  /** Called whenever the set of speakers changes, never on a poll that
   *  changed nothing - the caller repaints on this, and repainting twenty
   *  times a second for no reason is how a speaking indicator becomes the
   *  most expensive thing on the page. */
  onChange?: (speaking: ReadonlySet<string>) => void
}

interface Tap {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  gain: GainNode
  bytes: Uint8Array<ArrayBuffer>
  track: MediaStreamTrack
}

export class SpeakingMonitor {
  readonly #taps = new Map<string, Tap>()
  readonly #set: SpeakingSet
  readonly #createContext: () => AudioContext
  readonly #intervalMs: number
  readonly #onChange: ((speaking: ReadonlySet<string>) => void) | undefined

  #context: AudioContext | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  #last = new Set<string>()

  constructor(options: SpeakingMonitorOptions = {}) {
    this.#set = new SpeakingSet(options.thresholds ?? SPEAKING)
    this.#createContext = options.createContext ?? (() => new AudioContext())
    this.#intervalMs = options.intervalMs ?? 50
    this.#onChange = options.onChange
  }

  /**
   * Starts watching a track under a key of the caller's choosing.
   *
   * Re-watching a key with the same track is a no-op, so this is safe to
   * call on every render. Re-watching with a *different* track replaces the
   * tap and resets the decision, because a track handed over by a
   * renegotiation is a new source and the old one's last state is not
   * evidence about it.
   */
  watch(key: string, track: MediaStreamTrack): void {
    const existing = this.#taps.get(key)
    if (existing?.track === track) return
    if (existing) this.unwatch(key)

    const context = (this.#context ??= this.#createContext())
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const analyser = context.createAnalyser()
    // 1024 samples is about 21ms at 48kHz - one comfortably speech-sized
    // block, and short enough that the level tracks the voice rather than
    // averaging a whole word into the middle.
    analyser.fftSize = 1024
    const gain = context.createGain()
    gain.gain.value = 0

    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(context.destination)

    this.#taps.set(key, {
      source,
      analyser,
      gain,
      bytes: new Uint8Array(analyser.fftSize),
      track,
    })
    this.#set.forget(key)

    // A context opened outside a user gesture starts suspended, and a
    // suspended context's analyser answers with silence for ever without
    // erroring. Nothing to do if it fails - the indicator is cosmetic and
    // must never be the thing that breaks a call.
    if (context.state === 'suspended') void context.resume().catch(() => {})

    // Self-starting, so there is no way to wire up a tap and forget to turn
    // the timer on. It stops itself again when the last tap goes.
    this.start()
  }

  /** Stops watching, tears the nodes down, and clears the decision so a tile
   *  cannot stay lit for a track that has gone. */
  unwatch(key: string): void {
    const tap = this.#taps.get(key)
    if (!tap) return
    try {
      tap.source.disconnect()
      tap.analyser.disconnect()
      tap.gain.disconnect()
    } catch {
      // A node belonging to a context that has already closed throws on
      // disconnect. Nothing to do about it and nothing to report: the graph
      // is gone, which is what was wanted.
    }
    this.#taps.delete(key)
    this.#set.forget(key)
    if (this.#taps.size === 0) this.stop()
  }

  /** Drops every tap whose key is not listed. */
  retain(keys: Iterable<string>): void {
    const keep = new Set(keys)
    for (const key of [...this.#taps.keys()]) if (!keep.has(key)) this.unwatch(key)
    this.#set.retain(keep)
  }

  isSpeaking(key: string): boolean {
    return this.#set.speaking(key)
  }

  speaking(): ReadonlySet<string> {
    return new Set(this.#set.active())
  }

  /**
   * Reads every analyser once. Exposed so a test can step the clock rather
   * than wait for a timer.
   */
  poll(now: number = performance.now()): void {
    for (const [key, tap] of this.#taps) {
      tap.analyser.getByteTimeDomainData(tap.bytes)
      this.#set.update(key, rmsFromByteTimeDomain(tap.bytes), now)
    }
    if (!this.#onChange) return

    const current = this.#set.active()
    if (current.length === this.#last.size && current.every((k) => this.#last.has(k))) return
    this.#last = new Set(current)
    this.#onChange(this.#last)
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => this.poll(), this.#intervalMs)
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Stops, drops every tap and closes the context. */
  close(): void {
    this.stop()
    for (const key of [...this.#taps.keys()]) this.unwatch(key)
    void this.#context?.close().catch(() => {})
    this.#context = null
  }
}
