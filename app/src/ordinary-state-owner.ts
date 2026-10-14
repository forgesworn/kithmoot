import type { DeviceStore } from './device-store.js'
import { ORDINARY_OPERATION_CONTROL_PREFIX, openOrdinaryOperationClassification,
  ordinaryOperationNames, ordinaryOperationMarker, ordinaryOperationCommitment, ordinaryOperationControlDigest, validateOrdinaryOperationMarker } from './ordinary-operation-codec.js'
import { OrdinaryStateHold, ordinaryImageByteLength, encodeOrdinaryImage, openOrdinaryFrame, sealOrdinaryImage, sameOrdinaryFrame,
  validateOrdinaryFrame, validateOrdinaryKey, type OrdinaryFrame, type OrdinaryImage,
  type OrdinaryPurpose, type OrdinaryMigration } from './ordinary-state-codec.js'

export const ORDINARY_DATABASE = 'kithmoot-ordinary-state-v1'
const OWNER_STORE = 'owners'
const WRITE_LOCK = ORDINARY_DATABASE + ':write'
export const MAX_ORDINARY_TAB_OWNERS = 64
const TAB_PURPOSE = /^tab:[0-9a-f]{64}$/
export interface OrdinaryScope {
  readonly name: string
  readonly generation: string
  readonly fence: number
}
export interface OrdinaryPairMutation<T> {
  readonly browser: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly tab: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly live: () => boolean
  readonly work: (browser: DeviceStore, tab: DeviceStore,
    browserMigratedNames: readonly string[], tabMigratedNames: readonly string[], custody: OrdinaryPairCustody) => T
}
export type OrdinaryPairPrewrite = (browser: Pick<DeviceStore, 'get' | 'keys'>, tab: Pick<DeviceStore, 'get' | 'keys'>,
  browserMigratedNames: readonly string[], tabMigratedNames: readonly string[], custody: OrdinaryPairCustody) => void
/** A private producer's validation-only last check, after native authentication
 * and immediately before the two puts. It must perform no effect or asynchronous
 * work. Its readonly views contain acknowledged predecessor records only. */
export interface OrdinaryPairCommitInput extends OrdinaryPairMutation<void> {
  readonly beforeWrite: OrdinaryPairPrewrite
}
declare const pairCommitBrand: unique symbol
export interface OrdinaryPairCommitReceipt { readonly [pairCommitBrand]: true }
/** Custody facts only. Neither result grants permission to mint or adopt. */
export type OrdinaryPairCommitOutcome = Readonly<
  { status: 'committed'; receipt: OrdinaryPairCommitReceipt } | { status: 'definite-abort' }>
declare const pairCustodyBrand: unique symbol
export interface OrdinaryPairCustody { readonly [pairCustodyBrand]: true }
interface PairHeader { purpose: OrdinaryPurpose; expiresAt: number; generation: string; revision: number; fences: ReadonlyMap<string, number> }
const pairCustody = new WeakMap<object, { kind:'read'|'mutation'; browser: OrdinaryImage; tab: OrdinaryImage; browserOwner: OrdinaryStateOwner; tabOwner: OrdinaryStateOwner; browserStore: DeviceStore; tabStore: DeviceStore; browserScope: OrdinaryScope; tabScope: OrdinaryScope; rows?: readonly [Row, Row]; operationMarkers?: readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] }>()
const pairCommits = new WeakMap<object, {
  browser: { owner: OrdinaryStateOwner; scope: OrdinaryScope }
  tab: { owner: OrdinaryStateOwner; scope: OrdinaryScope }
  frames: readonly [OrdinaryFrame, OrdinaryFrame]
  state: 'available' | 'consuming' | 'consumed' | 'refused'
}>()
/** Only a live native pair callback can supply this opaque provenance. Exact
 * record matching prevents substituting a different image under its headers. */
export function ordinaryPairCustodyFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string, string>, tab: ReadonlyMap<string, string>):
  { browser: PairHeader; tab: PairHeader } {
  const captured = pairCustody.get(token)
  if (!captured) hold()
  const header = (image: OrdinaryImage, store: DeviceStore, records: ReadonlyMap<string, string>): PairHeader => {
    const names = store.keys()
    if (records.size !== names.length || names.some(name => records.get(name) !== store.get(name))) hold()
    return { purpose: image.purpose, expiresAt: image.expiresAt, generation: image.generation, revision: image.revision, fences: new Map(image.fences) }
  }
  return { browser: header(captured.browser, captured.browserStore, browser), tab: header(captured.tab, captured.tabStore, tab) }
}
/** Marker custody only, from the same fully classified native read/write
 * projection. It neither exposes a control row nor advances any journal. */
