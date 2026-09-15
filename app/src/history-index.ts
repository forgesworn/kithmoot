/**
 * Encrypted, device-local index for history a person has explicitly imported.
 *
 * This module has no relay transport, URL or fetch API. Query text and
 * decrypted documents only exist in the caller's process. The non-extractable
 * AES-GCM key is stored as a browser CryptoKey in IndexedDB, not derived from
 * a Nostr recovery phrase and never copied into localStorage.
 */

const VERSION = 1
const AAD = new TextEncoder().encode('kithmoot.history-index.v1')
const MAX_DOCUMENT_BYTES = 64 * 1024
const MAX_DOCUMENTS = 20_000
const NONCE_BYTES = 12

export interface ImportedHistoryDocument {
  /** Original signed Nostr event ID. Kept inside ciphertext. */
  id: string
  room?: string
  conversation?: string
  participant?: string
  sentAt: number
  text: string
  files?: string[]
}

export interface EncryptedHistoryRecord {
  /** Random local handle; never an event or room identifier. */
  key: string
  version: 1
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}

export interface HistoryIndexStorage {
  key(): Promise<CryptoKey | undefined>
  saveKey(key: CryptoKey): Promise<void>
  records(): Promise<EncryptedHistoryRecord[]>
  put(record: EncryptedHistoryRecord): Promise<void>
  remove(key: string): Promise<void>
}

export interface LocalHistorySearchResult {
  document: ImportedHistoryDocument
  /** Which encrypted record supplied it, useful only for local deletion. */
  storageKey: string
}

export class LocalHistoryIndex {
  #key: CryptoKey | undefined
  #openingKey: Promise<CryptoKey> | undefined
  constructor(private readonly storage: HistoryIndexStorage, private readonly crypt: Crypto = globalThis.crypto) {
    if (!crypt?.subtle || !crypt.getRandomValues) throw new Error('This device cannot create an encrypted history index.')
  }

  /** Adds an imported, already-authorised document without writing any
   * plaintext metadata beside it. Existing event IDs remain one record. */
  async add(document: ImportedHistoryDocument): Promise<'stored' | 'duplicate'> {
    assertDocument(document)
    const existing = await this.#opened()
    if (existing.some(value => value.document.id === document.id)) return 'duplicate'
    if (existing.length >= MAX_DOCUMENTS) throw new Error('This device history index is full; remove imported history before adding more.')
    const plaintext = new TextEncoder().encode(JSON.stringify(document))
    if (plaintext.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Imported history item is too large for the local index.')
    const nonce = new Uint8Array(NONCE_BYTES); this.crypt.getRandomValues(nonce)
    const ciphertext = await this.crypt.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, await this.#deviceKey(), plaintext)
    await this.storage.put({ key: randomHandle(this.crypt), version: VERSION, nonce: copy(nonce), ciphertext })
    return 'stored'
  }

  /** Search is an in-process decrypt-and-match operation. It sends no request
   * anywhere and deliberately reports only imported-index coverage. */
  async search(query: string, limit = 100): Promise<LocalHistorySearchResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Use a local search limit from 1 to 500.')
    const needle = query.trim().toLocaleLowerCase()
    const values = await this.#opened()
    return values.filter(value => {
      if (!needle) return true
      const document = value.document
      return [document.text, document.participant ?? '', ...(document.files ?? [])].join('\n').toLocaleLowerCase().includes(needle)
    }).sort((a, b) => b.document.sentAt - a.document.sentAt || b.document.id.localeCompare(a.document.id)).slice(0, limit)
  }

