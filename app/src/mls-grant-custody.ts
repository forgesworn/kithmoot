import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { validateMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'

export const MLS_GRANT_RECORD_BYTES = 2 * 1024 * 1024
export const MLS_GRANT_CUSTODY_BYTES = MLS_GRANT_RECORD_BYTES + 256
const dbName = 'kithmoot-vmls-grants-v1'
const encoder = new TextEncoder()
const aad = [encoder.encode('kithmoot.vmls-grant-ledger.v1'), encoder.encode('kithmoot.vmls-grant-ledger.v2')]
const digestLabel = encoder.encode('kithmoot/vmls-grant-custody-fence/v1')
const hex = /^[0-9a-f]{64}(?![\s\S])/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
const invalid = () => new Error('The VMLS grant custody could not be verified.')
const notReady = () => new Error('The VMLS grant writer barrier is not ready.')

export interface MlsGrantCustody { version: 2; phase: 'fenced' | 'ready'; fence: string; records: MlsGrantRecord[] }
interface Encrypted { key: 'active'; version: 1 | 2; nonce: ArrayBuffer; ciphertext: ArrayBuffer }
interface Snapshot { keyPresent: boolean; key?: CryptoKey; encrypted?: Encrypted; custody?: MlsGrantCustody; records: MlsGrantRecord[] }
export type MlsGrantPreparation = { state: 'ready' | 'blocked' | 'interrupted' | 'refused' }
export interface MlsGrantForegroundScope { readonly signal: AbortSignal; readonly current: () => boolean }
type ForegroundScope = MlsGrantForegroundScope
interface CustodyBinding { check(): void; signal?: AbortSignal; scope?: ForegroundScope }
export type MlsGrantForegroundResult<T> = { state: 'active'; value: T } | { state: 'blocked' | 'interrupted' | 'refused' | 'busy' }

/** Strict primitive validation precedes the legacy signed-term validator. */
export function mlsGrantCustodyRecords(value: unknown): MlsGrantRecord[] {
  if (!Array.isArray(value) || value.length > 256) throw invalid()
  for (const item of value) {
    if (!object(item) || !['node','issuer','persona','device'].every(key => typeof item[key] === 'string' && hex.test(item[key] as string)) ||
        typeof item.grantId !== 'string' || !/^[0-9a-f]{32}(?![\s\S])/.test(item.grantId) || typeof item.state !== 'string' ||
        !object(item.box) || typeof item.box.routeId !== 'string' || typeof item.box.eventUrl !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(item.box.routeId) ||
        typeof item.expiration !== 'number' || item.revokeAfter !== null && typeof item.revokeAfter !== 'number' ||
        !Array.isArray(item.rooms) || item.rooms.length > 64 || item.rooms.some(room => !object(room) || typeof room.name !== 'string' ||
          !['session','leaf'].every(key => typeof room[key] === 'string' && hex.test(room[key] as string)))) throw invalid()
    for (const name of ['active','revocation']) {
      const event = item[name]
      if (!object(event) || !exact(event, 'content,created_at,id,kind,pubkey,sig,tags') ||
          !['id','pubkey'].every(key => typeof event[key] === 'string' && hex.test(event[key] as string)) ||
          typeof event.sig !== 'string' || !/^[0-9a-f]{128}(?![\s\S])/.test(event.sig) || typeof event.content !== 'string' ||
          !Number.isSafeInteger(event.created_at) || !Number.isSafeInteger(event.kind) ||
          !Array.isArray(event.tags) || event.tags.length > 16 || event.tags.some(tag => !Array.isArray(tag) || tag.length !== 2 || tag.some(part => typeof part !== 'string'))) throw invalid()
    }
    validateMlsGrant(item as unknown as MlsGrantRecord)
  }
  if (new Set(value.map(item => `${item.node}/${item.device}`)).size !== value.length) throw invalid()
  const bytes = encoder.encode(JSON.stringify(value))
  try { if (bytes.length > MLS_GRANT_RECORD_BYTES) throw invalid() } finally { bytes.fill(0) }
  const event = (value: MlsGrantRecord['active']) => ({ id: value.id, pubkey: value.pubkey, created_at: value.created_at, kind: value.kind,
    tags: value.tags.map(tag => [...tag]), content: value.content, sig: value.sig })
  return (value as MlsGrantRecord[]).map(item => ({ version: item.version, box: { eventUrl: item.box.eventUrl, routeId: item.box.routeId },
    node: item.node, issuer: item.issuer, persona: item.persona, device: item.device, grantId: item.grantId, expiration: item.expiration,
    rooms: item.rooms.map(room => ({ session: room.session, name: room.name, leaf: room.leaf })), revokeAfter: item.revokeAfter,
    state: item.state, active: event(item.active), revocation: event(item.revocation) }))
    .sort((a, b) => a.node.localeCompare(b.node) || a.device.localeCompare(b.device))
}

export function mlsGrantCustody(value: unknown): MlsGrantCustody {
  if (!object(value) || !exact(value, 'fence,phase,records,version') || value.version !== 2 ||
      value.phase !== 'fenced' && value.phase !== 'ready' || typeof value.fence !== 'string' || !hex.test(value.fence)) throw invalid()
  return { version: 2, phase: value.phase, fence: value.fence, records: mlsGrantCustodyRecords(value.records) }
}

/** The full retained snapshot is required; the digest cannot replace it. */
export function mlsGrantCustodyDigest(custody: MlsGrantCustody): string {
  const bytes = encoder.encode(JSON.stringify(mlsGrantCustody(custody)))
  const input = concatBytes(digestLabel, bytes)
  try { return bytesToHex(sha256(input)) } finally { bytes.fill(0); input.fill(0) }
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error) })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error ?? invalid()) })
}
function same(a?: Encrypted, b?: Encrypted): boolean {
  const equal = (x: ArrayBuffer, y: ArrayBuffer) => x.byteLength === y.byteLength && new Uint8Array(x).every((value, i) => value === new Uint8Array(y)[i])
  return !a && !b || !!a && !!b && a.version === b.version && equal(a.nonce, b.nonce) && equal(a.ciphertext, b.ciphertext)
}

