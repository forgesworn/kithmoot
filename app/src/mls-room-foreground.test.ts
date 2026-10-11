import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserMlsRoomForeground } from './mls-room-foreground.js'

const account = '31'.repeat(32)
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
describe('room-only foreground ownership', () => {
  beforeEach(() => { vi.stubGlobal('document', { visibilityState: 'visible' }) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('constructs without browser storage, grant preparation or network I/O', () => {
    const foreground = new BrowserMlsRoomForeground()
    expect(foreground.capture()).toBeUndefined()
    expect(foreground.settled()).resolves.toBeUndefined()
  })
  it('refuses invalid account inputs before invoking work', async () => {
    const work = vi.fn(async () => 1)
    await expect(new BrowserMlsRoomForeground().run(account + '\n', () => true, work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'prerender'])('holds work while visibility is %s', async visibilityState => {
    vi.stubGlobal('document', { visibilityState })
    const work = vi.fn(async () => 1)
    expect(await new BrowserMlsRoomForeground().run(account, () => true, work)).toEqual({ state: 'interrupted' })
    expect(work).not.toHaveBeenCalled()
  })
  it.each([() => false, () => { throw new Error('replaced') }])('holds a missing/replaced account', async current => {
    const work = vi.fn(async () => 1)
    expect(await new BrowserMlsRoomForeground().run(account, current, work)).toEqual({ state: 'interrupted' })
    expect(work).not.toHaveBeenCalled()
  })
  it('rejects structurally copied scopes and records nested work before yielding', async () => {
    const foreground = new BrowserMlsRoomForeground(), began = deferred(), end = deferred()
    const run = foreground.run(account, () => true, async scope => {
      await expect(foreground.track({ ...scope }, async () => 1)).rejects.toThrow()
      void foreground.track(scope, async () => { began.resolve(); await end.promise })
      return 2
    })
    await began.promise
    expect(await foreground.run(account, () => true, async () => 3)).toEqual({ state: 'busy' })
    let settled = false
    const draining = foreground.settled().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    end.resolve(); expect(await run).toEqual({ state: 'done', value: 2 }); await draining
    expect(foreground.capture()).toBeUndefined()
  })
  it('invalidates synchronously and retains late work until actual settlement', async () => {
    const foreground = new BrowserMlsRoomForeground(), began = deferred(), end = deferred<Uint8Array>()
    let signal!: AbortSignal
    const run = foreground.run(account, () => true, async scope => {
      signal = scope.signal
      return foreground.track(scope, async () => { began.resolve(); return end.promise })
    })
    await began.promise
    let finished = false
    const stopping = foreground.invalidateAndWait().then(() => { finished = true })
    expect(signal.aborted).toBe(true); expect(foreground.capture()).toBeUndefined()
    expect(await foreground.run(account, () => true, async () => 3)).toEqual({ state: 'busy' })
    await Promise.resolve(); expect(finished).toBe(false)
    const bytes = new Uint8Array([1, 2, 3]); end.resolve(bytes)
    expect(await run).toEqual({ state: 'interrupted' }); await stopping
    expect([...bytes]).toEqual([0, 0, 0])
    expect(await foreground.run(account, () => true, async () => 4)).toEqual({ state: 'done', value: 4 })
  })
  it('withholds late callback bytes when the account changes', async () => {
    const foreground = new BrowserMlsRoomForeground(), began = deferred(), end = deferred()
    let current = true
    const bytes = new Uint8Array([9]), cycle: Record<string, unknown> = { bytes }
    cycle.self = cycle
    const run = foreground.run(account, () => current, async () => { began.resolve(); await end.promise; return cycle })
    await began.promise; current = false; end.resolve()
    expect(await run).toEqual({ state: 'interrupted' }); expect(bytes[0]).toBe(0)
  })
  it('keeps a floated nested failure from becoming successful UI output', async () => {
    const foreground = new BrowserMlsRoomForeground(), bytes = new Uint8Array([8])
    await expect(foreground.run(account, () => true, async scope => {
      void foreground.track(scope, async () => { throw new Error('native failure') })
      return { bytes }
    })).rejects.toThrow('native failure')
    expect(bytes[0]).toBe(0); expect(foreground.capture()).toBeUndefined()
  })
  it('drains new nested work registered while an earlier task is settling', async () => {
    const foreground = new BrowserMlsRoomForeground(), began = deferred(), first = deferred(), second = deferred()
    const run = foreground.run(account, () => true, async scope => {
      void foreground.track(scope, async () => {
        began.resolve(); await first.promise
        void foreground.track(scope, () => second.promise)
      })
      return 1
    })
    await began.promise; first.resolve()
    let settled = false; const stopping = foreground.settled().then(() => { settled = true })
    await first.promise; await Promise.resolve(); expect(settled).toBe(false)
    second.resolve(); expect(await run).toEqual({ state: 'done', value: 1 }); await stopping
  })
  it('allows an endpoint release to drain nested tails without joining itself', async () => {
    const foreground = new BrowserMlsRoomForeground()
    expect(await foreground.run(account, () => true, async scope => {
      await foreground.track(scope, async () => 1)
      await foreground.drain(scope)
      return 2
    })).toEqual({ state: 'done', value: 2 })
  })
})