  async remove(eventId: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error('Invalid imported event ID.')
    const matches = (await this.#opened()).filter(value => value.document.id === eventId)
    await Promise.all(matches.map(value => this.storage.remove(value.storageKey)))
    return matches.length !== 0
  }

  async count(): Promise<number> { return (await this.#opened()).length }

  async #deviceKey(): Promise<CryptoKey> {
    if (this.#key) return this.#key
    const opening = this.#openingKey ??= this.#openDeviceKey()
    try { return await opening }
    finally { if (this.#openingKey === opening) this.#openingKey = undefined }
  }

  async #openDeviceKey(): Promise<CryptoKey> {
    const existing = await this.storage.key()
    const key = existing ?? await this.crypt.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    if (!existing) await this.storage.saveKey(key)
    this.#key = key
    return key
  }

  async #opened(): Promise<LocalHistorySearchResult[]> {
    const key = await this.#deviceKey()
    return Promise.all((await this.storage.records()).map(async record => {
      if (record.version !== VERSION || !(record.nonce instanceof ArrayBuffer) || !(record.ciphertext instanceof ArrayBuffer) || record.nonce.byteLength !== NONCE_BYTES || !/^[0-9a-f]{32}$/.test(record.key)) throw new Error('Encrypted history index record is malformed.')
      let plaintext: ArrayBuffer
      try { plaintext = await this.crypt.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: AAD }, key, record.ciphertext) }
      catch { throw new Error('Encrypted history index record could not be opened.') }
      let document: unknown
      try { document = JSON.parse(new TextDecoder().decode(plaintext)) } catch { throw new Error('Encrypted history index record is not valid.') }
      assertDocument(document)
      return { document, storageKey: record.key }
    }))
  }
}

/** Exact coverage text for a UI. It must not be substituted with “all history”. */
export function importedHistoryCoverage(count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid imported history count.')
  return `This device’s imported index: ${count} item${count === 1 ? '' : 's'}. Search stays on this device.`
}

/** Browser persistence. CryptoKey structured cloning deliberately keeps the
 * device key non-extractable; records have only random local handles outside
 * AES-GCM ciphertext. */
export class BrowserHistoryIndexStorage implements HistoryIndexStorage {
  #db: Promise<IDBDatabase> | undefined
  constructor(private readonly dbName = 'kithmoot-history-index-v1', private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('This browser does not provide encrypted index storage.')
  }
  async key(): Promise<CryptoKey | undefined> { return (await request((await this.#store('keys', 'readonly')).get('device')))?.key }
  async saveKey(key: CryptoKey): Promise<void> { await complete((await this.#store('keys', 'readwrite')).put({ key }, 'device')) }
  async records(): Promise<EncryptedHistoryRecord[]> { return await request((await this.#store('records', 'readonly')).getAll()) }
  async put(record: EncryptedHistoryRecord): Promise<void> { await complete((await this.#store('records', 'readwrite')).put(record)) }
  async remove(key: string): Promise<void> { await complete((await this.#store('records', 'readwrite')).delete(key)) }
  async #store(store: 'keys' | 'records', mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.#database()).transaction(store, mode).objectStore(store)
  }
  #database(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, VERSION)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
        if (!open.result.objectStoreNames.contains('records')) open.result.createObjectStore('records', { keyPath: 'key' })
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
  }
}

function assertDocument(value: unknown): asserts value is ImportedHistoryDocument {
  const document = value as Partial<ImportedHistoryDocument>
  if (!document || typeof document !== 'object' || !/^[0-9a-f]{64}$/.test(document.id ?? '') ||
      !Number.isSafeInteger(document.sentAt) || document.sentAt! < 0 || typeof document.text !== 'string' ||
      (document.room !== undefined && typeof document.room !== 'string') ||
      (document.conversation !== undefined && typeof document.conversation !== 'string') ||
      (document.participant !== undefined && typeof document.participant !== 'string') ||
      (document.files !== undefined && (!Array.isArray(document.files) || document.files.some(file => typeof file !== 'string')))) throw new Error('Imported history document is invalid.')
}

function randomHandle(crypt: Crypto): string {
  const bytes = new Uint8Array(16); crypt.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function copy(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer }

function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(value: IDBRequest): Promise<void> { return request(value).then(() => undefined) }
