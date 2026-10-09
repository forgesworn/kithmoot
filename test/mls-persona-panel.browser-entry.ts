import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { BrowserMlsPanel } from '../app/src/mls-persona-panel.js'
import { BrowserMlsAccount, type MlsAccountContext } from '../app/src/mls-persona-account.js'
import { BrowserMlsPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaLinks } from '../app/src/mls-persona-link.js'
import { BrowserPersonaEnrolment } from '../app/src/mls-persona-enrolment.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'

declare global { interface Window { panelWitness(request: number[]): Promise<{ status: number; body: number[]; witnessRefused: boolean }> } }
let context: MlsAccountContext | undefined = { persona: '21'.repeat(32), generation: '0', mode: 'normal' }
let panel: BrowserMlsPanel, account: BrowserMlsAccount
const events: string[] = [], writers: string[] = []
let pausePair: Promise<void> | undefined, finishPair: (() => void) | undefined
export function holdPair() { pausePair = new Promise(resolve => { finishPair = resolve }) }
export function releasePair() { finishPair?.(); pausePair = undefined }
export function start(route: PersonaWitnessRoute) {
  const store = new BrowserMlsPersonaStore('mls-panel-test')
  const links = new BrowserPersonaLinks(() => context?.mode === 'normal', async config => {
    events.push('start'); writers.push(bytesToHex(ed25519.getPublicKey(config.transportSeed)))
    return { pairRoute: async () => {
      events.push('pair'); await pausePair
      return { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret), cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }
    }, request: async request => {
      events.push(request.path)
      const reply = await window.panelWitness(Array.from(request.body))
      return { ...reply, body: new Uint8Array(reply.body), path: { status: 'Ready', relay: null, direct: null, cause: '' } }
    }, openSocket: async () => { throw new Error('No events socket belongs to the witness panel.') },
    removeRoute: async () => {}, retireRoute: async () => {}, finalizeRoute: async () => {}, stop: async () => { events.push('stop') } }
  })
  account = new BrowserMlsAccount(() => context, () => ({ store, links, enrolment: new BrowserPersonaEnrolment(store, links), coordinator: new BrowserPersonaCoordinator(store, links.channels) }))
  panel = new BrowserMlsPanel(() => context, account)
}
export async function open() { await panel.open() }
export function seen() { return { events, writers } }
export async function change(next: MlsAccountContext | undefined) { context = next; await panel.invalidate() }
export async function canForget() { return account.canForgetBrowser() }
export async function inspect() { return account.state() }
export async function replacePreparation() {
  // Bypass UI notifications to prove the writer-lock installation check,
  // not BroadcastChannel delivery, protects an old clear confirmation.
  const store = new BrowserMlsPersonaStore('mls-panel-test'), coordinator = new BrowserPersonaCoordinator(store, async () => null)
  try {
    await coordinator.clear(context!.persona, () => true)
    return await store.withPersona(context!.persona, async s => (await s.create()).data.installation)
  } finally { await store.close() }
}
export async function loseInnerKey() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('mls-panel-test', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite'), cursor = tx.objectStore('keys').openCursor()
    cursor.onsuccess = () => { const c = cursor.result!; if (c.key === 'names') { c.continue(); return } c.update({ outer: c.value.outer }) }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
