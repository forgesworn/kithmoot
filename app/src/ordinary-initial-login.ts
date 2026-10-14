import { HEADLESS_PROVIDER_EFFECT_BOUNDARY, createNip07Signer, createSessionFromSigner, type SignetSession, type SignetSigner, type SignerEffectBoundary } from 'signet-login'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, ordinaryPairCustodyFor, ordinaryPairProjectedByteLengths, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner, captureOrdinaryForegroundSession } from './ordinary-foreground-signer.js'
import { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
import { ORDINARY_INITIAL_LOGIN_KEY, ORDINARY_INITIAL_LOGIN_MS, ORDINARY_INITIAL_LOGIN_SCOPE,
  ORDINARY_SIGNET_SESSION_NAMES, parseOrdinaryInitialLogin, type OrdinaryInitialLoginRecord } from './ordinary-initial-login-snapshot.js'

interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  generation: number
  currentGeneration(): number
  live(): boolean
  checkClients(): Promise<void>
  stop(): void
}
const sdkKeys = Object.values(ORDINARY_SIGNET_KEYS)
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name, store.get(name)!]))
function hold(): never { throw new OrdinaryStateHold() }
function validate(browser: Map<string, string>, tab: Map<string, string>, custody: OrdinaryPairCustody): void {
  validateOrdinarySnapshot(browser, tab, { browser: true, tab: true }, captureOrdinarySnapshotContext(browser, tab, custody))
}

/** One explicitly requested, initial extension login. Complete migration and
 * old-client fencing precede every effect. Session adoption into the production
 * root remains separate; only the native foreground wrapper escapes here. */
