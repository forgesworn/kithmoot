import type { SignetAuthEvent, SignetStorage } from 'signet-login'
import { verifyLogin } from 'signet-login/verify'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'

/** Exact SDK namespace. No room, participant or unrelated preference writer
 * is exposed through this adapter. Values remain inside the native image. */
export const ORDINARY_SIGNET_KEYS = Object.freeze({
  pubkey: 'signet:login.pubkey', method: 'signet:login.method', authEvent: 'signet:login.authEvent',
  bunkerUri: 'signet:login.bunkerUri', bunkerClientSk: 'signet:login.bunkerClientSk',
  expiresAt: 'signet:login.expiresAt', displayName: 'signet:login.displayName',
  clientSk: 'signet:login.clientSk', pendingRedirect: 'signet:login.pendingRedirect',
  pendingRelayAuth: 'signet:login.pendingRelayAuth',
})
const SESSION: readonly string[] = Object.freeze(['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName']
  .map(name => ORDINARY_SIGNET_KEYS[name as keyof typeof ORDINARY_SIGNET_KEYS]))
const SINGLE = new Set<string>([ORDINARY_SIGNET_KEYS.clientSk, ORDINARY_SIGNET_KEYS.pendingRedirect, ORDINARY_SIGNET_KEYS.pendingRelayAuth])
const ALL: readonly string[] = Object.values(ORDINARY_SIGNET_KEYS)
const HEX = /^[0-9a-f]{64}$/i
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
function secret(raw: string): void {
  if (!HEX.test(raw)) hold()
  const bytes = hexToBytes(raw)
  try { getPublicKey(bytes) } catch { hold() } finally { bytes.fill(0) }
}
function relay(raw: unknown): void {
  if (typeof raw !== 'string') hold()
  try {
    const url = new URL(raw)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) hold()
  } catch { hold() }
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
 * or independent rollback resistance. SDK v0.18.0 is required by the caller. */
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
    if (store.keys().some(key => key.startsWith('signet:login.') && !ALL.includes(key))) hold()
    const values = Object.fromEntries(ALL.map(key => [key, store.get(key)]))
    for (const raw of Object.values(values)) value(raw)
    const k = ORDINARY_SIGNET_KEYS
    if (values[k.clientSk] !== null) secret(values[k.clientSk]!)
    for (const [key, fields] of [
      [k.pendingRedirect, ['challenge', 'origin', 'appName', 'createdAt']],
      [k.pendingRelayAuth, ['challenge', 'origin', 'appName', 'relayUrl', 'sessionSkHex', 'issuedAt']],
    ] as const) if (values[key] !== null) {
      let record: unknown
      try { record = JSON.parse(values[key]!) } catch { hold() }
      plain(record, fields)
      if (typeof record.challenge !== 'string' || !HEX.test(record.challenge) || record.origin !== this.#options.origin || record.appName !== this.#options.appName) hold()
      if (key === k.pendingRedirect) { if (!integer(record.createdAt)) hold() }
      else {
        if (!integer(record.issuedAt) || typeof record.sessionSkHex !== 'string') hold()
        secret(record.sessionSkHex); relay(record.relayUrl)
      }
    }
    if (SESSION.every(key => values[key] === null)) return
    const pubkey = values[k.pubkey], method = values[k.method], proof = values[k.authEvent]
    if (!pubkey || !HEX.test(pubkey) || !method || !['nip07', 'redirect', 'bunker', 'amber'].includes(method) || !proof ||
        this.#options.account !== undefined && pubkey.toLowerCase() !== this.#options.account) hold()
    let parsed: unknown
    try { parsed = JSON.parse(proof) } catch { hold() }
    plain(parsed, ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig'])
    if (!integer(parsed.created_at) || !Array.isArray(parsed.tags) || parsed.tags.length > 128 ||
        parsed.tags.some(tag => !Array.isArray(tag) || tag.length > 32 || tag.some(part => typeof part !== 'string' || part.length > 1024))) hold()
    const bindings = (name: string) => (parsed.tags as string[][]).filter(tag => tag[0] === name)
    const challenge = bindings('challenge'), origin = bindings('origin'), app = bindings('app')
    if (challenge.length !== 1 || challenge[0]!.length !== 2 || origin.length !== 1 || origin[0]!.length !== 2 ||
        app.length > 1 || app.length === 1 && (app[0]!.length !== 2 || app[0]![1] !== this.#options.appName)) hold()
    const event = parsed as unknown as SignetAuthEvent
    if (event.pubkey !== pubkey) hold()
    // Stored proof integrity is checked at its signed time. It is not a fresh
    // server login and is never accepted as MLS membership evidence here.
    const checked = verifyLogin(event, { expectedOrigin: this.#options.origin,
      expectedChallenge: challenge[0]![1]!, now: () => event.created_at * 1000 })
    if (!checked.valid || checked.pubkey !== pubkey) hold()
    const expires = values[k.expiresAt]
    if (expires !== null && (!integer(Number(expires)) || String(Number(expires)) !== expires)) hold()
    if (method === 'bunker') {
      if (!values[k.bunkerClientSk] || !values[k.bunkerUri]) hold()
      secret(values[k.bunkerClientSk]!)
      try {
        const url = new URL(values[k.bunkerUri]!)
        if (url.protocol !== 'bunker:' || !HEX.test(url.hostname) || url.username || url.password || url.hash || url.pathname || !url.searchParams.getAll('relay').length) hold()
        for (const item of url.searchParams.getAll('relay')) relay(item)
      } catch { hold() }
    } else if (values[k.bunkerClientSk] !== null || values[k.bunkerUri] !== null) hold()
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
