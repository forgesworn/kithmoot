import { BrowserMlsPersonaStore, PersonaStorageError, personaManifest, type LockedPersonaStore } from '../app/src/mls-persona-store.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'

const dbName = 'mls-persona-store-test', persona = '12'.repeat(32), session = '34'.repeat(32)
const store = () => new BrowserMlsPersonaStore(dbName)
async function error(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return 'unexpected-success' } catch (e) { return e instanceof PersonaStorageError ? e.code : (e as Error).name }
}
async function raw() {
  return await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(dbName, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
async function alter(name: string, work: (s: IDBObjectStore) => void) {
  const db = await raw()
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(name, 'readwrite'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); work(tx.objectStore(name)) }) }
  finally { db.close() }
}
export async function prepare() {
  const db = store()
  try {
    return await db.withPersona(persona, async locked => {
      const initial = await locked.create(), { data, marker } = initial
      data.active.vault = [{ id: '01', sealed: await locked.sealObject(data.installation, '01', new Uint8Array([1, 2, 3])) }]
      data.active.sessions = [{ id: session, generation: '1', sealed: await locked.sealSession(data.installation, session, '1', new Uint8Array([4, 5])) }]
      data.coordinator = '01' // Store fixture only; the coordinator test uses real Rust state.
      const active = await locked.write(initial.revision, data, marker)
      data.staged = structuredClone(data.active)
      data.staged.sessions = [{ id: session, generation: '2', sealed: await locked.sealSession(data.installation, session, '2', new Uint8Array([6, 7])) }]
      const candidate = await locked.write(active.revision, data, marker)
      const mismatch = await error(() => locked.openSession(data.installation, session, '1', data.staged!.sessions[0].sealed))
      return { active: candidate.data.active.sessions[0].generation, staged: candidate.data.staged!.sessions[0].generation, mismatch }
    })
  } finally { await db.close() }
}
export async function reopenAndPromote() {
  const db = store()
  let escaped: LockedPersonaStore | undefined
  try {
    const result = await db.withPersona(persona, async locked => {
      escaped = locked
      const old = (await locked.read())!, data = structuredClone(old.data)
      const read = [...await locked.openSession(data.installation, session, '2', data.staged!.sessions[0].sealed)]
      data.active = data.staged!; data.staged = null; data.coordinator = '02'
      const promoted = await locked.write(old.revision, data, old.marker)
      const conflict = await error(() => locked.write(old.revision, old.data, old.marker))
      const unchangedVault = old.data.active.vault[0].sealed === promoted.data.active.vault[0].sealed
      return { read, active: promoted.data.active.sessions[0].generation, staged: promoted.data.staged, conflict, unchangedVault }
    })
    return { ...result, escaped: await error(() => escaped!.read()) }
  } finally { await db.close() }
}
export async function raceAndAbort() {
  const db = store()
  try {
    return await db.withPersona(persona, async locked => {
      const old = (await locked.read())!
      // Both seals start from one revision; the IDB CAS must admit just one.
      const outcomes = await Promise.allSettled([locked.write(old.revision, old.data, old.marker), locked.write(old.revision, old.data, old.marker)])
      const winners = outcomes.filter(x => x.status === 'fulfilled').length
      const losers = outcomes.filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason.code)
      const before = (await locked.read())!, next = structuredClone(before.data)
      next.active.sessions = []; next.staged = null; next.coordinator = '03'
      const put = IDBObjectStore.prototype.put
      let injected = false
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
        const request = put.apply(this, args)
        if (this.name === 'personas') { injected = true; this.transaction.abort() }
        return request
      }
      let failure: string
      try { failure = await error(() => locked.write(before.revision, next, before.marker)) }
      finally { IDBObjectStore.prototype.put = put }
      const after = (await locked.read())!
      return { winners, losers, injected, failure, identical: JSON.stringify(before) === JSON.stringify(after) }
    })
  } finally { await db.close() }
}
export async function loss(kind: 'record' | 'keys' | 'names' | 'tamper') {
  const target = kind === 'record' || kind === 'tamper' ? 'personas' : 'keys'
  await alter(target, s => {
    if (kind === 'names') { s.delete('names'); return }
    const cursor = s.openCursor()
    cursor.onsuccess = () => {
      const row = cursor.result
      if (!row) return
      if (row.key === 'names') { row.continue(); return }
      if (kind === 'tamper') { const value = row.value; new Uint8Array(value.sealed)[20] ^= 1; row.update(value) }
      else row.delete()
    }
  })
  const db = store()
  try {
    const reading = await error(() => db.withPersona(persona, s => s.read()))
    const replacing = await error(() => db.withPersona(persona, s => s.create()))
    return { reading, replacing }
  } finally { await db.close() }
}
let release: (() => void) | undefined
export let held = false
export async function hold() {
  const db = store()
  try { await db.withPersona(persona, async locked => {
    held = true
    await new Promise<void>(resolve => { release = resolve })
    const current = (await locked.read())!
    current.data.coordinator = '09'
    await locked.write(current.revision, current.data, current.marker)
  }) } finally { held = false; await db.close() }
}
export function unlock() { release!() }
export async function readState() {
  const db = store()
  try { return await db.withPersona(persona, async s => (await s.read())!.data.coordinator) }
  finally { await db.close() }
}
export async function metadata() {
  const db = await raw()
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(['keys', 'personas', 'markers'], 'readonly')
    const keys = tx.objectStore('keys').getAll(), rows = tx.objectStore('personas').getAll(), names = tx.objectStore('personas').getAllKeys(), markers = tx.objectStore('markers').getAll()
    tx.oncomplete = () => resolve({ nonextractable: keys.result.every(k => k instanceof CryptoKey ? !k.extractable : !k.outer.extractable && !k.inner.extractable), noPersona: !JSON.stringify([rows.result, names.result, markers.result]).includes(persona), sealedOnly: Object.keys(rows.result[0]).sort() })
    tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
export async function manifestIntegrity() {
  const db = store(), wasm = await loadMlsEngine()
  const platform = new wasm.Platform(new Uint8Array(32), new Uint8Array(32), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  try {
    return await db.withPersona(persona, async locked => {
      const current = (await locked.read())!, actual = current.data.active
      const entries = () => personaManifest(actual, wasm.coordinatorObjectHash)
      const genesis = wasm.coordinatorGenesis(new Uint8Array(32).fill(9), hexToBytes(current.data.installation), ed25519.getPublicKey(new Uint8Array(32).fill(8)), entries())
      const healthy = wasm.openCoordinator(platform, genesis.state, entries(), undefined)
      const initial = healthy.fenced() ?? null
      healthy.free()
      // Simulate a locally sealed but stale object set under unchanged saved
      // coordinator bytes. Manifest reconstruction, not cached hashes, fences it.
      actual.sessions[0].sealed = await locked.sealSession(current.data.installation, session, '1', new Uint8Array([99]))
      const corrupt = wasm.openCoordinator(platform, genesis.state, entries(), undefined)
      const altered = corrupt.fenced()
      corrupt.free()
      return { initial, altered }
    })
  } finally { platform.free(); await db.close() }
}
