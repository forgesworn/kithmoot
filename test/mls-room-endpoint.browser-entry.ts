import { base64, base64urlnopad } from '@scure/base'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsRoomForeground } from '../app/src/mls-room-foreground.js'
import { BrowserMlsRoomEndpoint } from '../app/src/mls-room-endpoint.js'
import { BrowserMlsRoomLinkVault, MLS_ROOM_LINK_OWNER, mlsRoomLinkDatabase } from '../app/src/mls-room-link-vault.js'
import { BrowserMlsRoomDevelopmentOwner } from '../app/src/mls-room-development-owner.js'
import { BrowserMlsRoomConsent } from '../app/src/mls-room-consent.js'
import { withMlsRoomLinkForgetGuard } from '../app/src/mls-room-link-forget.js'
import { MLS_ROOM_LINK_NAMES } from '../app/src/mls-room-link-forget.js'
import type { LinkEngine } from '../app/src/browser-link-types.js'
import { wipeLinkState } from '../app/src/browser-link-vault.js'

// Controlled foreground visibility permits two concurrent fixture tabs.
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
// Actual IDB, WebCrypto and native locks. The engine seam controls settlement;
// it does not stand in for default-WASM or live Bothy acceptance.
const foreground = new BrowserMlsRoomForeground(), secret = new Uint8Array(32).fill(31)
const identity = { pubkey: getPublicKey(secret), signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret) }
let activeIdentity = identity, live = true, mode = 'normal', stage = '', reached = false, release: (() => void) | undefined
let starts = 0, stops = 0, requests = 0, pairs = 0, failedStop = false, seed: number[] | undefined
async function hold(at: string) { if (stage === at) { reached = true; await new Promise<void>(resolve => { release = resolve }) } }
const card = new Uint8Array(126); card.set(new TextEncoder().encode('FSL1')); card[4] = 1; card.fill(32, 5, 37)
const code = () => 'bothy:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, bothy: '20'.repeat(32), secret: '44'.repeat(16), role: 'box', name: 'Fixture', exp: Math.floor(Date.now() / 1000) + 300, card: base64.encode(card) })))
const endpoint = new BrowserMlsRoomEndpoint(foreground, () => activeIdentity, () => mode === 'normal', async config => {
  starts++; seed = [...config.transportSeed]; await hold('start')
  return {
    pairRoute: async bundle => { pairs++; await hold('pair'); return { routeId: bundle.routeId, card: card.slice(), pairedRouteSecret: new Uint8Array(32).fill(41), cardSerial: 1n, cardVerifiedAt: 1n } },
    request: async () => { requests++; await hold('request'); return { status: 200, body: new Uint8Array([9]), witnessRefused: false, path: { status: 'relay', relay: 'wss://fixture.invalid/', direct: null, cause: 'fixture' } } },
    openSocket: async () => { throw new Error('Not used by this room fixture') },
    removeRoute: async () => {}, retireRoute: async () => {}, finalizeRoute: async () => {},
    stop: async () => { stops++; await hold('stop'); if (failedStop) throw new Error('Fixture stop failed') },
  } satisfies LinkEngine
})
export function configure(at = '', privacy = 'normal', fail = false) { stage = at; mode = privacy; reached = false; failedStop = fail }
export function releaseWork() { release?.() }
export function status() { return { occupied: !!foreground.capture(), reached, starts, stops, requests, pairs, seed } }
export function invalidate() { foreground.invalidate(); void endpoint.stop().catch(() => {}) }
export function settled() { return foreground.settled() }
export function ownerKey() { return MLS_ROOM_LINK_OWNER }
let consentResult: Promise<unknown>, consentCurrent = true
const consentOwner = new BrowserMlsRoomConsent()
export function startRoomConsent() {
  consentCurrent = true
  consentResult = foreground.run(identity.pubkey, () => consentCurrent, scope => consentOwner.ask(foreground, scope,
    { principal: location.origin, persona: identity.pubkey, device: '33'.repeat(32), homeBox: '44'.repeat(32), method: 'signLeafBindingV1/1' },
    Math.floor(Date.now() / 1000) + 1, () => consentCurrent))
}
export function invalidateRoomConsent() { consentCurrent = false }
export function abortRoomConsent() { foreground.invalidate() }
export function cancelRoomConsent() { consentOwner.cancel() }
export function finishRoomConsent() { return consentResult }
export function account() { return identity.pubkey }
export async function workflow(action: 'setup' | 'resume' | 'request' | 'pair' | 'signer' = 'resume') {
  return foreground.run(activeIdentity.pubkey, () => live, async scope => {
    try {
      await endpoint.resume(activeIdentity.pubkey, ['wss://fixture.invalid/link'])
      if (action === 'setup' || action === 'pair') return await endpoint.pair(code())
      if (action === 'signer') { await foreground.track(scope, async () => { await hold('signer'); return identity.signEvent({ kind: 1, content: '', tags: [], created_at: 0 }) }); return null }
      if (action === 'request') {
        const box = endpoint.boxes()[0]
        return await endpoint.request({ routeId: box.routeId, method: 'GET', path: '/health', authorization: '', body: new Uint8Array() })
      }
      return endpoint.boxes()[0] ?? null
    } finally { await endpoint.stop() }
  })
}
export function saved() { return foreground.run(activeIdentity.pubkey, () => live, async () => { try { return await endpoint.pairedBoxes(activeIdentity.pubkey) } finally { await endpoint.stop() } }) }
export async function outside() { try { await endpoint.resume(identity.pubkey); return true } catch { return false } }
export function replaceSigner() { activeIdentity = { ...identity }; live = false }
export function mutateSigner() { activeIdentity.signEvent = async template => finalizeEvent(template, secret) }
export function changeAccount() { activeIdentity = { ...identity, pubkey: '66'.repeat(32) } }
export function stopAgain() { return endpoint.stop() }
export function outsideOwnershipWrite(fake = false) {
  return foreground.run(identity.pubkey, () => true, async () => {
    const vault = new BrowserMlsRoomLinkVault(foreground, fake ? { ownsScope: () => true } as any : endpoint)
    await vault.write({ account: identity.pubkey, transportSeed: new Uint8Array(32).fill(12), relayUrls: ['wss://fixture.invalid/link'], routes: [] })
  })
}
export function holdEncryption() {
  const original = crypto.subtle.encrypt.bind(crypto.subtle)
  crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
    crypto.subtle.encrypt = original
    const result = await original(...args); stage = 'encrypt'; await hold('encrypt'); return result
  }
}
async function database(name: string) {
  const open = indexedDB.open(name, 1)
  open.onupgradeneeded = () => { open.result.createObjectStore('keys'); open.result.createObjectStore('records', { keyPath: 'key' }) }
  return new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
}
async function record(name: string) {
  const db = await database(name)
  try { return await new Promise<any>((resolve, reject) => {
    const get = db.transaction(['keys','records'], 'readonly'), k = get.objectStore('keys').get('device'), r = get.objectStore('records').get('active')
    get.oncomplete = () => resolve({ key: k.result, record: r.result }); get.onabort = get.onerror = () => reject(get.error)
  }) } finally { db.close() }
}
async function save(name: string, key: unknown, value: unknown) {
  const db = await database(name)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['keys','records'], 'readwrite')
    if (key !== undefined) tx.objectStore('keys').put(key, 'device')
    tx.objectStore('records').put(value)
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
  }) } finally { db.close() }
}
export async function inspect() {
  const { key, record: value } = await record(await mlsRoomLinkDatabase(activeIdentity.pubkey))
  return { key: !!key, extractable: key?.key?.extractable, record: !!value,
    cipher: value?.ciphertext ? [...new Uint8Array(value.ciphertext)] : null, databases: (await indexedDB.databases()).map(db => db.name) }
}
export async function corrupt(kind: 'null' | 'false' | 'wrong-key' | 'cross-account' | 'cross-grant') {
  const name = await mlsRoomLinkDatabase(identity.pubkey)
  if (kind === 'null' || kind === 'false') {
    // records has a key path, so put an object with a falsy retained key slot.
    const previous = await record(name)
    const db = await database(name)
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(kind === 'null' ? null : false, 'device'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
    db.close(); return previous.record?.ciphertext ? [...new Uint8Array(previous.record.ciphertext)] : null
  }
  const original = await record(name)
  if (kind === 'wrong-key') await save(name, { key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt','decrypt']) }, original.record)
  if (kind === 'cross-account') { activeIdentity = { ...identity, pubkey: '66'.repeat(32) }; await save(await mlsRoomLinkDatabase(activeIdentity.pubkey), original.key, original.record) }
  if (kind === 'cross-grant') {
    const plain = new TextEncoder().encode(JSON.stringify({ account: identity.pubkey, seed: base64.encode(new Uint8Array(32).fill(9)), relays: ['wss://fixture.invalid/link'], routes: [] }))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('kithmoot.vmls-grant-link.v1') }, original.key.key, plain)
    await save(name, original.key, { key: 'active', version: 1, nonce: nonce.buffer, ciphertext })
  }
  return (await inspect()).cipher
}
export async function roomOwnerQuiet(privacy: 'quiet' | 'tor-only') {
  const owner = new BrowserMlsRoomDevelopmentOwner(() => ({ persona: identity.pubkey, identity, authority: { owner: identity, signEvent: identity.signEvent }, generation: '0', mode: privacy }))
  try { await owner.pair(code(), ['wss://fixture.invalid/link']); return true } catch { return false }
}
export function concreteSavedRoutes() {
  const owner = new BrowserMlsRoomDevelopmentOwner(() => ({ persona: identity.pubkey, identity, authority: { owner: identity, signEvent: identity.signEvent }, generation: '0', mode: 'normal' }))
  return owner.routes()
}
export async function seedGrantSentinel() {
  // Read-only room operations must leave even legacy grant custody unchanged.
  const db = await database('kithmoot-vmls-grants-v1')
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('records','readwrite'); tx.objectStore('records').put({ key: 'active', version: 1, sentinel: 'legacy-untouched' }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) }); db.close()
}
export async function grantSentinel() { return (await record('kithmoot-vmls-grants-v1')).record }
export function forgetGuard() { return withMlsRoomLinkForgetGuard(async () => { await hold('forget') }) }
export async function corruptNames(kind: 'null' | 'missing' | 'extractable' | 'replacement') {
  const name = await mlsRoomLinkDatabase(identity.pubkey), retained = await record(name)
  const open = indexedDB.open(MLS_ROOM_LINK_NAMES)
  const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  const saved = await new Promise<any>((resolve, reject) => { const read = db.transaction('keys','readonly').objectStore('keys').get('names'); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
  const value = ['extractable','replacement'].includes(kind)
    ? { ...saved, key: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, kind === 'extractable', ['sign']) } : null
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys','readwrite')
    if (kind === 'missing') tx.objectStore('keys').delete('names')
    else tx.objectStore('keys').put(value, 'names')
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  })
  db.close()
  return { name, cipher: [...new Uint8Array(retained.record.ciphertext)], databases: (await indexedDB.databases()).map(db => db.name).sort() }
}
export async function retained(name: string) { return [...new Uint8Array((await record(name)).record.ciphertext)] }
export function transition(kind: 'one' | 'unchanged' | 'changed-seed' | 'changed-account' | 'multiple' | 'drop') {
  return foreground.run(identity.pubkey, () => live, async () => {
    try {
      await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link'])
      const vault = new BrowserMlsRoomLinkVault(foreground, endpoint), state = (await vault.read())!
      try {
        if (kind === 'drop') state.routes = []
        if (['one','multiple','changed-seed','changed-account'].includes(kind)) state.routes.push({ routeId: 'fixture-1', card: card.slice(), pairedRouteSecret: new Uint8Array(32).fill(51), cardSerial: 1n, cardVerifiedAt: 1n })
        if (kind === 'multiple') state.routes.push({ ...state.routes.at(-1)!, routeId: 'fixture-2' })
        if (kind === 'changed-seed') state.transportSeed.fill(7)
        if (kind === 'changed-account') state.account = '66'.repeat(32)
        await vault.write(state)
        return null
      } finally { wipeLinkState(state) }
    } finally { await endpoint.stop() }
  })
}
