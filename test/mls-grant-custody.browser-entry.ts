import { base32nopad } from '@scure/base'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { BrowserMlsGrantStore, planMlsGrant, type MlsGrantRecord } from '../app/src/mls-grant-ledger.js'
import { BrowserRendezvousVaultStorage } from '../app/src/rendezvous-vault.js'
import { BrowserMlsGrantCustody } from '../app/src/mls-grant-custody.js'

const dbName = 'kithmoot-vmls-grants-v1'
const connections: IDBDatabase[] = []
const factory = new Proxy(indexedDB, { get(target, property) {
  if (property === 'open') return (...args: Parameters<IDBFactory['open']>) => {
    const opened = target.open(...args)
    opened.addEventListener('success', () => connections.push(opened.result))
    return opened
  }
  const value = Reflect.get(target, property, target)
  return typeof value === 'function' ? value.bind(target) : value
} })
const legacyStorage = new BrowserRendezvousVaultStorage(dbName, factory)
const legacy = new BrowserMlsGrantStore(legacyStorage)
const owner = new BrowserMlsGrantCustody()
let current = true
let lifecycle = new AbortController()
const secret = new Uint8Array(32).fill(31)
const identity = { pubkey: getPublicKey(secret), signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret) }
let release: (() => void) | undefined
let writer: Promise<unknown> | undefined
let publications = 0, cleanups = 0
let originalEncrypted: any
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digestRecords = (records: MlsGrantRecord[]) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canonical(records)))))

