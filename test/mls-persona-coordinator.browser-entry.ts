import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { pairedWitnessIdentity, personaWriter } from '../app/src/mls-writer-identity.js'
import { BrowserPersonaCoordinator, type CoordinationResult } from '../app/src/mls-persona-coordinator.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'

const dbName = 'mls-coordination-test', persona = '21'.repeat(32), subject = '45'.repeat(32), session = '67'.repeat(32)
declare global { interface Window { witnessExchange(method: string, request: number[]): Promise<{ type: string; bytes?: number[] }> } }
async function withHost<T>(work: (host: BrowserPersonaCoordinator) => Promise<T>) {
  const store = new BrowserMlsPersonaStore(dbName)
  const exchange = async (method: string, request: Uint8Array): Promise<WitnessAnswer> => {
    const reply = await window.witnessExchange(method, Array.from(request))
    return reply.type === 'receipt' ? { type: 'receipt', bytes: new Uint8Array(reply.bytes!) } : { type: reply.type as 'unavailable' | 'refused' }
  }
  const host = new BrowserPersonaCoordinator(store, async () => ({ read: r => exchange('read', r), advance: r => exchange('advance', r) }))
  try { return await work(host) } finally { await store.close() }
}
function result<T>(value: CoordinationResult<T>) { return value.state === 'active' ? { ...value, marks: Object.fromEntries([...value.marks].map(([k, v]) => [k, String(v)])) } : value }
export async function prepare(route: PersonaWitnessRoute) {
  const wasm = await loadMlsEngine(), store = new BrowserMlsPersonaStore(dbName)
  try {
    return await store.withPersona(persona, async s => {
      const witness = pairedWitnessIdentity(route)
      const initial = await s.create(), genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(initial.data.installation), hexToBytes(witness), [])
      initial.data.coordinator = bytesToHex(genesis.state)
      initial.data.witnessRoute = route
      initial.data.enrolment = { subject, writer: personaWriter(initial.data.writerSeed), witness, digest: bytesToHex(genesis.digest) }
      initial.marker = { ...initial.marker, state: 'genesis', subject, writer: initial.data.enrolment.writer, digest: bytesToHex(genesis.digest) }
      await s.write(initial.revision, initial.data, initial.marker)
      return { digest: bytesToHex(genesis.digest), subject, session }
    })
  } finally { await store.close() }
}
export async function status() { return result(await withHost(h => h.status(persona))) }
export async function channelLifetime(mode: 'commit' | 'callback-error' | 'read-error' | 'stale-close') {
  const store = new BrowserMlsPersonaStore(dbName), events: string[] = []
  let current = true, seedWiped = false, opened = 0, closed = 0, entered!: () => void, finish!: () => void
  const stopping = new Promise<void>(resolve => { entered = resolve }), release = new Promise<void>(resolve => { finish = resolve })
  const host = new BrowserPersonaCoordinator(store, async (_persona, seed) => {
    opened++
    const exchange = async (method: string, request: Uint8Array): Promise<WitnessAnswer> => {
      seedWiped = seed.every(n => n === 0); events.push(method)
      if (mode === 'read-error') throw new Error('fixture read error')
      const reply = await window.witnessExchange(method, Array.from(request))
      return reply.type === 'receipt' ? { type: 'receipt', bytes: new Uint8Array(reply.bytes!) } : { type: reply.type as 'unavailable' | 'refused' }
    }
    return { read: r => exchange('read', r), advance: r => exchange('advance', r), close: async () => {
      events.push('closing'); entered(); await release; closed++; events.push('closed')
      if (mode === 'stale-close') current = false
    } }
  })
  try {
    const task = host.transact(persona, async tx => {
      if (mode === 'callback-error') throw new Error('fixture callback error')
      await tx.putVault('01', new Uint8Array([6])); return 'effect'
    }, () => current).then(result, e => ({ error: e.message }))
    await stopping
    let secondEntered = false
    const second = store.withPersona(persona, async () => { secondEntered = true; events.push('second-writer') })
    await new Promise(resolve => setTimeout(resolve, 30))
    const blockedDuringClose = !secondEntered
    finish(); const outcome = await task; await second
    return { outcome, events, opened, closed, seedWiped, blockedDuringClose }
  } finally { finish(); await store.close() }
}
export async function commit(value: number, generation: number, fault?: 'after-stage' | 'after-promotion' | 'abort-promotion' | 'stale' | 'stale-initial' | 'stale-exit') {
  const write = LockedPersonaStore.prototype.write, close = LockedPersonaStore.prototype.close, put = IDBObjectStore.prototype.put
  let writes = 0, puts = 0, injected = false, current = fault !== 'stale-initial'
  LockedPersonaStore.prototype.close = async function () { await close.call(this); if (fault === 'stale-exit') current = false }
  LockedPersonaStore.prototype.write = async function (...args) {
    const saved = await write.apply(this, args)
    writes++
    if ((fault === 'after-stage' && writes === 1) || (fault === 'after-promotion' && writes === 2)) { injected = true; throw new Error('fixture interrupted after persistence') }
    if (fault === 'stale' && writes === 1) current = false
    return saved
  }
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const pending = put.apply(this, args)
    if (this.name === 'personas' && ++puts === 2 && fault === 'abort-promotion') { injected = true; this.transaction.abort() }
    return pending
  }
  try {
    const outcome = await withHost(h => h.transact(persona, async tx => {
      await tx.putVault('01', new Uint8Array([value]))
      await tx.putSession(session, BigInt(generation), new Uint8Array([value, 7]))
      return `effect:${value}`
    }, () => current))
    return { ...result(outcome), injected }
  } catch (e) { return { error: (e as Error).message, injected } }
  finally { LockedPersonaStore.prototype.write = write; LockedPersonaStore.prototype.close = close; IDBObjectStore.prototype.put = put }
}
export async function read() {
  let opened: Uint8Array | undefined
  const answer = await withHost(h => h.transact(persona, async tx => {
    opened = await tx.readVault('01')
    const s = await tx.readSession(session)
    return { vault: Array.from(opened ?? []), snapshot: Array.from(s?.plaintext ?? []), generation: s ? String(s.generation) : null }
  }, () => true))
  return { ...result(answer), openedWiped: opened === undefined || opened.every(v => v === 0) }
}
export async function local() {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => {
    const file = (await s.read())!
    return { active: file.data.active.sessions.map(x => x.generation), staged: file.data.staged?.sessions.map(x => x.generation) ?? null, fence: file.marker.reason }
  }) } finally { await store.close() }
}
async function db(name = dbName) {
  return await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('backup'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
type Image = { name: string; keys: IDBValidKey[]; values: unknown[] }[]
export async function saveProfile() {
  const from = await db(), backup = await db(`${dbName}-backup`)
  try {
    const captured = await new Promise<Image>((resolve, reject) => {
      const tx = from.transaction(['keys', 'personas', 'markers'], 'readonly')
      const rows = ['keys', 'personas', 'markers'].map(name => ({ name, keys: tx.objectStore(name).getAllKeys(), values: tx.objectStore(name).getAll() }))
      tx.oncomplete = () => resolve(rows.map(x => ({ name: x.name, keys: x.keys.result, values: x.values.result }))); tx.onabort = () => reject(tx.error)
    })
    await new Promise<void>((resolve, reject) => { const tx = backup.transaction('backup', 'readwrite'); tx.objectStore('backup').put(captured, 'image'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
  } finally { from.close(); backup.close() }
}
export async function restoreProfile(only?: string) {
  const to = await db(), backup = await db(`${dbName}-backup`)
  try {
    const captured = await new Promise<Image>((resolve, reject) => { const r = backup.transaction('backup', 'readonly').objectStore('backup').get('image'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const rows = captured.filter(x => !only || x.name === only)
    await new Promise<void>((resolve, reject) => {
      const tx = to.transaction(rows.map(x => x.name), 'readwrite')
      for (const row of rows) { const s = tx.objectStore(row.name); s.clear(); row.keys.forEach((k, i) => s.put(row.values[i], k)) }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
  } finally { to.close(); backup.close() }
}
export async function damage(kind: 'stage' | 'record' | 'inner-key' | 'newer-format') {
  if (kind === 'stage') {
    const store = new BrowserMlsPersonaStore(dbName)
    try { await store.withPersona(persona, async s => { const f = (await s.read())!; f.data.staged = null; await s.write(f.revision, f.data, f.marker) }) }
    finally { await store.close() }
    return
  }
  if (kind === 'newer-format') {
    // A correctly sealed container from an unsupported future format must
    // not be mistaken for a destroyed writer key and erased during clear.
    const storage = await db()
    try {
      const saved = await new Promise<{ name: IDBValidKey; row: any; key: CryptoKey }>((resolve, reject) => {
        const tx = storage.transaction(['personas', 'keys'], 'readonly'), cursor = tx.objectStore('personas').openCursor()
        let value: { name: IDBValidKey; row: any; key: CryptoKey }
        cursor.onsuccess = () => { const c = cursor.result!; const key = tx.objectStore('keys').get(c.key); key.onsuccess = () => { value = { name: c.key, row: c.value, key: key.result.outer } } }
        tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error)
      })
      const aad = new TextEncoder().encode(JSON.stringify(['kithmoot.mls-persona', 1, persona, saved.row.revision])), sealed = new Uint8Array(saved.row.sealed)
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(1, 13), additionalData: aad }, saved.key, sealed.slice(13)))
      const value = JSON.parse(new TextDecoder().decode(plain)); plain.fill(0); value.version = 999
      const input = new TextEncoder().encode(JSON.stringify(value)), nonce = crypto.getRandomValues(new Uint8Array(12))
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, saved.key, input)); input.fill(0)
      const output = new Uint8Array(13 + cipher.length); output[0] = 1; output.set(nonce, 1); output.set(cipher, 13)
      await new Promise<void>((resolve, reject) => { const tx = storage.transaction('personas', 'readwrite'); tx.objectStore('personas').put({ ...saved.row, sealed: output.buffer }, saved.name); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
    } finally { storage.close() }
    return
  }
  const storage = await db()
  try { await new Promise<void>((resolve, reject) => {
    const tx = storage.transaction(kind === 'record' ? 'personas' : 'keys', 'readwrite'), s = tx.objectStore(kind === 'record' ? 'personas' : 'keys')
    const cursor = s.openCursor()
    cursor.onsuccess = () => { const c = cursor.result; if (!c) return; if (c.key === 'names') { c.continue(); return } if (kind === 'record') c.delete(); else c.update({ outer: c.value.outer }) }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { storage.close() }
}
export async function fenceRace() {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => {
    const f = (await s.read())!, encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    let resume!: () => void, entered!: () => void
    const atSeal = new Promise<void>(resolve => { entered = resolve })
    crypto.subtle.encrypt = async (...args) => { entered(); await new Promise<void>(resolve => { resume = resolve }); return encrypt(...args) }
    try {
      const writing = s.write(f.revision, f.data, f.marker).then(() => 'unexpected-success', e => e.code)
      await atSeal
      await s.fence('missing-record')
      resume()
      return { writing: await writing, reason: (await s.marker())!.reason }
    } finally { crypto.subtle.encrypt = encrypt }
  }) } finally { await store.close() }
}
export async function concurrentSteps() {
  return result(await withHost(h => h.transact(persona, async tx => {
    const second = tx.putSession(session, 2n, new Uint8Array([2])), third = tx.putSession(session, 3n, new Uint8Array([3]))
    await Promise.all([second, third])
    return 'effect:3'
  }, () => true)))
}
export async function clear(fault?: 'after-intent' | 'abort-key-destruction' | 'after-key-destruction' | 'abort-erasure') {
  const fence = LockedPersonaStore.prototype.fence, write = LockedPersonaStore.prototype.write, put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete
  let injected = false
  LockedPersonaStore.prototype.fence = async function (...args) {
    const result = await fence.apply(this, args)
    if (fault === 'after-intent' && !injected) { injected = true; throw new Error('fixture interrupted after clear intent') }
    return result
  }
  LockedPersonaStore.prototype.write = async function (...args) {
    const result = await write.apply(this, args)
    if (fault === 'after-key-destruction' && result.data.cleared && !injected) { injected = true; throw new Error('fixture interrupted after key destruction') }
    return result
  }
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const result = put.apply(this, args)
    if (fault === 'abort-key-destruction' && this.name === 'keys' && !injected) { injected = true; this.transaction.abort() }
    return result
  }
  IDBObjectStore.prototype.delete = function (...args: Parameters<typeof remove>) {
    const result = remove.apply(this, args)
    if (fault === 'abort-erasure' && this.name === 'keys' && !injected) { injected = true; this.transaction.abort() }
    return result
  }
  try { return { ...await withHost(h => h.clear(persona, () => true)), injected } }
  catch (e) { return { error: (e as Error).message, injected } }
  finally { LockedPersonaStore.prototype.fence = fence; LockedPersonaStore.prototype.write = write; IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = remove }
}
export async function confirmRetired(subject: string) { return await withHost(h => h.keeperConfirmsRetired(persona, subject, () => true)) }
export async function replacementState() {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => {
    let file, unreadable = false
    try { file = await s.read(true) } catch { unreadable = true }
    const marker = await s.marker()
    return { innerKey: await s.hasInnerKey(), row: await s.revision() !== null, unreadable, cleared: file?.data.cleared ?? null,
      active: file?.data.active.sessions.length ?? null, staged: file?.data.staged?.sessions.length ?? null,
      marker: marker?.state, reason: marker?.reason, installation: marker?.installation, retired: marker?.retired }
  }) } finally { await store.close() }
}
export async function prepareFresh() {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => { const f = await s.create(); return { installation: f.data.installation, state: f.marker.state, retired: f.marker.retired } }) }
  catch (e) { return { error: (e as Error).message } }
  finally { await store.close() }
}
export async function discardTombstones() {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => {
    const f = (await s.read())!
    try { await s.write(f.revision, f.data, { ...f.marker, retired: [] }); return 'unexpected-success' } catch (e) { return (e as { code: string }).code }
  }) } finally { await store.close() }
}
export async function unregistered() {
  const store = new BrowserMlsPersonaStore('mls-prepared-only-test')
  const host = new BrowserPersonaCoordinator(store, async () => { throw new Error('Unregistered persona sent witness traffic') })
  try {
    const old = await store.withPersona(persona, s => s.create())
    const cleared = await host.clear(persona, () => true)
    const fresh = await store.withPersona(persona, s => s.create())
    return { cleared, changed: old.data.installation !== fresh.data.installation && old.data.writerSeed !== fresh.data.writerSeed,
      tombstone: fresh.marker.retired.some(t => t.installation === old.data.installation && t.subject === null) }
  } finally { await store.close() }
}
