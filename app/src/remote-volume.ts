/**
 * Per-person volume, laid over the one-speaker rule and Leave.
 *
 * A slider is a person's own opinion of how loud somebody else is, on this
 * device, and nothing else's business - see the comment above
 * `attachRemoteTrack` in main.ts for why the `<audio>` element it targets
 * can never simply be removed. `HTMLMediaElement.volume` would do the whole
 * job everywhere were it not for two things: it is read-only on iOS Safari,
 * and it caps at 1.0 everywhere, so a slider that goes to 200% cannot be
 * built on it alone.
 *
 * Both are true only sometimes, so Web Audio is opened only sometimes: a
 * level above 100%, or any level at all on iOS, is routed through one
 * shared `AudioContext` - a `MediaStreamAudioSourceNode` per track into a
 * `GainNode` into the destination - while the element stays in the
 * document, muted, purely as the decode sink a track needs before it can be
 * played at all. Everywhere else `.volume` does the whole job and Web Audio
 * is never opened for this at all: one fewer context per call, on top of
 * `SpeakingMonitor`'s, for the ordinary case of turning somebody down.
 *
 * The one-speaker rule and Leave are the caller's `muted`, computed in
 * `render()`, and they always win here: at `muted: true` the gain is zero
 * and the element stays muted whatever `level` says, so a slider at 200%
 * can never undo either rule.
 */

const IS_IOS = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent ?? '')

export interface RemoteVolumeOptions {
  /** Injected so a test can hand in a fake, and so a real caller could share
   *  a context - not done here, because `SpeakingMonitor`'s taps are
   *  deliberately silent and this module's are not: sharing one context
   *  would be fine, sharing its nodes would not. */
  createContext?: () => AudioContext
  /** Overrides the platform check above, for a test. */
  isIOS?: boolean
}

interface Route {
  el: HTMLAudioElement
  track: MediaStreamTrack
  usingGain: boolean
  source?: MediaStreamAudioSourceNode
  gain?: GainNode
}

export class RemoteVolume {
  readonly #routes = new Map<string, Route>()
  readonly #createContext: () => AudioContext
  readonly #isIOS: boolean
  #context: AudioContext | null = null
  #gainFailed = false

  constructor(options: RemoteVolumeOptions = {}) {
    this.#createContext = options.createContext ?? (() => new AudioContext())
    this.#isIOS = options.isIOS ?? IS_IOS
  }

  /**
   * Whether a level above 100%, or any change on iOS, can currently be
   * made audible. False only once Web Audio has actually failed here - a
   * level nobody has needed yet keeps this optimistic. The caller reads
   * this to cap a slider at 100% and say why - see `renderSheetRoster`.
   */
  get gainAvailable(): boolean {
    return !this.#gainFailed
  }

  /**
   * Call from a user gesture - the app already has one at Join - so a
   * context opened here is not born suspended and left that way for ever.
   * Safe to call whether or not anything ends up needing the gain path.
   */
  resume(): void {
    if (this.#gainFailed) return
    try {
      const ctx = this.#ensureContext()
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    } catch {
      this.#gainFailed = true
    }
  }

  /**
   * Routes `track` through `el` at `level` (0 to 2, 1 being untouched), or
   * silences it regardless of `level` when `muted` is set by the
   * one-speaker rule or Leave.
   *
   * Safe to call on every render: re-applying the same track under the same
   * gain decision is close to free, and a track handed over by a
   * renegotiation - the element kept, a new object in its `track` field -
   * is picked up here the same way `SpeakingMonitor.watch` picks it up.
   */
  apply(key: string, el: HTMLAudioElement, track: MediaStreamTrack, level: number, muted: boolean): void {
    const wantGain = this.#needsGain(level)
    let route = this.#routes.get(key)

    if (route && (route.track !== track || route.el !== el || route.usingGain !== wantGain)) {
      this.#teardown(route)
      route = undefined
    }

    if (!route) {
      route = wantGain ? this.#openGain(el, track) : { el, track, usingGain: false }
      this.#routes.set(key, route)
    }

    if (route.usingGain && route.gain) {
      // The decode sink only, never the speaker: the gain node is the only
      // path to the destination while this route is active.
      el.muted = true
      route.gain.gain.value = muted ? 0 : level
    } else {
      // A rule-muted element must stay muted whatever `.volume` says, so
      // `.muted` still carries the rule's answer even on the plain path.
      el.muted = muted
      el.volume = Math.min(Math.max(level, 0), 1)
    }
  }

  /** Stops watching a key and disconnects its nodes, if it had any. */
  detach(key: string): void {
    const route = this.#routes.get(key)
    if (!route) return
    this.#teardown(route)
    this.#routes.delete(key)
  }

  /** Drops every key not listed - the same shape as `SpeakingMonitor.retain`. */
  retain(keys: Iterable<string>): void {
    const keep = new Set(keys)
    for (const key of [...this.#routes.keys()]) if (!keep.has(key)) this.detach(key)
  }

  /** Tears everything down and closes the context, if one was ever opened. */
  close(): void {
    for (const key of [...this.#routes.keys()]) this.detach(key)
    void this.#context?.close().catch(() => {})
    this.#context = null
  }

  #needsGain(level: number): boolean {
    // The untouched 100% needs nothing extra anywhere, iOS included: it is
    // what `.volume` already defaults to, so there is nothing to change.
    if (level === 1) return false
    if (this.#gainFailed) return false
    return level > 1 || this.#isIOS
  }

  #ensureContext(): AudioContext {
    if (!this.#context) this.#context = this.#createContext()
    return this.#context
  }

  #openGain(el: HTMLAudioElement, track: MediaStreamTrack): Route {
    try {
      const ctx = this.#ensureContext()
      const source = ctx.createMediaStreamSource(new MediaStream([track]))
      const gain = ctx.createGain()
      source.connect(gain)
      gain.connect(ctx.destination)
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
      return { el, track, usingGain: true, source, gain }
    } catch {
      // Never the thing that breaks a call: a level this browser cannot
      // reach falls back to whatever `.volume` can do instead, capped at
      // 1.0 - the caller shows the cap, see `gainAvailable`.
      this.#gainFailed = true
      return { el, track, usingGain: false }
    }
  }

  #teardown(route: Route): void {
    try {
      route.source?.disconnect()
      route.gain?.disconnect()
    } catch {
      // A node belonging to a context that has already closed throws on
      // disconnect. Nothing to do about it: the graph is gone either way.
    }
  }
}
