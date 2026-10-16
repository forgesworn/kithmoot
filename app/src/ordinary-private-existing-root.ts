import { OrdinaryLegacyStartupLifetime } from './ordinary-legacy-startup.js'
import { OrdinaryProtectedWorkerLifetime } from './ordinary-protected-worker.js'
import type { OrdinaryPrivateExistingCaptureResource } from './ordinary-state-owner.js'

const MARKER = 'kithmoot.ordinary-tab.v1'
const HEX = /^[0-9a-f]{64}$/
declare const privateRoot: unique symbol
export interface OrdinaryPrivateExistingRoot { readonly [privateRoot]: true }
export interface OrdinaryPrivateExistingRootBinding {
  readonly href: string
  readonly origin: string
  readonly marker: string
  readonly controller: ServiceWorker
  readonly generation: number
  readonly websocketImplementation: typeof WebSocket
  live(): boolean
  assertClientsCurrent(): Promise<void>
  revoke(): void
}
const roots = new WeakMap<object, { root: ExistingRoot; claimed: boolean }>()
const providerCommands = new WeakMap<object, {root: object; current: () => boolean}>()
/** Native owner consumer only. Spend the exact root-registered command before
 * capture consumption. A foreign, substituted or settled promise cannot mint
 * construction timing or consent. No root binding or owner is returned. */
export function claimOrdinaryPrivateExistingProviderCommand(root: OrdinaryPrivateExistingRoot, command: Promise<void>): void {
  const value = providerCommands.get(command)
  if (!value) hold()
  providerCommands.delete(command)
  if (value.root !== root || !value.current()) hold()
}
function hold(): never { throw new Error('Protected startup held') }
/** Invoke each fixed close synchronously, but represent even a synchronous
 * failure as a joined result so another resource's cleanup cannot be skipped. */
function joinClose(close: () => void | Promise<void>): Promise<void> {
  try { return Promise.resolve(close()) } catch (error) { return Promise.reject(error) }
}

/** Package-private native capture boundary. The actual root never escapes the
 * zero-argument entry below. Presence, a caller URL and a caller owner cannot
 * mint this binding. A proxy or repeated claim is refused. */
export function claimOrdinaryPrivateExistingRoot(root: OrdinaryPrivateExistingRoot): OrdinaryPrivateExistingRootBinding {
  const value = roots.get(root)
  if (!value || value.claimed) hold()
  const binding = value.root.claim()
  value.claimed = true
  return binding
}

class ExistingRoot {
  // Actual entry metadata is captured synchronously before the first await.
  readonly #href = location.href
  readonly #origin = location.origin
  readonly #controller = navigator.serviceWorker?.controller ?? null
  readonly #storage = sessionStorage
  readonly #marker = this.#storage.getItem(MARKER)
  readonly #generation = 1
  readonly #websocketImplementation = WebSocket
  readonly #startup = new OrdinaryLegacyStartupLifetime()
  #worker?: OrdinaryProtectedWorkerLifetime
  #capture?: OrdinaryPrivateExistingCaptureResource
  #provider?: OrdinaryPrivateExistingCaptureResource
  #beginProvider?: (root: OrdinaryPrivateExistingRoot, command: Promise<void>) => OrdinaryPrivateExistingCaptureResource
  #providerWork?: Promise<void>
  #providerOpening?: Promise<void>
  #work?: Promise<void>
  #opening?: Promise<void>
  #closing?: Promise<void>
  #lockWork?: Promise<void>
  #releaseTab?: () => void
  #workerClose?: Promise<void>
  #startupClose?: Promise<void>
  #stopFailure?: { readonly error: unknown }
  #closed = false
  #claimable = false
  #captureReady = false
  #startupAcquired = false
  #pagehide = () => { void this.close().catch(() => {}) }
  #changed = () => { void this.close().catch(() => {}) }

