import { OrdinaryStateHold, type OrdinaryPurpose } from './ordinary-state-codec.js'
import { OrdinaryStateOwner } from './ordinary-state-owner.js'

export const ORDINARY_TAB_MARKER = 'kithmoot.ordinary-tab.v1'
export const ORDINARY_TAB_LIFETIME_MS = 12 * 60 * 60 * 1000
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }

/** Owns one encrypted tab namespace across reloads. The marker contains no
 * room, account, participant or key material. The app still has to migrate
 * and validate its complete tab state before creating identities or effects. */
export class OrdinaryTabLifetime {
  #owner?: OrdinaryStateOwner
  #maintenance?: OrdinaryStateOwner
  #closed = false
  #expiresAt = 0
  #release?: () => void
  #lockWork?: Promise<void>
  #opening?: Promise<void>
  #timer?: ReturnType<typeof setTimeout>
  #pagehide = () => { void this.close().catch(() => {}) }
  readonly #options: { storage: Storage; live(): boolean; stop(): void }

  constructor(options: { storage: Storage; live(): boolean; stop(): void }) {
    this.#options = { ...options }
  }
  /** The lifetime owns native uncertainty, including expired-row cleanup. */
  get holdingRetention(): boolean { return !!(this.#maintenance?.holdingRetention || this.#owner?.holdingRetention) }
  retryRetention(): void { this.#maintenance?.retryRetention(); this.#owner?.retryRetention() }
  get live(): boolean { return !!this.#owner && this.#custodyLive() }
  #custodyLive(): boolean { return !this.#closed && this.#options.live() && (!this.#expiresAt || Date.now() < this.#expiresAt) }
  get owner(): OrdinaryStateOwner { if (!this.live || !this.#owner) hold(); return this.#owner }
  get expiresAt(): number { return this.#expiresAt }

  static async open(options: { storage: Storage; live(): boolean; stop(): void }): Promise<OrdinaryTabLifetime> {
    const lifetime = new OrdinaryTabLifetime(options)
    try { await lifetime.prepare(); return lifetime }
    catch (error) { await lifetime.close(); throw error }
  }
  prepare(): Promise<void> {
    if (this.#opening) return this.#opening
    this.#opening = this.#open().catch(async error => {
      this.#stop(); await this.#finish(); throw error
    })
    return this.#opening
  }
  #check(): void { if (!this.#custodyLive()) hold() }
  async #open(): Promise<void> {
    this.#check()
    if (!navigator.locks) hold()
    let marker: string | null
    try { marker = this.#options.storage.getItem(ORDINARY_TAB_MARKER) } catch { hold() }
    const restoring = marker !== null
    if (restoring && !HEX.test(marker!)) hold()
    if (!restoring) {
      marker = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      try {
        this.#options.storage.setItem(ORDINARY_TAB_MARKER, marker)
        if (this.#options.storage.getItem(ORDINARY_TAB_MARKER) !== marker) hold()
      } catch { hold() }
    }
    const purpose: OrdinaryPurpose = `tab:${marker!}`
    // A duplicate/cloned marker never queues behind the live tab or silently
    // replaces its identity. Keep this lock until native retention has joined.
    await new Promise<void>((resolve, reject) => {
      const lockWork = navigator.locks.request(`kithmoot-ordinary-state-v1:lifetime:${marker}`,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) { reject(new OrdinaryStateHold()); return }
          await new Promise<void>(release => { this.#release = release; resolve() })
        }).then(() => {})
      this.#lockWork = lockWork
      void lockWork.catch(reject)
    })
    this.#check()
    const savedExpiry = await OrdinaryStateOwner.tabLease(purpose, () => this.#custodyLive())
    this.#check()
    // A persisted marker with missing custody cannot prove first use. A cut
    // before first native preparation also holds for explicit recovery.
    if (restoring && savedExpiry === undefined) hold()
    if (!restoring && savedExpiry !== undefined) hold()
    if (savedExpiry !== undefined && savedExpiry > Date.now() + ORDINARY_TAB_LIFETIME_MS) hold()
    await OrdinaryStateOwner.expireTabs(() => this.#custodyLive(), owner => { this.#maintenance = owner })
    this.#check()
    if (savedExpiry !== undefined && Date.now() >= savedExpiry) hold()
    this.#expiresAt = savedExpiry ?? Date.now() + ORDINARY_TAB_LIFETIME_MS
    this.#owner = new OrdinaryStateOwner(purpose, this.#expiresAt)
    this.#timer = setTimeout(() => { void this.close().catch(() => {}) }, this.#expiresAt - Date.now())
    window.addEventListener('pagehide', this.#pagehide)
  }
  /** Revokes effects synchronously; native handoffs finish before the lifetime
   * lock is released. Closing does not extend custody or remove a reload marker. */
  #stop(): void {
    if (!this.#closed) {
      this.#closed = true
      try { this.#options.stop() } catch { /* A caller cannot restore liveness. */ }
      if (this.#timer !== undefined) clearTimeout(this.#timer)
      window.removeEventListener('pagehide', this.#pagehide)
    }
  }
  async #finish(): Promise<void> {
    await this.#owner?.close()
    this.#release?.()
    await this.#lockWork?.catch(() => {})
  }
  async close(): Promise<void> {
    this.#stop()
    await this.#opening?.catch(() => {})
    await this.#finish()
  }
}
