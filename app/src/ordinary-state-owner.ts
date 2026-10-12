import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ordinaryImageByteLength, openOrdinaryFrame, sealOrdinaryImage, sameOrdinaryFrame,
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
interface Row { key: CryptoKey; frame?: OrdinaryFrame; pending?: OrdinaryFrame }
class DefiniteAbort extends Error {}
interface Snapshot { db: IDBDatabase; row?: Row; image?: OrdinaryImage }
function hold(): never { throw new OrdinaryStateHold() }
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new OrdinaryStateHold())
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
/** A private synchronous helper view; escaping it cannot write after the call. */
function view(records: Map<string, string>, writable: boolean): { store: DeviceStore; close(): void } {
  let active = true
  const check = () => { if (!active) hold() }
  return {
    store: {
      get: name => { check(); return records.get(name) ?? null },
      keys: () => { check(); return [...records.keys()] },
      set: (name, value) => { check(); if (!writable) hold(); records.set(name, value) },
      remove: name => { check(); if (!writable) hold(); records.delete(name) },
    },
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
  #retry?: () => void
  /** An unknown native result keeps both the exact candidate and Web Lock. */
  get holdingRetention(): boolean { return this.#retry !== undefined }
  retryRetention(): void { this.#retry?.() }
  #custodyCheck(live: () => boolean, reconciling: boolean): void {
    if (reconciling) { if (!live()) hold() }
    else this.#check(live)
  }
  constructor(readonly purpose: OrdinaryPurpose = 'browser', readonly expiresAt = 0) {}
  #check(live: () => boolean, expiredCleanup = false): void {
    if (this.#closed || !live() || !expiredCleanup && this.purpose !== 'browser' && Date.now() >= this.expiresAt) hold()
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  async #locked<T>(live: () => boolean, work: () => Promise<T>): Promise<T> {
    this.#check(live)
    if (!navigator.locks) hold()
    return navigator.locks.request(WRITE_LOCK, async () => {
      this.#check(live)
      const result = await work()
      this.#check(live)
      return result
    })
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
    db.onversionchange = () => { db.close(); this.#closed = true; this.#db = undefined }
    return db
  }
  async #snapshot(live: () => boolean, reconciling = false): Promise<Snapshot> {
    let db = await this.#database(live, reconciling)
    const tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    let saved: Row | undefined
    try { saved = row(await request(tx.objectStore(OWNER_STORE).get(this.purpose))); await ended }
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
    this.#custodyCheck(live, reconciling)
    if (!reconciling && this.#generation !== undefined && this.#generation !== image.generation) hold()
    return { db, row: saved, image }
  }
  #scope(image: OrdinaryImage, scope: OrdinaryScope): void {
    if (scope.generation !== image.generation || scope.fence !== (image.fences.get(scope.name) ?? 0)) hold()
  }
  async #ownerNames(live: () => boolean): Promise<IDBValidKey[]> {
    const db = await this.#database(live), tx = db.transaction(OWNER_STORE, 'readonly'), ended = settled(tx)
    void ended.catch(() => {})
    const names = await request(tx.objectStore(OWNER_STORE).getAllKeys(undefined, MAX_ORDINARY_TAB_OWNERS + 2))
    await ended; this.#check(live)
    if (names.length > MAX_ORDINARY_TAB_OWNERS + 1 || names.some(name =>
      typeof name !== 'string' || name !== 'browser' && !TAB_PURPOSE.test(name))) hold()
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
        const saved = row(await request(tx.objectStore(OWNER_STORE).get(purpose)))
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
    const current = saved.frame ? await openOrdinaryFrame(saved.frame, saved.key) : undefined
    const intended = saved.pending ? await openOrdinaryFrame(saved.pending, saved.key) : undefined
    for (const image of [current, intended]) if (image && (image.purpose !== this.purpose || image.expiresAt !== this.expiresAt)) hold()
    if (intended && (current ? intended.generation !== current.generation || intended.keyId !== current.keyId ||
        intended.revision !== current.revision + 1 : intended.revision !== 0)) hold()
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
    this.#closed = true
    await Promise.allSettled([...this.#work])
    this.#db?.close(); this.#db = undefined
  }
}
