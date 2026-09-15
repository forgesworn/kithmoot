/**
 * Device-local storage for a Vennel root-derived rendezvous child.
 *
 * This is intentionally separate from contacts, accounts and room storage.
 * It accepts only Heartwood's bounded encrypted provision reply, opens it
 * through the browser's retained NIP-46 *device* key, and keeps the verified
 * child under a non-extractable WebCrypto key in IndexedDB.  It deliberately
 * does not invent a browser device key or a generic signer decrypt API. The
 * account ceremony supplies the retained NIP-46 client-key operation only for
 * Heartwood's purpose-specific rendezvous provision response.
 */
import { base64urlnopad } from '@scure/base'
import { getPublicKey } from 'nostr-tools/pure'
import {
  readRendezvousProvision,
  readRendezvousProvisionEnvelope,
  type RendezvousProvisionExpect,
} from '../../src/rendezvous-provisioning.js'

const DATABASE_VERSION = 1
const RECORD_VERSION = 1
const RECORD_KEY = 'active'
const AAD = new TextEncoder().encode('kithmoot.rendezvous-vault.record.v1')
const NONCE_BYTES = 12
const HEX64 = /^[0-9a-f]{64}$/

export interface RendezvousReceipt {
  identity: string
  device: string
  rendezvousPubkey: string
  index: number
  expiresAt: number
}

/** A constrained NIP-44 operation whose private half is the browser's
 * retained NIP-46 client key, never the account identity key. */
export interface RendezvousDeviceCrypt {
  decrypt(peerPubkey: string, ciphertext: string): Promise<string>
}

export interface EncryptedRendezvousRecord {
  key: 'active'
  version: 1
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}

export interface RendezvousVaultStorage {
  key(): Promise<CryptoKey | undefined>
  saveKey(key: CryptoKey): Promise<void>
  record(): Promise<EncryptedRendezvousRecord | undefined>
  put(record: EncryptedRendezvousRecord): Promise<void>
  remove(): Promise<void>
}

export type RendezvousVaultResult =
  | { ok: true; receipt: RendezvousReceipt }
  | { ok: false; reason: string }

/** An active child only exposes a short-lived copy at a permitted derivation
 * point. Its serialised form is unavailable outside the encrypted vault. */
export class StoredRendezvousChild {
  #scalar: Uint8Array
  constructor(readonly receipt: RendezvousReceipt, scalar: Uint8Array) {
    if (scalar.length !== 32) throw new Error('A rendezvous child is 32 bytes.')
    this.#scalar = scalar.slice()
  }

  /** Calls `use` with a copy then wipes that copy before returning. `use` must
   * be synchronous; async callers would keep the key beyond this boundary. */
  withScalar<T>(use: (scalar: Uint8Array) => T): T {
    const scalar = this.#scalar.slice()
    try { return use(scalar) } finally { scalar.fill(0) }
  }

  wipe(): void { this.#scalar.fill(0) }
  toString(): string { return `StoredRendezvousChild(${this.receipt.rendezvousPubkey.slice(0, 12)}…, index=${this.receipt.index})` }
}

/**
 * A one-record browser vault. A later index may replace the installed child;
 * an equal or older reply is refused. Corrupt encrypted storage fails closed
 * rather than silently creating a local fallback key.
 */
export class RendezvousVault {
  #key: CryptoKey | undefined
  #openingKey: Promise<CryptoKey> | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(private readonly storage: RendezvousVaultStorage, private readonly crypt: Crypto = globalThis.crypto) {
    if (!crypt?.subtle || !crypt.getRandomValues) throw new Error('This device cannot create an encrypted rendezvous vault.')
  }

