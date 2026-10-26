import { base32nopad } from '@scure/base'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { BrowserMlsGrantStore, planMlsGrant, type MlsGrantRecord } from '../app/src/mls-grant-ledger.js'
import { BrowserRendezvousVaultStorage } from '../app/src/rendezvous-vault.js'
import { BrowserMlsGrantCustody, BrowserMlsGrantForeground } from '../app/src/mls-grant-custody.js'
import { BrowserMlsGrantDevelopmentOwner } from '../app/src/mls-grant-development-owner.js'
import { BrowserMlsRevocationInbox } from '../app/src/mls-revocation-inbox.js'
import { BrowserMlsMembershipController } from '../app/src/mls-membership-controller.js'
import { BrowserMlsKeeperDecisions } from '../app/src/mls-keeper-decisions.js'
import { BrowserMlsKeeperInboxFetch } from '../app/src/mls-keeper-inbox-fetch.js'
import { NostrVmlsRevocationTransport } from '../app/src/mls-revocation-relay.js'
import { BrowserMlsGrantDevelopmentPanel } from '../app/src/mls-grant-development-panel.js'

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
export async function malformedKey(mode: 'null' | 'false' | 'zero' | 'empty' | 'undefined') {
  await legacyStorage.key(); closeLegacy()
  const db = await latest()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite')
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
      transaction.objectStore('keys').put({ null: null, false: false, zero: 0, empty: '', undefined: undefined }[mode], 'device')
    })
  } finally { db.close() }
}
export async function keySlot() {
  const db = await latest()
  try {
    const transaction = db.transaction(['keys','records'], 'readonly')
    const read = <T>(operation: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error)
    })
    const [slot, value, record] = await Promise.all([read(transaction.objectStore('keys').getKey('device')),
      read(transaction.objectStore('keys').get('device')), read(transaction.objectStore('records').getKey('active'))])
    return { database: db.version, present: slot !== undefined, value: value === undefined ? 'undefined' : value, record: record !== undefined }
  } finally { db.close() }
}
export function changeKeyBeforeFence() {
  const original = crypto.subtle.encrypt.bind(crypto.subtle)
  crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
    crypto.subtle.encrypt = original
    await malformedKey('null')
    return original(...args)
  }
}
let upgradeRequests = 0
export function observeUpgrades() {
  const original = IDBFactory.prototype.open
  IDBFactory.prototype.open = function(name: string, version?: number) {
    if (name === dbName && version === 2) upgradeRequests++
    return version === undefined ? original.call(this, name) : original.call(this, name, version)
  }
}
export function upgrades() { return upgradeRequests }
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

