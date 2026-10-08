import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { VaultLocks } from './mls-vault.js'

/** The coordinator covers the exact inner ciphertext, not this outer seal.
 * Session ciphertext includes the engine's outbox, evidence and replay state. */
export interface PersonaObjects {
  vault: { id: string; sealed: string }[]
  sessions: { id: string; generation: string; sealed: string }[]
}
export interface PersonaWitnessRoute {
  routeId: string
  card: string
  pairedRouteSecret: string
  cardSerial: string
  cardVerifiedAt: string
}
export interface PersonaData {
  version: 1
  persona: string
  installation: string
  writerSeed: string
  witnessRoute: PersonaWitnessRoute | null
  coordinator: string | null
  active: PersonaObjects
  staged: PersonaObjects | null
  cleared: boolean
}
/** No persona or secret in the marker. Its existence forbids silently
 * replacing a missing sealed record. Retirement/replacement keeps tombstones. */
export interface PersonaMarker {
  version: 1
  state: 'prepared' | 'genesis' | 'fenced' | 'superseded'
  subject: string | null
  installation: string
  writer: string | null
  digest: string | null
  reason: string | null
  retired: { subject: string | null; installation: string }[]
}
export interface PersonaSnapshot { revision: string; data: PersonaData; marker: PersonaMarker }
interface SealedPersona { revision: string; sealed: ArrayBuffer }
interface Keys { outer: CryptoKey; inner?: CryptoKey }
export class PersonaStorageError extends Error {
  constructor(readonly code: 'unavailable' | 'seal-lost' | 'missing-record' | 'conflict' | 'invalid' | 'closed') {
    super(`MLS persona storage: ${code}`)
  }
}
const HEX32 = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/
const MAX_FIELD = 8 * 1024 * 1024
const MAX_CONTAINER = 64 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const empty = (): PersonaObjects => ({ vault: [], sessions: [] })
function requireValue(ok: unknown): asserts ok { if (!ok) throw new PersonaStorageError('invalid') }
function bytes(value: unknown, max = MAX_FIELD): asserts value is string {
  requireValue(typeof value === 'string' && value.length <= max * 2 && HEX.test(value))
}
function uint(value: string, positive = false): bigint {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value))
  const n = BigInt(value)
  // The manifest's generation is a positive signed 64-bit integer; the Link
  // route counters (positive=false) retain their full unsigned wire range.
  requireValue(n <= (positive ? 0x7fffffffffffffffn : 0xffffffffffffffffn) && (!positive || n > 0n))
  return n
}
function objects(value: PersonaObjects): void {
  requireValue(value && Array.isArray(value.vault) && value.vault.length <= 64 && Array.isArray(value.sessions) && value.sessions.length <= 1024)
  for (const item of value.vault) { bytes(item.id, 256); bytes(item.sealed); requireValue(item.sealed.length >= 58) }
  for (const item of value.sessions) { requireValue(HEX32.test(item.id)); uint(item.generation, true); bytes(item.sealed); requireValue(item.sealed.length >= 58) }
  requireValue(new Set(value.vault.map(x => x.id)).size === value.vault.length)
  requireValue(new Set(value.sessions.map(x => x.id)).size === value.sessions.length)
}
/** Recompute from actual durable ciphertext every time the coordinator opens.
 * There are deliberately no cached digest fields in the persisted schema. */
