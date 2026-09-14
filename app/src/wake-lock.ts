/**
 * Keeps this device's screen on while it is on a call.
 *
 * Without this a phone left on the table dims and locks mid-call, and once
 * the tab is suspended in the background the audio and video it carries
 * often go with it. `navigator.wakeLock` fixes that, but only while the
 * document stays visible: the browser silently drops the lock the moment
 * the tab is hidden - switching app, locking then unlocking the phone - and
 * gives no way to hold it through that. So the lock has to be re-requested
 * every time the page comes back into view, for as long as this device is
 * still on the call; the caller decides that "still on the call" part and
 * says so with `acquire()`/`release()`, and this reacts to visibility on
 * its own so nobody has to remember to call back in.
 *
 * Feature-detected and never throws: a browser with no Wake Lock API, a
 * request refused by permissions policy, or one made while the tab happens
 * to be hidden, all land on `state`, never on an exception a caller has to
 * catch. `state` is worth putting in a bug report - see `collectDiagnostics`
 * in main.ts - because "the screen slept" and "the call dropped" look the
 * same from across the room.
 */

/** The shape this needs from a real `WakeLockSentinel`, small enough to
 *  fake in a test with no browser at all. */
export interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

/** The shape this needs from `navigator.wakeLock`. */
export interface NavigatorWakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

/** The shape this needs from `document`, to hear visibility change and
 *  read it back without pulling in a whole DOM. */
export interface DocumentLike {
  readonly visibilityState: 'visible' | 'hidden'
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * `unsupported` - this browser has no Wake Lock API. Nothing to retry.
 * `active` - the lock is held right now.
 * `inactive` - wanted or not, but not held: released, not yet acquired, or
 *   the tab is hidden and the browser has taken it back.
 * `error` - the browser has the API but the last request was refused (a
 *   permissions policy, most often an embedding one this app does not
 *   control).
 */
export type WakeLockState = 'unsupported' | 'active' | 'inactive' | 'error'

export interface CallWakeLockOptions {
  /** Defaults to `navigator.wakeLock` when present. Inject a fake for a
   *  test that never touches a real browser. */
  wakeLock?: NavigatorWakeLockLike
  /** Defaults to `document`. */
  doc?: DocumentLike
  /** Called after `state` changes, so a caller can repaint a note about it
   *  without polling. */
  onStateChange?: (state: WakeLockState) => void
}

export class CallWakeLock {
  readonly #wakeLock: NavigatorWakeLockLike | undefined
  readonly #doc: DocumentLike | undefined
  readonly #onStateChange: ((state: WakeLockState) => void) | undefined
  #sentinel: WakeLockSentinelLike | undefined
  #state: WakeLockState
  /** Whether this device considers itself on the call. Kept separately
   *  from `state` because "wanted" survives the tab going hidden, which is
   *  exactly the case that needs to be remembered so visibility coming
   *  back can act on it. */
  #wanted = false

  constructor(options: CallWakeLockOptions = {}) {
    this.#wakeLock = options.wakeLock ?? globalWakeLock()
    this.#doc = options.doc ?? globalDocument()
    this.#onStateChange = options.onStateChange
    this.#state = this.#wakeLock ? 'inactive' : 'unsupported'
    this.#doc?.addEventListener('visibilitychange', this.#onVisibility)
  }

  get state(): WakeLockState {
    return this.#state
  }

  /** This device has joined the call: take the lock now, and take it again
   *  every time the tab comes back into view until `release()` is called. */
  async acquire(): Promise<void> {
    this.#wanted = true
    await this.#request()
  }

  /** This device is off the call: Leave call, leaving the room, or the
   *  page itself going away. Idempotent, and safe to call whether or not a
   *  lock was ever actually held. */
  async release(): Promise<void> {
    this.#wanted = false
    const sentinel = this.#sentinel
    this.#sentinel = undefined
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release()
      } catch {
        // Already gone. Either way there is nothing left to hold.
      }
    }
    if (this.#state !== 'unsupported') this.#setState('inactive')
  }

  /** Stop listening for visibility. Nothing in this app currently tears
   *  down a `CallWakeLock` - it lives for the tab - but a test creates many
   *  of them, and a document that outlives the fixture must not be left
   *  holding a reference to it. */
  dispose(): void {
    this.#doc?.removeEventListener('visibilitychange', this.#onVisibility)
  }

  readonly #onVisibility = (): void => {
    if (this.#wanted && this.#doc?.visibilityState === 'visible') void this.#request()
  }

  async #request(): Promise<void> {
    if (!this.#wakeLock) {
      this.#setState('unsupported')
      return
    }
    try {
      const sentinel = await this.#wakeLock.request('screen')
      // `acquire()`/visibility can race a `release()` that happened while
      // the request was in flight; a lock this device no longer wants is
      // released rather than held.
      if (!this.#wanted) {
        sentinel.release().catch(() => {})
        return
      }
      this.#sentinel = sentinel
      this.#setState('active')
      sentinel.addEventListener('release', () => {
        if (this.#sentinel !== sentinel) return
        this.#sentinel = undefined
        this.#setState('inactive')
      })
    } catch {
      this.#setState('error')
    }
  }

  #setState(next: WakeLockState): void {
    if (this.#state === next) return
    this.#state = next
    this.#onStateChange?.(next)
  }
}

function globalWakeLock(): NavigatorWakeLockLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const withWakeLock = navigator as Navigator & { wakeLock?: NavigatorWakeLockLike }
  return 'wakeLock' in navigator ? withWakeLock.wakeLock : undefined
}

function globalDocument(): DocumentLike | undefined {
  return typeof document === 'undefined' ? undefined : document
}
