import { describe, it, expect, vi } from 'vitest'
import { CallWakeLock, type DocumentLike, type NavigatorWakeLockLike, type WakeLockSentinelLike } from './wake-lock.js'

/** A fake `navigator.wakeLock` and a fake `document`, tracking enough to
 *  assert on both without a real browser. */
function fakeEnvironment(options: { requestFails?: boolean } = {}) {
  const releaseListeners: (() => void)[] = []
  let sentinel: WakeLockSentinelLike | undefined
  let requestCount = 0

  const wakeLock: NavigatorWakeLockLike = {
    request: vi.fn(async () => {
      requestCount++
      if (options.requestFails) throw new DOMException('denied', 'NotAllowedError')
      releaseListeners.length = 0
      sentinel = {
        released: false,
        release: vi.fn(async () => {
          if (sentinel) sentinel.released = true
          for (const listener of releaseListeners) listener()
        }),
        addEventListener: vi.fn((_type: 'release', listener: () => void) => {
          releaseListeners.push(listener)
        }),
      }
      return sentinel
    }),
  }

  let visibilityState: 'visible' | 'hidden' = 'visible'
  const visibilityListeners: (() => void)[] = []
  const doc: DocumentLike = {
    get visibilityState() {
      return visibilityState
    },
    addEventListener: vi.fn((_type: 'visibilitychange', listener: () => void) => {
      visibilityListeners.push(listener)
    }),
    removeEventListener: vi.fn((_type, listener: () => void) => {
      const at = visibilityListeners.indexOf(listener)
      if (at !== -1) visibilityListeners.splice(at, 1)
    }),
  }

  return {
    wakeLock,
    doc,
    requestCount: () => requestCount,
    currentSentinel: () => sentinel,
    /** The browser silently taking the lock back, or the page calling
     *  `release()` on the sentinel directly - either way the 'release'
     *  event is how a held lock finds out it no longer is one. */
    revokeSilently(): void {
      sentinel!.released = true
      for (const listener of releaseListeners) listener()
    },
    hide(): void {
      visibilityState = 'hidden'
      for (const listener of visibilityListeners) listener()
    },
    show(): void {
      visibilityState = 'visible'
      for (const listener of visibilityListeners) listener()
    },
  }
}

/** `acquire()` on visibility is fire-and-forget by design - see `#onVisibility`
 *  in wake-lock.ts - so a test that triggers it through a visibility event
 *  rather than calling `acquire()` directly waits a couple of microtask
 *  turns for the request and the state change that follows it to settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('CallWakeLock', () => {
  it('reports unsupported and never requests when there is no navigator.wakeLock', async () => {
    const { doc } = fakeEnvironment()
    const lock = new CallWakeLock({ doc })
    expect(lock.state).toBe('unsupported')
    await lock.acquire()
    expect(lock.state).toBe('unsupported')
  })

  it('requests the lock on acquire and holds it', async () => {
    const env = fakeEnvironment()
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc })
    await lock.acquire()
    expect(env.wakeLock.request).toHaveBeenCalledWith('screen')
    expect(lock.state).toBe('active')
  })

  it('goes to error, without throwing, when the request is refused', async () => {
    const env = fakeEnvironment({ requestFails: true })
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc })
    await expect(lock.acquire()).resolves.toBeUndefined()
    expect(lock.state).toBe('error')
  })

  it('releases the sentinel and reports inactive on release()', async () => {
    const env = fakeEnvironment()
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc })
    await lock.acquire()
    await lock.release()
    expect(env.currentSentinel()!.release).toHaveBeenCalled()
    expect(lock.state).toBe('inactive')
  })

  it('re-requests on visibilitychange while still wanted, but not once released', async () => {
    const env = fakeEnvironment()
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc })
    await lock.acquire()
    expect(env.requestCount()).toBe(1)

    // The browser drops the lock the moment the tab is hidden, silently.
    env.hide()
    env.revokeSilently()
    expect(lock.state).toBe('inactive')

    // Coming back into view while still on the call re-acquires it.
    env.show()
    await flush()
    expect(env.requestCount()).toBe(2)
    expect(lock.state).toBe('active')

    // Off the call: a visibility flap afterwards must not reach for it again.
    await lock.release()
    env.hide()
    env.show()
    await flush()
    expect(env.requestCount()).toBe(2)
    expect(lock.state).toBe('inactive')
  })

  it('does not re-request on a visibilitychange that leaves the tab hidden', async () => {
    const env = fakeEnvironment()
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc })
    await lock.acquire()
    env.hide()
    expect(env.requestCount()).toBe(1)
  })

  it('tells a caller about every state change, for a diagnostics line or a note', async () => {
    const env = fakeEnvironment()
    const states: string[] = []
    const lock = new CallWakeLock({ wakeLock: env.wakeLock, doc: env.doc, onStateChange: (s) => states.push(s) })
    await lock.acquire()
    await lock.release()
    expect(states).toEqual(['active', 'inactive'])
  })
})