const foreground = new BrowserMlsGrantForeground()
let escaped: BrowserMlsGrantCustody | undefined
let downstream = 0, successes = 0, phaseReached = false
let releaseForeground: (() => void) | undefined
export function foregroundStatus() { return { occupied: !!foreground.capture(), downstream, successes, phaseReached } }
export function invalidateForeground() { foreground.invalidate() }
export function changeForegroundPredicate() { current = false }
export function foregroundSettled() { return foreground.settled() }
export function invalidateForegroundAndWait() { return foreground.invalidateAndWait() }
export function releaseForegroundWork() { releaseForeground?.() }
export async function foregroundRead() {
  return foreground.run(() => current, lifecycle.signal, async custody => { downstream++; escaped = custody; return custody.all() })
}
export async function foregroundHold() {
  return foreground.run(() => current, lifecycle.signal, async custody => {
    downstream++; escaped = custody
    await new Promise<void>(resolve => { releaseForeground = resolve })
    const records = await custody.all(); successes++; return records
  })
}
export async function escapedRead() { return escaped!.all() }
export async function escapedPut() { return escaped!.put(await record(8)) }
export async function unboundForegroundAccess() {
  let opened = 0
  const original = indexedDB.open.bind(indexedDB)
  indexedDB.open = (...args: Parameters<IDBFactory['open']>) => { opened++; return original(...args) }
  try {
    const custody = new BrowserMlsGrantCustody(foreground), item = await record(8)
    let read = false, write = false, fake = false
    try { await custody.all(); read = true } catch {}
    try { await custody.put(item); write = true } catch {}
    try { new BrowserMlsGrantCustody({ capture: () => ({ current: () => true, signal: lifecycle.signal }) } as any); fake = true } catch {}
    return { opened, read, write, fake }
  } finally { indexedDB.open = original }
}
export function invalidateOnOpen() {
  const original = indexedDB.open.bind(indexedDB)
  indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
    indexedDB.open = original
    const opened = original(...args)
    opened.addEventListener('success', () => { phaseReached = true; foreground.invalidate() }, { once: true })
    return opened
  }
}
export async function foregroundAt(phase: 'read' | 'decrypt' | 'encrypt' | 'cas' | 'queued-put' | 'committed' | 'after-put' | 'throw') {
  const item = await record(8)
  return foreground.run(() => current, lifecycle.signal, async custody => {
    downstream++; escaped = custody
    const invalidate = () => { phaseReached = true; foreground.invalidate() }
    if (phase === 'read' || phase === 'cas') {
      const original = IDBObjectStore.prototype.get
      IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
        const result = original.call(this, key)
        if (this.name === 'records' && this.transaction.mode === (phase === 'cas' ? 'readwrite' : 'readonly')) {
          IDBObjectStore.prototype.get = original
          result.addEventListener('success', invalidate, { once: true })
        }
        return result
      }
    }
    if (phase === 'decrypt' || phase === 'encrypt') {
      const original = crypto.subtle[phase].bind(crypto.subtle)
      crypto.subtle[phase] = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        crypto.subtle[phase] = original
        const value = await original(...args)
        phaseReached = true
        await new Promise<void>(resolve => { releaseForeground = resolve })
        return value
      }
    }
    if (phase === 'queued-put') {
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        const result = key === undefined ? original.call(this, value) : original.call(this, value, key)
        if (this.name === 'records') { IDBObjectStore.prototype.put = original; invalidate() }
        return result
      }
    }
    if (phase === 'committed') {
      const original = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase['transaction']>) {
        const transaction = original.apply(this, args)
        if (transaction.mode === 'readwrite') {
          IDBDatabase.prototype.transaction = original
          transaction.addEventListener('complete', invalidate, { once: true })
        }
        return transaction
      }
    }
    if (phase === 'throw') throw new Error('Foreground fixture callback refused')
    if (phase === 'read' || phase === 'decrypt') { const records = await custody.all(); successes++; return records }
    await custody.put(item)
    if (phase === 'after-put') invalidate()
    successes++; return [item]
  })
}

/** Deliberately float custody work to exercise actual owner settlement. */
export async function foregroundFloated(operation: 'read' | 'put', phase: 'crypto' | 'lock', fail = false) {
  const item = await record(8)
  return foreground.run(() => current, lifecycle.signal, async custody => {
    downstream++; escaped = custody
    if (phase === 'crypto') {
      const method = operation === 'read' ? 'decrypt' : 'encrypt'
      const original = crypto.subtle[method].bind(crypto.subtle)
      crypto.subtle[method] = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        crypto.subtle[method] = original
        const result = await original(...args)
        phaseReached = true
        await new Promise<void>(resolve => { releaseForeground = resolve })
        return result
      }
    } else {
      let acquired!: () => void
      const held = new Promise<void>(resolve => { acquired = resolve })
      void navigator.locks.request(dbName, async () => {
        acquired()
        await new Promise<void>(resolve => { releaseForeground = resolve })
      })
      await held
    }
    const io = operation === 'read' ? custody.all() : custody.put(item)
    void io.catch(() => {})
    if (phase === 'crypto') {
      while (!phaseReached) await new Promise(resolve => setTimeout(resolve, 0))
    } else phaseReached = true
    if (fail) throw new Error('Floated callback refused')
    return 'callback returned'
  })
}

export function foregroundMalformedPut(uncloneable: boolean) {
  return foreground.run(() => current, lifecycle.signal, async custody => {
    void custody.put((uncloneable ? { callback: () => {} } : { state: 'active' }) as any).catch(() => {})
    return 'must not succeed'
  })
}
export async function foregroundRelease(operation: 'read' | 'put', predicate: boolean) {
  const item = await record(8)
  return foreground.run(() => current, lifecycle.signal, async custody => {
    const original = foreground.track.bind(foreground)
    foreground.track = (scope, work) => {
      foreground.track = original
      return original(scope, async () => {
        const value = await work()
        phaseReached = true
        if (predicate) current = false
        else foreground.invalidate()
        return value
      })
    }
    if (operation === 'read') await custody.all()
    else await custody.put(item)
    successes++
  })
}
let developmentGeneration = 'fixture', developmentMode: 'normal' | 'quiet' = 'normal', developmentAuthority: object = identity
let developmentSign = identity.signEvent
const cryptOwner = { async encrypt(_peer: string, plain: string) { return plain }, async decrypt(_peer: string, cipher: string) { return cipher } }
let developmentCryptOwner: object = cryptOwner, developmentEncrypt = cryptOwner.encrypt, developmentDecrypt = cryptOwner.decrypt
const development = new BrowserMlsGrantDevelopmentOwner(() => ({ identity, persona: identity.pubkey, generation: developmentGeneration, mode: developmentMode,
  authority: { owner: developmentAuthority, signEvent: developmentSign, crypt: { owner: developmentCryptOwner, encrypt: developmentEncrypt, decrypt: developmentDecrypt } } }))