  constructor() {
    roots.set(this, { root: this, claimed: false })
    window.addEventListener('pagehide', this.#pagehide, { once: true })
    navigator.serviceWorker?.addEventListener('controllerchange', this.#changed)
  }
  #live(): boolean {
    try {
      return !this.#closed && this.#controller !== null &&
        navigator.serviceWorker.controller === this.#controller &&
        location.href === this.#href && location.origin === this.#origin &&
        this.#marker !== null && HEX.test(this.#marker) &&
        this.#storage.getItem(MARKER) === this.#marker && !!this.#worker?.live
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  claim(): OrdinaryPrivateExistingRootBinding {
    if (!this.#claimable || !this.#releaseTab || !this.#marker || !this.#controller) hold()
    this.#check()
    this.#claimable = false
    return Object.freeze({ href: this.#href, origin: this.#origin, marker: this.#marker,
      controller: this.#controller, generation: this.#generation, websocketImplementation: this.#websocketImplementation,
      live: () => this.#live(),
      assertClientsCurrent: async () => { this.#check(); await this.#worker!.assertCurrent(); this.#check() },
      revoke: () => { void this.close().catch(() => {}) } })
  }
  start(): Promise<void> {
    if (this.#opening) return this.#opening
    this.#work = this.#run()
    this.#opening = this.#work.then(async () => {
      // The checkpoint deliberately stops before provider/SDK/Session effects.
      // Retain the root, tab lock and MIGRATION until revocation/pagehide.
      if (!this.#live()) { await this.close(); return }
      this.#notice('captured-held')
    }, async () => {
      this.#stop()
      // #work is already terminal here; close cannot join itself.
      await this.close()
    })
    return this.#opening
  }
  restoreProvider(): Promise<void> {
    if (this.#providerOpening) return this.#providerOpening
    // Checkpoint callers must wait for the actual native capture. There is
    // no queued provider construction hidden behind initial startup work.
    if (!this.#captureReady || !this.#beginProvider || !this.#live()) {
      this.#stop()
      return this.close()
    }
    let resolve!: () => void, reject!: (error: unknown) => void
    const command = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Publish the exact command before native resource creation can revoke or
    // re-enter this root. The provider retains this same outer on both owners.
    this.#providerWork = command
    providerCommands.set(command, {root: this, current: () => this.#providerWork === command && this.#captureReady && this.#live()})
    void command.finally(() => providerCommands.delete(command)).catch(() => {})
    this.#providerOpening = this.#providerWork.then(async () => {
      if (!this.#live()) { await this.close(); return }
      this.#notice('provider-held')
    }, async () => { this.#stop(); await this.close() })
    try {
      this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)
      // Resource creation may synchronously revoke before assignment. Retain
      // that late resource and stop it; close joins it before releasing locks.
      if (this.#closed) this.#provider.stop()
      void this.#provider.completed.then(resolve, reject)
    } catch (error) { reject(error) }
    return this.#providerOpening
  }
  async #run(): Promise<void> {
    if (!this.#marker || !HEX.test(this.#marker) || !this.#origin || this.#origin === 'null' ||
        new URL(this.#href).origin !== this.#origin) hold()
    await this.#startup.acquire()
    this.#startupAcquired = true
    if (this.#closed) hold()
    if (await this.#startup.inspectPresence() !== 'existing' || this.#closed) hold()
    this.#worker = new OrdinaryProtectedWorkerLifetime()
    const prepared = await this.#worker.prepare()
    if (prepared !== 'ready' || this.#closed) hold()
    // Being controlled after worker installation cannot replace control at
    // document entry; this root's original controller must still be exact.
    this.#check()
    await new Promise<void>((resolve, reject) => {
      this.#lockWork = navigator.locks.request(`kithmoot-ordinary-state-v1:lifetime:${this.#marker}`,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock || this.#closed) { reject(new Error('Protected startup held')); return }
          await new Promise<void>(release => { this.#releaseTab = release; resolve() })
        }).then(() => {})
      void this.#lockWork.catch(reject)
    })
    this.#check()
    await this.#worker.assertCurrent()
    this.#check()
    // This is the first owner/crypto/SDK runtime import in the root graph.
    const native = await import('./ordinary-state-owner.js')
    this.#check()
    this.#beginProvider = native.beginOrdinaryPrivateExistingProvider
    this.#claimable = true
    this.#capture = native.beginOrdinaryPrivateExistingCapture(this as unknown as OrdinaryPrivateExistingRoot)
    // begin queues the fixed exclusive native WRITE operation synchronously.
    // Release only the initial shared WRITE; keep MIGRATION and the tab lock.
    await this.#startup.releaseInitialWrite()
    this.#check()
    await this.#capture.completed
    this.#check()
    this.#captureReady = true
  }
  #notice(state: 'held' | 'captured-held' | 'provider-held'): void {
    document.documentElement.dataset.ordinaryProtectedStartup = state
  }
  #stopOne(stop: () => void): void {
    try { stop() } catch (error) { this.#stopFailure ??= { error } }
  }
  #stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#claimable = false
    this.#captureReady = false
    if (this.#providerWork) providerCommands.delete(this.#providerWork)
    this.#stopOne(() => this.#notice('held'))
    // Before acquire's continuation no native reader or worker was started.
    // Abort a queued acquisition now; once acquired, retain MIGRATION until
    // the ordered close below joins every subsequently owned resource.
    if (!this.#startupAcquired) this.#stopOne(() => {
      this.#startupClose = this.#startup.close()
      void this.#startupClose.catch(() => {})
    })
    this.#stopOne(() => this.#provider?.stop())
    this.#stopOne(() => this.#capture?.stop())
    this.#stopOne(() => {
      this.#workerClose = this.#worker?.close()
      void this.#workerClose?.catch(() => {})
    })
    this.#stopOne(() => window.removeEventListener('pagehide', this.#pagehide))
    this.#stopOne(() => navigator.serviceWorker?.removeEventListener('controllerchange', this.#changed))
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    let resolve!: () => void, reject!: (error: unknown) => void
    this.#closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Publish the close promise before synchronous revocation callbacks can
    // re-enter close through a native resource.
    this.#stop()
    // Starting close synchronously revokes native transactions. Its join runs
    // alongside the root work so a blocked open retains its real terminal tail.
    const initialProvider = this.#provider, initialCapture = this.#capture
    const providerClose = joinClose(() => initialProvider?.close())
    const nativeClose = joinClose(() => initialCapture?.close())
    const nativeJoins = Promise.allSettled([providerClose, nativeClose])
    void (async () => {
      await this.#work?.catch(() => {})
      await this.#providerWork?.catch(() => {})
      // Rejection cannot skip another owned resource. Pending provider work
      // still retains the tab and MIGRATION locks until it has actually joined.
      const results = await nativeJoins
      // A synchronous revocation during provider construction can start close
      // before #provider is assigned. Join the actual late assignment too.
      // Failure order is first synchronous stop failure, initial provider,
      // initial capture, late provider, late capture, tab release, tab join,
      // worker, startup. Resolution order cannot skip a join or
      // change which error is reported. The same resource is never reclosed.
      results.push(...await Promise.allSettled([
        this.#provider !== initialProvider ? joinClose(() => this.#provider?.close()) : undefined,
        this.#capture !== initialCapture ? joinClose(() => this.#capture?.close()) : undefined,
      ]))
      results.push(...await Promise.allSettled([joinClose(() => this.#releaseTab?.())]))
      this.#releaseTab = undefined
      results.push(...await Promise.allSettled([this.#lockWork]))
      results.push(...await Promise.allSettled([this.#workerClose]))
      results.push(...await Promise.allSettled([joinClose(() => this.#startupClose ??= this.#startup.close())])) // MIGRATION last.
      if (this.#stopFailure) throw this.#stopFailure.error
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })().then(resolve, reject)
    return this.#closing
  }
}

let started: Promise<void> | undefined
let actualRoot: ExistingRoot | undefined
/** Unmounted existing-member checkpoint only. No root, owner, image, selector,
 * key, provider, signer or current-authority capability is returned. */
export function prepareOrdinaryPrivateExistingRoot(): Promise<void> {
  if (started) return started
  try { actualRoot = new ExistingRoot(); started = actualRoot.start() }
  catch { started = Promise.resolve(); document.documentElement.dataset.ordinaryProtectedStartup = 'held' }
  return started
}

/** Unmounted current-provider discovery checkpoint. All native/SDK objects
 * remain private; no member session, carrier or UI is activated. */
export function restoreOrdinaryPrivateExistingProviderRoot(): Promise<void> {
  // A cold checkpoint call waits for capture, then invokes construction
  // synchronously. Capture readiness supplies timing only, never consent.
  return prepareOrdinaryPrivateExistingRoot().then(() => actualRoot?.restoreProvider())
}
