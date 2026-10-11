/** An exact room-operation scope. This carries no grant preparation or
 * readiness. Only its concrete foreground can validate or settle its work. */
export interface MlsRoomForegroundScope {
  readonly account: string
  readonly signal: AbortSignal
  current(): boolean
}
export type MlsRoomForegroundResult<T> = { state: 'done'; value: T } | { state: 'interrupted' } | { state: 'busy' }
interface Owned {
  scope: MlsRoomForegroundScope
  controller: AbortController
  tasks: Set<Promise<unknown>>
  errors: unknown[]
}
const interrupted = (): MlsRoomForegroundResult<never> => ({ state: 'interrupted' })
const stale = () => new Error('The development room operation is no longer current.')
function wipe(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0)
  else if (ArrayBuffer.isView(value)) new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0)
  else for (const item of Object.values(value)) wipe(item, seen)
}

/** Room-only foreground ownership. Unlike grant foreground, this never opens
 * or migrates grant storage. The application owner supplies its captured account
 * predicate and keeps this object private. Callback cleanup must finish before
 * it returns; never await settled() from inside that callback or a tracked task.
 * Endpoint control work is owned by BrowserLink's native lifecycle, rather than
 * recursively registered as an operation waiting for its own shutdown. */
export class BrowserMlsRoomForeground {
  #owned?: Owned
  #epoch = 0
  #settled: Promise<void> = Promise.resolve()

  capture(): MlsRoomForegroundScope | undefined {
    const scope = this.#owned?.scope
    return scope?.current() ? scope : undefined
  }
  active(scope: MlsRoomForegroundScope): boolean {
    return this.#owned?.scope === scope && scope.current()
  }
  invalidate(): void { this.#epoch++; this.#owned?.controller.abort() }

  track<T>(scope: MlsRoomForegroundScope, work: () => Promise<T>): Promise<T> {
    const owned = this.#owned
    if (!owned || owned.scope !== scope || !this.active(scope)) return Promise.reject(stale())
    const task = Promise.resolve().then(async () => {
      if (!this.active(scope)) throw stale()
      const result = await work()
      if (!this.active(scope)) { wipe(result); throw stale() }
      return result
    }).catch(error => { owned.errors.push(error); throw error }).finally(() => owned.tasks.delete(task))
    owned.tasks.add(task)
    void task.catch(() => {})
    return task
  }

  /** Joins real nested work, excluding the outer callback which may itself
   * be awaiting endpoint shutdown. Use only from an external owner or endpoint
   * release; a tracked task must never wait for its own drain. */
  async drain(scope: MlsRoomForegroundScope): Promise<void> {
    const owned = this.#owned
    if (!owned || owned.scope !== scope) throw stale()
    while (owned.tasks.size) await Promise.allSettled([...owned.tasks])
  }
  settled(): Promise<void> { return this.#settled }
  async invalidateAndWait(): Promise<void> { this.invalidate(); await this.settled() }

  async run<T>(account: string, current: () => boolean,
    work: (scope: MlsRoomForegroundScope) => Promise<T>): Promise<MlsRoomForegroundResult<T>> {
    if (!/^[0-9a-f]{64}(?![\s\S])/.test(account)) throw stale()
    if (this.#owned) return { state: 'busy' }
    if (typeof current !== 'function' || typeof work !== 'function') throw stale()
    const controller = new AbortController(), epoch = this.#epoch
    const scope: MlsRoomForegroundScope = Object.freeze({ account, signal: controller.signal,
      current: () => {
        try { return this.#owned?.scope === scope && !controller.signal.aborted && epoch === this.#epoch &&
          document.visibilityState === 'visible' && current() === true } catch { return false }
      } })
    const owned: Owned = { scope, controller, tasks: new Set(), errors: [] }
    this.#owned = owned
    let resolveSettled!: () => void
    this.#settled = new Promise<void>(resolve => { resolveSettled = resolve })
    const operation = Promise.resolve().then(async () => {
      if (!this.active(scope)) throw stale()
      return work(scope)
    })
    let value: T | undefined
    try {
      value = await operation
      await this.drain(scope)
      if (!this.active(scope)) { wipe(value); return interrupted() }
      if (owned.errors.length) throw owned.errors[0]
      return { state: 'done', value }
    } catch (error) {
      await this.drain(scope)
      wipe(value)
      if (!this.active(scope)) return interrupted()
      throw error
    } finally {
      controller.abort()
      if (this.#owned === owned) this.#owned = undefined
      resolveSettled()
    }
  }
}