export function personaManifest(value: PersonaObjects, objectHash: (bytes: Uint8Array) => Uint8Array): unknown[] {
  objects(value)
  return [
    ...value.vault.map(item => ({ type: 'vault', record: hexToBytes(item.id), sealedHash: objectHash(hexToBytes(item.sealed)) })),
    ...value.sessions.map(item => ({ type: 'session', session: hexToBytes(item.id), generation: uint(item.generation, true), snapshotHash: objectHash(hexToBytes(item.sealed)) })),
  ]
}
function validate(data: PersonaData, marker: PersonaMarker, persona: string): void {
  requireValue(data?.version === 1 && data.persona === persona && HEX32.test(persona) && HEX32.test(data.installation) && HEX32.test(data.writerSeed) && typeof data.cleared === 'boolean')
  if (data.coordinator !== null) bytes(data.coordinator)
  objects(data.active)
  if (data.staged !== null) { requireValue(data.coordinator !== null); objects(data.staged) }
  if (data.cleared) requireValue(data.coordinator !== null && data.active.vault.length === 0 && data.active.sessions.length === 0 && data.staged === null)
  if (data.witnessRoute !== null) {
    const route = data.witnessRoute
    requireValue(route && /^[A-Za-z0-9._:-]{1,128}$/.test(route.routeId) && HEX32.test(route.pairedRouteSecret))
    bytes(route.card, 64 * 1024); uint(route.cardSerial); uint(route.cardVerifiedAt)
  }
  validateMarker(marker)
  requireValue(marker.state !== 'superseded')
  requireValue(marker.installation === data.installation)
}
function validateMarker(marker: PersonaMarker): void {
  requireValue(marker?.version === 1 && ['prepared', 'genesis', 'fenced', 'superseded'].includes(marker.state) && HEX32.test(marker.installation))
  for (const field of [marker.subject, marker.writer, marker.digest]) requireValue(field === null || HEX32.test(field))
  requireValue(marker.reason === null || (typeof marker.reason === 'string' && marker.reason.length <= 128))
  if (marker.state === 'fenced') requireValue(typeof marker.reason === 'string' && marker.reason.length > 0)
  requireValue(Array.isArray(marker.retired) && marker.retired.length <= 64)
  for (const t of marker.retired) requireValue(HEX32.test(t.installation) && (t.subject === null || HEX32.test(t.subject)))
}

/** Each callback owns the persona Web Lock, including its witness trip. No
 * IndexedDB transaction survives a crypto operation or network await. Browser
 * transaction completion is the durability boundary; it is weaker than fsync.
 * No fallback to a process-local mutex when Web Locks are unavailable. */
export class BrowserMlsPersonaStore {
  #database: Promise<IDBDatabase> | undefined
  constructor(private readonly dbName = 'kithmoot-mls-personas-v1',
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly locks: VaultLocks = globalThis.navigator?.locks,
    private readonly crypto: Crypto = globalThis.crypto) {
    if (!factory || !locks || !crypto?.subtle) throw new PersonaStorageError('unavailable')
  }
  async withPersona<T>(persona: string, work: (store: LockedPersonaStore) => Promise<T>): Promise<T> {
    requireValue(HEX32.test(persona))
    const db = await this.#db()
    const key = await this.locks.request(`${this.dbName}:names`, async () => {
      const tx = db.transaction(['keys', 'personas', 'markers'], 'readonly'), done = complete(tx)
      const saved = request<CryptoKey | undefined>(tx.objectStore('keys').get('names'))
      const counts = Promise.all(['keys', 'personas', 'markers'].map(s => request(tx.objectStore(s).count())))
      const [existing, count] = await Promise.all([saved, counts, done]).then(([a, b]) => [a, b] as const)
      if (existing) return existing
      // A missing naming key alongside any retained state is not a new store.
      if (count.some(n => n > 0)) throw new PersonaStorageError('seal-lost')
      const created = await this.crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
      const put = db.transaction('keys', 'readwrite'), committed = complete(put)
      put.objectStore('keys').add(created, 'names')
      await committed
      return created
    })
    const name = bytesToHex(new Uint8Array(await this.crypto.subtle.sign('HMAC', key, encoder.encode(`persona|${persona}`))))
    return this.locks.request(`${this.dbName}:persona:${name}`, async () => {
      const store = new LockedPersonaStore(db, name, persona, this.crypto)
      try { return await work(store) } finally { await store.close() }
    })
  }
  async close(): Promise<void> { (await this.#database)?.close(); this.#database = undefined }
  #db(): Promise<IDBDatabase> {
    return this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.factory.open(this.dbName, 1)
      open.onupgradeneeded = () => { for (const name of ['keys', 'personas', 'markers']) open.result.createObjectStore(name) }
      open.onsuccess = () => { open.result.onversionchange = () => open.result.close(); resolve(open.result) }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new PersonaStorageError('unavailable'))
    }).catch(error => { this.#database = undefined; throw error })
  }
}

/** Scoped to withPersona. A leaked handle cannot start work after unlock;
 * unfinished operations are drained before releasing the lock. */
