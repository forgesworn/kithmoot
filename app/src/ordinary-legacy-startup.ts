import { ORDINARY_DATABASE, ORDINARY_MIGRATION_LOCK, ORDINARY_WRITE_LOCK } from './ordinary-state-layout.js'

function hold(): never { throw new Error('Startup held') }

/** Resource lifetime only: never a state image, signer or recovery authority.
 * The fixed shared lease excludes the real migration writer. Committing to
 * legacy evaluation irreversibly retains it until the UA destroys this page. */
export class OrdinaryLegacyStartupLifetime {
  readonly #abort = new AbortController()
  readonly #reads = new Set<Promise<boolean>>()
  #acquiring?: Promise<void>
  #work?: Promise<void>
  #release?: () => void
  #closing?: Promise<void>
  #held = false
  #closed = false
  #committed = false
  #absent = false
  #inspected = false

  acquire(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Startup held'))
    if (this.#acquiring) return this.#acquiring
    if (!navigator.locks) return Promise.reject(new Error('Startup held'))
    this.#acquiring = new Promise<void>((resolve, reject) => {
      const work = Promise.resolve(navigator.locks.request(ORDINARY_MIGRATION_LOCK,
        { mode: 'shared', signal: this.#abort.signal }, async () => { await navigator.locks.request(ORDINARY_WRITE_LOCK,
        { mode: 'shared', signal: this.#abort.signal }, async () => {
          if (this.#closed) hold()
          this.#held = true
          await new Promise<void>(release => { this.#release = release; resolve() })
        }) }))
      this.#work = work
      void work.catch(reject)
    })
    return this.#acquiring
  }
  /** A stricter first-entry decision than semantic restoration: ANY existing
   * database holds. An aborted creation proves absence without installing a
   * database, loading SDK/crypto modules or inspecting protected contents. */
  assertAbsent(): Promise<void> {
    if (!this.#held || this.#closed || this.#committed || this.#inspected) return Promise.reject(new Error('Startup held'))
    this.#inspected = true
    const pending = new Promise<boolean>((resolve, reject) => {
      let missing = false, aborted = false, failed = false
      const request = indexedDB.open(ORDINARY_DATABASE)
      const finishAbsent = () => {
        if (missing && aborted && failed && request.error?.name === 'AbortError') resolve(true)
      }
      request.onupgradeneeded = event => {
        const transaction = request.transaction
        if (!transaction) { reject(new Error('Startup held')); return }
        if (event.oldVersion === 0 && event.newVersion === 1) {
          missing = true
          transaction.onabort = () => { aborted = true; finishAbsent() }
        }
        transaction.abort()
      }
      // A blocked request remains joined. No timeout can establish absence.
      request.onerror = () => {
        failed = true
        if (!missing || request.error?.name !== 'AbortError') reject(request.error)
        else finishAbsent()
      }
      request.onsuccess = () => { request.result.close(); resolve(false) }
    })
    this.#reads.add(pending)
    void pending.finally(() => this.#reads.delete(pending)).catch(() => {})
    return pending.then(absent => {
      if (this.#closed || !this.#held || !absent) hold()
      this.#absent = true
    })
  }
  commitLegacy(): void {
    if (!this.#held || this.#closed || this.#committed || !this.#absent || this.#reads.size) hold()
    this.#committed = true
    // There is deliberately no application release path after this point.
    this.#release = undefined
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    if (!this.#committed) this.#abort.abort()
    this.#closing = (async () => {
      await Promise.allSettled([...this.#reads])
      this.#release?.()
      this.#release = undefined
      await this.#work?.catch(() => {})
      this.#held = false
    })()
    return this.#closing
  }
}
