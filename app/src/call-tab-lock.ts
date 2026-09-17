/**
 * Which tab, of this browser, is this device's call.
 *
 * Two tabs signed in as the same account share one device key - see
 * `room-tabs.ts`, which coordinates the same fact for leaving a room
 * outright. This is the narrower case: both tabs open on the *same room*,
 * one of them on the call. Left alone, the other tab's own presence
 * heartbeat keeps restating "no tracks" under the identical device key,
 * and the room believes whichever heartbeat landed last - see
 * `Session.pausePresence` for why that orphans real, live media. So a tab
 * that is not the call holder has to know it, promptly, and stay quiet.
 *
 * A key is `${roomId}|${devicePubkey}`, the caller's business to build.
 * Messages never carry anything else identifying: no participant name, no
 * room content.
 */

export interface CallTabLockChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

type Message =
  | { t: 'claim'; key: string; tab: string }
  | { t: 'release'; key: string; tab: string }
  | { t: 'probe'; key: string; tab: string }

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    (m.t === 'claim' || m.t === 'release' || m.t === 'probe') &&
    typeof m.key === 'string' && m.key.length > 0 && m.key.length <= 200 &&
    typeof m.tab === 'string' && m.tab.length <= 64
  )
}

const CHANNEL_NAME = 'kithmoot.call-tab-lock'
const STORAGE_KEY = 'kithmoot.call-tab-lock.msg'

/** A `BroadcastChannel`-shaped fallback over `storage` events, for a
 *  browser (or a private window) with no `BroadcastChannel`. A tab never
 *  sees its own writes here, same as `BroadcastChannel` never echoes its
 *  own `postMessage` - both properties this module relies on. */
function storageChannel(): CallTabLockChannel {
  const listeners = new Set<(event: MessageEvent) => void>()
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    let parsed: unknown
    try { parsed = JSON.parse(event.newValue) } catch { return }
    const message = (parsed as { message?: unknown } | null)?.message
    for (const listener of listeners) listener({ data: message } as MessageEvent)
  }
  window.addEventListener('storage', onStorage)
  return {
    postMessage(message) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ message, at: Date.now(), r: Math.random() })) } catch { /* No storage: nothing to coordinate with. */ }
    },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    close() { window.removeEventListener('storage', onStorage); listeners.clear() },
  }
}

export function defaultCallTabLockChannel(): CallTabLockChannel {
  if (typeof BroadcastChannel !== 'undefined') return new BroadcastChannel(CHANNEL_NAME)
  return storageChannel()
}

export interface CallTabLockHandlers {
  /** Another tab has claimed a call key this tab was holding. Stop this
   *  tab's media and peer connections for the call; the room and its chat
   *  stay open. */
  onPreempted(key: string): void
  /** Some other tab holds (or now holds) a call key this tab never claimed.
   *  Go quiet on it - see `Session.pausePresence`. */
  onHeldElsewhere(key: string): void
  /** Nobody now claims a call key this tab was quiet about. Safe to resume
   *  ordinary presence. */
  onFreed(key: string): void
}

export class CallTabLock {
  readonly tab = crypto.randomUUID()
  readonly #channel: CallTabLockChannel
  readonly #handlers: CallTabLockHandlers
  #held = new Set<string>()
  #listener = (event: MessageEvent) => { this.#receive(event.data) }

  constructor(handlers: CallTabLockHandlers, channel: CallTabLockChannel = defaultCallTabLockChannel()) {
    this.#handlers = handlers
    this.#channel = channel
    this.#channel.addEventListener('message', this.#listener)
  }

  /** This tab has joined the call for `key`. Every other tab of the same
   *  key, wherever it is in its own lifecycle, must go quiet on it. */
  claim(key: string): void {
    this.#held.add(key)
    this.#channel.postMessage({ t: 'claim', key, tab: this.tab })
  }

  /** This tab is off the call for `key`, by its own choice. */
  release(key: string): void {
    if (!this.#held.delete(key)) return
    this.#channel.postMessage({ t: 'release', key, tab: this.tab })
  }

  /**
   * Ask whether another tab already holds `key`, for a tab that has just
   * opened the room and does not yet know. Resolves once, after `waitMs`
   * (default long enough for a same-machine round trip and then some) or
   * as soon as one answer arrives - whichever is first.
   */
  askHeldElsewhere(key: string, waitMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false
      const done = (result: boolean) => {
        if (answered) return
        answered = true
        clearTimeout(timer)
        this.#channel.removeEventListener('message', listen)
        resolve(result)
      }
      const listen = (event: MessageEvent): void => {
        const data = event.data
        if (!isMessage(data) || data.t !== 'claim' || data.key !== key || data.tab === this.tab) return
        done(true)
      }
      const timer = setTimeout(() => done(false), waitMs)
      this.#channel.addEventListener('message', listen)
      this.#channel.postMessage({ t: 'probe', key, tab: this.tab })
    })
  }

  #receive(data: unknown): void {
    if (!isMessage(data) || data.tab === this.tab) return
    if (data.t === 'probe') {
      if (this.#held.has(data.key)) this.#channel.postMessage({ t: 'claim', key: data.key, tab: this.tab })
      return
    }
    if (data.t === 'claim') {
      if (this.#held.delete(data.key)) this.#handlers.onPreempted(data.key)
      else this.#handlers.onHeldElsewhere(data.key)
      return
    }
    // release: only news to a tab that was quietly deferring to the tab
    // that just released. A tab holding a different key of its own is
    // unaffected, and this tab's own release already updated its own set.
    this.#handlers.onFreed(data.key)
  }

  close(): void {
    this.#channel.removeEventListener('message', this.#listener)
    this.#channel.close()
  }
}