export async function record(index = 1, state: MlsGrantRecord['state'] = 'active', node = 32): Promise<MlsGrantRecord> {
  const key = index.toString(16).padStart(64, '0')
  const box = { routeId: 'legacy-node', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(node)).toLowerCase()}/events` }
  const grant = await planMlsGrant(identity, box, '22'.repeat(32), key, { session: '33'.repeat(32), leaf: key, name: 'Retained room' }, 1_000)
  return { ...grant, state }
}
export async function seed() {
  const records = await Promise.all(['installing','active','revoking','revoked'].map((state, index) => record(index + 1, state as MlsGrantRecord['state'])))
  for (const item of records) await legacy.put(item)
  return records
}
export function closeLegacy() { connections.splice(0).forEach(db => db.close()) }
export async function prepare() { return owner.prepare(() => current, lifecycle.signal) }
export async function secondPrepare() { return new BrowserMlsGrantCustody().prepare(() => current, lifecycle.signal) }
export function stop() { current = false; lifecycle.abort() }
export function resume() { current = true; lifecycle = new AbortController() }
export async function all() { return owner.all() }
export async function put(index = 8) { return owner.put(await record(index)) }
export async function legacyPut(index = 8) {
  try { await legacy.put(await record(index)); return { accepted: true } }
  catch { return { accepted: false } }
}
export async function freshLegacyWriter(index = 9, node = 34) {
  const grant = await record(index, 'installing', node)
  return navigator.locks.request(`kithmoot.vmls-grant.${grant.node}.${grant.device}`, async () => {
    try { await legacy.all(); await legacy.put(grant); publications++; await legacy.put({ ...grant, state: 'active' }); return { accepted: true } }
    catch { return { accepted: false } }
  })
}
export async function advanceDatabaseSchema() {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(dbName, 3)
    open.onsuccess = () => { open.result.close(); resolve() }; open.onerror = () => reject(open.error)
  })
}
export async function legacyOpen() {
  return new Promise(resolve => {
    const open = indexedDB.open(dbName, 1)
    open.onsuccess = () => { open.result.close(); resolve({ accepted: true }) }
    open.onerror = () => resolve({ accepted: false, name: open.error?.name })
  })
}
export async function savedFence() { return (await legacyStorage.record())?.version }
export async function inspect() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(dbName); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  try {
    const transaction = db.transaction(['keys','records'], 'readonly')
    const read = (store: string, key: string) => new Promise<any>((resolve, reject) => {
      const request = transaction.objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const [stored, encrypted] = await Promise.all([read('keys','device'), read('records','active')])
    if (!encrypted) return { database: db.version, key: !!stored?.key, record: false }
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.nonce, additionalData: new TextEncoder().encode(`kithmoot.vmls-grant-ledger.v${encrypted.version}`) }, stored.key, encrypted.ciphertext))
    try { return { database: db.version, key: true, extractable: stored.key.extractable, record: true, version: encrypted.version, value: JSON.parse(new TextDecoder().decode(bytes)) } }
    finally { bytes.fill(0) }
  } finally { db.close() }
}
export async function emptyKey() {
  await legacyStorage.saveKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']))
}
export async function capacity() {
  const records = await Promise.all(Array.from({ length: 256 }, (_, index) => record(index + 1)))
  for (const item of records) item.rooms = Array.from({ length: 32 }, (_, index) => ({ session: (index + 1).toString(16).padStart(64, '0'), leaf: item.device, name: 'x' }))
  const encoder = new TextEncoder()
  let remaining = 2 * 1024 * 1024 - encoder.encode(JSON.stringify(records)).length
  for (const item of records) for (const room of item.rooms) {
    const add = Math.min(119, remaining); room.name += 'x'.repeat(add); remaining -= add
  }
  if (remaining !== 0) throw new Error('Capacity fixture could not reach the exact legacy bound.')
  const bytes = encoder.encode(JSON.stringify(records)), nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt'])
  const result = { count: records.length, bytes: bytes.length, digest: digestRecords(records) }
  try {
    await legacyStorage.saveKey(key)
    await legacyStorage.put({ key: 'active', version: 1, nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode('kithmoot.vmls-grant-ledger.v1') }, key, bytes) })
  } finally { bytes.fill(0) }
  return result
}
export async function summary() {
  const records = await owner.all(), bytes = new TextEncoder().encode(JSON.stringify(records))
  try { return { count: records.length, bytes: bytes.length, digest: digestRecords(records) } } finally { bytes.fill(0) }
}
export async function retainOriginal() { originalEncrypted = await legacyStorage.record(); return rawSummary() }
export async function changeFence() {
  const encrypted: any = await legacyStorage.record(), key = (await legacyStorage.key())!
  const aad = new TextEncoder().encode('kithmoot.vmls-grant-ledger.v2')
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.nonce, additionalData: aad }, key, encrypted.ciphertext))
  const value = JSON.parse(new TextDecoder().decode(bytes)); bytes.fill(0)
  value.records[0].rooms[0].name = 'Changed while draining'
  const replacement = new TextEncoder().encode(JSON.stringify(value)), nonce = crypto.getRandomValues(new Uint8Array(12))
  try { await legacyStorage.put({ key: 'active', version: 2, nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, replacement) } as any) }
  finally { replacement.fill(0) }
}
async function latest() {
  return new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(dbName); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
}
export async function rawSummary() {
  const db = await latest()
  try {
    const transaction = db.transaction(['keys','records'], 'readonly')
    const read = (store: string, key: string) => new Promise<any>(resolve => { const request = transaction.objectStore(store).get(key); request.onsuccess = () => resolve(request.result) })
    const [stored, encrypted] = await Promise.all([read('keys','device'), read('records','active')])
    return { database: db.version, key: !!stored?.key, version: encrypted?.version,
      digest: encrypted && bytesToHex(sha256(concatBytes(new Uint8Array(encrypted.nonce), new Uint8Array(encrypted.ciphertext)))) }
  } finally { db.close() }
}
export async function tamper(mode: 'missing-key' | 'changed-key' | 'legacy' | 'missing-record') {
  const key = mode === 'changed-key' ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']) : undefined
  const db = await latest()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['keys','records'], 'readwrite')
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
      if (mode === 'missing-key') transaction.objectStore('keys').delete('device')
      if (mode === 'changed-key') transaction.objectStore('keys').put({ key }, 'device')
      if (mode === 'legacy') transaction.objectStore('records').put(originalEncrypted)
      if (mode === 'missing-record') transaction.objectStore('records').delete('active')
    })
  } finally { db.close() }
}
export function stopOnReadyWrite() {
  const original = IDBObjectStore.prototype.put
  let writes = 0
  IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
    const result = key === undefined ? original.call(this, value) : original.call(this, value, key)
    if (this.name === 'records' && value?.version === 2 && ++writes === 2) {
      IDBObjectStore.prototype.put = original; stop()
    }
    return result
  }
}
/** Historical writer ordering, using the actual v1 store and real locks.
 * Carrier settlement is simulated; no remote outcome is inferred. */
export async function startWriter(index = 9) {
  const grant = await record(index, 'installing')
  const pause = new Promise<void>(resolve => { release = resolve })
  writer = navigator.locks.request(`kithmoot.vmls-grant.${grant.node}.${grant.device}`, async () => {
    try {
      await legacy.all(); await legacy.put(grant)
      await pause
      publications++
      try { await legacy.put({ ...grant, state: 'active' }); return { saved: true } }
      catch { return { saved: false } }
    } finally { cleanups++ }
  })
  return grant.device
}
export function finishWriter() { release?.(); return writer }
export function counters() { return { publications, cleanups } }
export async function progress() {
  return { publications, cleanups, locks: await navigator.locks.query(), version: await savedFence() }
}
export function failNextWrite(at: 'key' | 'record') {
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === (at === 'key' ? 'keys' : 'records')) {
      IDBObjectStore.prototype.put = original
      throw new DOMException('Fixture quota failure', 'QuotaExceededError')
    }
    return key === undefined ? original.call(this, value) : original.call(this, value, key)
  }
}
