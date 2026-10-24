import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startOperatorLifecycle } from '../../server/operator-lifecycle.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const events: string[] = [], signals = new EventEmitter(), callbacks: (() => void)[] = []
  const backend = { disposeForProcessExit: vi.fn(() => { events.push('backend') }) }
  const pool = { connect: vi.fn(async () => {}), close: vi.fn(() => { events.push('pool') }) }
  const session = { start: vi.fn(), close: vi.fn(() => { events.push('session') }) }
  const host = { announce: vi.fn(), close: vi.fn(() => { events.push('host') }) }
  const timers = { schedule: vi.fn((callback: () => void, _ms: number) => { callbacks.push(callback); return Symbol('advertisement') }), cancel: vi.fn((_timer: unknown) => {}) }
  const options = { createBackend: vi.fn(async () => backend), pool, createSession: vi.fn(() => session),
    createHost: vi.fn(() => host), signals, timers, advertise: true, ready: vi.fn() }
  return { options, backend, pool, session, host, signals, timers, callbacks, events }
}
function noLaterStartup(f: ReturnType<typeof fixture>) {
  expect(f.options.createSession).not.toHaveBeenCalled()
  expect(f.options.createHost).not.toHaveBeenCalled()
  expect(f.host.announce).not.toHaveBeenCalled()
  expect(f.timers.schedule).not.toHaveBeenCalled()
  expect(f.options.ready).not.toHaveBeenCalled()
  expect(f.signals.listenerCount('SIGTERM')).toBe(0)
  expect(f.signals.listenerCount('SIGINT')).toBe(0)
}

describe('private operator startup cancellation', () => {
  it('disposes a backend which resolves after SIGTERM exactly once without connecting or announcing readiness', async () => {
    const f = fixture(), native = deferred<typeof f.backend>()
    f.options.createBackend.mockReturnValue(native.promise)
    const startup = startOperatorLifecycle(f.options)
    f.signals.emit('SIGTERM')
    expect(f.pool.close).toHaveBeenCalledOnce()
    expect(f.backend.disposeForProcessExit).not.toHaveBeenCalled()
    native.resolve(f.backend)
    const lifecycle = await startup
    expect(lifecycle.stopped).toBe(true)
    lifecycle.stop(); lifecycle.stop()
    expect(f.backend.disposeForProcessExit).toHaveBeenCalledOnce()
    expect(f.pool.close).toHaveBeenCalledOnce()
    expect(f.pool.connect).not.toHaveBeenCalled()
    noLaterStartup(f)
  })

  it('quietly accepts an initialiser rejection caused after cancellation', async () => {
    const f = fixture(), native = deferred<typeof f.backend>()
    f.options.createBackend.mockReturnValue(native.promise)
    const startup = startOperatorLifecycle(f.options)
    f.signals.emit('SIGINT')
    native.reject(new Error('Fixture native startup interrupted'))
    await expect(startup).resolves.toMatchObject({ stopped: true })
    expect(f.backend.disposeForProcessExit).not.toHaveBeenCalled()
    expect(f.pool.close).toHaveBeenCalledOnce()
    noLaterStartup(f)
  })

  it.each(['resolve', 'reject'] as const)('fences a relay connection which later %ss after SIGINT', async outcome => {
    const f = fixture(), connection = deferred<void>()
    f.pool.connect.mockReturnValue(connection.promise)
    const startup = startOperatorLifecycle(f.options)
    await Promise.resolve()
    expect(f.pool.connect).toHaveBeenCalledOnce()
    f.signals.emit('SIGINT')
    if (outcome === 'resolve') connection.resolve()
    else connection.reject(new Error('Fixture relay connection cancelled'))
    await expect(startup).resolves.toMatchObject({ stopped: true })
    expect(f.backend.disposeForProcessExit).toHaveBeenCalledOnce()
    expect(f.pool.close).toHaveBeenCalledOnce()
    noLaterStartup(f)
  })

  it('does not create a host if stopping occurs synchronously during session start', async () => {
    const f = fixture()
    f.session.start.mockImplementation(() => { f.signals.emit('SIGTERM') })
    const lifecycle = await startOperatorLifecycle(f.options)
    expect(lifecycle.stopped).toBe(true)
    expect(f.options.createHost).not.toHaveBeenCalled()
    expect(f.session.close).toHaveBeenCalledOnce()
    expect(f.backend.disposeForProcessExit).toHaveBeenCalledOnce()
    expect(f.options.ready).not.toHaveBeenCalled()
    expect(f.timers.schedule).not.toHaveBeenCalled()
  })

  it('also closes a host returned late by a factory which initiated stop', async () => {
    const f = fixture()
    f.options.createHost.mockImplementation(() => { f.signals.emit('SIGTERM'); return f.host })
    await expect(startOperatorLifecycle(f.options)).resolves.toMatchObject({ stopped: true })
    expect(f.host.close).toHaveBeenCalledOnce()
    expect(f.backend.disposeForProcessExit).toHaveBeenCalledOnce()
    expect(f.host.announce).not.toHaveBeenCalled()
    expect(f.options.ready).not.toHaveBeenCalled()
    expect(f.timers.schedule).not.toHaveBeenCalled()
  })
})

describe('private operator shutdown ownership', () => {
  it('attempts every cleanup after throwing host/session/pool closes and fences a stale advertisement callback', async () => {
    const f = fixture()
    f.host.close.mockImplementation(() => { f.events.push('host'); throw new Error('Fixture host close failed') })
    f.session.close.mockImplementation(() => { f.events.push('session'); throw new Error('Fixture session close failed') })
    f.pool.close.mockImplementation(() => { f.events.push('pool'); throw new Error('Fixture pool close failed') })
    const lifecycle = await startOperatorLifecycle(f.options)
    expect(f.options.ready).toHaveBeenCalledOnce()
    expect(f.host.announce).toHaveBeenCalledOnce()
    expect(f.timers.schedule).toHaveBeenCalledWith(expect.any(Function), 30_000)
    expect(() => f.signals.emit('SIGTERM')).not.toThrow()
    lifecycle.stop(); f.callbacks[0]()
    expect(f.events).toEqual(['host', 'session', 'pool', 'backend'])
    expect(f.backend.disposeForProcessExit).toHaveBeenCalledOnce()
    expect(f.timers.cancel).toHaveBeenCalledOnce()
    expect(f.host.announce).toHaveBeenCalledOnce()
    expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    expect(f.signals.listenerCount('SIGINT')).toBe(0)
  })

  it('cleans up and preserves an unexpected startup failure for the CLI generic error path', async () => {
    const f = fixture()
    f.session.start.mockImplementation(() => { throw new Error('Fixture unexpected startup failure') })
    await expect(startOperatorLifecycle(f.options)).rejects.toThrow('Fixture unexpected startup failure')
    expect(f.events).toEqual(['session', 'pool', 'backend'])
    expect(f.options.createHost).not.toHaveBeenCalled()
    expect(f.options.ready).not.toHaveBeenCalled()
    expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    expect(f.signals.listenerCount('SIGINT')).toBe(0)
  })
})
