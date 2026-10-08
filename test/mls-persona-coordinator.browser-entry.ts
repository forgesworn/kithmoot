import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BrowserMlsPersonaStore, LockedPersonaStore } from '../app/src/mls-persona-store.js'
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
export async function prepare(witness: string) {
  const wasm = await loadMlsEngine(), store = new BrowserMlsPersonaStore(dbName)
  try {
    return await store.withPersona(persona, async s => {
      const initial = await s.create(), genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(initial.data.installation), hexToBytes(witness), [])
      initial.data.coordinator = bytesToHex(genesis.state)
      initial.marker = { ...initial.marker, state: 'genesis', subject, writer: '89'.repeat(32), digest: bytesToHex(genesis.digest) }
      await s.write(initial.revision, initial.data, initial.marker)
      return { digest: bytesToHex(genesis.digest), subject, session }
    })
  } finally { await store.close() }
}
export async function status() { return result(await withHost(h => h.status(persona))) }
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
export async function damage(kind: 'stage' | 'record' | 'inner-key') {
  if (kind === 'stage') {
    const store = new BrowserMlsPersonaStore(dbName)
    try { await store.withPersona(persona, async s => { const f = (await s.read())!; f.data.staged = null; await s.write(f.revision, f.data, f.marker) }) }
    finally { await store.close() }
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
