import { verifyEvent } from 'nostr-tools/pure'
import { normaliseArtwork, MAX_CHAT_ARTWORK } from '../../src/artwork.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { MAX_KEPT, type KeptPendingSend, type PendingStorage } from './pending-sends.js'

const LOCK = 'kithmoot-ordinary-state-v1:pending'
const PREFIX = 'kithmoot.pending.'
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
type Pair = { durable: string | null; transient: string | null }
interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  account: string
  roomId: string
  current(): { account: string; roomId: string } | undefined
  live(): boolean
  checkClients(): Promise<void>
  /** Synchronously revoke this foreground queue when custody holds. */
  stop(): void
  /** Required authenticated inner-message, room, channel and participant
   * binding. This adapter also verifies the outer signed event itself. */
  accepts(record: KeptPendingSend): boolean
}

/** Named pending custody for one immutable foreground account and room.
 * Complete native migrations must precede open. Every write changes at most
 * one encrypted owner; there is no claim of an atomic two-owner handoff.
 * The app must close/replace its queue when the captured foreground changes. */
export class OrdinaryPendingState implements PendingStorage {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #name: string
  readonly #work = new Set<Promise<unknown>>()
  #expected?: Pair
  #closed = false
  #held = false
  private constructor(options: Options, browserScope: OrdinaryScope, tabScope: OrdinaryScope) {
    this.#options = options; this.#browserScope = browserScope; this.#tabScope = tabScope
    this.#name = `kithmoot.account.${options.account}.${PREFIX}${options.roomId}`
  }
  static async open(input: Options): Promise<OrdinaryPendingState> {
    const options = { ...input }
    if (!HEX.test(options.account) || !HEX.test(options.roomId) || options.browser.purpose !== 'browser' ||
        !/^tab:[0-9a-f]{64}$/.test(options.tab.purpose)) hold()
    const live = () => {
      const current = options.current()
      return options.live() && current?.account === options.account && current.roomId === options.roomId
    }
    const browserScope = await options.browser.capture('room:' + options.roomId, live)
    const tabScope = await options.tab.capture('room:' + options.roomId, live)
    const state = new OrdinaryPendingState(options, browserScope, tabScope)
    await state.load(options.roomId)
    return state
  }
  #live = (): boolean => {
    const current = this.#options.current()
    return !this.#closed && this.#options.live() && current?.account === this.#options.account && current.roomId === this.#options.roomId
  }
  #check(room: string): void { if (room !== this.#options.roomId || !this.#live() || this.#held) hold() }
  #locked<T>(room: string, work: () => Promise<T>): Promise<T> {
    const operation = (async () => {
      this.#check(room)
      if (!navigator.locks) hold()
      return navigator.locks.request(LOCK, async () => {
        this.#check(room); await this.#options.checkClients(); this.#check(room)
        return work()
      })
    })()
    this.#work.add(operation); void operation.finally(() => this.#work.delete(operation)).catch(() => {})
    return operation.catch(error => { this.#stop(); throw error })
  }
  #stop(): void {
    if (!this.#held) {
      this.#held = true
      try { this.#options.stop() } catch { /* Revocation failure never waives the hold. */ }
    }
  }
  #records(raw: string | null): KeptPendingSend[] {
    if (raw === null) return []
    if (raw.length > ORDINARY_VALUE_UNITS) hold()
    let values: unknown
    try { values = JSON.parse(raw) } catch { hold() }
    if (!Array.isArray(values) || values.length > MAX_KEPT) hold()
    for (const row of values) {
      if (!row || Object.getPrototypeOf(row) !== Object.prototype ||
          Object.keys(row).some(name => !['id','channel','text','files','artwork','event','state','editable'].includes(name)) ||
          typeof row.id !== 'string' || !row.id.length || row.id.length > 128 || typeof row.channel !== 'string' ||
          !row.channel.length || row.channel.length > 512 || typeof row.text !== 'string' || !Array.isArray(row.files) ||
          row.files.some((file: unknown) => typeof file !== 'string') ||
          !['waiting','refused','unknown','moved'].includes(row.state) ||
          (row.editable !== undefined && row.editable !== true)) hold()
      const event = row.event
      if (!event || Object.getPrototypeOf(event) !== Object.prototype || Object.keys(event).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' ||
          !HEX.test(event.id) || !HEX.test(event.pubkey) || typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig) ||
          !Number.isSafeInteger(event.kind) || event.kind < 0 || !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
          typeof event.content !== 'string' || !Array.isArray(event.tags) ||
          event.tags.some((tag: unknown) => !Array.isArray(tag) || tag.some(value => typeof value !== 'string'))) hold()
      try { if (!verifyEvent(event)) hold() } catch { hold() }
      if (row.artwork !== undefined && (!Array.isArray(row.artwork) || row.artwork.length > MAX_CHAT_ARTWORK || row.artwork.some((art: unknown) => !normaliseArtwork(art)))) hold()
      // JSON decoding removes verifier cache symbols and escaped object aliases.
      if (this.#options.accepts(structuredClone(row)) !== true) hold()
    }
    return values
  }
  #validate(pair: Pair): void {
    const records = [...this.#records(pair.durable), ...this.#records(pair.transient)]
    if (records.length > MAX_KEPT || new Set(records.map(record => record.id)).size !== records.length) hold()
  }
  async #read(): Promise<Pair> {
    const read = (owner: OrdinaryStateOwner, scope: OrdinaryScope) => owner.readMigrated(scope, this.#live, store => {
      if (store.get(PREFIX + this.#options.roomId) !== null) hold() // No guessed legacy account binding.
      return store.get(this.#name)
    })
    // Every pending adapter uses the same outer lock and fixed native order.
    const durable = await read(this.#options.browser, this.#browserScope)
    const transient = await read(this.#options.tab, this.#tabScope)
    const pair = { durable, transient }; this.#validate(pair); return pair
  }
  load(room: string): Promise<Pair> {
    return this.#locked(room, async () => {
      const pair = await this.#read()
      await this.#options.checkClients(); this.#check(room)
      this.#expected = { ...pair }; return { ...pair }
    })
  }
  retain(room: string, durable: string | null, transient: string | null): Promise<void> {
    const candidate = { durable, transient }
    return this.#locked(room, async () => {
      this.#validate(candidate)
      if (!this.#expected) hold()
      const current = await this.#read()
      if (current.durable !== this.#expected.durable || current.transient !== this.#expected.transient) hold()
      const changed = (['durable','transient'] as const).filter(name => current[name] !== candidate[name])
      if (changed.length > 1) hold()
      if (changed.length) {
        const part = changed[0]!, owner = part === 'durable' ? this.#options.browser : this.#options.tab
        const scope = part === 'durable' ? this.#browserScope : this.#tabScope
        await owner.mutateMigrated(scope, this.#live, store => {
          if (store.get(this.#name) !== current[part] || store.get(PREFIX + room) !== null) hold()
          if (candidate[part] === null) store.remove(this.#name)
          else store.set(this.#name, candidate[part]!)
        })
      }
      // The known receipt updates expectation before the post-write client
      // fence. A fence failure holds this adapter; it never authorises replay.
      this.#expected = { ...candidate }
      await this.#options.checkClients(); this.#check(room)
    })
  }
  /** Revokes synchronously and joins only this adapter's native operations.
   * The foreground owns closing the shared browser/tab lifetimes themselves. */
  async close(): Promise<void> {
    this.#closed = true; this.#stop()
    await Promise.allSettled([...this.#work])
  }
}
