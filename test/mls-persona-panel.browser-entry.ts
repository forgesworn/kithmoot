import { CoordinatedMlsVault } from '../app/src/mls-coordinated-vault.js'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsVaultStorage, MlsVault } from '../app/src/mls-vault.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { BrowserMlsPanel } from '../app/src/mls-persona-panel.js'
import { BrowserMlsAccount, type MlsAccountContext } from '../app/src/mls-persona-account.js'
import { BrowserMlsPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaLinks } from '../app/src/mls-persona-link.js'
import { BrowserPersonaEnrolment } from '../app/src/mls-persona-enrolment.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { rememberStandaloneRevocations } from '../app/src/mls-revocation-outbox.js'
import { localPeerCrypt } from '../src/dm.js'
import { dmRelayListTemplate } from '../src/dm-relays.js'
import { unwrapVmlsRevocationRequest } from '../src/vmls-revocation-request.js'

declare global { interface Window { panelWitness(request: number[]): Promise<{ status: number; body: number[]; witnessRefused: boolean }> } }
let context: MlsAccountContext | undefined = { persona: '21'.repeat(32), generation: '0', mode: 'normal' }
let panel: BrowserMlsPanel, account: BrowserMlsAccount
let coordinator: BrowserPersonaCoordinator
let rejectPublish = false, directoryWait: Promise<void> | undefined, releaseDirectory: (() => void) | undefined
const transportCalls: string[] = []
const wallNow = Date.now.bind(Date)
let fixtureTime: number | undefined
Date.now = () => fixtureTime === undefined ? wallNow() : fixtureTime * 1000
export function revocationTime(value?: number) { if (value !== undefined) fixtureTime = value; return Math.floor(Date.now() / 1000) }
const publications: { id: string; createdAt: number; expiration: number }[] = []
export function revocationPublications() { return publications }
const keeperSecret = new Uint8Array(32).fill(43)
const keeper = { pubkey: getPublicKey(keeperSecret), signEvent: async (event: any) => finalizeEvent(event, keeperSecret), ...localPeerCrypt(keeperSecret) }
const transport = {
  directory: async (pubkey: string) => {
    transportCalls.push(`directory:${pubkey}`); await directoryWait
    return [await keeper.signEvent(dmRelayListTemplate(['wss://keeper.test'], Math.floor(Date.now() / 1000)))]
  },
  publish: async (publication: any) => {
    transportCalls.push('publish')
    const request = await unwrapVmlsRevocationRequest(publication.event, keeper)
    if (request) publications.push({ id: publication.event.id, createdAt: request.createdAt, expiration: request.expiration })
    if (!request || request.sender !== identity.pubkey || request.device !== '34'.repeat(32) || request.keeper !== keeper.pubkey ||
        JSON.stringify(request.sessions) !== JSON.stringify(['12'.repeat(32)]) || JSON.stringify(request.boxes) !== JSON.stringify(['56'.repeat(32)])) throw new Error('Wrong retained request wire payload')
    if (rejectPublish) throw new Error('Keeper relay refused the request')
  },
}
export function revocationSeen() { return transportCalls }
export function refuseRevocation(value: boolean) { rejectPublish = value }
export function holdDirectory() { directoryWait = new Promise(resolve => { releaseDirectory = resolve }) }
export function finishDirectory() { releaseDirectory?.(); directoryWait = undefined }
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
  coordinator = new BrowserPersonaCoordinator(store, links.channels)
  account = new BrowserMlsAccount(() => context, () => ({ store, links, enrolment: new BrowserPersonaEnrolment(store, links), coordinator }))
  panel = new BrowserMlsPanel(() => context, account, document, () => transport)
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

const secret = new Uint8Array(32).fill(42)
let rejectSigner = false, releaseSigner: (() => void) | undefined, signerWait: Promise<void> | undefined
const identity = { pubkey: getPublicKey(secret), async signEvent(e: any) {
  document.body.dataset.signer = 'waiting'; await signerWait
  if (rejectSigner) throw new Error('declined')
  return finalizeEvent(e, secret)
} }
export async function useIdentity() { context = { persona: identity.pubkey, generation: 'identity', mode: 'normal', identity, revocationIdentity: { ...identity, ...localPeerCrypt(secret) } }; await panel.invalidate() }
export async function seedRevocation() {
  return coordinator.transact(identity.pubkey, tx => rememberStandaloneRevocations(tx, identity.pubkey, keeper.pubkey, '12'.repeat(32),
    [{ identity: identity.pubkey, device: '34'.repeat(32), homeBox: '56'.repeat(32), own: false, pending: false }], Math.floor(Date.now() / 1000)), () => true)
}
export async function removeEncryption() {
  context = { ...context!, generation: 'no-encryption', revocationIdentity: undefined }
  await panel.invalidate(); await panel.open()
}
export function denySigner(value = true) { rejectSigner = value }
export function holdSigner() { signerWait = new Promise(resolve => { releaseSigner = resolve }) }
export function finishSigner() { releaseSigner?.(); signerWait = undefined }
export async function legacyEnrol() {
  const vault = new MlsVault(new BrowserMlsVaultStorage())
  return vault.enrol(vault.context(location.origin, identity.pubkey), identity, Math.floor(Date.now() / 1000) + 86400)
}
export async function replaceDevice() { return account.enrolDevice(Math.floor(Date.now() / 1000) + 86400, true) }
export function boxSign() { return panel.signBoxRequest({ v: 1, box: '78'.repeat(32), method: 'POST', path: '/vmls/v1/fetch', payload: '12'.repeat(32) }) }
export function vaultState() { return account.vaultState() }

export async function mutateConsentScope() {
  const state = await account.vaultState()
  if (!state.vault?.ok || !state.vault.value) throw new Error('no device')
  const scope = { principal: location.origin, persona: identity.pubkey, device: state.vault.value.device.device, homeBox: '78'.repeat(32), method: 'signLeafBindingV1/1' as const }
  const result = await account.approveScope(scope, async shown => {
    scope.homeBox = '79'.repeat(32)
    return shown.homeBox === '78'.repeat(32) ? 'approve' : 'deny'
  })
  return { result, state: (await account.vaultState()).vault }
}

export async function loseKeyBeforeRelease() {
  const sign = CoordinatedMlsVault.prototype.signBoxRequestV1
  CoordinatedMlsVault.prototype.signBoxRequestV1 = async function (...args) {
    const answer = await sign.apply(this, args)
    await loseInnerKey()
    return answer
  }
  try { return await account.signBoxRequest({ v: 1, box: '78'.repeat(32), method: 'POST', path: '/vmls/v1/fetch', payload: '12'.repeat(32) }, async () => 'approve') }
  finally { CoordinatedMlsVault.prototype.signBoxRequestV1 = sign }
}
