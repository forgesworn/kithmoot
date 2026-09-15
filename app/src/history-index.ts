/**
 * Encrypted, device-local index for history a person has explicitly imported.
 *
 * This module has no relay transport, URL or fetch API. Query text and
 * decrypted documents only exist in the caller's process. The non-extractable
 * AES-GCM key is stored as a browser CryptoKey in IndexedDB, not derived from
 * a Nostr recovery phrase and never copied into localStorage.
 */

const DATABASE_VERSION = 2
const RECORD_VERSION = 2
const LEGACY_DOCUMENT_AAD = new TextEncoder().encode('kithmoot.history-index.v1')
const DOCUMENT_AAD = new TextEncoder().encode('kithmoot.history-index.document.v2')
const RECEIPT_AAD = new TextEncoder().encode('kithmoot.history-index.receipt.v1')
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
  /** Present only when this encrypted local record is a verified public event
   * signed by the currently selected account. It is the exact kind a later
   * NIP-09 deletion request may name; received gift wraps never set it. */
  accountAuthoredKind?: number
}

export interface EncryptedHistoryRecord {
  /** Random local handle; never an event or room identifier. */
  key: string
  version: 1 | 2
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}

/** A device-local deletion barrier. Its event ID stays encrypted, so it can
 * prevent an older import or restore from resurrecting local search material
 * without becoming plaintext metadata beside the index. */
export interface HistoryDeletionReceipt {
  id: string
  deletedAt: number
}

export interface EncryptedHistoryDeletionReceipt {
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
  receipts(): Promise<EncryptedHistoryDeletionReceipt[]>
  put(record: EncryptedHistoryRecord): Promise<void>
  /** Atomically removes local search records and records their deletion
   * barrier. A crash cannot leave the device saying a result was removed while
   * an older restore may silently re-add it. */
  removeAndReceipt(keys: readonly string[], receipt: EncryptedHistoryDeletionReceipt): Promise<void>
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
   * plaintext metadata beside it. Existing event IDs remain one record and a
   * durable local deletion receipt refuses resurrection from an older import. */
  async add(document: ImportedHistoryDocument): Promise<'stored' | 'duplicate' | 'retired'> {
    assertDocument(document)
    const opened = await this.#opened()
    if (opened.documents.some(value => value.document.id === document.id)) return 'duplicate'
    if (opened.receipts.some(receipt => receipt.id === document.id)) return 'retired'
    if (opened.documents.length >= MAX_DOCUMENTS) throw new Error('This device history index is full; remove imported history before adding more.')
    const plaintext = new TextEncoder().encode(JSON.stringify(document))
    if (plaintext.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Imported history item is too large for the local index.')
    const nonce = new Uint8Array(NONCE_BYTES); this.crypt.getRandomValues(nonce)
    const ciphertext = await this.crypt.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: DOCUMENT_AAD }, await this.#deviceKey(), plaintext)
    await this.storage.put({ key: randomHandle(this.crypt), version: RECORD_VERSION, nonce: copy(nonce), ciphertext })
    return 'stored'
  }

  /** Search is an in-process decrypt-and-match operation. It sends no request
   * anywhere and deliberately reports only imported-index coverage. */
  async search(query: string, limit = 100): Promise<LocalHistorySearchResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Use a local search limit from 1 to 500.')
    const needle = query.trim().toLocaleLowerCase()
    const values = (await this.#opened()).documents
    return values.filter(value => {
      if (!needle) return true
      const document = value.document
      return [document.text, document.participant ?? '', ...(document.files ?? [])].join('\n').toLocaleLowerCase().includes(needle)
    }).sort((a, b) => b.document.sentAt - a.document.sentAt || b.document.id.localeCompare(a.document.id)).slice(0, limit)
  }

