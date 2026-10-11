import { base64 } from '@scure/base'
import { linkEventUrl, linkRelays } from './browser-link-pairing.js'
import { wipeLinkState, type LinkState, type LinkVault } from './browser-link-vault.js'
import { BrowserMlsGrantForeground, type MlsGrantForegroundScope } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'

export const MLS_GRANT_LINK_OWNER = 'kithmoot-vmls-grant-link-v1'
const aad = new TextEncoder().encode('kithmoot.vmls-grant-link.v1')
const maximum = 256 * 1024
interface Encrypted { key: 'active'; version: 1; nonce: ArrayBuffer; ciphertext: ArrayBuffer }
interface Snapshot { db: IDBDatabase; key?: CryptoKey; encrypted?: Encrypted }
const invalid = () => new Error('The dedicated grant connection storage could not be verified.')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error ?? invalid()) })
}
function same(a?: Encrypted, b?: Encrypted): boolean {
  const equal = (x: ArrayBuffer, y: ArrayBuffer) => x.byteLength === y.byteLength && new Uint8Array(x).every((value, i) => value === new Uint8Array(y)[i])
  return !a && !b || !!a && !!b && a.version === b.version && equal(a.nonce, b.nonce) && equal(a.ciphertext, b.ciphertext)
}
function keySlot(slot: unknown, present: boolean): CryptoKey | undefined {
  if (!present) return undefined
  if (!object(slot) || !exact(slot, 'key') || !(slot.key instanceof CryptoKey)) throw invalid()
  const key = slot.key
  if (key.extractable || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' ||
      (key.algorithm as AesKeyAlgorithm).length !== 256 || [...key.usages].sort().join(',') !== 'decrypt,encrypt') throw invalid()
  return key
}
function encryptedSlot(slot: unknown, present: boolean): Encrypted | undefined {
  if (!present) return undefined
  if (!object(slot) || !exact(slot, 'ciphertext,key,nonce,version') || slot.key !== 'active' || slot.version !== 1 ||
      !(slot.nonce instanceof ArrayBuffer) || slot.nonce.byteLength !== 12 || !(slot.ciphertext instanceof ArrayBuffer) ||
      slot.ciphertext.byteLength < 16 || slot.ciphertext.byteLength > maximum + 16) throw invalid()
  return slot as unknown as Encrypted
}
function validate(state: LinkState): void {
  if (!/^[0-9a-f]{64}(?![\s\S])/.test(state.account) || !(state.transportSeed instanceof Uint8Array) || state.transportSeed.length !== 32 ||
      !Array.isArray(state.routes) || state.routes.length > 16) throw invalid()
  linkRelays(state.relayUrls)
  const seen = new Set<string>()
  for (const route of state.routes) {
    if (!/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(route.routeId) || seen.has(route.routeId) ||
        !(route.pairedRouteSecret instanceof Uint8Array) || route.pairedRouteSecret.length !== 32 ||
        typeof route.cardSerial !== 'bigint' || route.cardSerial < 0n || route.cardSerial > 0xffffffffffffffffn ||
        typeof route.cardVerifiedAt !== 'bigint' || route.cardVerifiedAt < 0n || route.cardVerifiedAt > 0xffffffffffffffffn) throw invalid()
    linkEventUrl(route.card); seen.add(route.routeId)
  }
}
function serialise(state: LinkState): string {
  return JSON.stringify({ account: state.account, seed: base64.encode(state.transportSeed), relays: state.relayUrls,
    routes: state.routes.map(route => ({ routeId: route.routeId, card: base64.encode(route.card), secret: base64.encode(route.pairedRouteSecret), serial: String(route.cardSerial), verified: String(route.cardVerifiedAt) })) })
}

/** Concrete, distinct endpoint custody. The endpoint holds its own Web Lock
 * through engine and signer shutdown. No ordinary Link seed/route is copied.
 * Each whole operation captures its original foreground before crypto awaits;
 * first-key creation and the sealed record commit in one native transaction. */
