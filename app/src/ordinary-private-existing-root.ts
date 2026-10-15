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
  live(): boolean
  assertClientsCurrent(): Promise<void>
  revoke(): void
}
const roots = new WeakMap<object, { root: ExistingRoot; claimed: boolean }>()
function hold(): never { throw new Error('Protected startup held') }

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
  readonly #startup = new OrdinaryLegacyStartupLifetime()
  #worker?: OrdinaryProtectedWorkerLifetime
  #capture?: OrdinaryPrivateExistingCaptureResource
  #work?: Promise<void>
  #opening?: Promise<void>
  #closing?: Promise<void>
  #lockWork?: Promise<void>
  #releaseTab?: () => void
  #workerClose?: Promise<void>
  #closed = false
  #claimable = false
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
      controller: this.#controller, generation: this.#generation,
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
      this.#notice('held')
      // #work is already terminal here; close cannot join itself.
      await this.close()
    })
    return this.#opening
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
    this.#claimable = true
    this.#capture = native.beginOrdinaryPrivateExistingCapture(this as unknown as OrdinaryPrivateExistingRoot)
    // begin queues the fixed exclusive native WRITE operation synchronously.
    // Release only the initial shared WRITE; keep MIGRATION and the tab lock.
    await this.#startup.releaseInitialWrite()
    this.#check()
    await this.#capture.completed
    this.#check()
  }
  #notice(state: 'held' | 'captured-held'): void {
    document.documentElement.dataset.ordinaryProtectedStartup = state
  }
  #stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#claimable = false
    this.#notice('held')
    // Before acquire's continuation no native reader or worker was started.
    // Abort a queued acquisition now; once acquired, retain MIGRATION until
    // the ordered close below joins every subsequently owned resource.
    if (!this.#startupAcquired) void this.#startup.close().catch(() => {})
    this.#capture?.stop()
    this.#workerClose = this.#worker?.close()
    window.removeEventListener('pagehide', this.#pagehide)
    navigator.serviceWorker?.removeEventListener('controllerchange', this.#changed)
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
    const nativeClose = this.#capture?.close()
    void (async () => {
      await this.#work?.catch(() => {})
      await nativeClose
      this.#releaseTab?.()
      this.#releaseTab = undefined
      await this.#lockWork?.catch(() => {})
      await this.#workerClose
      await this.#startup.close() // MIGRATION is released last.
    })().then(resolve, reject)
    return this.#closing
  }
}

let started: Promise<void> | undefined
/** Unmounted existing-member checkpoint only. No root, owner, image, selector,
 * key, provider, signer or current-authority capability is returned. */
export function prepareOrdinaryPrivateExistingRoot(): Promise<void> {
  if (started) return started
  try { started = new ExistingRoot().start() }
  catch { started = Promise.resolve(); document.documentElement.dataset.ordinaryProtectedStartup = 'held' }
  return started
}