export function ordinaryPairOperationMarkersFor(token: OrdinaryPairCustody, browser: ReadonlyMap<string,string>, tab: ReadonlyMap<string,string>):
  readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] {
  ordinaryPairCustodyFor(token, browser, tab)
  const captured = pairCustody.get(token)
  if (!captured?.operationMarkers) hold()
  for (const [i, records] of [browser, tab].entries()) {
    const markers = [...records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
    if (markers.length !== captured.operationMarkers[i]!.size || markers.some(([name, raw]) => captured.operationMarkers![i]!.get(name) !== raw)) hold()
  }
  return [new Map(captured.operationMarkers[0]), new Map(captured.operationMarkers[1])]
}
/** Signing may consume only acknowledged input bytes from a read callback,
 * never a writable projection which has not yet acquired a native receipt. */
export function ordinaryPairReadCustodyFor(token:OrdinaryPairCustody,browser:ReadonlyMap<string,string>,tab:ReadonlyMap<string,string>) {
  const captured=pairCustody.get(token)
  if(captured?.kind!=='read')hold()
  OrdinaryStateOwner.validatePairBinding(token,{browser:{owner:captured.browserOwner,scope:captured.browserScope},
    tab:{owner:captured.tabOwner,scope:captured.tabScope},live:()=>true})
  return ordinaryPairCustodyFor(token,browser,tab)
}
/** Capacity-only projection from a live authenticated pair callback. Exact
 * current bytes must still match the opaque token. The projected records do
 * not acquire semantic validity or mutation authority; no mutable image,
 * keyId, key or migration carrier escapes. Both revision+1 images are sized
 * before the caller starts first-use entropy or signing. */
export function ordinaryPairProjectedByteLengths(token: OrdinaryPairCustody, browser: ReadonlyMap<string, string>,
  tab: ReadonlyMap<string, string>, proposed: { readonly browser: ReadonlyMap<string, string>; readonly tab: ReadonlyMap<string, string> }, reserveScopes = false):
  Readonly<{ browser: number; tab: number }> {
  try {
    ordinaryPairCustodyFor(token, browser, tab)
    const captured = pairCustody.get(token)
    if (!captured || typeof reserveScopes !== 'boolean' || !proposed || Object.getPrototypeOf(proposed) !== Object.prototype ||
        Reflect.ownKeys(proposed).sort().join(',') !== 'browser,tab') hold()
    const copy = (records: ReadonlyMap<string, string>) => {
      // Native Map brand, no thenable or callback-backed projection object.
      if (Reflect.ownKeys(records).length !== 0) hold()
      return new Map(Map.prototype.entries.call(records) as MapIterator<[string, string]>)
    }
    const data = (name: 'browser' | 'tab') => {
      const field = Object.getOwnPropertyDescriptor(proposed, name)
      if (!field || !Object.hasOwn(field, 'value')) hold()
      return copy(field.value as ReadonlyMap<string, string>)
    }
    const b = data('browser'), t = data('tab')
    try {
      const fences = (image: OrdinaryImage, scope: OrdinaryScope) => {
        const copy = new Map(image.fences)
        if (reserveScopes && !copy.has(scope.name)) copy.set(scope.name, scope.fence)
        return copy
      }
      const first = ordinaryImageByteLength({ ...captured.browser, revision: captured.browser.revision + 1, records: b,
        fences: fences(captured.browser, captured.browserScope) })
      const second = ordinaryImageByteLength({ ...captured.tab, revision: captured.tab.revision + 1, records: t,
        fences: fences(captured.tab, captured.tabScope) })
      return Object.freeze({ browser: first, tab: second })
    } finally { b.clear(); t.clear() }
  } catch { return hold() }
}
interface Row { key: CryptoKey; frame?: OrdinaryFrame; pending?: OrdinaryFrame }
class DefiniteAbort extends Error {}
interface Snapshot { db: IDBDatabase; row?: Row; image?: OrdinaryImage }
function hold(): never { throw new OrdinaryStateHold() }
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
function settled(tx: IDBTransaction, aborted?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => { aborted?.(); reject(tx.error ?? new OrdinaryStateHold()) }
    // Only abort is terminal failure: an individual request error can still
    // be prevented by the browser and is not proof that commit was impossible.
  })
}
function row(raw: unknown): Row | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype ||
      !['frame,key', 'key,pending', 'frame,key,pending'].includes(Object.keys(raw).sort().join(','))) hold()
  const value = raw as Row
  return { key: validateOrdinaryKey(value.key),
    ...(Object.hasOwn(raw, 'frame') ? { frame: validateOrdinaryFrame(value.frame) } : {}),
    ...(Object.hasOwn(raw, 'pending') ? { pending: validateOrdinaryFrame(value.pending) } : {}) }
}
function sameRow(a?: Row, b?: Row): boolean {
  return !!a === !!b && sameOrdinaryFrame(a?.frame, b?.frame) && sameOrdinaryFrame(a?.pending, b?.pending)
}
function copyImage(image: OrdinaryImage): OrdinaryImage {
  return { ...image, records: new Map(image.records), fences: new Map(image.fences),
    ...(image.migration ? { migration: { ...image.migration, sources: new Map(image.migration.sources), names: [...image.migration.names] } } : {}) }
}
function clearImage(image?: OrdinaryImage): void {
  if (!image) return
  ;(image.records as Map<string, string>).clear()
  ;(image.fences as Map<string, number>).clear()
  if (image.migration) {
    ;(image.migration.sources as Map<string, string>).clear()
    ;(image.migration.names as string[]).length = 0
  }
}
function preserveOperationMarkers(previous: ReadonlyMap<string, string>, candidate: ReadonlyMap<string, string>): void {
  const selected = (records: ReadonlyMap<string, string>) => [...records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
  const first = selected(previous), second = selected(candidate)
  if (first.length !== second.length || first.some(([name, raw]) => candidate.get(name) !== raw)) hold()
}
/** A private synchronous helper view; escaping it cannot write after the call. */
function view(records: Map<string, string>, writable: boolean): { store: DeviceStore; close(): void } {
  let active = true
  const check = () => { if (!active) hold() }
  return {
    store: Object.freeze<DeviceStore>({
      get: name => { check(); return records.get(name) ?? null },
      keys: () => { check(); return [...records.keys()] },
      set: (name, value) => { check(); if (!writable) hold(); records.set(name, value) },
      remove: name => { check(); if (!writable) hold(); records.delete(name) },
    }),
    close: () => { active = false; records.clear() },
  }
}

/** Native origin-local encrypted custody. The app must supply a live foreground
 * guard and finish legacy/client fencing before admitting effects. This class
 * alone is neither membership authority nor independent rollback resistance. */
export class OrdinaryStateOwner {
  #db?: IDBDatabase
  #generation?: string
  #closed = false
  #work = new Set<Promise<unknown>>()
  #resources = new Set<{ stop(): void }>()
  #retry?: () => void
  #operationControls = new Set<string>()
  #operationMarkerValues = new Map<string,string>()
  #operationControlDigests = new Map<string,string>()
  /** An unknown native result keeps both the exact candidate and Web Lock. */
  get holdingRetention(): boolean { return this.#retry !== undefined }
  retryRetention(): void { this.#retry?.() }
  #custodyCheck(live: () => boolean, reconciling: boolean): void {
    if (reconciling) { if (!live()) hold() }
    else this.#check(live)
  }
  constructor(readonly purpose: OrdinaryPurpose = 'browser', readonly expiresAt = 0) {
    // These identities are immutable at runtime too. An accessor cannot run
    // between the final native check and a put argument.
    Object.defineProperties(this, { purpose: { value: purpose, enumerable: true, writable: false, configurable: false },
      expiresAt: { value: expiresAt, enumerable: true, writable: false, configurable: false } })
  }
  #check(live: () => boolean, expiredCleanup = false): void {
    if (this.#closed) hold()
    const selected = live()
    if (this.#closed || selected !== true || !expiredCleanup && this.purpose !== 'browser' && Date.now() >= this.expiresAt) hold()
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  /** Resource ownership only: this does not authorise the operation or expose
   * a native image. Register before its first continuation so closing either
   * lifetime joins borrowed provider/deferred work after revoking storage.
   * An operation must never await the close which is joining that same work. */
  static joinPairLifetime<T>(browser: OrdinaryStateOwner, tab: OrdinaryStateOwner, operation: Promise<T>): Promise<T> {
    if (!(browser instanceof OrdinaryStateOwner) || !(tab instanceof OrdinaryStateOwner) || browser === tab ||
        browser.purpose !== 'browser' || !TAB_PURPOSE.test(tab.purpose) || !(operation instanceof Promise)) hold()
    browser.#track(operation); tab.#track(operation)
    return operation
  }
  /** Retain an already-authorised resource on both exact native lifetimes.
   * Only a current read can register it. Closing either owner, database
   * invalidation or the tab deadline revokes synchronously, then joins cleanup.
   * Registration supplies no permission to sign, dial, read or mutate. */
  static retainPairResource(custody: OrdinaryPairCustody,
    binding: Pick<OrdinaryPairMutation<unknown>, 'browser' | 'tab' | 'live'>,
    callbacks: { readonly revoke: () => void; readonly join: () => Promise<void> }): () => void {
    if (pairCustody.get(custody)?.kind !== 'read') hold()
    const captured = { browser: { owner: binding.browser.owner, scope: { ...binding.browser.scope } },
      tab: { owner: binding.tab.owner, scope: { ...binding.tab.scope } }, live: binding.live }
    OrdinaryStateOwner.validatePairBinding(custody, captured)
    const browser = captured.browser.owner, tab = captured.tab.owner, revoke = callbacks.revoke, join = callbacks.join
    if (typeof revoke !== 'function' || typeof join !== 'function') hold()
    let active = true, timer: ReturnType<typeof setTimeout>
    const release = () => {
      if (!active) return false
      active = false; clearTimeout(timer); browser.#resources.delete(resource); tab.#resources.delete(resource)
      return true
    }
    const resource = { stop: () => {
      if (!release()) return
      try { revoke() } catch { /* join still owns cleanup */ }
      const cleanup = Promise.resolve().then(join)
      browser.#track(cleanup); tab.#track(cleanup); void cleanup.catch(() => {})
    } }
    const expire = () => {
      if (!active) return
      if (Date.now() >= tab.expiresAt) resource.stop()
      else timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, tab.expiresAt - Date.now())))
    }
    // Callback getters above may revoke an owner. Recheck before retaining.
    OrdinaryStateOwner.validatePairBinding(custody, captured)
    browser.#resources.add(resource); tab.#resources.add(resource)
    timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(1, tab.expiresAt - Date.now())))
    return () => { release() }
  }
  #revoke(): void {
    this.#closed = true
    for (const resource of [...this.#resources]) resource.stop()
    this.#resources.clear()
  }
  /** Reuse a genuine current pair read for another native component's scopes.
   * Exact owner instances and their live lifetimes are required; matching rows
   * or caller-supplied generation strings cannot substitute for provenance.
   * This synchronous restriction neither starts a read nor exports an image. */
  static validatePairBinding(custody: OrdinaryPairCustody,
    input: Pick<OrdinaryPairMutation<unknown>, 'browser' | 'tab' | 'live'>): void {
    const browser=input.browser.owner,tab=input.tab.owner,
      browserScope={...input.browser.scope},tabScope={...input.tab.scope},live=input.live
    const captured=pairCustody.get(custody)
    if(!captured||captured.browserOwner!==browser||captured.tabOwner!==tab||browser===tab||
      !(browser instanceof OrdinaryStateOwner)||!(tab instanceof OrdinaryStateOwner)||typeof live!=='function')hold()
    // Invoke the trusted selector before the final lifetime checks: it may
    // synchronously close an owner while still returning true.
    const selected = live(), now = Date.now()
    if(selected!==true||browser.#closed||tab.#closed||browser.#retry||tab.#retry||
      browser.purpose!=='browser'||browser.expiresAt!==0||!TAB_PURPOSE.test(tab.purpose)||
      captured.browser.purpose!==browser.purpose||captured.browser.expiresAt!==browser.expiresAt||
      captured.tab.purpose!==tab.purpose||captured.tab.expiresAt!==tab.expiresAt||now>=tab.expiresAt||
      captured.browser.generation!==browser.#generation||captured.tab.generation!==tab.#generation)hold()
    for(const scope of [browserScope,tabScope])if(typeof scope.name!=='string'||!scope.name.length||scope.name.length>512||
      !Number.isSafeInteger(scope.fence)||scope.fence<0)hold()
    browser.#scope(captured.browser,browserScope);tab.#scope(captured.tab,tabScope)
  }
  async #locked<T>(live: () => boolean, work: () => Promise<T>): Promise<T> {
    this.#check(live)
    if (!navigator.locks) hold()
    return navigator.locks.request(WRITE_LOCK, async () => {
      this.#check(live)
      await this.#operationBarrier(live)
      const result = await work()
      this.#check(live)
      return result
    })
  }
  /** Classify the whole origin before ordinary callbacks, single-row intent
   * promotion or expiry cleanup. The coherent reader stays alive across native
   * crypto; rows are opened one at a time rather than cloning every large tab
   * into memory. An active journal grants no ordinary read/write capability. */
  async #operationBarrier(live: () => boolean): Promise<void> {
    const db = await this.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    const store = tx.objectStore(OWNER_STORE)
    let done = false, browserImage: OrdinaryImage | undefined
    const controlNames = new Set<string>(), tabNames = new Set<string>(), controlDigests = new Map<string,string>()
    const isTab = (name: string) => name.length === 68 && TAB_PURPOSE.test(name)
    const marked = (image: OrdinaryImage) => [...image.records].filter(([name]) => name.startsWith('kithmoot.operation-journal'))
    const reads: { run(): void; fail(): void }[] = []
    // SubtleCrypto resolves outside an IDB task in Firefox. Queue the next
    // read into a genuine request callback, rather than merely keeping the
    // transaction alive and issuing a request from an inactive continuation.
    const read = <T>(work: () => IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      reads.push({ run: () => { try { const r = work(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }
        catch (error) { reject(error) } }, fail: () => reject(new OrdinaryStateHold()) })
    })
    tx.addEventListener('abort', () => { done = true; for (const entry of reads.splice(0)) entry.fail() })
    const keepAlive = () => {
      if (done) return
      const next = store.getKey('browser')
      next.onerror = () => { done = true; try { tx.abort() } catch {} }
      next.onsuccess = () => {
        if (done) return
        for (const entry of reads.splice(0)) entry.run()
        keepAlive()
      }
    }
    try {
      keepAlive()
      const keys = await read(() => store.getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2)); this.#check(live)
      if (keys.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1) hold()
      for (const key of keys) {
        if (typeof key !== 'string') hold()
        if (key === 'browser') continue
        if (isTab(key)) tabNames.add(key)
        else if (key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX) && key.length === ORDINARY_OPERATION_CONTROL_PREFIX.length + 64 &&
          /^[0-9a-f]{64}$/.test(key.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length))) controlNames.add(key)
        else hold()
      }
      if (tabNames.size > MAX_ORDINARY_TAB_OWNERS || controlNames.size > MAX_ORDINARY_TAB_OWNERS) hold()
      const open = async (name: string): Promise<{ key: CryptoKey; image: OrdinaryImage } | undefined> => {
        const saved = row(await read(() => store.get(name))); this.#check(live)
        if (!saved) return undefined
        let active: OrdinaryImage | undefined, intended: OrdinaryImage | undefined
        try {
          for (const frame of [saved.frame, saved.pending]) {
            if (!frame) continue
            let image: OrdinaryImage | undefined = await openOrdinaryFrame(frame, saved.key)
            try {
              this.#check(live)
              if (image.purpose !== name || !controlNames.size && marked(image).length) hold()
              if (frame === saved.frame) active = image
              else intended = image
              image = undefined
            } finally { clearImage(image) }
          }
          if (intended && active) {
            if (intended.keyId !== active.keyId || intended.generation !== active.generation || intended.expiresAt !== active.expiresAt ||
                intended.revision !== active.revision + 1 || [...active.fences].some(([name, fence]) => (intended!.fences.get(name) ?? 0) < fence)) hold()
            preserveOperationMarkers(active.records, intended.records)
          } else if (intended && marked(intended).length) hold()
          if (!active) return undefined
          const result = { key: saved.key, image: active }; active = undefined; return result
        } finally { clearImage(active); clearImage(intended) }
      }
      const browser = keys.includes('browser') ? await open('browser') : undefined
      browserImage = browser?.image
      if (controlNames.size && !browser) hold()
      const browserMarkers = new Map<string, string>()
      if (browser) for (const [name, raw] of marked(browser.image)) {
        const value = validateOrdinaryOperationMarker(raw), names = ordinaryOperationNames(value.tab)
        if (name !== names.marker || !controlNames.has(names.control) || browserMarkers.has(value.tab)) hold()
        browserMarkers.set(value.tab, raw)
      }
      for (const purpose of tabNames) {
        const opened = await open(purpose)
        if (!opened) continue
        const names = ordinaryOperationNames(purpose as OrdinaryPurpose), markers = marked(opened.image)
        try {
          if (!controlNames.has(names.control)) { if (markers.length) hold(); continue }
          if (markers.length !== 1 || markers[0]![0] !== names.marker || !browserMarkers.has(purpose) ||
              markers[0]![1] !== browserMarkers.get(purpose) || opened.image.migration?.phase !== 'complete' ||
              browser!.image.migration?.phase !== 'complete') hold()
          const header = (image: OrdinaryImage) => ({ purpose: image.purpose, keyId: image.keyId,
            generation: image.generation, expiresAt: image.expiresAt })
          const control = await read(() => store.get(names.control)); this.#check(live)
          const journal = await openOrdinaryOperationClassification(control, { browser: { binding: header(browser!.image), key: browser!.key },
            tab: { binding: header(opened.image), key: opened.key } }); this.#check(live)
          if (journal.phase !== 'settled') hold()
          const expected = ordinaryOperationMarker({ id: journal.id, tab: journal.tab, sequence: journal.sequence, commitment: ordinaryOperationCommitment(journal) })
          if (expected !== markers[0]![1] || journal.phase !== 'settled' || !journal.targetRevisions ||
              browser!.image.revision <= journal.targetRevisions[0] || opened.image.revision <= journal.targetRevisions[1]) hold()
          for (const [owner, name, generation, fence] of journal.scopes) {
            const current = owner === 'browser' ? browser!.image : opened.image
            if (current.purpose !== owner || current.generation !== generation || (current.fences.get(name) ?? 0) < fence) hold()
          }
          controlDigests.set(names.control, ordinaryOperationControlDigest(control))
          controlNames.delete(names.control)
        } finally { clearImage(opened.image) }
      }
      if (controlNames.size || browserMarkers.size !== keys.filter(key => typeof key === 'string' && key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX)).length) hold()
      this.#operationControlDigests = controlDigests
      this.#operationControls = new Set(browserMarkers.keys())
      this.#operationMarkerValues = new Map([...browserMarkers].map(([purpose, raw]) => [ordinaryOperationNames(purpose as OrdinaryPurpose).marker, raw]))
      done = true; await ended; this.#check(live)
    } catch { done = true; try { tx.abort() } catch {} await ended.catch(() => {}); hold() }
    finally { done = true; clearImage(browserImage) }
  }
  /** Re-read in the consumer's own coherent transaction. A control inserted,
   * removed or changed after classification cannot inherit old provenance. */
  #operationControlSnapshot(store: IDBObjectStore): Promise<void> {
    return new Promise((resolve, reject) => {
      const keys = store.getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2)
      keys.onerror = () => reject(new OrdinaryStateHold())
      keys.onsuccess = () => {
        try {
          const values = keys.result
          if (values.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1 || values.some(key => typeof key !== 'string' ||
              key !== 'browser' && !(key.length === 68 && TAB_PURPOSE.test(key)) &&
              !this.#operationControlDigests.has(key))) hold()
          if (values.filter(key => typeof key === 'string' && key.startsWith('tab:')).length > MAX_ORDINARY_TAB_OWNERS) hold()
          const controls = values.filter(key => typeof key === 'string' && key.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX)) as string[]
          if (controls.length !== this.#operationControlDigests.size || controls.some(name => !values.includes('browser') ||
              !values.includes('tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length)))) hold()
          if (!controls.length) { resolve(); return }
          let index = 0
          // Stream one control at a time from genuine request callbacks. A
          // bounded header check must not retain all large cipher copies.
          const read = () => {
            if (index === controls.length) { resolve(); return }
            const name = controls[index]!, next = store.get(name)
            next.onerror = () => reject(new OrdinaryStateHold())
            next.onsuccess = () => {
              try {
                if (ordinaryOperationControlDigest(next.result) !== this.#operationControlDigests.get(name)) hold()
                index++; read()
              } catch { reject(new OrdinaryStateHold()) }
            }
          }
          read()
        } catch { reject(new OrdinaryStateHold()) }
      }
    })
  }
  #classifiedPairMarkers(browser: OrdinaryImage, tab: OrdinaryImage): readonly [ReadonlyMap<string,string>, ReadonlyMap<string,string>] {
    const marked = (image: OrdinaryImage) => new Map([...image.records].filter(([name]) => name.startsWith('kithmoot.operation-journal')))
    const b = marked(browser), t = marked(tab), names = ordinaryOperationNames(tab.purpose)
    if (b.size !== this.#operationMarkerValues.size || [...b].some(([name, raw]) => this.#operationMarkerValues.get(name) !== raw) ||
        t.size !== (b.has(names.marker) ? 1 : 0) || [...t].some(([name, raw]) => name !== names.marker || b.get(name) !== raw)) hold()
    return [b, t]
  }
  async #database(live: () => boolean, reconciling = false): Promise<IDBDatabase> {
    this.#custodyCheck(live, reconciling)
    if (this.#db) return this.#db
    const opened = indexedDB.open(ORDINARY_DATABASE, 1)
    let refused = false
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onupgradeneeded = event => {
        if (event.oldVersion !== 0) { opened.transaction!.abort(); return }
        opened.result.createObjectStore(OWNER_STORE)
      }
      opened.onerror = () => reject(opened.error)
      opened.onblocked = () => { refused = true; reject(new OrdinaryStateHold()) }
      opened.onsuccess = () => {
        const value = opened.result
        if (refused) { value.close(); return }
        try {
          this.#custodyCheck(live, reconciling)
          if (value.version !== 1 || value.objectStoreNames.length !== 1 || !value.objectStoreNames.contains(OWNER_STORE)) hold()
          resolve(value)
        } catch (error) { value.close(); reject(error) }
      }
    })
    this.#custodyCheck(live, reconciling)
    this.#db = db
    db.onversionchange = () => { this.#revoke(); db.close(); this.#db = undefined }
    return db
  }
  async #snapshot(live: () => boolean, reconciling = false, barrier: OrdinaryStateOwner = this): Promise<Snapshot> {
    let db = await this.#database(live, reconciling)
    const tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    let saved: Row | undefined
    try {
      const store = tx.objectStore(OWNER_STORE)
      const [raw] = await Promise.all([request(store.get(this.purpose)), barrier.#operationControlSnapshot(store)])
      saved = row(raw); await ended
    }
    catch (error) { try { tx.abort() } catch {} await ended.catch(() => {}); throw error }
    this.#custodyCheck(live, reconciling)
    if (!saved) return { db }
    if (saved.pending && !reconciling) {
      // A restarted owner reconciles the durable frozen intent before reading
      // ordinary state or creating any replacement identity/candidate.
      await this.#verifyRow(saved)
      const active: Row = { key: saved.key, frame: saved.pending }
      await this.#install(db, saved, active, live)
      db = await this.#database(live)
      saved = active
    }
    if (reconciling) return { db, row: saved }
    if (!saved.frame || saved.frame.purpose !== this.purpose || saved.frame.expiresAt !== this.expiresAt) hold()
    const image = await openOrdinaryFrame(saved.frame, saved.key)
    try {
      this.#custodyCheck(live, reconciling)
      if (!reconciling && this.#generation !== undefined && this.#generation !== image.generation) hold()
    } catch (error) { clearImage(image); throw error }
    return { db, row: saved, image }
  }
  #scope(image: OrdinaryImage, scope: OrdinaryScope): void {
    if (scope.generation !== image.generation || scope.fence !== (image.fences.get(scope.name) ?? 0)) hold()
  }
  async #ownerNames(live: () => boolean): Promise<IDBValidKey[]> {
    const db = await this.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    const keys = await request(tx.objectStore(OWNER_STORE).getAllKeys(undefined, 2 * MAX_ORDINARY_TAB_OWNERS + 2))
    await ended; this.#check(live)
    if (keys.length > 2 * MAX_ORDINARY_TAB_OWNERS + 1 || keys.some(name => typeof name !== 'string' ||
      name !== 'browser' && !(name.length === 68 && TAB_PURPOSE.test(name)) &&
      !(name.startsWith(ORDINARY_OPERATION_CONTROL_PREFIX) && name.length === ORDINARY_OPERATION_CONTROL_PREFIX.length + 64 &&
        this.#operationControls.has('tab:' + name.slice(ORDINARY_OPERATION_CONTROL_PREFIX.length))))) hold()
    const names = keys.filter(name => !(name as string).startsWith(ORDINARY_OPERATION_CONTROL_PREFIX))
    if (names.length > MAX_ORDINARY_TAB_OWNERS + 1) hold()
    return names
  }
  /** Read only authenticated lease metadata. Missing custody is reported to
   * the lifetime service, which must distinguish a new marker from a restore. */
  static async tabLease(purpose: OrdinaryPurpose, live: () => boolean): Promise<number | undefined> {
    if (!TAB_PURPOSE.test(purpose)) hold()
    const manager = new OrdinaryStateOwner()
    try {
      return await manager.#locked(live, async () => {
        const db = await manager.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
        void ended.catch(() => {})
        const store = tx.objectStore(OWNER_STORE)
        const [raw] = await Promise.all([request(store.get(purpose)), manager.#operationControlSnapshot(store)])
        const saved = row(raw)
        await ended; manager.#check(live)
        if (!saved) return undefined
        const frame = saved.pending ?? saved.frame
        if (!frame || frame.purpose !== purpose) hold()
        const owner = new OrdinaryStateOwner(purpose, frame.expiresAt)
        await owner.#verifyRow(saved); manager.#check(live)
        return frame.expiresAt
      })
    } finally { await manager.close() }
  }
  /** Expiry is not proof that an uncertain intent was absent. Authenticate
   * and promote its exact frame before removing expired custody. The caller
   * receives the current native owner so an unknown receipt can be retried. */
  static async expireTabs(live: () => boolean, retaining: (owner: OrdinaryStateOwner | undefined) => void): Promise<void> {
    const manager = new OrdinaryStateOwner()
    try {
      await manager.#locked(live, async () => {
        // Settled journal cleanup needs its atomic browser-marker/tab/control
        // transition. The ordinary single-row cleanup cannot remove one half.
        if (manager.#operationControls.size) hold()
        const names = await manager.#ownerNames(live)
        for (const purpose of names) {
          if (purpose === 'browser') continue
          const db = await manager.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
          void ended.catch(() => {})
          const saved = row(await request(tx.objectStore(OWNER_STORE).get(purpose)))
          await ended; manager.#check(live)
          const frame = saved?.pending ?? saved?.frame
          if (!saved || !frame || frame.purpose !== purpose) hold()
          const owner = new OrdinaryStateOwner(purpose as OrdinaryPurpose, frame.expiresAt)
          await owner.#verifyRow(saved); manager.#check(live)
          if (Date.now() < frame.expiresAt) continue
          retaining(owner)
          try {
            let active = saved
            if (saved.pending) {
              active = { key: saved.key, frame: saved.pending }
              await owner.#install(db, saved, active, live, true)
            }
            owner.#check(live, true)
            if (Date.now() < frame.expiresAt) hold()
            await owner.#install(await owner.#database(live, true), active, undefined, live, true)
          } finally { await owner.close(); retaining(undefined) }
        }
      })
    } finally { await manager.close() }
  }
  /** Initialisation is allowed only after the caller has verified the complete
   * legacy snapshot and old-client handshake. Key and image have one commit. */
  prepare(live: () => boolean, initial: ReadonlyMap<string, string>, migration?: OrdinaryMigration,
    validate?: (store: DeviceStore, migrated: boolean) => void): Promise<void> {
    // Capture all caller input before a lock/crypto await.
    const records = new Map(initial)
    const manifest = migration ? { ...migration, sources: new Map(migration.sources), names: [...migration.names] } : undefined
    return this.#track(this.#locked(live, async () => {
      const previous = await this.#snapshot(live)
      if (!previous.image) {
        if (this.#generation !== undefined) hold() // Deleted custody is not a fresh installation.
        // Raw marker import cannot create authenticated enrollment. Only the
        // dedicated atomic browser/tab/control transition may add markers.
        preserveOperationMarkers(new Map(), records)
        // Fixed-width placeholders check canonical encoding and capacity before
        // expensive validators, key creation or entropy. Never retain this image.
        const checked: OrdinaryImage = { purpose: this.purpose, keyId: '0'.repeat(64), generation: '0'.repeat(64), revision: 0,
          expiresAt: this.expiresAt, records, migration: manifest, fences: new Map() }
        ordinaryImageByteLength(checked)
        if (manifest?.phase === 'sealed') {
          // 'cleaning' adds two canonical bytes before any source is removed.
          // Reserve that control transition before committing initial custody.
          // Later source-pair removal outweighs revision digit growth.
          ordinaryImageByteLength({ ...checked, revision: 1, migration: { ...manifest, phase: 'cleaning' } })
        }
      }
      // The sealed full image, rather than the partially cleaned plaintext,
      // is the validation source on restart. New custody is validated before
      // any key/nonce creation. Helpers cannot edit or retain the private view.
      if (validate) {
        const privateView = view(new Map(previous.image?.records ?? records), false)
        try {
          const result: unknown = validate(privateView.store, previous.image?.migration?.phase === 'complete')
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(result).catch(() => {}); hold()
          }
          this.#check(live)
        } finally { privateView.close() }
      }
      if (previous.image) { this.#generation = previous.image.generation; return }
      if (this.purpose !== 'browser') {
        const names = await this.#ownerNames(live)
        if (names.filter(name => name !== 'browser').length >= MAX_ORDINARY_TAB_OWNERS) hold()
      }
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      this.#check(live)
      const image: OrdinaryImage = { purpose: this.purpose, keyId: random(), generation: random(), revision: 0,
        expiresAt: this.expiresAt, records, migration: manifest, fences: new Map() }
      const frame = await sealOrdinaryImage(image, key)
      this.#check(live)
      await this.#commit(previous, { key, frame }, live)
      this.#generation = image.generation
    }).finally(() => { records.clear(); manifest?.sources.clear() }))
  }
  capture(name: string, live: () => boolean): Promise<OrdinaryScope> {
    return this.#track(this.#locked(live, async () => {
      if (typeof name !== 'string' || !name.length || name.length > 512 || this.#generation === undefined) hold()
      const current = await this.#snapshot(live)
      if (!current.image) hold()
      return Object.freeze({ name, generation: current.image.generation, fence: current.image.fences.get(name) ?? 0 })
    }))
  }
  read<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#reading(scope, live, work)
  }
  /** Production adapters cannot expose records from an incomplete migration. */
  readMigrated<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#reading(scope, live, work, true)
  }
  #reading<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T, requireCompleteMigration = false): Promise<T> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const current = await this.#snapshot(live)
      if (!current.image || this.#generation === undefined) hold()
      this.#scope(current.image, captured)
      if (requireCompleteMigration && current.image.migration?.phase !== 'complete') hold()
      const privateView = view(new Map(current.image.records), false)
      try {
        const value = work(privateView.store)
        if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') hold()
        this.#check(live)
        return value
      } finally { privateView.close() }
    }))
  }
  mutate<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => T): Promise<T> {
    return this.#mutation(scope, live, work)
  }
  /** Legacy-name conversion must inspect completion in the same locked native
   * snapshot that supplies its records, rather than a prior separate read. */
  mutateMigrated<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore, migratedNames: readonly string[]) => T): Promise<T> {
    return this.#mutation(scope, live, (store, names) => { if (!names) hold(); return work(store, names) }, undefined, true)
  }
  /** Compare and replace in one authenticated snapshot. A definite mismatch
   * discards the private view without allocating a nonce or writing a frame. */
  compareAndMutateMigrated(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore) => boolean): Promise<boolean> {
    return this.#mutation(scope, live, work, undefined, true, true)
  }
  /** Coherent authenticated browser/tab read. Final semantic bindings must be
   * checked inside the synchronous callback before any result can escape. */
  static readPairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    const browser = input.browser.owner, tab = input.tab.owner
    const browserScope = { ...input.browser.scope }, tabScope = { ...input.tab.scope }
    const live = input.live, work = input.work
    const check = () => {
      if (browser === tab || browser.purpose !== 'browser' || browser.expiresAt !== 0 || !TAB_PURPOSE.test(tab.purpose) ||
          !Number.isSafeInteger(tab.expiresAt) || tab.expiresAt <= 0 ||
          browser.#generation === undefined || tab.#generation === undefined) hold()
      browser.#check(live); tab.#check(live)
      if (browser.#closed || tab.#closed) hold()
      for (const scope of [browserScope, tabScope]) if (typeof scope.name !== 'string' || !scope.name.length ||
        scope.name.length > 512 || !Number.isSafeInteger(scope.fence) || scope.fence < 0) hold()
    }
    const guarded = () => { try { check(); return true } catch { return false } }
    const operation = Promise.resolve().then(async () => {
      check()
      if (browser.#retry || tab.#retry || !navigator.locks) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        check()
        await browser.#operationBarrier(guarded); check()
        let first: OrdinaryImage | undefined, second: OrdinaryImage | undefined
        try {
          const priorBrowser = await browser.#snapshot(guarded)
          clearImage(priorBrowser.image); check()
          const priorTab = await tab.#snapshot(guarded, false, browser)
          clearImage(priorTab.image); check()
          const db = await browser.#database(guarded); check()
          const tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
          void ended.catch(() => {})
          let saved: (Row | undefined)[]
          try {
            const store = tx.objectStore(OWNER_STORE)
            const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
            await ended; check(); saved = raw.map(row)
          } catch (error) { try { tx.abort() } catch {}; await ended.catch(() => {}); throw error }
          if (!saved[0]?.frame || !saved[1]?.frame || saved[0].pending || saved[1].pending) hold()
          first = await openOrdinaryFrame(saved[0].frame, saved[0].key); check()
          second = await openOrdinaryFrame(saved[1].frame, saved[1].key); check()
          if (first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt || first.generation !== browser.#generation ||
              second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt || second.generation !== tab.#generation ||
              first.migration?.phase !== 'complete' || second.migration?.phase !== 'complete') hold()
          browser.#scope(first, browserScope); tab.#scope(second, tabScope)
          const browserView = view(new Map(first.records), false), tabView = view(new Map(second.records), false)
          const custody = Object.freeze({}) as OrdinaryPairCustody
          pairCustody.set(custody, { kind:'read', browser: first, tab: second, browserOwner: browser, tabOwner: tab, browserStore: browserView.store, tabStore: tabView.store, browserScope, tabScope, rows: [saved[0], saved[1]], operationMarkers: browser.#classifiedPairMarkers(first, second) })
          try {
            const result = work(browserView.store, tabView.store,
              Object.freeze([...first.migration.names]), Object.freeze([...second.migration.names]), custody)
            if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
              void Promise.resolve(result).catch(() => {}); hold()
            }
            check()
            return result
          } finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
        } finally { clearImage(first); clearImage(second) }
      })
    })
    browser.#track(operation); tab.#track(operation)
    return operation
  }
  /** One origin-local native commit for completed browser and tab images.
   * The caller must retain matching semantic identities in both final records
   * and validate that binding on startup before effects. This primitive does
   * not supply membership authority or independent rollback resistance. */
  static mutatePairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, false) as Promise<T>
  }
  /** Additive producer path. Receipts exist only in memory; durable restart
   * adoption must independently validate the stored successor. No callback
   * result is released as
   * plaintext. A known commit survives later liveness loss as a custody fact;
   * effects require consumePairCommit's fresh native callback instead. */
  static commitPairMigrated(input: OrdinaryPairCommitInput): Promise<OrdinaryPairCommitOutcome> {
    const beforeWrite = input.beforeWrite
    if (typeof beforeWrite !== 'function') return Promise.reject(new OrdinaryStateHold())
    return this.#mutatePairMigrated(input, false, false, beforeWrite) as Promise<OrdinaryPairCommitOutcome>
  }
  /** One attempt only, bound to both exact owners, scopes and committed
   * frames. The callback may synchronously adopt a preallocated successor;
   * it still owes the application's complete semantic and authority checks. */
  static consumePairCommit<T>(input: OrdinaryPairMutation<T> & { readonly receipt: OrdinaryPairCommitReceipt }): Promise<T> {
    const token = input.receipt, receipt = pairCommits.get(token)
    if (!receipt || receipt.state !== 'available') return Promise.reject(new OrdinaryStateHold())
    receipt.state = 'consuming'
    let body: Promise<unknown> | undefined
    try {
      const browser = { owner: input.browser.owner, scope: { ...input.browser.scope } }
      const tab = { owner: input.tab.owner, scope: { ...input.tab.scope } }
      const sameScope = (a: OrdinaryScope, b: OrdinaryScope) => a.name === b.name && a.generation === b.generation && a.fence === b.fence
      if (browser.owner !== receipt.browser.owner || tab.owner !== receipt.tab.owner ||
          !sameScope(browser.scope, receipt.browser.scope) || !sameScope(tab.scope, receipt.tab.scope)) hold()
      const live = input.live, work = input.work
      const pending = this.readPairMigrated({ browser, tab, live, work: (b, t, bn, tn, custody) => {
        const captured = pairCustody.get(custody)
        if (receipt.state !== 'consuming' || captured?.kind !== 'read' || !captured.rows ||
            !sameOrdinaryFrame(captured.rows[0].frame, receipt.frames[0]) ||
            !sameOrdinaryFrame(captured.rows[1].frame, receipt.frames[1])) hold()
        OrdinaryStateOwner.validatePairBinding(custody, { browser, tab, live })
        receipt.state = 'consumed' // before reentrant application code
        const result = work(b, t, bn, tn, custody)
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          body = Promise.resolve(result)
          OrdinaryStateOwner.joinPairLifetime(browser.owner, tab.owner, body)
          void body.catch(() => {}); hold()
        }
        OrdinaryStateOwner.validatePairBinding(custody, { browser, tab, live })
        return result
      } })
      const result = pending.catch(error => { receipt.state = 'refused'; throw error })
        .finally(async () => { pairCommits.delete(token); if (body) await Promise.allSettled([body]) })
      return OrdinaryStateOwner.joinPairLifetime(browser.owner, tab.owner, result)
    } catch (error) { receipt.state = 'refused'; pairCommits.delete(token); return Promise.reject(error) }
  }
  /** Reserve the two authenticated input scope names at their existing fence
   * values in the SAME candidate. First-use producers size this reservation
   * before entropy; later forget advances existing entries without needing new
   * fence slots. No prior fence is evicted and no scope is advanced here. */
  static retainPairScopesMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, false, true) as Promise<T>
  }
  /** Deletion and both invitation fences share one native commit. Old captured
   * queries cannot recreate forgotten custody, even when no record existed. */
  static forgetPairMigrated<T>(input: OrdinaryPairMutation<T>): Promise<T> {
    return this.#mutatePairMigrated(input, true) as Promise<T>
  }
  static #mutatePairMigrated<T>(input: OrdinaryPairMutation<T>, fencing: boolean, reserveScopes = false,
    beforeWrite?: OrdinaryPairPrewrite): Promise<T | OrdinaryPairCommitOutcome> {
    const browser = input.browser.owner, tab = input.tab.owner
    const browserScope = { ...input.browser.scope }, tabScope = { ...input.tab.scope }
    const live = input.live, work = input.work
    const check = () => {
      if (browser === tab || browser.purpose !== 'browser' || browser.expiresAt !== 0 ||
          !TAB_PURPOSE.test(tab.purpose) || !Number.isSafeInteger(tab.expiresAt) || tab.expiresAt <= 0 ||
          browser.#generation === undefined || tab.#generation === undefined) hold()
      browser.#check(live); tab.#check(live)
      if (browser.#closed || tab.#closed) hold()
      for (const scope of [browserScope, tabScope]) if (typeof scope.name !== 'string' ||
        !scope.name.length || scope.name.length > 512 || !Number.isSafeInteger(scope.fence) || scope.fence < 0) hold()
    }
    // Defer even the first lock request until the identical promise is joined
    // by both lifetimes. Neither owner can close past unresolved custody.
    const operation = Promise.resolve().then(async () => {
      check()
      if (browser.#retry || tab.#retry || !navigator.locks) hold()
      return navigator.locks.request(WRITE_LOCK, async () => {
        check()
        let browserSnapshot: Snapshot | undefined, tabSnapshot: Snapshot | undefined
        let browserImage: OrdinaryImage | undefined, tabImage: OrdinaryImage | undefined
        let body: Promise<unknown> | undefined
        const current = () => {
          check()
          if (!browserSnapshot?.image || !tabSnapshot?.image) hold()
          browser.#scope(browserSnapshot.image, browserScope); tab.#scope(tabSnapshot.image, tabScope)
          if (browserSnapshot.image.generation !== browser.#generation || tabSnapshot.image.generation !== tab.#generation ||
              browserSnapshot.image.migration?.phase !== 'complete' || tabSnapshot.image.migration?.phase !== 'complete') hold()
        }
        const guarded = () => {
          try { check(); return true } catch { return false }
        }
        try {
          await browser.#operationBarrier(guarded); check()
          // Prior single-owner intents must finish before the callback or any
          // new frame. Both lifetime guards also cover that recovery work.
          browserSnapshot = await browser.#snapshot(guarded); check()
          tabSnapshot = await tab.#snapshot(guarded, false, browser); current()
          if (!browserSnapshot.row || !tabSnapshot.row) hold()
          browserImage = copyImage(browserSnapshot.image!)
          tabImage = copyImage(tabSnapshot.image!)
          const browserView = view(new Map(browserImage.records), true), tabView = view(new Map(tabImage.records), true)
          const custody = Object.freeze({}) as OrdinaryPairCustody
          pairCustody.set(custody, { kind:'mutation', browser: browserImage, tab: tabImage, browserOwner: browser, tabOwner: tab, browserStore: browserView.store, tabStore: tabView.store, browserScope, tabScope, operationMarkers: browser.#classifiedPairMarkers(browserSnapshot.image!, tabSnapshot.image!) })
          let result: T
          try {
            result = work(browserView.store, tabView.store,
              Object.freeze([...browserImage.migration!.names]), Object.freeze([...tabImage.migration!.names]), custody)
            if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
              if (beforeWrite) {
                body = Promise.resolve(result)
                OrdinaryStateOwner.joinPairLifetime(browser, tab, body)
              }
              void Promise.resolve(result).catch(() => {}); hold()
            }
            if (beforeWrite && result !== undefined) hold()
            current()
            ;(browserImage.records as Map<string, string>).clear()
            ;(tabImage.records as Map<string, string>).clear()
            browserImage.records = new Map(browserView.store.keys().map(name => [name, browserView.store.get(name)!]))
            tabImage.records = new Map(tabView.store.keys().map(name => [name, tabView.store.get(name)!]))
          } finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
          preserveOperationMarkers(browserSnapshot.image!.records, browserImage.records)
          preserveOperationMarkers(tabSnapshot.image!.records, tabImage.records)
          browserImage.revision++; tabImage.revision++
          if (reserveScopes) {
            if (!browserImage.fences.has(browserScope.name)) (browserImage.fences as Map<string, number>).set(browserScope.name, browserScope.fence)
            if (!tabImage.fences.has(tabScope.name)) (tabImage.fences as Map<string, number>).set(tabScope.name, tabScope.fence)
          }
          if (fencing) {
            ;(browserImage.fences as Map<string, number>).set(browserScope.name, browserScope.fence + 1)
            ;(tabImage.fences as Map<string, number>).set(tabScope.name, tabScope.fence + 1)
          }
          // The second image can refuse capacity before the first nonce exists.
          ordinaryImageByteLength(browserImage); ordinaryImageByteLength(tabImage)
          const browserFrame = await sealOrdinaryImage(browserImage, browserSnapshot.row.key); current()
          const tabFrame = await sealOrdinaryImage(tabImage, tabSnapshot.row.key); current()
          const installed = await OrdinaryStateOwner.#installPair(browser, tab, browserSnapshot, tabSnapshot,
            { key: browserSnapshot.row.key, frame: beforeWrite ? validateOrdinaryFrame(browserFrame) : browserFrame },
            { key: tabSnapshot.row.key, frame: beforeWrite ? validateOrdinaryFrame(tabFrame) : tabFrame }, current,
            beforeWrite && { work: beforeWrite, browserScope, tabScope })
          if (beforeWrite) {
            if (installed === 'definite-abort') return Object.freeze({ status: 'definite-abort' as const })
            const receipt = Object.freeze({}) as OrdinaryPairCommitReceipt
            pairCommits.set(receipt, { browser: { owner: browser, scope: Object.freeze({ ...browserScope }) },
              tab: { owner: tab, scope: Object.freeze({ ...tabScope }) },
              frames: [validateOrdinaryFrame(browserFrame), validateOrdinaryFrame(tabFrame)], state: 'available' })
            return Object.freeze({ status: 'committed' as const, receipt })
          }
          current()
          return result!
        } finally {
          clearImage(browserImage); clearImage(tabImage)
          clearImage(browserSnapshot?.image); clearImage(tabSnapshot?.image)
          if (body) await Promise.allSettled([body])
        }
      })
    })
    browser.#track(operation); tab.#track(operation)
    return operation
  }
  static async #installPair(browser: OrdinaryStateOwner, tab: OrdinaryStateOwner,
    browserPrevious: Snapshot, tabPrevious: Snapshot, browserCandidate: Row, tabCandidate: Row,
    check: () => void, barrier?: { work: OrdinaryPairPrewrite; browserScope: OrdinaryScope; tabScope: OrdinaryScope }): Promise<'committed' | 'definite-abort'> {
    check()
    const tx = browserPrevious.db.transaction(OWNER_STORE, 'readwrite')
    const browserPurpose = browser.purpose, tabPurpose = tab.purpose
    let aborted = false
    const ended = settled(tx, () => { aborted = true })
    void ended.catch(() => {})
    let writesAttempted = false, authentication: Promise<void> | undefined
    let reconcile = !!barrier
    // Preserve exact expectations independently of the objects passed to
    // native put. Producer receipts are confirmed by a coherent readback even
    // after ordinary oncomplete, rather than inferred from request outcomes.
    const browserExpected = barrier ? { key: browserCandidate.key, frame: validateOrdinaryFrame(browserCandidate.frame) } : browserCandidate
    const tabExpected = barrier ? { key: tabCandidate.key, frame: validateOrdinaryFrame(tabCandidate.frame) } : tabCandidate
    let first: OrdinaryImage | undefined, second: OrdinaryImage | undefined, body: Promise<unknown> | undefined
    let barrierRefused = false, sourceRefused = false, authenticationRefused = false
    const sourceCheck = () => {
      try { check() } catch (error) { sourceRefused = true; throw error }
    }
    const equalImage = (a: OrdinaryImage, b: OrdinaryImage) => {
      const x = encodeOrdinaryImage(a), y = encodeOrdinaryImage(b)
      try { return x.length === y.length && x.every((byte, i) => byte === y[i]) }
      finally { x.fill(0); y.fill(0) }
    }
    try {
      try {
        const store = tx.objectStore(OWNER_STORE)
        const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
        const saved = raw.map(row)
        sourceCheck()
        if (!saved[0]?.frame || !saved[1]?.frame || !sameRow(saved[0], browserPrevious.row) ||
            !sameRow(saved[1], tabPrevious.row) || saved[0].pending || saved[1].pending) hold()
        let authenticated = false, refused = false, barrierStarted = false
        const barrierCheck = () => {
          try {
            sourceCheck()
            if (!barrier || !first || !second || !browserPrevious.image || !tabPrevious.image ||
                first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt || first.generation !== browser.#generation ||
                second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt || second.generation !== tab.#generation ||
                first.migration?.phase !== 'complete' || second.migration?.phase !== 'complete' ||
                !sameRow(saved[0], browserPrevious.row) || !sameRow(saved[1], tabPrevious.row) ||
                !equalImage(first, browserPrevious.image) || !equalImage(second, tabPrevious.image)) hold()
            browser.#scope(first, barrier.browserScope); tab.#scope(second, barrier.tabScope)
          } catch (error) { sourceRefused = true; throw error }
        }
        // CryptoKey clones have no comparable public identity. Authenticate
        // the freshly read keys while THIS writer transaction owns both rows.
        // The barrier and both puts run in its active request callback.
        const keepAlive = () => {
          const r = store.getKey(browser.purpose)
          r.onerror = () => { refused = true; try { tx.abort() } catch {} }
          r.onsuccess = () => {
            try {
              sourceCheck()
              if (refused) { tx.abort(); return }
              if (!authenticated) { keepAlive(); return }
              if (barrier) {
                if (barrierStarted) hold()
                barrierStarted = true
                barrierCheck()
                const browserView = view(new Map(first!.records), false), tabView = view(new Map(second!.records), false)
                const custody = Object.freeze({}) as OrdinaryPairCustody
                pairCustody.set(custody, { kind: 'read', browser: first!, tab: second!, browserOwner: browser, tabOwner: tab,
                  browserStore: browserView.store, tabStore: tabView.store, browserScope: barrier.browserScope, tabScope: barrier.tabScope,
                  rows: [saved[0]!, saved[1]!], operationMarkers: browser.#classifiedPairMarkers(first!, second!) })
                try {
                  const result: unknown = barrier.work(browserView.store, tabView.store,
                    Object.freeze([...first!.migration!.names]), Object.freeze([...second!.migration!.names]), custody)
                  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                    body = Promise.resolve(result)
                    OrdinaryStateOwner.joinPairLifetime(browser, tab, body)
                    void body.catch(() => {}); hold()
                  }
                  if (result !== undefined) hold()
                  barrierCheck()
                } catch (error) { barrierRefused = true; throw error }
                finally { pairCustody.delete(custody); browserView.close(); tabView.close() }
              }
              // No await, application callback, getter or entropy separates
              // the final barrier check from these two candidate puts. Mark
              // attempted before calling put: a throwing native wrapper may
              // already have queued it, so only both-row reconciliation can
              // prove absence after this point.
              writesAttempted = true
              store.put(browserCandidate, browserPurpose)
              store.put(tabCandidate, tabPurpose)
            } catch { refused = true; try { tx.abort() } catch {} }
          }
        }
        keepAlive()
        authentication = (async () => {
          try {
            first = await openOrdinaryFrame(saved[0]!.frame!, saved[0]!.key); sourceCheck()
            second = await openOrdinaryFrame(saved[1]!.frame!, saved[1]!.key); sourceCheck()
            if (first.purpose !== browser.purpose || first.expiresAt !== browser.expiresAt ||
                second.purpose !== tab.purpose || second.expiresAt !== tab.expiresAt) hold()
            authenticated = true
          } catch { refused = true; authenticationRefused = true }
          finally { if (!barrier) { clearImage(first); clearImage(second) } }
        })()
        await ended
      } catch {
        try { tx.abort() } catch {}
        await ended.catch(() => {})
        await authentication
        if (!writesAttempted) {
          // Native abort is proof that neither put was queued. Callback,
          // source or authentication refusal remains a refusal, not an
          // inferred safe-abort result for the producer.
          if (barrier && aborted && !barrierRefused && !sourceRefused && !authenticationRefused && first && second) {
            return 'definite-abort'
          }
          throw new OrdinaryStateHold()
        }
        reconcile = true
      }
      await authentication
      if (!writesAttempted && (barrierRefused || sourceRefused || authenticationRefused)) throw new OrdinaryStateHold()
      if (reconcile) {
        // Classify BOTH exact rows from ONE readonly transaction. Unknown,
        // mixed or unauthenticated results retain this lock and ciphertext.
        for (;;) {
          browser.#db?.close(); browser.#db = undefined
          tab.#db?.close(); tab.#db = undefined
          try {
            const db = await browser.#database(() => true, true)
            const read = db.transaction(OWNER_STORE, 'readonly'), finished = settled(read)
            void finished.catch(() => {})
            let saved: (Row | undefined)[]
            try {
              const store = read.objectStore(OWNER_STORE)
              const [firstRow, secondRow] = await Promise.all([request(store.get(browser.purpose)), request(store.get(tab.purpose)), browser.#operationControlSnapshot(store)])
            const raw = [firstRow, secondRow]
              await finished
              saved = raw.map(row)
            } catch (error) { try { read.abort() } catch {}; await finished.catch(() => {}); throw error }
            if (!saved[0]?.frame || !saved[1]?.frame || saved[0].pending || saved[1].pending) hold()
            let a: OrdinaryImage | undefined, b: OrdinaryImage | undefined
            try {
              a = await openOrdinaryFrame(saved[0].frame, saved[0].key)
              b = await openOrdinaryFrame(saved[1].frame, saved[1].key)
              if (a.purpose !== browser.purpose || a.expiresAt !== browser.expiresAt ||
                  b.purpose !== tab.purpose || b.expiresAt !== tab.expiresAt) hold()
              if (sameRow(saved[0], browserExpected) && sameRow(saved[1], tabExpected)) break
              if (sameRow(saved[0], browserPrevious.row) && sameRow(saved[1], tabPrevious.row)) throw new DefiniteAbort()
            } finally { clearImage(a); clearImage(b) }
          } catch (error) {
            if (error instanceof DefiniteAbort) {
              if (barrier) return 'definite-abort'
              throw new OrdinaryStateHold()
            }
          }
          await new Promise<void>(resolve => { browser.#retry = resolve; tab.#retry = resolve })
          browser.#retry = undefined; tab.#retry = undefined
        }
      }
      await authentication
      // Existing mutation callers still suppress results after liveness loss.
      // The producer receives only a committed custody fact and opaque receipt;
      // adoption must independently authenticate a fresh current pair later.
      if (!barrier) check()
      return 'committed'
    } finally {
      clearImage(first); clearImage(second)
      if (body) await Promise.allSettled([body])
    }
  }

  /** The fence is committed with deletion; a captured pre-forget scope can
   * never repopulate this room. Capacity is checked by the canonical codec. */
  forget(scope: OrdinaryScope, live: () => boolean, selected: (name: string, value: string) => boolean): Promise<void> {
    const captured = { ...scope }
    return this.#mutation(captured, live, store => {
      for (const name of store.keys()) if (selected(name, store.get(name)!)) store.remove(name)
    }, image => { (image.fences as Map<string, number>).set(captured.name, image.revision + 1) })
  }
  migration(scope: OrdinaryScope, live: () => boolean): Promise<OrdinaryMigration | undefined> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const snapshot = await this.#snapshot(live)
      if (!snapshot.image || this.#generation === undefined) hold()
      this.#scope(snapshot.image, captured)
      return snapshot.image.migration ? structuredClone(snapshot.image.migration) : undefined
    }))
  }
  /** Migration orchestration verifies legacy source bytes between these
   * encrypted manifest commits; this method never deletes Storage itself. */
  retainMigration(scope: OrdinaryScope, live: () => boolean, input: OrdinaryMigration): Promise<void> {
    const manifest = { ...input, sources: new Map(input.sources), names: [...input.names] }
    return this.#mutation(scope, live, () => {}, image => { image.migration = manifest })
      .finally(() => manifest.sources.clear())
  }
  #mutation<T>(scope: OrdinaryScope, live: () => boolean, work: (store: DeviceStore, migratedNames?: readonly string[]) => T,
    control?: (image: OrdinaryImage) => void, requireCompleteMigration = false, commitIfTrue = false): Promise<T> {
    const captured = { ...scope }
    return this.#track(this.#locked(live, async () => {
      const current = await this.#snapshot(live)
      if (!current.image || !current.row || this.#generation === undefined) hold()
      this.#scope(current.image, captured)
      if (requireCompleteMigration && current.image.migration?.phase !== 'complete') hold()
      const image = copyImage(current.image)
      const records = new Map(image.records), privateView = view(records, true)
      try {
        const result = work(privateView.store, requireCompleteMigration ? Object.freeze([...current.image.migration!.names]) : undefined)
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') hold()
        this.#check(live)
        if (commitIfTrue) {
          if (typeof result !== 'boolean') hold()
          if (!result) return result
        }
        // Copy before revoking the helper view; no escaped helper may edit the candidate.
        image.records = new Map(records)
        preserveOperationMarkers(current.image.records, image.records)
        privateView.close()
        control?.(image)
        image.revision++
        const frame = await sealOrdinaryImage(image, current.row.key)
        this.#check(live)
        await this.#commit(current, { key: current.row.key, frame }, live)
        this.#check(live)
        return result
      } finally { privateView.close(); (image.records as Map<string,string>).clear(); image.migration?.sources instanceof Map && image.migration.sources.clear() }
    }))
  }
  async #verifyRow(saved: Row): Promise<void> {
    if (!saved.frame && !saved.pending) hold()
    let current: OrdinaryImage | undefined, intended: OrdinaryImage | undefined
    try {
      current = saved.frame ? await openOrdinaryFrame(saved.frame, saved.key) : undefined
      intended = saved.pending ? await openOrdinaryFrame(saved.pending, saved.key) : undefined
      for (const image of [current, intended]) if (image && (image.purpose !== this.purpose || image.expiresAt !== this.expiresAt)) hold()
      if (intended && (current ? intended.generation !== current.generation || intended.keyId !== current.keyId ||
          intended.revision !== current.revision + 1 : intended.revision !== 0)) hold()
    } finally { clearImage(current); clearImage(intended) }
  }
  async #commit(previous: Snapshot, candidate: Row, live: () => boolean): Promise<void> {
    if (!candidate.frame || candidate.pending || previous.row?.pending) hold()
    // Native atomic intent first, then byte-exact promotion. Both rows use
    // the same non-extractable key. No dependent effect is acknowledged at
    // the staging boundary, and restart never re-encrypts the staged frame.
    const staged: Row = { key: candidate.key, pending: candidate.frame,
      ...(previous.row?.frame ? { frame: previous.row.frame } : {}) }
    await this.#install(previous.db, previous.row, staged, live)
    await this.#install(await this.#database(live), staged, candidate, live)
  }
  async #install(db: IDBDatabase, previous: Row | undefined, candidate: Row | undefined, live: () => boolean, expiredCleanup = false): Promise<void> {
    this.#check(live, expiredCleanup)
    const tx = db.transaction(OWNER_STORE, 'readwrite'), ended = settled(tx)
    void ended.catch(() => {})
    const abort = () => { try { tx.abort() } catch {} }
    try {
      const store = tx.objectStore(OWNER_STORE)
      const saved = row(await request(store.get(this.purpose)))
      this.#check(live, expiredCleanup)
      if (!sameRow(saved, previous)) hold()
      if (candidate) store.put(candidate, this.purpose)
      else store.delete(this.purpose)
      await ended
    } catch {
      abort(); await ended.catch(() => {})
      // An acknowledgement failure is reconciled under the SAME lock and
      // with the SAME nonce/frame. No later tab can advance past an unknown.
      for (;;) {
        this.#db?.close(); this.#db = undefined
        try {
          const reopened = await this.#snapshot(() => true, true)
          if (sameRow(reopened.row, candidate)) { if (reopened.row) await this.#verifyRow(reopened.row); break }
          if (sameRow(reopened.row, previous)) throw new DefiniteAbort()
        } catch (reconciliation) {
          if (reconciliation instanceof DefiniteAbort) throw new OrdinaryStateHold()
          // Missing/corrupt/unavailable custody is not absence or success.
        }
        await new Promise<void>(resolve => { this.#retry = resolve })
        this.#retry = undefined
      }
    }
    this.#check(live, expiredCleanup)
  }
  /** Stops local effects immediately, joins actual native work, then closes. */
  async close(): Promise<void> {
    this.#revoke()
    while (this.#work.size) await Promise.allSettled([...this.#work])
    this.#db?.close(); this.#db = undefined
  }
}