export class OrdinaryInitialLogin {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #origin: string
  readonly #work = new Set<Promise<unknown>>()
  #expected: readonly (string | null)[] | undefined
  #pendingRaw: string | undefined
  #pending: OrdinaryInitialLoginRecord | undefined
  #raw: SignetSigner | undefined
  #source: SignetSession | undefined
  #foreground: OrdinaryForegroundSigner | undefined
  #closed = false
  #held = false
  #called = false
  #closing: Promise<void> | undefined
  #expiry: ReturnType<typeof setTimeout> | undefined
  private constructor(options: Options, browser: OrdinaryScope, tab: OrdinaryScope) {
    this.#options = options; this.#browserScope = browser; this.#tabScope = tab; this.#origin = location.origin
    this.#scheduleExpiry()
  }
  #scheduleExpiry(): void {
    const left = this.#options.tab.expiresAt - Date.now()
    this.#expiry = setTimeout(() => {
      if (this.#closed) return
      if (Date.now() >= this.#options.tab.expiresAt) { this.revoke(); void this.close().catch(() => {}) }
      else this.#scheduleExpiry()
    }, Math.min(Math.max(1, left), 2_147_483_647))
  }
  #live = (): boolean => {
    if (this.#held || this.#closed) return false
    try {
      const valid = this.#options.live() === true && this.#options.currentGeneration() === this.#options.generation &&
        Number.isSafeInteger(Date.now()) && Date.now() >= 0 && Date.now() < this.#options.tab.expiresAt &&
        (!this.#pending || Date.now() < this.#pending.expiresAt)
      return valid && !this.#held && !this.#closed
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  #stop(): void {
    if (this.#held) return
    this.#held = true; this.#foreground?.revoke()
    queueMicrotask(() => { void this.close().catch(() => {}) })
    try { this.#options.stop() } catch { /* The held state already revokes effects. */ }
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser, this.#options.tab, pending)
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  async #clients(): Promise<void> { this.#check(); await this.#options.checkClients(); this.#check() }
  #record(custody: OrdinaryPairCustody, browser: Map<string, string>, tab: Map<string, string>, challenge: string, account: string | null): OrdinaryInitialLoginRecord {
    const headers = ordinaryPairCustodyFor(custody, browser, tab), createdAt = Date.now(), expiresAt = Math.min(createdAt + ORDINARY_INITIAL_LOGIN_MS, headers.tab.expiresAt)
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || createdAt < 0 || expiresAt <= createdAt) hold()
    return parseOrdinaryInitialLogin(JSON.stringify({ version: 1, method: 'nip07', origin: this.#origin, appName: 'KithMoot', challenge, account, createdAt, expiresAt,
      browser: { generation: headers.browser.generation, fence: this.#browserScope.fence },
      tab: { purpose: headers.tab.purpose, generation: headers.tab.generation, fence: this.#tabScope.fence } }), this.#origin)
  }
  #capacity(browser: Map<string, string>, tab: Map<string, string>, custody: OrdinaryPairCustody): void {
    // These are sizing-only placeholders. No fabricated signature or account
    // is validated, retained or promoted as evidence.
    const hex = 'f'.repeat(64), pending = this.#pending ?? this.#record(custody, browser, tab, hex, hex)
    const proposedBrowser = new Map(browser), proposedTab = new Map(tab)
    try {
      proposedTab.set(ORDINARY_INITIAL_LOGIN_KEY, JSON.stringify({ ...pending, account: hex }))
      ordinaryPairProjectedByteLengths(custody, browser, tab, { browser: proposedBrowser, tab: proposedTab }, true)
      proposedTab.delete(ORDINARY_INITIAL_LOGIN_KEY)
      const proof = JSON.stringify({ id: hex, pubkey: hex, sig: 'f'.repeat(128), kind: 21236, content: '', created_at: Number.MAX_SAFE_INTEGER,
        tags: [['challenge', hex], ['origin', this.#origin], ['app', 'KithMoot']] })
      for (const name of ORDINARY_SIGNET_SESSION_NAMES) proposedBrowser.delete(ORDINARY_SIGNET_KEYS[name])
      proposedBrowser.set(ORDINARY_SIGNET_KEYS.pubkey, hex); proposedBrowser.set(ORDINARY_SIGNET_KEYS.method, 'nip07'); proposedBrowser.set(ORDINARY_SIGNET_KEYS.authEvent, proof)
      ordinaryPairProjectedByteLengths(custody, browser, tab, { browser: proposedBrowser, tab: proposedTab }, true)
    } finally { proposedBrowser.clear(); proposedTab.clear() }
  }
  #preflight(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    const b = records(browser), t = records(tab)
    try {
      validate(b, t, custody)
      const values = sdkKeys.map(key => browser.get(key))
      if (this.#expected && values.some((value, i) => value !== this.#expected![i]) ||
          tab.get(ORDINARY_INITIAL_LOGIN_KEY) !== (this.#pendingRaw ?? null)) hold()
      if (!this.#expected) {
        if (ORDINARY_SIGNET_SESSION_NAMES.some(name => browser.get(ORDINARY_SIGNET_KEYS[name]) !== null) ||
            browser.get(ORDINARY_SIGNET_KEYS.pendingRedirect) !== null || browser.get(ORDINARY_SIGNET_KEYS.pendingRelayAuth) !== null) hold()
        this.#expected = Object.freeze(values)
      }
      if (!this.#source) this.#capacity(b, t, custody)
    } finally { b.clear(); t.clear() }
  }
  #pair(work: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => void, mutate = false): Promise<void> {
    const method = mutate ? OrdinaryStateOwner.retainPairScopesMigrated : OrdinaryStateOwner.readPairMigrated
    return method.call(OrdinaryStateOwner, { browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live: this.#live,
      work: (browser: DeviceStore, tab: DeviceStore, _b: readonly string[], _t: readonly string[], custody: OrdinaryPairCustody) => {
        this.#preflight(browser, tab, custody); this.#check(); work(browser, tab, custody); this.#check()
        if (mutate) { const b = records(browser), t = records(tab); try { validate(b, t, custody) } finally { b.clear(); t.clear() } }
      } }) as Promise<void>
  }
  static async open(input: Options): Promise<OrdinaryInitialLogin> {
    const options = { ...input }; let state: OrdinaryInitialLogin | undefined
    try {
      if (HEADLESS_PROVIDER_EFFECT_BOUNDARY !== 1 || !Number.isSafeInteger(options.generation) || options.generation < 0 || options.browser.purpose !== 'browser' ||
          !/^tab:[0-9a-f]{64}$/.test(options.tab.purpose) || location.origin === 'null' || location.origin.length > 1024) hold()
      const live = () => options.live() === true && options.currentGeneration() === options.generation
      if (!live()) hold(); await options.checkClients(); if (!live()) hold()
      const browser = await options.browser.capture(ORDINARY_INITIAL_LOGIN_SCOPE, live), tab = await options.tab.capture(ORDINARY_INITIAL_LOGIN_SCOPE, live)
      state = new OrdinaryInitialLogin(options, browser, tab)
      await state.#track(async () => { await state!.#clients(); await state!.#pair(() => {}) })
      return state
    } catch (error) { if (state) { state.#stop(); await state.close() } else { try { options.stop() } catch {} }; throw error }
  }
  /** This class owns the raw SDK wrapper. Consumers receive only the native
   * foreground wrapper and must close this owner on reset/exit. */
  loginExtension(): Promise<Readonly<SignetSession>> {
    if (this.#called || this.#held || this.#closed) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
    this.#called = true
    return this.#track(async () => {
      let active = true, starting = false, sdk: Promise<unknown> | undefined
      const boundary: SignerEffectBoundary = Object.freeze({ start: <T>(provider: () => Promise<T>): Promise<T> => {
        if (!active || starting) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
        starting = true
        return this.#track(async () => {
          let operation: Promise<T> | undefined
          try {
            await this.#clients()
            await this.#pair(() => { if (!active) hold(); try { operation = Promise.resolve(provider()) } catch (error) { operation = Promise.reject(error) }; void operation.catch(() => {}) })
            if (!operation) hold(); const value = await operation
            await this.#clients(); await this.#pair(() => { if (!active) hold() }); this.#check(); return value
          } finally { if (operation) await Promise.allSettled([operation]); starting = false }
        })
      } })
      try {
        await this.#clients()
        let prepared: OrdinaryInitialLoginRecord | undefined
        await this.#pair((browser, tab, custody) => {
          const b = records(browser), t = records(tab)
          try {
            const challenge = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
            prepared = this.#record(custody, b, t, challenge, null)
          } finally { b.clear(); t.clear() }
        })
        if (!prepared) hold()
        const initial = JSON.stringify(prepared)
        await this.#clients(); await this.#pair((_browser, tab) => tab.set(ORDINARY_INITIAL_LOGIN_KEY, initial), true)
        this.#pendingRaw = initial; this.#pending = prepared
        await this.#clients(); await this.#pair(() => {})
        sdk = createNip07Signer(boundary); void sdk.catch(() => {})
        this.#raw = await sdk as SignetSigner
        if (this.#raw.method !== 'nip07' || this.#raw.providerEffectBoundary !== 1) hold()
        const selected = parseOrdinaryInitialLogin(JSON.stringify({ ...prepared, account: this.#raw.pubkey }), this.#origin)
        const selectedRaw = JSON.stringify(selected)
        await this.#clients(); await this.#pair((_browser, tab) => tab.set(ORDINARY_INITIAL_LOGIN_KEY, selectedRaw), true)
        this.#pendingRaw = selectedRaw; this.#pending = selected
        sdk = createSessionFromSigner(this.#raw, { appName: 'KithMoot', origin: this.#origin, challenge: selected.challenge, boundary }); void sdk.catch(() => {})
        // Refuse any proof/session shape the actual foreground adapter cannot
        // consume before changing native session custody.
        const source = captureOrdinaryForegroundSession(await sdk as SignetSession)
        if (source.pubkey !== selected.account || source.method !== 'nip07' || source.signer !== this.#raw || source.authEvent.pubkey !== selected.account) hold()
        const proof = JSON.stringify(source.authEvent)
        let expected: readonly (string | null)[] | undefined
        await this.#clients(); await this.#pair((browser, tab) => {
          for (const name of ORDINARY_SIGNET_SESSION_NAMES) browser.remove(ORDINARY_SIGNET_KEYS[name])
          browser.set(ORDINARY_SIGNET_KEYS.pubkey, source.pubkey); browser.set(ORDINARY_SIGNET_KEYS.method, 'nip07'); browser.set(ORDINARY_SIGNET_KEYS.authEvent, proof)
          tab.remove(ORDINARY_INITIAL_LOGIN_KEY); expected = Object.freeze(sdkKeys.map(key => browser.get(key)))
        }, true)
        this.#expected = expected; this.#pendingRaw = undefined; this.#pending = undefined; this.#source = source
        await this.#clients(); await this.#pair(() => {})
        this.#foreground = await OrdinaryForegroundSigner.open({ browser: this.#options.browser, tab: this.#options.tab, session: source,
          currentSession: () => this.#source, generation: this.#options.generation, currentGeneration: this.#options.currentGeneration,
          live: this.#live, checkClients: this.#options.checkClients, stop: () => this.#stop() })
        await this.#clients(); await this.#pair(() => {}); this.#check()
        return this.#foreground.session
      } catch (error) { this.#stop(); throw error }
      finally { active = false; if (sdk) await Promise.allSettled([sdk]) }
    })
  }
  /** Fencing and retention happen before old results can be adopted. This
   * cannot abort a wallet request; its old owner must still join that request. */
  static async cancelPending(input: Options): Promise<void> {
    const options = { ...input }, live = () => options.live() === true && options.currentGeneration() === options.generation
    if (!Number.isSafeInteger(options.generation) || options.generation < 0) hold()
    if (!live()) hold(); await options.checkClients(); if (!live()) hold()
    const browser = await options.browser.capture(ORDINARY_INITIAL_LOGIN_SCOPE, live), tab = await options.tab.capture(ORDINARY_INITIAL_LOGIN_SCOPE, live)
    await OrdinaryStateOwner.forgetPairMigrated({ browser: { owner: options.browser, scope: browser }, tab: { owner: options.tab, scope: tab }, live,
      work: (browserStore, tabStore, _b, _t, custody) => {
        const b = records(browserStore), t = records(tabStore)
        try { validate(b, t, custody); if (!t.has(ORDINARY_INITIAL_LOGIN_KEY)) hold(); tabStore.remove(ORDINARY_INITIAL_LOGIN_KEY) }
        finally { b.clear(); t.clear() }
      } })
    await options.checkClients(); if (!live()) hold()
  }
  revoke(): void { this.#stop() }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true; this.#stop(); if (this.#expiry !== undefined) clearTimeout(this.#expiry)
    this.#closing = (async () => {
      await Promise.allSettled([...this.#work]); await this.#foreground?.close(); await this.#raw?.close()
      this.#source = undefined; this.#raw = undefined; this.#pending = undefined; this.#pendingRaw = undefined
    })()
    return this.#closing
  }
}
