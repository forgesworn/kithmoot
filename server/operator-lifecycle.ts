// Private CLI orchestration. No SDK export, configuration, keys or logging.
interface BackendResource { disposeForProcessExit(): void }
interface PoolResource { connect(): Promise<void>; close(): void }
interface SessionResource { start(): void; close(): void }
interface HostResource { announce(): void; close(): void }
interface SignalSource {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown
  removeListener(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown
}
interface TimerSource {
  schedule(callback: () => void, intervalMs: number): unknown
  cancel(timer: unknown): void
}
const defaultTimers: TimerSource = {
  schedule: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: timer => clearInterval(timer as ReturnType<typeof setInterval>),
}

export interface OperatorLifecycle { readonly stopped: boolean; stop(): void }

/** Signals can arrive while native initialisation or relay connection awaits.
 * Late results still belong to this process and must be disposed even after
 * the first stop has already cleaned up everything available at that time. */
export async function startOperatorLifecycle<Backend extends BackendResource, Session extends SessionResource, Host extends HostResource>(options: {
  createBackend(): Promise<Backend>
  pool: PoolResource
  createSession(): Session
  createHost(session: Session, backend: Backend): Host
  advertise: boolean
  ready(): void
  signals: SignalSource
  timers?: TimerSource
}): Promise<OperatorLifecycle> {
  let backend: Backend | undefined, session: Session | undefined, host: Host | undefined
  let stopped = false, poolClosed = false, timer: unknown, timerScheduled = false
  const timers = options.timers ?? defaultTimers
  const attempt = (action: () => unknown) => {
    try {
      const result = action()
      // Contracts are synchronous today. A future async cleanup must not
      // create an unhandled rejection or prevent the remaining disposals.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => {})
    } catch {}
  }
  const cleanup = () => {
    attempt(() => options.signals.removeListener('SIGTERM', stop))
    attempt(() => options.signals.removeListener('SIGINT', stop))
    if (timerScheduled) { timerScheduled = false; const current = timer; timer = undefined; attempt(() => timers.cancel(current)) }
    const currentHost = host; host = undefined
    if (currentHost) attempt(() => currentHost.close())
    const currentSession = session; session = undefined
    if (currentSession) attempt(() => currentSession.close())
    if (!poolClosed) { poolClosed = true; attempt(() => options.pool.close()) }
    const currentBackend = backend; backend = undefined
    if (currentBackend) attempt(() => currentBackend.disposeForProcessExit())
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    cleanup()
  }
  const lifecycle = { get stopped() { return stopped }, stop }
  try {
    options.signals.once('SIGTERM', stop)
    options.signals.once('SIGINT', stop)
    backend = await options.createBackend()
    if (stopped) { cleanup(); return lifecycle }
    const acquiredBackend = backend
    await options.pool.connect()
    if (stopped) { cleanup(); return lifecycle }
    session = options.createSession()
    if (stopped) { cleanup(); return lifecycle }
    session.start()
    if (stopped) { cleanup(); return lifecycle }
    host = options.createHost(session, acquiredBackend)
    if (stopped) { cleanup(); return lifecycle }
    if (options.advertise) {
      host.announce()
      if (stopped) { cleanup(); return lifecycle }
      timer = timers.schedule(() => {
        if (stopped) return
        try { host?.announce() } catch { stop() }
      }, 30_000)
      timerScheduled = true
      if (stopped) { cleanup(); return lifecycle }
    }
    if (!stopped) options.ready()
    return lifecycle
  } catch (error) {
    const cancelled = stopped
    stop()
    if (!cancelled) throw error
    return lifecycle
  }
}
