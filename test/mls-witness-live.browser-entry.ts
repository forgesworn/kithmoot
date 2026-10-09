import { BrowserMlsPersonaStore, LockedPersonaStore } from '../app/src/mls-persona-store.js'
import { BrowserPersonaLinks } from '../app/src/mls-persona-link.js'
import { BrowserPersonaEnrolment } from '../app/src/mls-persona-enrolment.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { BrowserMlsAccount } from '../app/src/mls-persona-account.js'
import { BrowserMlsPanel } from '../app/src/mls-persona-panel.js'

const persona = '21'.repeat(32), session = '67'.repeat(32)
const store = new BrowserMlsPersonaStore('mls-real-witness-lab')
const links = new BrowserPersonaLinks(() => true)
const enrolment = new BrowserPersonaEnrolment(store, links)
let advanceBoundary: 'witness' | 'lost-reply' | undefined
let readMode: 'normal' | 'remember' | 'replay' | 'bad-signature' = 'normal'
let rememberedRead: Uint8Array | undefined
const coordinator = new BrowserPersonaCoordinator(store, async (...args) => {
  const channel = await links.channels(...args)
  if (!channel) return null
  return { ...channel, read: async request => {
    const answer = await channel.read(request)
    if (answer.type !== 'receipt') return answer
    if (readMode === 'remember') rememberedRead = answer.bytes.slice()
    if (readMode === 'replay') return { type: 'receipt', bytes: rememberedRead!.slice() }
    if (readMode === 'bad-signature') {
      const bytes = answer.bytes.slice(); bytes[bytes.length - 1] ^= 1
      return { type: 'receipt', bytes }
    }
    return answer
  }, advance: async request => {
    const answer = await channel.advance(request)
    if (answer.type === 'receipt' && advanceBoundary) {
      document.body.dataset.boundary = advanceBoundary
      if (advanceBoundary === 'witness') await new Promise(() => {})
      advanceBoundary = undefined
      return { type: 'unavailable' }
    }
    return answer
  } }
})
export const prepare = () => enrolment.prepare(persona, () => true)
export const pair = (uri: string, relay: string) => enrolment.pair(persona, uri, [relay], () => true)
export const genesis = () => enrolment.genesis(persona, () => true)
export const status = () => coordinator.status(persona)
export const clear = () => coordinator.clear(persona, () => true)
export const retired = (subject: string) => coordinator.keeperConfirmsRetired(persona, subject, () => true)
export function readFault(mode: typeof readMode) { readMode = mode }
export const close = async () => { await links.pause(); await store.close() }
let panel: BrowserMlsPanel | undefined
export async function openPanel() {
  const context = () => ({ persona, generation: '0', mode: 'normal' as const })
  panel ??= new BrowserMlsPanel(context, new BrowserMlsAccount(context, () => ({ store, links, enrolment, coordinator })))
  await panel.open()
}
export function enterPairing(uri: string, relay: string) {
  ;(document.getElementById('mlsWitnessCode') as HTMLInputElement).value = uri
  ;(document.getElementById('mlsWitnessRelays') as HTMLInputElement).value = relay
  document.getElementById('mlsWitnessPair')!.click()
}

// The daemon and Link exchanges are real. These hooks stop the caller at an
// actual completed IDB write, allowing the runner to kill the whole browser.
export function stopAt(boundary: 'stage' | 'promotion' | 'witness' | 'lost-reply') {
  if (boundary === 'witness' || boundary === 'lost-reply') { advanceBoundary = boundary; return }
  const write = LockedPersonaStore.prototype.write
  LockedPersonaStore.prototype.write = async function (...args) {
    const file = await write.apply(this, args)
    if ((boundary === 'stage' && file.data.staged) ||
        (boundary === 'promotion' && !file.data.staged && file.data.active.sessions.length)) {
      LockedPersonaStore.prototype.write = write
      document.body.dataset.boundary = boundary
      await new Promise(() => {})
    }
    return file
  }
}
export async function commit(value: number, generation: number) {
  const reply = await coordinator.transact(persona, async tx => {
    await tx.putVault('01', new Uint8Array([value]))
    await tx.putSession(session, BigInt(generation), new Uint8Array([value, 7]))
    return `effect:${value}`
  }, () => true)
  return reply.state === 'active' ? { ...reply, marks: Object.fromEntries([...reply.marks].map(([k, v]) => [k, String(v)])) } : reply
}
export async function read() {
  const reply = await coordinator.transact(persona, async tx => {
    const vault = await tx.readVault('01'), saved = await tx.readSession(session)
    return { vault: Array.from(vault ?? []), session: Array.from(saved?.plaintext ?? []), generation: saved ? String(saved.generation) : null }
  }, () => true)
  return reply.state === 'active' ? { state: reply.state, value: reply.value } : reply
}

export async function lose(kind: 'stage' | 'inner-key') {
  if (kind === 'stage') {
    await store.withPersona(persona, async locked => {
      const file = (await locked.read())!
      await locked.write(file.revision, { ...file.data, staged: null }, file.marker)
    })
    return
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mls-real-witness-lab', 1)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite'), cursor = tx.objectStore('keys').openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) return
        if (row.key !== 'names') row.update({ outer: row.value.outer })
        row.continue()
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
