import { OrdinaryClientFence } from './ordinary-state-clients.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

function hold(): never { throw new OrdinaryStateHold() }

/** Worker compatibility and resource lifetime only. This cannot read private
 * state, select an account or grant restoration/provider/session authority.
 * The private root must construct it after its pure existing-state decision,
 * retain MIGRATION throughout, and join close before releasing that lease. */
export class OrdinaryProtectedWorkerLifetime {
  readonly #url = new URL('/j/sw.js', location.origin).href
  readonly #scope = new URL('/j/', location.origin).href
  readonly #controller: ServiceWorker | null
  readonly #fence: OrdinaryClientFence
  readonly #work = new Set<Promise<unknown>>()
  #registration?: ServiceWorkerRegistration
  #opening?: Promise<'ready' | 'controlled-reload-required'>
  #closing?: Promise<void>
  #closed = false
  #ready = false
  #changed = () => this.#stop()

  constructor() {
    if (!navigator.serviceWorker || !navigator.locks) hold()
    this.#controller = navigator.serviceWorker.controller
    // The responder must exist before this document asks the origin-wide
    // worker inventory to acknowledge it, including uncontrolled windows.
    this.#fence = new OrdinaryClientFence()
    navigator.serviceWorker.addEventListener('controllerchange', this.#changed)
  }
  #current(): boolean {
    const registration = this.#registration, controller = this.#controller
    return !!controller && !!registration && controller === navigator.serviceWorker.controller &&
      controller === registration.active && controller.state === 'activated' &&
      controller.scriptURL === this.#url && registration.scope === this.#scope
  }
  get live(): boolean { return this.#ready && !this.#closed && this.#fence.live && this.#current() }
  #check(): void { if (this.#closed || !this.#fence.live) hold() }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  prepare(): Promise<'ready' | 'controlled-reload-required'> {
    if (this.#closed) return Promise.reject(new OrdinaryStateHold())
    if (this.#opening) return this.#opening
    this.#opening = this.#track(Promise.resolve().then(async () => {
      try {
        this.#check()
        const registration = await navigator.serviceWorker.register(this.#url,
          { scope: this.#scope, updateViaCache: 'none' })
        this.#registration = registration
        if (registration.scope !== this.#scope) hold()
        if (!registration.active) {
          const worker = registration.installing ?? registration.waiting
          if (!worker || worker.scriptURL !== this.#url) hold()
          // Installing a public worker is not native private custody. Still
          // retain its real terminal transition if close happens meanwhile.
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (worker.state !== 'activated' && worker.state !== 'redundant') return
              worker.removeEventListener('statechange', changed)
              worker.state === 'activated' ? resolve() : reject(new OrdinaryStateHold())
            }
            worker.addEventListener('statechange', changed)
            changed()
          })
        }
        this.#check()
        // A first uncontrolled document must reload even if a worker becomes
        // active. No origin/path/version label substitutes for actual control.
        if (!this.#current()) return 'controlled-reload-required'
        await this.#fence.assertCurrent()
        this.#check()
        if (!this.#current()) hold()
        this.#ready = true
        return 'ready'
      } catch (error) { this.#stop(); throw error }
    }))
    return this.#opening
  }
  assertCurrent(): Promise<void> {
    return this.#track(Promise.resolve().then(async () => {
      try {
        if (!this.live) hold()
        await this.#fence.assertCurrent()
        if (!this.live) hold()
      } catch (error) { this.#stop(); throw error }
    }))
  }
  #stop(): void {
    this.#closed = true
    this.#ready = false
    this.#fence.close()
    navigator.serviceWorker.removeEventListener('controllerchange', this.#changed)
  }
  close(): Promise<void> {
    this.#stop()
    if (this.#closing) return this.#closing
    // Never call close from the tracked prepare/assert continuation itself.
    this.#closing = (async () => {
      while (this.#work.size) await Promise.allSettled([...this.#work])
    })()
    return this.#closing
  }
}