export function changeDevelopmentContext(kind: string) {
  if (kind === 'generation') developmentGeneration = 'replacement'
  if (kind === 'mode') developmentMode = 'quiet'
  if (kind === 'same-pubkey-authority') developmentAuthority = {}
  if (kind === 'sign') developmentSign = async template => identity.signEvent(template)
  if (kind === 'encrypt') developmentEncrypt = async (peer, plaintext) => cryptOwner.encrypt(peer, plaintext)
  if (kind === 'decrypt') developmentDecrypt = async (peer, ciphertext) => cryptOwner.decrypt(peer, ciphertext)
  if (kind === 'crypt-owner') developmentCryptOwner = {}
}
const developmentRoom = { session: '33'.repeat(32), rendezvousKey: '44'.repeat(32) }
const developmentPlan = () => ({ operation: '66'.repeat(32), kind: 'device', target: '55'.repeat(32), compromised: true,
  room: { session: developmentRoom.session }, members: [], grants: [] }) as any
const developmentDecision = () => ({ binding: { persona: identity.pubkey }, prompt: { operation: '66'.repeat(32) }, conflict: false, grants: [], rooms: [] }) as any
export function developmentWorkflow(name: string) {
  const room = { session: '33'.repeat(32), rendezvousKey: '44'.repeat(32) }
  if (name === 'records') return development.records()
  if (name === 'roomChoices') return development.roomChoices()
  if (name === 'routes') return development.routes()
  if (name === 'pair') return development.pair('not a pairing', ['wss://fixture.invalid/'])
  if (name === 'install') return development.install(room, '55'.repeat(32), 'no-route')
  if (name === 'memberView') return development.memberView(room)
  if (name === 'memberPlan') return development.memberPlan(room, 'device', '55'.repeat(32), true)
  if (name === 'memberBegin') return development.memberBegin(room, developmentPlan())
  if (name === 'memberAdvance') return development.memberAdvance(room, '66'.repeat(32))
  if (name === 'revocationRecords') return development.revocationRecords()
  if (name === 'sendRevocationPrivately') return development.sendRevocationPrivately('66'.repeat(32), {
    routeId: 'no-route', permission: finalizeEvent({ kind: 24242, created_at: 1, content: '', tags: [] }, secret),
    consent: async () => 'approve', current: () => true,
  })
  if (name === 'keeperView') return development.keeperView()
  if (name === 'keeperApprovals') return development.keeperApprovals()
  if (name === 'keeperReceive') return development.keeperReceive([])
  if (name === 'keeperCheck') return development.keeperCheck(['wss://fixture.invalid/'])
  if (name === 'keeperReview') return development.keeperReview('66'.repeat(32))
  if (name === 'keeperDecide') return development.keeperDecide(developmentDecision(), true)
  if (name === 'keeperApprove') return development.keeperApprove(developmentDecision())
  if (name === 'keeperAdvance') return development.keeperAdvance('66'.repeat(32))
  if (name === 'keeperComplete') return development.keeperComplete('66'.repeat(32))
  throw new Error('Unknown fixture development workflow')
}
export function pauseDevelopment() { return development.pause() }
let developmentPanel: BrowserMlsGrantDevelopmentPanel | undefined
export function openDevelopmentPanel() {
  developmentPanel ??= new BrowserMlsGrantDevelopmentPanel(() => ({ identity, persona: identity.pubkey, generation: developmentGeneration, mode: developmentMode,
    authority: { owner: developmentAuthority, signEvent: developmentSign, crypt: { owner: developmentCryptOwner, encrypt: developmentEncrypt, decrypt: developmentDecrypt } } }))
  developmentPanel.open()
}
export function invalidateDevelopmentPanel() { return developmentPanel?.invalidate() }