  async remove(eventId: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error('Invalid imported event ID.')
    const matches = (await this.#opened()).documents.filter(value => value.document.id === eventId)
    if (matches.length === 0) return false
    const receipt = await this.#encryptedReceipt({ id: eventId, deletedAt: Math.floor(Date.now() / 1000) })
    await this.storage.removeAndReceipt(matches.map(value => value.storageKey), receipt)
    return matches.length !== 0
  }

  async count(): Promise<number> { return (await this.#opened()).documents.length }

  async deletionReceiptCount(): Promise<number> { return (await this.#opened()).receipts.length }

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

  async #opened(): Promise<{ documents: LocalHistorySearchResult[]; receipts: HistoryDeletionReceipt[] }> {
    const key = await this.#deviceKey()
    const [documents, receipts] = await Promise.all([
      Promise.all((await this.storage.records()).map(async record => {
        const document = await this.#open(record, DOCUMENT_AAD, 'record')
        assertDocument(document)
        return { document, storageKey: record.key }
      })),
      Promise.all((await this.storage.receipts()).map(async receipt => {
        const value = await this.#open(receipt, RECEIPT_AAD, 'deletion receipt')
        assertDeletionReceipt(value)
        return value
      })),
    ])
    return { documents, receipts }
  }

  async #encryptedReceipt(receipt: HistoryDeletionReceipt): Promise<EncryptedHistoryDeletionReceipt> {
    assertDeletionReceipt(receipt)
    const nonce = new Uint8Array(NONCE_BYTES); this.crypt.getRandomValues(nonce)
    const plaintext = new TextEncoder().encode(JSON.stringify(receipt))
    const ciphertext = await this.crypt.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: RECEIPT_AAD }, await this.#deviceKey(), plaintext)
    return { key: randomHandle(this.crypt), version: 1, nonce: copy(nonce), ciphertext }
  }

  async #open(record: EncryptedHistoryRecord | EncryptedHistoryDeletionReceipt, additionalData: Uint8Array, name: string): Promise<unknown> {
    if (!(record.version === 1 || record.version === RECORD_VERSION) || !(record.nonce instanceof ArrayBuffer) || !(record.ciphertext instanceof ArrayBuffer) || record.nonce.byteLength !== NONCE_BYTES || !/^[0-9a-f]{32}$/.test(record.key)) throw new Error(`Encrypted history ${name} is malformed.`)
    let plaintext: ArrayBuffer
    const aad = name === 'record' && record.version === 1 ? LEGACY_DOCUMENT_AAD : additionalData
    try { plaintext = await this.crypt.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: copy(aad) }, await this.#deviceKey(), record.ciphertext) }
    catch { throw new Error(`Encrypted history ${name} could not be opened.`) }
    try { return JSON.parse(new TextDecoder().decode(plaintext)) } catch { throw new Error(`Encrypted history ${name} is not valid.`) }
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
  async key(): Promise<CryptoKey | undefined> { return (await request((await this.#transaction('keys', 'readonly')).objectStore('keys').get('device')))?.key }
  async saveKey(key: CryptoKey): Promise<void> {
    const transaction = await this.#transaction('keys', 'readwrite')
    transaction.objectStore('keys').put({ key }, 'device')
    await complete(transaction)
  }
  async records(): Promise<EncryptedHistoryRecord[]> { return await request((await this.#transaction('records', 'readonly')).objectStore('records').getAll()) }
  async receipts(): Promise<EncryptedHistoryDeletionReceipt[]> { return await request((await this.#transaction('receipts', 'readonly')).objectStore('receipts').getAll()) }
  async put(record: EncryptedHistoryRecord): Promise<void> {
    const transaction = await this.#transaction('records', 'readwrite')
    transaction.objectStore('records').put(record)
    await complete(transaction)
  }
  async removeAndReceipt(keys: readonly string[], receipt: EncryptedHistoryDeletionReceipt): Promise<void> {
    const transaction = await this.#transaction(['records', 'receipts'], 'readwrite')
    const records = transaction.objectStore('records')
    for (const key of keys) records.delete(key)
    transaction.objectStore('receipts').put(receipt)
    await complete(transaction)
  }
  async #transaction(stores: 'keys' | 'records' | 'receipts' | ('records' | 'receipts')[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.#database()).transaction(stores, mode)
  }
  #database(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, DATABASE_VERSION)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
        if (!open.result.objectStoreNames.contains('records')) open.result.createObjectStore('records', { keyPath: 'key' })
        if (!open.result.objectStoreNames.contains('receipts')) open.result.createObjectStore('receipts', { keyPath: 'key' })
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
      (document.files !== undefined && (!Array.isArray(document.files) || document.files.some(file => typeof file !== 'string'))) ||
      (document.accountAuthoredKind !== undefined && (!Number.isSafeInteger(document.accountAuthoredKind) || document.accountAuthoredKind < 0 || document.accountAuthoredKind > 65_535))) throw new Error('Imported history document is invalid.')
}

function assertDeletionReceipt(value: unknown): asserts value is HistoryDeletionReceipt {
  const receipt = value as Partial<HistoryDeletionReceipt>
  if (!receipt || typeof receipt !== 'object' || !/^[0-9a-f]{64}$/.test(receipt.id ?? '') || !Number.isSafeInteger(receipt.deletedAt) || receipt.deletedAt! < 0) throw new Error('Encrypted history deletion receipt is invalid.')
}

function randomHandle(crypt: Crypto): string {
  const bytes = new Uint8Array(16); crypt.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function copy(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer }

function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Encrypted history transaction was aborted.'))
  })
}
