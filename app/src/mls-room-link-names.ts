import { bytesToHex } from '@noble/hashes/utils.js'
import { MLS_ROOM_LINK_OWNER, MLS_ROOM_LINK_NAMES, hasMlsRoomLinkCustody } from './mls-room-link-forget.js'

const invalid = () => new Error('Room connection naming custody could not be verified.')
const label = new TextEncoder().encode('kithmoot.vmls-room-link.names.v1')
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? invalid()) })
}
function valid(value: unknown): asserts value is CryptoKey {
  if (!(value instanceof CryptoKey) || value.extractable || value.type !== 'secret' || value.algorithm.name !== 'HMAC' ||
      (value.algorithm as HmacKeyAlgorithm).hash.name !== 'SHA-256' || (value.algorithm as HmacKeyAlgorithm).length !== 256 ||
      value.usages.join(',') !== 'sign') throw invalid()
}
/** Keyed opaque account names, separate from witness and grant naming keys.
 * Only explicit room storage work calls this. Raw account IDs remain in the
 * encrypted payload and crypto AAD, never in enumerable database/lock names. */
export async function mlsRoomLinkDatabase(account: string): Promise<string> {
  if (!/^[0-9a-f]{64}(?![\s\S])/.test(account) || !navigator.locks) throw invalid()
  return navigator.locks.request(MLS_ROOM_LINK_NAMES, async () => {
    const names = await indexedDB.databases()
    if (!names.some(db => db.name === MLS_ROOM_LINK_NAMES) && await hasMlsRoomLinkCustody()) throw invalid()
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(MLS_ROOM_LINK_NAMES, 1)
      open.onupgradeneeded = event => {
        if (event.oldVersion !== 0) { open.transaction!.abort(); return }
        open.result.createObjectStore('keys')
      }
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
      // A blocked native open remains pending until it actually settles.
    })
    try {
      if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('keys')) throw invalid()
      const read = db.transaction('keys', 'readonly'), ended = done(read)
      const store = read.objectStore('keys')
      const [saved, present, count] = await Promise.all([request(store.get('names')), request(store.getKey('names')), request(store.count()), ended])
      let key: CryptoKey
      if (present !== undefined) {
        if (!saved || typeof saved !== 'object' || Object.keys(saved).sort().join(',') !== 'key,proof' || count !== 1) throw invalid()
        const slot = saved as { key: unknown; proof: unknown }
        valid(slot.key)
        if (!(slot.proof instanceof ArrayBuffer) || slot.proof.byteLength !== 32) throw invalid()
        const proof = new Uint8Array(await crypto.subtle.sign('HMAC', slot.key, label))
        if (!proof.every((value, at) => value === new Uint8Array(slot.proof as ArrayBuffer)[at])) throw invalid()
        key = slot.key
      }
      else {
        if (count || names.some(db => db.name?.startsWith(MLS_ROOM_LINK_OWNER + ':'))) throw invalid()
        key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
        const proof = await crypto.subtle.sign('HMAC', key, label)
        const write = db.transaction('keys', 'readwrite'), committed = done(write)
        write.objectStore('keys').add({ key, proof }, 'names'); await committed
      }
      const name = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('room-link|' + account))))
      return MLS_ROOM_LINK_OWNER + ':' + name
    } finally { db.close() }
  })
}