/** Instrument concrete methods only in this fixture. The private owner still
 * creates real custody and cannot accept a services/signer/ready override. */
export async function developmentInputSnapshot(kind: 'member' | 'decision' | 'wrappers' | 'relays') {
  let release!: () => void, entered!: () => void
  const acquired = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const lock = navigator.locks.request(`${dbName}:migration-v2`, async () => { entered(); await waiting })
  await acquired
  const plan = developmentPlan(), decision = developmentDecision(), wrappers: any[] = []
  const relays = ['wss://original.invalid/'], permission = { relay: { url: relays[0]!, read: true, write: false }, authenticate: false, current: () => true }
  const originals = { begin: BrowserMlsMembershipController.prototype.begin, decide: BrowserMlsKeeperDecisions.prototype.decide,
    receive: BrowserMlsRevocationInbox.prototype.receive, check: BrowserMlsKeeperInboxFetch.prototype.check, directory: NostrVmlsRevocationTransport.prototype.directory }
  let observed: unknown
  BrowserMlsMembershipController.prototype.begin = async function (selected) { observed = selected.compromised; return {} as any }
  BrowserMlsKeeperDecisions.prototype.decide = async function (selected) { observed = selected.prompt.operation; return {} as any }
  BrowserMlsRevocationInbox.prototype.receive = async function (selected) { observed = selected.length; return {} as any }
  NostrVmlsRevocationTransport.prototype.directory = async function () { return [] }
  BrowserMlsKeeperInboxFetch.prototype.check = async function (_identity, selected) {
    observed = { relay: selected![0]!.relay.url, authenticate: selected![0]!.authenticate, current: selected![0]!.current() }; return {} as any
  }
  try {
    const work = kind === 'member' ? development.memberBegin(developmentRoom, plan) : kind === 'decision' ? development.keeperDecide(decision, true)
      : kind === 'wrappers' ? development.keeperReceive(wrappers) : development.keeperCheck(relays, [permission])
    plan.compromised = false; decision.prompt.operation = '77'.repeat(32); wrappers.push({}); relays[0] = 'wss://changed.invalid/'
    permission.relay.url = 'wss://changed.invalid/'; permission.authenticate = true
    release(); await lock
    return { result: await work, observed }
  } finally {
    release(); await lock
    BrowserMlsMembershipController.prototype.begin = originals.begin; BrowserMlsKeeperDecisions.prototype.decide = originals.decide
    BrowserMlsRevocationInbox.prototype.receive = originals.receive; BrowserMlsKeeperInboxFetch.prototype.check = originals.check
    NostrVmlsRevocationTransport.prototype.directory = originals.directory
  }
}
let releaseDevelopmentCapability: (() => void) | undefined, developmentCapabilityEntered = false
export function capabilityEntered() { return developmentCapabilityEntered }
export function releaseCapability() { releaseDevelopmentCapability?.() }
export async function developmentCapability(kind: 'sign' | 'encrypt' | 'decrypt', pause = true) {
  const original = BrowserMlsRevocationInbox.prototype.receive
  const authority = { calls: 0 }
  const waiting = pause ? new Promise<void>(resolve => { releaseDevelopmentCapability = resolve }) : Promise.resolve()
  if (kind === 'sign') { developmentAuthority = authority; developmentSign = async function (template) { authority.calls++; developmentCapabilityEntered = true; await waiting; return identity.signEvent(template) } }
  else {
    developmentCryptOwner = authority
    if (kind === 'encrypt') developmentEncrypt = async function (_peer, plain) { authority.calls++; developmentCapabilityEntered = true; await waiting; return plain }
    else developmentDecrypt = async function (_peer, cipher) { authority.calls++; developmentCapabilityEntered = true; await waiting; return cipher }
  }
  let downstream = 0
  BrowserMlsRevocationInbox.prototype.receive = async function (_wrappers, captured) {
    if (kind === 'sign') await captured.signEvent({ kind: 1, created_at: 1, content: '', tags: [] })
    else await captured[kind](identity.pubkey, 'fixture')
    downstream++; return {} as any
  }
  try { return { result: await development.keeperReceive([]), calls: authority.calls, downstream } }
  finally { BrowserMlsRevocationInbox.prototype.receive = original }
}