export class LockedPersonaStore {
  #closed = false
  #pending = new Set<Promise<unknown>>()
  constructor(private readonly db: IDBDatabase, private readonly name: string,
    private readonly persona: string, private readonly crypto: Crypto) {}
  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#pending]) }
  #run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new PersonaStorageError('closed'))
    const task = work()
    this.#pending.add(task)
    void task.then(() => this.#pending.delete(task), () => this.#pending.delete(task))
    return task
  }
  async #rows(): Promise<{ row?: SealedPersona; marker?: PersonaMarker; keys?: Keys }> {
    const tx = this.db.transaction(['personas', 'markers', 'keys'], 'readonly'), done = complete(tx)
    const row = request<SealedPersona | undefined>(tx.objectStore('personas').get(this.name))
    const marker = request<PersonaMarker | undefined>(tx.objectStore('markers').get(this.name))
    const keys = request<Keys | undefined>(tx.objectStore('keys').get(this.name))
    const [r, m, k] = await Promise.all([row, marker, keys, done])
    return { row: r, marker: m, keys: k }
  }
  /** allowMissingInner is for the coordinator's retiring/clear path only.
   * Before any ordinary mutation it must separately check the inner key and
   * authenticate the named objects. The outer record is always authenticated. */
  read(allowMissingInner = false): Promise<PersonaSnapshot | undefined> {
    return this.#run(async () => {
      const { row, marker, keys } = await this.#rows()
      if (!row) {
        if (marker?.state === 'superseded' && !keys) { validateMarker(marker); return undefined }
        if (marker || keys) throw new PersonaStorageError('missing-record')
        return undefined
      }
      if (!marker) throw new PersonaStorageError('missing-record')
      if (!keys?.outer) throw new PersonaStorageError('seal-lost')
      const plain = await open(this.crypto, keys.outer, this.#outerAad(row.revision), new Uint8Array(row.sealed), MAX_CONTAINER)
      try {
        const data: PersonaData = JSON.parse(decoder.decode(plain))
        validate(data, marker, this.persona)
        if (!data.cleared && !keys.inner && !allowMissingInner) throw new PersonaStorageError('seal-lost')
        return { revision: row.revision, data, marker }
      } catch (error) {
        if (error instanceof PersonaStorageError) throw error
        throw new PersonaStorageError('invalid')
      } finally { plain.fill(0) }
    })
  }
  marker(): Promise<PersonaMarker | undefined> {
    return this.#run(async () => { const m = (await this.#rows()).marker; if (m) validateMarker(m); return m })
  }
  hasInnerKey(): Promise<boolean> { return this.#run(async () => !!(await this.#rows()).keys?.inner) }
  /** A terminal local fence survives later restoration of a missing key or
   * object. The first reason and subject are kept for explicit retirement.
   * If the marker itself is absent/corrupt, fail rather than minting an id. */
  fence(reason: string): Promise<PersonaMarker> {
    return this.#run(async () => {
      requireValue(typeof reason === 'string' && reason.length > 0 && reason.length <= 128)
      const tx = this.db.transaction('markers', 'readwrite'), done = complete(tx)
      let result: PersonaMarker | undefined, failure: unknown
      const get = tx.objectStore('markers').get(this.name)
      get.onsuccess = () => {
        try {
          validateMarker(get.result)
          result = get.result.state === 'fenced' ? get.result : { ...get.result, state: 'fenced', reason }
          tx.objectStore('markers').put(result, this.name)
        } catch (error) { failure = error; tx.abort() }
      }
      try { await done } catch (error) { throw failure ?? error }
      return result!
    })
  }
  create(): Promise<PersonaSnapshot> {
    return this.#run(async () => {
      const previous = await this.#rows()
      if (previous.row || previous.keys) throw new PersonaStorageError('conflict')
      if (previous.marker) { validateMarker(previous.marker); if (previous.marker.state !== 'superseded') throw new PersonaStorageError('conflict') }
      const data: PersonaData = { version: 1, persona: this.persona, installation: this.#random(), writerSeed: this.#random(), witnessRoute: null, coordinator: null, active: empty(), staged: null, cleared: false }
      const retired = previous.marker?.retired ?? []
      if (retired.some(t => t.installation === data.installation)) throw new PersonaStorageError('conflict')
      const marker: PersonaMarker = { version: 1, state: 'prepared', subject: null, installation: data.installation, writer: null, digest: null, reason: null, retired }
      const make = () => this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const keys = { outer: await make(), inner: await make() }
      return this.#save(null, data, marker, keys)
    })
  }
  /** Atomic stage or promotion: coordinator bytes and BOTH object sets change
   * together. Unchanged inner seals must be retained byte for byte. */
  write(expected: string, data: PersonaData, marker: PersonaMarker): Promise<PersonaSnapshot> {
    // Copy before the first await: caller mutation cannot change a candidate
    // while its seal is being computed.
    const copy = structuredClone({ data, marker })
    return this.#run(async () => {
      const { row, keys, marker: previous } = await this.#rows()
      if (!row || row.revision !== expected) throw new PersonaStorageError('conflict')
      if (!keys?.outer || (!copy.data.cleared && !keys.inner)) throw new PersonaStorageError('seal-lost')
      if (!previous || previous.installation !== copy.data.installation) throw new PersonaStorageError('conflict')
      return this.#save(expected, copy.data, copy.marker, keys)
    })
  }
  async #save(expected: string | null, data: PersonaData, marker: PersonaMarker, keys: Keys): Promise<PersonaSnapshot> {
    validate(data, marker, this.persona)
    const revision = this.crypto.randomUUID(), plain = encoder.encode(JSON.stringify(data))
    let sealed: Uint8Array<ArrayBuffer>
    try { requireValue(plain.length <= MAX_CONTAINER); sealed = await seal(this.crypto, keys.outer, this.#outerAad(revision), plain) }
    finally { plain.fill(0) }
    const tx = this.db.transaction(['personas', 'markers', 'keys'], 'readwrite'), done = complete(tx)
    let conflict = false
    const current = tx.objectStore('personas').get(this.name)
    current.onsuccess = () => {
      if ((current.result?.revision ?? null) !== expected) { conflict = true; tx.abort(); return }
      const previous = tx.objectStore('markers').get(this.name)
      previous.onsuccess = () => {
        // fence() can commit while an asynchronous outer seal is pending.
        // Checking only the persona revision would let that old seal un-fence it.
        if (previous.result?.state === 'fenced' && (marker.state !== 'fenced' || marker.reason !== previous.result.reason)) { conflict = true; tx.abort(); return }
        // Ordinary writes never discard retirement history or rewrite an
        // enrolled subject. Only supersede() may change those lifecycle facts.
        if (previous.result && (JSON.stringify(previous.result.retired) !== JSON.stringify(marker.retired) ||
          (['genesis', 'fenced'].includes(previous.result.state) && ['subject', 'writer', 'digest'].some(key => previous.result[key] !== marker[key as 'subject' | 'writer' | 'digest'])))) { conflict = true; tx.abort(); return }
        if (expected === null) {
          // Only an explicit supersession permits replacing a retained marker.
          if (previous.result && (previous.result.state !== 'superseded' || JSON.stringify(previous.result.retired) !== JSON.stringify(marker.retired))) { conflict = true; tx.abort(); return }
          tx.objectStore('keys').add(keys, this.name)
        } else if (data.cleared) {
          // Key destruction and the retiring-only file are one transaction.
          tx.objectStore('keys').put({ outer: keys.outer }, this.name)
        }
        tx.objectStore('markers').put(marker, this.name)
        tx.objectStore('personas').put({ revision, sealed: sealed.buffer }, this.name)
      }
    }
    try { await done } catch (error) { if (conflict) throw new PersonaStorageError('conflict'); throw error }
    return { revision, data, marker }
  }
  /** Remove the old file and both keys atomically, retaining its fence. A
   * successful local erase is never a claim that the witness retired it. */
  erase(expected: string | null): Promise<void> { return this.#remove(expected, false).then(() => undefined) }
  /** Called only after the coordinator's signed retirement or the keeper's
   * explicit exact-subject confirmation. The coordinator rejects a live duty. */
  supersede(expected: string | null, subject: string | null): Promise<PersonaMarker> { return this.#remove(expected, true, subject) }
  /** A damaged seal can still be erased after an explicit clear. Its opaque
   * revision participates in the same CAS; this exposes no secret metadata. */
  revision(): Promise<string | null> { return this.#run(async () => (await this.#rows()).row?.revision ?? null) }
  #remove(expected: string | null, supersede: boolean, subject?: string | null): Promise<PersonaMarker> {
    return this.#run(async () => {
      const tx = this.db.transaction(['personas', 'markers', 'keys'], 'readwrite'), done = complete(tx)
      let result: PersonaMarker | undefined, failure: unknown
      const row = tx.objectStore('personas').get(this.name)
      row.onsuccess = () => {
        if ((row.result?.revision ?? null) !== expected) { failure = new PersonaStorageError('conflict'); tx.abort(); return }
        const marker = tx.objectStore('markers').get(this.name)
        marker.onsuccess = () => {
          try {
            validateMarker(marker.result)
            const previous: PersonaMarker = marker.result
            if (previous.state !== 'fenced' || (supersede && previous.subject !== subject)) throw new PersonaStorageError('conflict')
            const retired = [...previous.retired.filter(t => t.installation !== previous.installation), { subject: previous.subject, installation: previous.installation }].slice(-64)
            result = supersede ? { ...previous, state: 'superseded', reason: null, writer: null, digest: null, retired } : previous
            tx.objectStore('personas').delete(this.name)
            tx.objectStore('keys').delete(this.name)
            tx.objectStore('markers').put(result, this.name)
          } catch (error) { failure = error; tx.abort() }
        }
      }
      try { await done } catch (error) { throw failure ?? error }
      return result!
    })
  }
  sealObject(installation: string, record: string, plain: Uint8Array): Promise<string> {
    return this.#object('seal', installation, record, undefined, plain)
  }
  openObject(installation: string, record: string, sealed: string): Promise<Uint8Array> {
    bytes(sealed)
    return this.#object('open', installation, record, undefined, hexToBytes(sealed))
  }
  sealSession(installation: string, session: string, generation: string, plain: Uint8Array): Promise<string> {
    return this.#object('seal', installation, session, generation, plain)
  }
  openSession(installation: string, session: string, generation: string, sealed: string): Promise<Uint8Array> {
    bytes(sealed)
    return this.#object('open', installation, session, generation, hexToBytes(sealed))
  }
  #object<T extends 'seal' | 'open'>(operation: T, installation: string, id: string, generation: string | undefined, value: Uint8Array): Promise<T extends 'seal' ? string : Uint8Array> {
    if (this.#closed) return Promise.reject(new PersonaStorageError('closed'))
    const copy = value.slice()
    return this.#run(async () => {
      try {
        requireValue(HEX32.test(installation)); bytes(id, 256)
        if (generation !== undefined) { requireValue(HEX32.test(id)); uint(generation, true) }
        requireValue(copy.length <= MAX_FIELD - (operation === 'seal' ? 29 : 0))
        const { keys, marker } = await this.#rows()
        if (!keys?.inner) throw new PersonaStorageError('seal-lost')
        if (marker?.installation !== installation) throw new PersonaStorageError('conflict')
        const aad = encoder.encode(JSON.stringify(['kithmoot.mls-persona.object', 1, this.persona, installation, generation === undefined ? 'vault' : 'session', id, generation ?? null]))
        return (operation === 'seal' ? bytesToHex(await seal(this.crypto, keys.inner, aad, copy)) : await open(this.crypto, keys.inner, aad, copy, MAX_FIELD)) as T extends 'seal' ? string : Uint8Array
      } finally { copy.fill(0) }
    })
  }
  #random(): string { return bytesToHex(this.crypto.getRandomValues(new Uint8Array(32))) }
  #outerAad(revision: string): Uint8Array<ArrayBuffer> { return encoder.encode(JSON.stringify(['kithmoot.mls-persona', 1, this.persona, revision])) }
}

async function seal(crypto: Crypto, key: CryptoKey, aad: Uint8Array<ArrayBuffer>, plain: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const input = plain.slice()
  let ciphertext: Uint8Array
  try { ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, input)) }
  finally { input.fill(0) }
  const result = new Uint8Array(13 + ciphertext.length)
  result[0] = 1; result.set(nonce, 1); result.set(ciphertext, 13)
  return result
}
async function open(crypto: Crypto, key: CryptoKey, aad: Uint8Array<ArrayBuffer>, sealed: Uint8Array, max: number): Promise<Uint8Array> {
  requireValue(sealed.length >= 29 && sealed.length <= max + 29 && sealed[0] === 1)
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(1, 13), additionalData: aad }, key, sealed.slice(13))) }
  catch (error) { if (error instanceof DOMException && error.name === 'OperationError') throw new PersonaStorageError('seal-lost'); throw error }
}
function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new PersonaStorageError('unavailable')); tx.onerror = () => { /* onabort is the completion boundary */ } }) }