/** Dormant grant-only foundation. No runtime constructs this owner yet.
 * Preparation is explicit and must start outside device/node/persona locks.
 * Neither readiness nor migration infers a remote grant outcome. */
export class BrowserMlsGrantCustody {
  #db?: IDBDatabase
  #opening?: Promise<IDBDatabase>
  #revision = 0
  #preparing = new Set<Promise<unknown>>()
  /** The unbound constructor remains a low-level storage test seam. The
   * application foreground owner creates its own nominal, bound instance. */
  constructor(private readonly foreground?: BrowserMlsGrantForeground) {
    if (foreground !== undefined && !(foreground instanceof BrowserMlsGrantForeground)) throw notReady()
  }
  #binding(): CustodyBinding {
    if (!this.foreground) return { check: () => {} }
    const scope = this.foreground.capture()
    const check = () => {
      if (!scope || this.foreground!.capture() !== scope || scope.signal.aborted || !scope.current()) throw notReady()
    }
    check()
    return { check, signal: scope!.signal, scope }
  }
  /** A blocked result can precede native request termination. Its owning
   * foreground scope must remain occupied until this settlement completes. */
  async preparationSettled(): Promise<void> { await Promise.allSettled([...this.#preparing]) }

  async prepare(current: () => boolean, signal: AbortSignal): Promise<MlsGrantPreparation> {
    if (typeof current !== 'function' || !(signal instanceof AbortSignal) || !globalThis.navigator?.locks || !globalThis.indexedDB) return { state: 'refused' }
    let binding: CustodyBinding
    try { binding = this.#binding(); if (binding.signal && binding.signal !== signal) return { state: 'refused' } }
    catch { return { state: signal.aborted ? 'interrupted' : 'refused' } }
    const live = () => { try { binding.check(); return !signal.aborted && current() === true } catch { return false } }
    const check = () => { if (!live()) throw notReady() }
    try {
      return await new Promise<MlsGrantPreparation>((resolve, reject) => {
        const preparing = navigator.locks.request(dbName + ':migration-v2', { signal }, async (): Promise<MlsGrantPreparation> => {
          check()
          const frozen = await navigator.locks.request(dbName, { signal }, async () => {
            check()
            const db = await this.#database()
            check()
            const snapshot = await this.#read(db, check, signal)
            check()
            if (snapshot.custody) return snapshot.custody
            if (db.version !== 1) throw invalid()
            const key = snapshot.key ?? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt'])
            check()
            const custody: MlsGrantCustody = { version: 2, phase: 'fenced', fence: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), records: snapshot.records }
            await this.#write(db, snapshot, custody, key, check, signal)
            check()
            return custody
          })
          if (frozen.phase === 'ready') return { state: 'ready' }
          const digest = mlsGrantCustodyDigest(frozen)
          const keys = frozen.records.map(record => `kithmoot.vmls-grant.${record.node}.${record.device}`)
          const drain = async (at: number): Promise<MlsGrantPreparation> => {
            check()
            if (at < keys.length) return navigator.locks.request(keys[at], { signal }, () => drain(at + 1))
            const upgraded = await this.#upgrade(check, () => resolve({ state: 'blocked' }))
            check()
            if (!upgraded) return { state: 'blocked' }
            return navigator.locks.request(dbName, { signal }, async () => {
              check()
              const snapshot = await this.#read(upgraded, check, signal)
              check()
              if (!snapshot.custody || snapshot.custody.phase !== 'fenced' || !snapshot.key ||
                  mlsGrantCustodyDigest(snapshot.custody) !== digest || upgraded.version !== 2) throw invalid()
              await this.#write(upgraded, snapshot, { ...snapshot.custody, phase: 'ready' }, snapshot.key, check, signal)
              check()
              return { state: 'ready' }
            })
          }
          return drain(0)
        })
        this.#preparing.add(preparing)
        void preparing.finally(() => this.#preparing.delete(preparing)).catch(() => {})
        void preparing.then(resolve, reject)
      })
    } catch { return { state: live() ? 'refused' : 'interrupted' } }
  }

  async all(): Promise<MlsGrantRecord[]> {
    const { check, signal, scope } = this.#binding()
    const work = () => this.#exclusive(async () => {
      check()
      const db = await this.#database()
      check()
      const snapshot = await this.#read(db, check, signal)
      check()
      if (db.version !== 2 || snapshot.custody?.phase !== 'ready') throw notReady()
      check()
      return structuredClone(snapshot.records)
    }, check, signal)
    return scope ? this.foreground!.track(scope, work) : work()
  }
  async put(record: MlsGrantRecord): Promise<void> {
    const { check, signal, scope } = this.#binding()
    const work = async () => {
      check()
      const copy = mlsGrantCustodyRecords([structuredClone(record)])[0]
      return this.#exclusive(async () => {
      check()
      const db = await this.#database()
      check()
      const snapshot = await this.#read(db, check, signal)
      check()
      if (db.version !== 2 || snapshot.custody?.phase !== 'ready' || !snapshot.key) throw notReady()
      const records = mlsGrantCustodyRecords([...snapshot.records.filter(item => item.node !== copy.node || item.device !== copy.device), copy])
      check()
      await this.#write(db, snapshot, { ...snapshot.custody, records }, snapshot.key, check, signal)
      check()
      }, check, signal)
    }
    return scope ? this.foreground!.track(scope, work) : work()
  }
  async #exclusive<T>(work: () => Promise<T>, check: () => void = () => {}, signal?: AbortSignal): Promise<T> {
    if (!globalThis.navigator?.locks) return Promise.reject(notReady())
    check()
    return navigator.locks.request(dbName, signal ? { signal } : {}, work)
  }
  #adopt(db: IDBDatabase): IDBDatabase {
    if (db.version !== 1 && db.version !== 2 || !db.objectStoreNames.contains('keys') || !db.objectStoreNames.contains('records')) { db.close(); throw invalid() }
    this.#db = db
    db.onversionchange = () => { db.close(); if (this.#db === db) { this.#db = undefined; this.#revision++ } }
    return db
  }
  #database(): Promise<IDBDatabase> {
    if (this.#db) return Promise.resolve(this.#db)
    if (this.#opening) return this.#opening
    const work = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(dbName)
      open.onupgradeneeded = event => {
        if (event.oldVersion !== 0) { open.transaction!.abort(); return }
        open.result.createObjectStore('keys'); open.result.createObjectStore('records', { keyPath: 'key' })
      }
      open.onsuccess = () => { try { resolve(this.#adopt(open.result)) } catch (error) { reject(error) } }
      open.onerror = () => reject(open.error)
    })
    this.#opening = work
    void work.finally(() => { if (this.#opening === work) this.#opening = undefined }).catch(() => {})
    return work
  }
  #upgrade(check: () => void, blocked: () => void): Promise<IDBDatabase | undefined> {
    check()
    this.#db?.close(); this.#db = undefined; this.#revision++
    return new Promise((resolve, reject) => {
      let abandoned = false
      const open = indexedDB.open(dbName, 2)
      // Report promptly, but retain the shared migration and drained writer
      // locks until this native request actually terminates. Other owners
      // cannot enqueue another upgrade while the abandoned request is pending.
      open.onblocked = () => { abandoned = true; blocked() }
      open.onupgradeneeded = () => {
        try { if (abandoned) throw notReady(); check() } catch { abandoned = true; open.transaction!.abort() }
      }
      open.onsuccess = () => {
        try { if (abandoned) { open.result.close(); resolve(undefined); return }; check(); resolve(this.#adopt(open.result)) }
        catch (error) { open.result.close(); reject(error) }
      }
      open.onerror = () => { if (!abandoned) reject(open.error); else resolve(undefined) }
    })
  }
  async #read(db: IDBDatabase, check: () => void = () => {}, signal?: AbortSignal): Promise<Snapshot> {
    check()
    const revision = this.#revision
    const transaction = db.transaction(['keys','records'], 'readonly'), done = completed(transaction)
    void done.catch(() => {})
    const abort = () => { try { transaction.abort() } catch { /* Already terminal. */ } }
    signal?.addEventListener('abort', abort, { once: true })
    let keyRecord: unknown, keySlot: IDBValidKey | undefined, raw: unknown
    try {
      [keyRecord, keySlot, raw] = await Promise.all([request(transaction.objectStore('keys').get('device')),
        request(transaction.objectStore('keys').getKey('device')), request(transaction.objectStore('records').get('active'))])
      check()
      await done
      check()
    } catch (error) { abort(); await done.catch(() => {}); throw error }
    finally { signal?.removeEventListener('abort', abort) }
    if (db !== this.#db || revision !== this.#revision) throw notReady()
    const key = (keyRecord as { key?: CryptoKey } | undefined)?.key
    const keyPresent = keySlot !== undefined
    if (keyPresent && (!object(keyRecord) || !exact(keyRecord, 'key') || !(key instanceof CryptoKey) || key.extractable ||
        key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256 ||
        [...key.usages].sort().join(',') !== 'decrypt,encrypt')) throw invalid()
    if (!raw) {
      if (db.version !== 1) throw invalid()
      check()
      return { keyPresent, key, records: [] }
    }
    if (!object(raw) || !exact(raw, 'ciphertext,key,nonce,version') || raw.key !== 'active' || raw.version !== 1 && raw.version !== 2 ||
        !(raw.nonce instanceof ArrayBuffer) || raw.nonce.byteLength !== 12 || !(raw.ciphertext instanceof ArrayBuffer) ||
        raw.ciphertext.byteLength > (raw.version === 1 ? MLS_GRANT_RECORD_BYTES : MLS_GRANT_CUSTODY_BYTES) + 16 || !key ||
        raw.version === 1 && db.version !== 1) throw invalid()
    const encrypted = raw as unknown as Encrypted
    check()
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.nonce, additionalData: aad[encrypted.version - 1] }, key, encrypted.ciphertext))
    try {
      check()
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const custody = encrypted.version === 2 ? mlsGrantCustody(value) : undefined
      if (custody?.phase === 'ready' && db.version !== 2 || db !== this.#db || revision !== this.#revision) throw invalid()
      check()
      return { keyPresent, key, encrypted, custody, records: custody?.records ?? mlsGrantCustodyRecords(value) }
    } finally { bytes.fill(0) }
  }
  async #write(db: IDBDatabase, snapshot: Snapshot, custody: MlsGrantCustody, key: CryptoKey, check: () => void, signal?: AbortSignal): Promise<void> {
    check()
    const revision = this.#revision, bytes = encoder.encode(JSON.stringify(mlsGrantCustody(custody)))
    let encrypted: Encrypted
    try {
      if (bytes.length > MLS_GRANT_CUSTODY_BYTES) throw invalid()
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      encrypted = { key: 'active', version: 2, nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad[1] }, key, bytes) }
    } finally { bytes.fill(0) }
    check()
    if (db !== this.#db || revision !== this.#revision || custody.phase === 'ready' && db.version !== 2) throw notReady()
    const transaction = db.transaction(['keys','records'], 'readwrite'), done = completed(transaction)
    void done.catch(() => {})
    const abort = () => { try { transaction.abort() } catch { /* A committed transaction cannot be rolled back. */ } }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const [savedKey, savedKeySlot, saved] = await Promise.all([request(transaction.objectStore('keys').get('device')),
        request(transaction.objectStore('keys').getKey('device')), request(transaction.objectStore('records').get('active'))])
      check()
      if (!same(snapshot.encrypted, saved) || snapshot.keyPresent !== (savedKeySlot !== undefined) ||
          !!snapshot.key !== !!savedKey?.key || db !== this.#db || revision !== this.#revision) throw invalid()
      check()
      if (!snapshot.keyPresent) transaction.objectStore('keys').put({ key }, 'device')
      transaction.objectStore('records').put(encrypted)
      await done
      check()
    } catch (error) {
      try { transaction.abort() } catch { /* It may already have aborted. */ }
      await done.catch(() => {})
      throw error
    } finally { signal?.removeEventListener('abort', abort) }
  }
}

/** Nominal foreground storage ownership. The runtime composition keeps this
 * private and exposes named workflows, never its custody or a replacement
 * Store. Nested ledger/inbox/decision calls share the exact captured scope.
 * This class alone is not a usable application or endpoint composition. */
export class BrowserMlsGrantForeground {
  readonly #custody = new BrowserMlsGrantCustody(this)
  #scope?: ForegroundScope
  #prepared?: ForegroundScope
  #controller?: AbortController
  #epoch = 0
  #pending = new Set<Promise<unknown>>()
  #errors: unknown[] = []
  #settled: Promise<void> = Promise.resolve()
  capture(): ForegroundScope | undefined { return this.#scope }
  prepared(scope: ForegroundScope): boolean { return this.#prepared === scope && this.#scope === scope && scope.current() }
  invalidate(): void { this.#epoch++; this.#controller?.abort() }
  settled(): Promise<void> { return this.#settled }
  invalidateAndWait(): Promise<void> { this.invalidate(); return this.settled() }
  /** Concrete bound custody registers even floated I/O before it can yield.
   * A callback's return cannot release ownership ahead of that settlement. */
  track<T>(scope: ForegroundScope, work: () => Promise<T>): Promise<T> {
    if (this.#scope !== scope || !scope.current()) return Promise.reject(notReady())
    const pending = Promise.resolve().then(async () => {
      if (this.#scope !== scope || !scope.current()) throw notReady()
      const result = await work()
      if (this.#scope !== scope || !scope.current()) throw notReady()
      return result
    }).catch(error => { this.#errors.push(error); throw error }).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    void pending.catch(() => {})
    return pending
  }
  async #drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending])
  }

  async run<T>(current: () => boolean, signal: AbortSignal,
    work: (custody: BrowserMlsGrantCustody) => Promise<T>): Promise<MlsGrantForegroundResult<T>> {
    if (this.#scope) return { state: 'busy' }
    if (typeof current !== 'function' || !(signal instanceof AbortSignal) || typeof work !== 'function') return { state: 'refused' }
    const epoch = this.#epoch, controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const scope = Object.freeze({ signal: controller.signal, current: () => {
      try { return this.#scope === scope && epoch === this.#epoch && !controller.signal.aborted && current() === true } catch { return false }
    } })
    this.#scope = scope; this.#controller = controller
    const errors = this.#errors = []
    let resolveSettled!: () => void
    this.#settled = new Promise<void>(resolve => { resolveSettled = resolve })
    const cleanup = () => {
      controller.abort(); signal.removeEventListener('abort', abort)
      if (this.#scope === scope) { this.#scope = undefined; this.#prepared = undefined; this.#controller = undefined }
      resolveSettled()
    }
    const finish = async () => {
      await this.#custody.preparationSettled()
      await this.#drain()
      const valid = scope.current()
      cleanup()
      return valid
    }
    let prepared: MlsGrantPreparation = { state: 'interrupted' }, value: T | undefined, error: unknown, failed = false, errorWasCurrent = false
    try {
      if (scope.current()) prepared = await this.#custody.prepare(scope.current, scope.signal)
      if (prepared.state === 'blocked') {
        void finish().catch(() => cleanup())
        return { state: 'blocked' }
      }
      if (prepared.state === 'ready') {
        await this.#custody.preparationSettled()
        if (scope.current()) { this.#prepared = scope; value = await work(this.#custody) }
      }
    } catch (caught) {
      failed = true; error = caught; errorWasCurrent = scope.current()
      controller.abort()
    }
    const valid = await finish()
    if (failed && errorWasCurrent) throw error
    let stillCurrent = false
    try { stillCurrent = epoch === this.#epoch && !signal.aborted && current() === true } catch {}
    if (!valid || !stillCurrent) return { state: 'interrupted' }
    if (errors.length) throw errors[0]
    if (prepared.state !== 'ready') return { state: prepared.state }
    return { state: 'active', value: value as T }
  }
}