export class BrowserMlsGrantLinkVault implements LinkVault {
  #db?: IDBDatabase
  #opening?: Promise<IDBDatabase>
  constructor(private readonly foreground: BrowserMlsGrantForeground, private readonly endpoint: BrowserMlsGrantEndpoint) {
    if (!(foreground instanceof BrowserMlsGrantForeground) || !(endpoint instanceof BrowserMlsGrantEndpoint)) throw invalid()
  }
  #binding(): { scope: MlsGrantForegroundScope; check(): void } {
    const scope = this.foreground.capture()
    const check = () => { if (!scope || !this.foreground.prepared(scope)) throw invalid() }
    check()
    return { scope: scope!, check }
  }
  async read(): Promise<LinkState | undefined> {
    const { scope, check } = this.#binding()
    let candidate: LinkState | undefined
    try { return await this.foreground.track(scope, () => this.#locked(scope, check, async () => {
      const snapshot = await this.#snapshot(scope, check)
      candidate = await this.#decode(snapshot, check)
      return candidate
    })) } catch (error) { if (candidate) wipeLinkState(candidate); throw error }
  }
  async #decode(snapshot: Snapshot, check: () => void): Promise<LinkState | undefined> {
      if (!snapshot.encrypted) { check(); return undefined }
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: snapshot.encrypted.nonce, additionalData: aad }, snapshot.key!, snapshot.encrypted.ciphertext))
      let state: LinkState | undefined
      try {
        check()
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!object(value) || !exact(value, 'account,relays,routes,seed') || typeof value.account !== 'string' || typeof value.seed !== 'string' || !Array.isArray(value.routes)) throw invalid()
        state = { account: value.account, transportSeed: base64.decode(value.seed), relayUrls: value.relays as string[], routes: [] }
        for (const route of value.routes) {
          if (!object(route) || !exact(route, 'card,routeId,secret,serial,verified') ||
              !['card','routeId','secret','serial','verified'].every(key => typeof route[key] === 'string') ||
              !/^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(route.serial as string) || !/^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(route.verified as string)) throw invalid()
          state.routes.push({ routeId: route.routeId as string, card: base64.decode(route.card as string), pairedRouteSecret: base64.decode(route.secret as string),
            cardSerial: BigInt(route.serial as string), cardVerifiedAt: BigInt(route.verified as string) })
        }
        validate(state); check(); return state
      } catch (error) { if (state) wipeLinkState(state); throw error }
      finally { bytes.fill(0) }
  }
  async write(input: LinkState): Promise<void> {
    const { scope, check: bound } = this.#binding()
    const check = () => { bound(); if (!BrowserMlsGrantEndpoint.prototype.ownsScope.call(this.endpoint, scope)) throw invalid() }
    return this.foreground.track(scope, () => this.#locked(scope, check, async () => {
      check()
      const state = structuredClone(input)
      try {
        validate(state)
        const snapshot = await this.#snapshot(scope, check)
        const previous = await this.#decode(snapshot, check)
        try {
          // Never replace unreadable custody, switch the account/seed, drop a
          // saved route, or rewrite it from a stale cached engine snapshot.
          if (!previous && state.routes.length !== 0 || previous && (state.routes.length !== previous.routes.length + 1 ||
              serialise(previous) !== serialise({ ...state, routes: state.routes.slice(0, previous.routes.length) }))) throw invalid()
        } finally { if (previous) wipeLinkState(previous) }
        const key = snapshot.key ?? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt'])
        check()
        const bytes = new TextEncoder().encode(serialise(state))
        let encrypted: Encrypted
        try {
          if (bytes.length > maximum) throw invalid()
          const nonce = crypto.getRandomValues(new Uint8Array(12))
          encrypted = { key: 'active', version: 1, nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, bytes) }
        } finally { bytes.fill(0) }
        check()
        await this.#transaction(snapshot.db, 'readwrite', scope, check, async transaction => {
          const keys = transaction.objectStore('keys'), records = transaction.objectStore('records')
          const [rawKey, keyPresent, rawRecord, recordPresent] = await Promise.all([request(keys.get('device')), request(keys.getKey('device')), request(records.get('active')), request(records.getKey('active'))])
          check()
          const savedKey = keySlot(rawKey, keyPresent !== undefined), saved = encryptedSlot(rawRecord, recordPresent !== undefined)
          if (!!snapshot.key !== !!savedKey || !same(snapshot.encrypted, saved)) throw invalid()
          if (!snapshot.key) keys.put({ key }, 'device')
          records.put(encrypted)
        })
        check()
      } finally { wipeLinkState(state) }
    }))
  }
  async #locked<T>(scope: MlsGrantForegroundScope, check: () => void, work: () => Promise<T>): Promise<T> {
    check()
    if (!navigator.locks) throw invalid()
    return navigator.locks.request(MLS_GRANT_LINK_OWNER + ':storage', { signal: scope.signal }, async () => {
      check(); const value = await work(); check(); return value
    })
  }
  async #snapshot(scope: MlsGrantForegroundScope, check: () => void): Promise<Snapshot> {
    check()
    const db = await this.#database(scope, check)
    check()
    return this.#transaction(db, 'readonly', scope, check, async transaction => {
      const keys = transaction.objectStore('keys'), records = transaction.objectStore('records')
      const [rawKey, keyPresent, rawRecord, recordPresent] = await Promise.all([request(keys.get('device')), request(keys.getKey('device')), request(records.get('active')), request(records.getKey('active'))])
      check()
      const key = keySlot(rawKey, keyPresent !== undefined), encrypted = encryptedSlot(rawRecord, recordPresent !== undefined)
      if (encrypted && !key) throw invalid()
      return { db, key, encrypted }
    })
  }
  async #transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, scope: MlsGrantForegroundScope, check: () => void,
    work: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    check()
    if (db !== this.#db || db.version !== 1) throw invalid()
    const transaction = db.transaction(['keys','records'], mode), ended = done(transaction)
    void ended.catch(() => {})
    const abort = () => { try { transaction.abort() } catch { /* A commit that won remains durable. */ } }
    scope.signal.addEventListener('abort', abort, { once: true })
    try { check(); const result = await work(transaction); check(); await ended; check(); return result }
    catch (error) { abort(); await ended.catch(() => {}); throw error }
    finally { scope.signal.removeEventListener('abort', abort) }
  }
  #database(scope: MlsGrantForegroundScope, check: () => void): Promise<IDBDatabase> {
    if (this.#db) return Promise.resolve(this.#db)
    if (this.#opening) return this.#opening
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open(MLS_GRANT_LINK_OWNER, 1)
      opened.onupgradeneeded = event => {
        try {
          check()
          if (event.oldVersion !== 0) throw invalid()
          opened.result.createObjectStore('keys'); opened.result.createObjectStore('records', { keyPath: 'key' })
        } catch { opened.transaction!.abort() }
      }
      opened.onsuccess = () => {
        const db = opened.result
        try {
          check()
          if (scope.signal.aborted || db.version !== 1 || db.objectStoreNames.length !== 2 || !db.objectStoreNames.contains('keys') || !db.objectStoreNames.contains('records')) throw invalid()
          this.#db = db
          db.onversionchange = () => { db.close(); if (this.#db === db) { this.#db = undefined; this.foreground.invalidate() } }
          resolve(db)
        } catch (error) { db.close(); reject(error) }
      }
      opened.onerror = () => reject(opened.error)
    })
    this.#opening = opening
    void opening.finally(() => { if (this.#opening === opening) this.#opening = undefined }).catch(() => {})
    return opening
  }
}