  async accept(response: string, expect: RendezvousProvisionExpect, device: RendezvousDeviceCrypt): Promise<RendezvousVaultResult> {
    return await this.#serial(async () => {
      const outer = readRendezvousProvisionEnvelope(response, expect)
      if (!outer.ok) return outer
      let plaintext: string
      try { plaintext = await device.decrypt(outer.envelope.rendezvousPubkey, outer.envelope.ciphertext) }
      catch { return { ok: false, reason: 'ciphertext' } }
      const parsed = readRendezvousProvision(plaintext, expect)
      if (!parsed.ok) return parsed
      try {
        if (getPublicKey(parsed.provision.scalar) !== outer.envelope.rendezvousPubkey) return { ok: false, reason: 'rendezvous key' }
        const receipt: RendezvousReceipt = {
          identity: expect.identity,
          device: expect.device,
          rendezvousPubkey: outer.envelope.rendezvousPubkey,
          index: parsed.provision.index,
          expiresAt: parsed.provision.expiresAt,
        }
        const previous = await this.#read()
        try {
          if (previous && (previous.receipt.identity !== expect.identity || previous.receipt.device !== expect.device)) return { ok: false, reason: 'account' }
          if (previous && receipt.index <= previous.receipt.index) return { ok: false, reason: 'index' }
          const child = new StoredRendezvousChild(receipt, parsed.provision.scalar)
          try { await this.#write(child) }
          finally { child.wipe() }
          return { ok: true, receipt }
        } finally { previous?.wipe() }
      } catch { return { ok: false, reason: 'vault' } }
      finally { parsed.provision.wipe() }
    })
  }

  /** Returns an isolated child only for its matching account/device pair. */
  async active(identity: string, device: string): Promise<StoredRendezvousChild | undefined> {
    return await this.#serial(async () => {
      const child = await this.#read()
      try {
        return child?.receipt.identity === identity && child.receipt.device === device
          ? new StoredRendezvousChild(child.receipt, child.withScalar(value => value.slice()))
          : undefined
      } finally { child?.wipe() }
    })
  }

  /** Sign-out/revocation removes this account's dedicated child record. */
  async clear(identity: string): Promise<void> {
    await this.#serial(async () => {
      const child = await this.#read()
      try { if (child?.receipt.identity === identity) await this.storage.remove() }
      finally { child?.wipe() }
    })
  }

  async #read(): Promise<StoredRendezvousChild | undefined> {
    const record = await this.storage.record()
    if (!record) return undefined
    if (record.key !== RECORD_KEY || record.version !== RECORD_VERSION || !(record.nonce instanceof ArrayBuffer) || !(record.ciphertext instanceof ArrayBuffer) || record.nonce.byteLength !== NONCE_BYTES) throw new Error('Encrypted rendezvous vault record is malformed.')
    let bytes: Uint8Array | undefined
    try {
      const plaintext = await this.crypt.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: copy(AAD) }, await this.#deviceKey(), record.ciphertext)
      bytes = new Uint8Array(plaintext)
    } catch { throw new Error('Encrypted rendezvous vault record could not be opened.') }
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return stored(value)
    } catch { throw new Error('Encrypted rendezvous vault record is invalid.') }
    finally { bytes?.fill(0) }
  }

  async #write(child: StoredRendezvousChild): Promise<void> {
    const scalar = child.withScalar(value => value.slice())
    const value = { ...child.receipt, scalar: base64urlnopad.encode(scalar) }
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const nonce = new Uint8Array(NONCE_BYTES); this.crypt.getRandomValues(nonce)
    try {
      const ciphertext = await this.crypt.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, await this.#deviceKey(), bytes)
      await this.storage.put({ key: RECORD_KEY, version: RECORD_VERSION, nonce: copy(nonce), ciphertext })
    } finally {
      scalar.fill(0)
      bytes.fill(0)
      nonce.fill(0)
    }
  }

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

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.then(() => undefined, () => undefined)
    return await next
  }
}

/** IndexedDB stores an opaque CryptoKey by structured clone rather than an
 * extractable string; the sole record has no plaintext account or child data. */
export class BrowserRendezvousVaultStorage implements RendezvousVaultStorage {
  #db: Promise<IDBDatabase> | undefined
  constructor(private readonly dbName = 'kithmoot-rendezvous-vault-v1', private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('This browser does not provide encrypted rendezvous vault storage.')
  }
  async key(): Promise<CryptoKey | undefined> { return (await request((await this.#transaction('keys', 'readonly')).objectStore('keys').get('device')))?.key }
  async saveKey(key: CryptoKey): Promise<void> {
    const transaction = await this.#transaction('keys', 'readwrite')
    transaction.objectStore('keys').put({ key }, 'device'); await complete(transaction)
  }
  async record(): Promise<EncryptedRendezvousRecord | undefined> { return await request((await this.#transaction('records', 'readonly')).objectStore('records').get(RECORD_KEY)) }
  async put(record: EncryptedRendezvousRecord): Promise<void> {
    const transaction = await this.#transaction('records', 'readwrite')
    transaction.objectStore('records').put(record); await complete(transaction)
  }
  async remove(): Promise<void> {
    const transaction = await this.#transaction('records', 'readwrite')
    transaction.objectStore('records').delete(RECORD_KEY); await complete(transaction)
  }
  async #transaction(store: 'keys' | 'records', mode: IDBTransactionMode): Promise<IDBTransaction> { return (await this.#database()).transaction(store, mode) }
  #database(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, DATABASE_VERSION)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
        if (!open.result.objectStoreNames.contains('records')) open.result.createObjectStore('records', { keyPath: 'key' })
      }
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
  }
}

function stored(value: unknown): StoredRendezvousChild {
  const record = value as Partial<RendezvousReceipt> & { scalar?: unknown }
  if (!record || typeof record !== 'object' || !hex(record.identity) || !hex(record.device) || !hex(record.rendezvousPubkey) ||
      !Number.isSafeInteger(record.index) || record.index! < 0 || record.index! > 0xffffffff ||
      !Number.isSafeInteger(record.expiresAt) || record.expiresAt! < 0 || typeof record.scalar !== 'string') throw new Error('invalid')
  let scalar: Uint8Array
  try { scalar = base64urlnopad.decode(record.scalar) } catch { throw new Error('invalid') }
  if (scalar.length !== 32 || getPublicKey(scalar) !== record.rendezvousPubkey) { scalar.fill(0); throw new Error('invalid') }
  try {
    return new StoredRendezvousChild({ identity: record.identity, device: record.device, rendezvousPubkey: record.rendezvousPubkey, index: record.index!, expiresAt: record.expiresAt! }, scalar)
  } finally { scalar.fill(0) }
}

function hex(value: unknown): value is string { return typeof value === 'string' && HEX64.test(value) }
function copy(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer }
function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error('Encrypted rendezvous vault transaction was aborted.')) }) }
