import type { SignetStorage } from 'signet-login'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'
import { ORDINARY_SIGNET_KEYS, validateOrdinarySignetSnapshot } from './ordinary-signet-snapshot.js'
export { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
const SESSION: readonly string[] = Object.freeze(['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName']
  .map(name => ORDINARY_SIGNET_KEYS[name as keyof typeof ORDINARY_SIGNET_KEYS]))
const SINGLE = new Set<string>([ORDINARY_SIGNET_KEYS.clientSk, ORDINARY_SIGNET_KEYS.pendingRedirect, ORDINARY_SIGNET_KEYS.pendingRelayAuth])
function hold(): never { throw new OrdinaryStateHold() }
type Values = Readonly<Record<string, string | null>>
function value(raw: unknown): asserts raw is string | null {
  if (raw !== null && (typeof raw !== 'string' || raw.length > ORDINARY_VALUE_UNITS)) hold()
}
function plain(raw: unknown, fields: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== fields.length || fields.some(name => !Object.hasOwn(raw, name))) hold()
}
function integer(raw: unknown): raw is number { return Number.isSafeInteger(raw) && (raw as number) >= 0 }
interface Options {
  owner: OrdinaryStateOwner
  generation: number
  currentGeneration(): number
  live(): boolean
  origin: string
  appName: string
  /** Known-account restore/operations bind to this exact account. An explicit
   * sign-in attempt can leave it unset until the verified proof supplies it. */
  account?: string
  checkClients(): Promise<void>
  stop(): void
}

/** Required Signet custody for one captured foreground. Opening requires a
 * completed migration and validates the whole SDK partition before any SDK
 * entropy, connection or restore. It supplies custody, never MLS authority
 * or independent rollback resistance. The caller requires the provider boundary
 * contract in pinned SDK v0.19.1. */
export class OrdinarySignetState implements SignetStorage {
  readonly required = true
  readonly #options: Options
  readonly #scope: OrdinaryScope
  readonly #work = new Set<Promise<unknown>>()
  #closed = false
  #held = false
  private constructor(options: Options, scope: OrdinaryScope) { this.#options = options; this.#scope = scope }
  #live = (): boolean => !this.#closed && !this.#held && this.#options.live() && this.#options.currentGeneration() === this.#options.generation
  #stop(): void { if (!this.#held) { this.#held = true; try { this.#options.stop() } catch { /* The held flag still revokes effects. */ } } }
  #check(): void { if (!this.#live()) hold() }
  #track<T>(work: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      try {
        this.#check(); await this.#options.checkClients(); this.#check()
        const result = await work()
        await this.#options.checkClients(); this.#check()
        return result
      } catch (error) { this.#stop(); throw error }
    })()
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  static async open(input: Options): Promise<OrdinarySignetState> {
    const options = { ...input }
    let state: OrdinarySignetState | undefined
    try {
      if (options.owner.purpose !== 'browser' || !integer(options.generation) || !options.origin || options.origin === 'null' || !options.appName ||
          options.account !== undefined && !/^[0-9a-f]{64}$/.test(options.account)) hold()
      try { if (new URL(options.origin).origin !== options.origin) hold() } catch { hold() }
      const live = () => options.live() && options.currentGeneration() === options.generation
      if (!live()) hold()
      await options.checkClients()
      const scope = await options.owner.capture('@ordinary-signet', live)
      state = new OrdinarySignetState(options, scope)
      const ready = state
      await ready.#track(() => options.owner.readMigrated(scope, ready.#live, store => { ready.#validate(store) }))
      return state
    } catch (error) {
      if (state) state.#stop()
      else { try { options.stop() } catch { /* No foreground may proceed after a failed open. */ } }
      throw error
    }
  }
  #validate(store: DeviceStore): void {
    validateOrdinarySignetSnapshot(new Map(store.keys().map(key => [key, store.get(key)!])), {
      kind: 'browser', origin: this.#options.origin, appName: this.#options.appName, account: this.#options.account,
    })
  }
  getItems(keys: readonly string[]): Promise<Values> {
    let captured: string[]
    try { if (!Array.isArray(keys)) hold(); captured = [...keys] }
    catch (error) { this.#stop(); return Promise.reject(error) }
    return this.#track(() => {
      if (captured.length !== SESSION.length || new Set(captured).size !== SESSION.length || captured.some(key => !SESSION.includes(key))) hold()
      return this.#options.owner.readMigrated(this.#scope, this.#live, store => {
        this.#validate(store)
        return Object.freeze(Object.fromEntries(captured.map(key => [key, store.get(key)])))
      })
    })
  }
  getItem(key: string): Promise<string | null> {
    return this.#track(() => {
      if (!SINGLE.has(key)) hold()
      return this.#options.owner.readMigrated(this.#scope, this.#live, store => { this.#validate(store); return store.get(key) })
    })
  }
  #snapshot(input: Values): Values {
    plain(input, SESSION)
    const copy = Object.fromEntries(SESSION.map(key => { value(input[key]); return [key, input[key]] }))
    return Object.freeze(copy)
  }
  setItems(changes: Values, expected: Values): Promise<boolean> {
    // Capture and validate before any asynchronous boundary; no caller alias
    // can alter the candidate or precondition while a native receipt is unknown.
    let next: Values, before: Values
    try { next = this.#snapshot(changes); before = this.#snapshot(expected) }
    catch (error) { this.#stop(); return Promise.reject(error) }
    return this.#track(() => this.#options.owner.compareAndMutateMigrated(this.#scope, this.#live, store => {
      this.#validate(store)
      if (SESSION.some(key => store.get(key) !== before[key])) return false
      for (const key of SESSION) { if (next[key] === null) store.remove(key); else store.set(key, next[key]!) }
      this.#validate(store); return true
    }))
  }
  compareAndSetItem(key: string, expected: string | null, next: string | null): Promise<boolean> {
    return this.#track(() => {
      if (!SINGLE.has(key)) hold()
      value(expected); value(next)
      return this.#options.owner.compareAndMutateMigrated(this.#scope, this.#live, store => {
        this.#validate(store)
        if (store.get(key) !== expected) return false
        if (next === null) store.remove(key); else store.set(key, next)
        this.#validate(store); return true
      })
    })
  }
  /** Required SDK paths must use conditional writes, never blind helpers. */
  setItem(_key: string, _value: string): Promise<void> { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
  removeItem(_key: string): Promise<void> { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
  async close(): Promise<void> { this.#closed = true; this.#stop(); await Promise.allSettled([...this.#work]) }
}
