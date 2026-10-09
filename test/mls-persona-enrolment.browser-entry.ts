import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaEnrolment } from '../app/src/mls-persona-enrolment.js'
import { BrowserPersonaLinks } from '../app/src/mls-persona-link.js'

const dbName = 'mls-enrolment-test', persona = '21'.repeat(32)
let route: PersonaWitnessRoute, uri: string
export function configure(value: { route: PersonaWitnessRoute; uri: string }) { route = value.route; uri = value.uri }
type Fault = 'after-genesis' | 'abort-genesis' | 'stale-pair-close' | 'stale-exit' | 'stale-initial'
export async function perform(action: 'prepare' | 'status' | 'pair' | 'genesis', fault?: Fault) {
  let current = fault !== 'stale-initial', injected = false
  const events: string[] = [], writers: string[] = [], store = new BrowserMlsPersonaStore(dbName)
  const links = new BrowserPersonaLinks(() => true, async config => {
    events.push('start'); writers.push(bytesToHex(ed25519.getPublicKey(config.transportSeed)))
    return { pairRoute: async () => {
      events.push('pair')
      return { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret), cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }
    }, request: async () => { throw new Error('Enrolment must not send a witness request.') },
    openSocket: async () => { throw new Error('Enrolment must not open an events socket.') }, removeRoute: async () => {}, retireRoute: async () => {}, finalizeRoute: async () => {},
    stop: async () => { events.push('stop'); if (fault === 'stale-pair-close') current = false } }
  })
  const host = new BrowserPersonaEnrolment(store, links)
  const write = LockedPersonaStore.prototype.write, close = LockedPersonaStore.prototype.close, put = IDBObjectStore.prototype.put
  LockedPersonaStore.prototype.write = async function (...args) {
    const saved = await write.apply(this, args)
    if (fault === 'after-genesis' && saved.data.enrolment) { injected = true; throw new Error('fixture interrupted after genesis') }
    return saved
  }
  LockedPersonaStore.prototype.close = async function () { await close.call(this); if (fault === 'stale-exit') current = false }
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const result = put.apply(this, args)
    if (fault === 'abort-genesis' && this.name === 'personas') { injected = true; this.transaction.abort() }
    return result
  }
  try {
    const value = action === 'pair' ? await host.pair(persona, uri, route.relayUrls, () => current) : await host[action](persona, () => current)
    return { value, events, writers, injected }
  } catch (e) { return { error: (e as Error).message, events, writers, injected } }
  finally { LockedPersonaStore.prototype.write = write; LockedPersonaStore.prototype.close = close; IDBObjectStore.prototype.put = put; await links.pause(); await store.close() }
}
export async function damage(kind: 'marker' | 'inner-key' | 'invalid-inner-key') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(dbName, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(kind === 'marker' ? 'markers' : 'keys', 'readwrite'), cursor = tx.objectStore(kind === 'marker' ? 'markers' : 'keys').openCursor()
    cursor.onsuccess = () => { const c = cursor.result!; if (c.key === 'names') { c.continue(); return } c.update(kind === 'marker' ? { ...c.value, subject: '99'.repeat(32) } : { outer: c.value.outer, ...(kind === 'invalid-inner-key' ? { inner: { algorithm: { name: 'AES-GCM' } } } : {}) }) }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
export async function substituteRoute(changed: PersonaWitnessRoute) {
  const store = new BrowserMlsPersonaStore(dbName)
  try { return await store.withPersona(persona, async s => {
    const file = (await s.read())!
    return s.write(file.revision, { ...file.data, witnessRoute: changed }, file.marker).then(() => 'unexpected-success', e => e.code)
  }) } finally { await store.close() }
}
export async function drainedWrite() {
  const store = new BrowserMlsPersonaStore(dbName)
  let writing: Promise<string> | undefined, previous: string | undefined
  try {
    await store.withPersona(persona, async s => {
      const file = (await s.read())!; previous = file.revision
      // Deliberately leave a started operation for scope cleanup to drain.
      writing = s.write(file.revision, file.data, file.marker).then(saved => saved.revision)
      void writing.catch(() => undefined)
    })
    return { committed: await writing !== previous }
  } finally { await store.close() }
}
