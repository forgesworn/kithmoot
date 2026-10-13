import { HEADLESS_PROVIDER_EFFECT_BOUNDARY, createNip07Signer, type SignetSession, type SignetSigner, type SignerEffectBoundary } from 'signet-login'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner, captureOrdinaryForegroundProof } from './ordinary-foreground-signer.js'
import { ORDINARY_SIGNET_KEYS as keys } from './ordinary-signet-snapshot.js'
import { ORDINARY_INITIAL_LOGIN_KEY } from './ordinary-initial-login-snapshot.js'

interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  generation: number
  currentGeneration(): number
  live(): boolean
  checkClients(): Promise<void>
  stop(): void
}
const sdkKeys = Object.values(keys)
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name, store.get(name)!]))
function hold(): never { throw new OrdinaryStateHold() }
type Retained = Readonly<{ pubkey: string; authEvent: SignetSession['authEvent']; expiresAt?: number; displayName?: string }>

/** Owns one native NIP-07 restore and its raw SDK wrapper. Retained proof is
 * historical integrity evidence only. No new proof, persistence or silent
 * downgrade is performed; the coordinated root must mount this explicitly. */
export class OrdinaryExtensionRestore {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #work = new Set<Promise<unknown>>()
  #expected: readonly (string | null)[] | undefined
  #retained: Retained | undefined
  #raw: SignetSigner | undefined
  #source: SignetSession | undefined
  #foreground: OrdinaryForegroundSigner | undefined
  #called = false
  #closed = false
  #held = false
  #closing: Promise<void> | undefined
  #expiry: ReturnType<typeof setTimeout> | undefined
  private constructor(options: Options, browser: OrdinaryScope, tab: OrdinaryScope) {
    this.#options = options; this.#browserScope = browser; this.#tabScope = tab
  }
  #live = (): boolean => {
    if (this.#closed || this.#held) return false
    try {
      const now = Date.now(), valid = this.#options.live() === true && this.#options.currentGeneration() === this.#options.generation &&
        Number.isSafeInteger(now) && now >= 0 && now < this.#options.tab.expiresAt &&
        (this.#retained?.expiresAt === undefined || now < this.#retained.expiresAt)
      return valid && !this.#closed && !this.#held
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  #stop(): void {
    if (this.#held) return
    this.#held = true; this.#foreground?.revoke()
    queueMicrotask(() => { void this.close().catch(() => {}) })
    try { this.#options.stop() } catch { /* Held already revokes all effects. */ }
  }
  #scheduleExpiry(): void {
    const expires = Math.min(this.#options.tab.expiresAt, this.#retained?.expiresAt ?? this.#options.tab.expiresAt)
    this.#expiry = setTimeout(() => {
      if (this.#closed) return
      if (Date.now() >= expires) this.#stop()
      else this.#scheduleExpiry()
    }, Math.min(Math.max(1, expires - Date.now()), 2_147_483_647))
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser, this.#options.tab, pending)
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  async #clients(): Promise<void> { this.#check(); await this.#options.checkClients(); this.#check() }
  #preflight(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    const b = records(browser), t = records(tab)
    try {
      validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, custody))
      const values = sdkKeys.map(key => browser.get(key))
      if (tab.get(ORDINARY_INITIAL_LOGIN_KEY) !== null || browser.get(keys.pendingRedirect) !== null || browser.get(keys.pendingRelayAuth) !== null ||
          this.#expected && values.some((value, index) => value !== this.#expected![index])) hold()
      if (!this.#retained) {
        const pubkey = browser.get(keys.pubkey), proof = browser.get(keys.authEvent)
        if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey) || browser.get(keys.method) !== 'nip07' || !proof) hold()
        // The complete composer independently checks signature/origin/app at
        // signed time. Capture the actual foreground-compatible canonical shape
        // BEFORE any account request; preserve its exact retained JSON order.
        const captured = captureOrdinaryForegroundProof(JSON.parse(proof))
        if (captured.kind !== 21236 || JSON.stringify(captured) !== proof || captured.pubkey !== pubkey) hold()
        const authEvent = { ...captured, kind: 21236 as const }
        const expires = browser.get(keys.expiresAt), displayName = browser.get(keys.displayName)
        const retained = Object.freeze({ pubkey, authEvent,
          ...(expires === null ? {} : { expiresAt: Number(expires) }),
          ...(displayName === null ? {} : { displayName }) })
        if (retained.expiresAt !== undefined && Date.now() >= retained.expiresAt) hold()
        this.#retained = retained; this.#expected = Object.freeze(values)
      }
    } finally { b.clear(); t.clear() }
  }
  #read(work: () => void): Promise<void> {
    return OrdinaryStateOwner.readPairMigrated({ browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live: this.#live,
      work: (browser, tab, _b, _t, custody) => { this.#preflight(browser, tab, custody); this.#check(); work(); this.#check() } })
  }
  static async open(input: Options): Promise<OrdinaryExtensionRestore> {
    const options = { ...input }; let state: OrdinaryExtensionRestore | undefined
    try {
      if (HEADLESS_PROVIDER_EFFECT_BOUNDARY !== 1 || !Number.isSafeInteger(options.generation) || options.generation < 0 ||
          options.browser.purpose !== 'browser' || !/^tab:[0-9a-f]{64}$/.test(options.tab.purpose) || location.origin === 'null' || location.origin.length > 1024) hold()
      const live = () => options.live() === true && options.currentGeneration() === options.generation
      if (!live()) hold(); await options.checkClients(); if (!live()) hold()
      const browser = await options.browser.capture('@ordinary-signet', live), tab = await options.tab.capture('@ordinary-signet', live)
      state = new OrdinaryExtensionRestore(options, browser, tab)
      await state.#track(async () => { await state!.#clients(); await state!.#read(() => {}) })
      state.#scheduleExpiry(); return state
    } catch (error) { if (state) { state.#stop(); await state.close() } else { try { options.stop() } catch {} }; throw error }
  }
  restoreExtension(): Promise<Readonly<SignetSession>> {
    // Latch before any caller selector can re-enter or supersede restoration.
    if (this.#called || this.#held || this.#closed) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
    this.#called = true
    return this.#track(async () => {
      let active = true, starting = false, sdk: Promise<SignetSigner> | undefined
      const boundary: SignerEffectBoundary = Object.freeze({ start: <T>(provider: () => Promise<T>): Promise<T> => {
        if (!active || starting) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
        starting = true
        return this.#track(async () => {
          let operation: Promise<T> | undefined
          try {
            await this.#clients()
            await this.#read(() => {
              if (!active) hold()
              // Start under the complete fresh paired decision, then join the
              // provider outside the origin lock. Never return its promise here.
              try { operation = Promise.resolve(provider()) } catch (error) { operation = Promise.reject(error) }
              void operation.catch(() => {})
            })
            if (!operation) hold(); const value = await operation
            await this.#clients(); await this.#read(() => { if (!active) hold() }); this.#check(); return value
          } finally { if (operation) await Promise.allSettled([operation]); starting = false }
        })
      } })
      try {
        await this.#clients(); await this.#read(() => {})
        sdk = createNip07Signer(boundary); void sdk.catch(() => {})
        this.#raw = await sdk
        const retained = this.#retained!
        if (this.#raw.providerEffectBoundary !== 1 || this.#raw.method !== 'nip07' || this.#raw.pubkey !== retained.pubkey) hold()
        // No SDK restore helper: it may clear retained rows on discovery failure
        // and its initial effects are outside this versioned SDK contract.
        this.#source = Object.freeze({ ...retained, method: 'nip07', signer: this.#raw })
        await this.#clients(); await this.#read(() => {})
        this.#foreground = await OrdinaryForegroundSigner.open({ browser: this.#options.browser, tab: this.#options.tab,
          session: this.#source, currentSession: () => this.#source, generation: this.#options.generation,
          currentGeneration: this.#options.currentGeneration, live: this.#live, checkClients: this.#options.checkClients, stop: () => this.#stop() })
        await this.#clients(); await this.#read(() => {}); this.#check()
        return this.#foreground.session
      } catch (error) { this.#stop(); throw error }
      finally { active = false; if (sdk) await Promise.allSettled([sdk]) }
    })
  }
  revoke(): void { this.#stop() }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true; this.#stop(); if (this.#expiry !== undefined) clearTimeout(this.#expiry)
    this.#closing = (async () => {
      while (this.#work.size) await Promise.allSettled([...this.#work])
      await this.#foreground?.close(); await this.#raw?.close()
      this.#raw = undefined; this.#source = undefined; this.#retained = undefined; this.#expected = undefined
    })()
    return this.#closing
  }
}
