import { base64, base64urlnopad } from '@scure/base'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsGrantForeground } from '../app/src/mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from '../app/src/mls-grant-endpoint.js'
import { BrowserMlsGrantLinkVault, MLS_GRANT_LINK_OWNER } from '../app/src/mls-grant-link-vault.js'
import { planMlsGrant } from '../app/src/mls-grant-ledger.js'
import type { LinkEngine, LinkRoute, LinkListener, LinkSocket } from '../app/src/browser-link-types.js'

/** Real IDB, WebCrypto, Web Locks, signing and NIP-42 adapter; the native
 * engine seam controls late promises and frames, not a live Bothy outcome. */
const foreground = new BrowserMlsGrantForeground()
const secret = new Uint8Array(32).fill(31)
const identity = { pubkey: getPublicKey(secret), signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => {
  if (template.kind === 22242) { signers++; await hold('signer') }
  return finalizeEvent(template, secret)
} }
let mode = 'normal', stage = '', reached = false, release: (() => void) | undefined
let starts = 0, stops = 0, signers = 0, publications = 0, sockets = 0, requests = 0, pairs = 0
let failedStop = false
let activeIdentity = identity, disconnects = 0
let nativeListener: LinkListener | undefined, heldSocket: LinkSocket | undefined
let seed: number[] | undefined
async function hold(at: string) { if (stage === at) { reached = true; await new Promise<void>(resolve => { release = resolve }) } }
const card = new Uint8Array(126); card.set(new TextEncoder().encode('FSL1')); card[4] = 1; card.fill(32, 5, 37)
const code = () => 'bothy:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, bothy: '20'.repeat(32), secret: '44'.repeat(16), role: 'box', name: 'Fixture', exp: Math.floor(Date.now() / 1000) + 300, card: base64.encode(card) })))
const endpoint = new BrowserMlsGrantEndpoint(foreground, () => activeIdentity, () => mode === 'normal', async config => {
  starts++; seed = [...config.transportSeed]; await hold('start')
  const engine: LinkEngine = {
    pairRoute: async bundle => { pairs++; await hold('pair'); return { routeId: bundle.routeId, card: card.slice(), pairedRouteSecret: new Uint8Array(32).fill(41), cardSerial: 1n, cardVerifiedAt: 1n } satisfies LinkRoute },
    request: async () => { requests++; await hold('request'); return { status: 200, body: new Uint8Array(), witnessRefused: false, path: { status: 'relay', relay: 'wss://fixture.invalid/', direct: null, cause: 'fixture' } } },
    openSocket: async (_url, _route, listener) => {
      nativeListener = listener
      sockets++; await hold('socket')
      let closed = false
      setTimeout(() => { if (!closed) listener.onText?.(JSON.stringify(['AUTH','fixture-challenge'])) }, 0)
      return { sendText: raw => {
        const frame = JSON.parse(raw)
        if (frame[0] === 'AUTH') listener.onText?.(JSON.stringify(['OK',frame[1].id,true,'']))
        if (frame[0] === 'EVENT') { publications++; listener.onText?.(JSON.stringify(['OK',frame[1].id,true,''])) }
      }, disconnect: () => { if (!closed) { closed = true; disconnects++; listener.onClosed?.('Fixture socket closed') } },
      path: () => ({ status: 'relay', relay: 'wss://fixture.invalid/', direct: null, cause: 'fixture' }) }
    },
    removeRoute: async () => {}, retireRoute: async () => {}, finalizeRoute: async () => {},
    stop: async () => { stops++; await hold('stop'); if (failedStop) throw new Error('Fixture stop failed') },
  }
  return engine
})
export function configure(at = '', privacy = 'normal', fail = false) { stage = at; mode = privacy; reached = false; failedStop = fail }
export function releaseWork() { release?.() }
export function status() { return { occupied: !!foreground.capture(), reached, starts, stops, signers, publications, sockets, requests, pairs, disconnects, seed } }
export function invalidate() { foreground.invalidate(); void endpoint.stop().catch(() => {}) }
export function settled() { return foreground.settled() }
export async function workflow(action: 'setup' | 'resume' | 'request' | 'publish' | 'pair' = 'resume') {
  return foreground.run(() => true, new AbortController().signal, async () => {
    try {
      await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link'])
      if (action === 'setup' || action === 'pair') return await endpoint.pair(code())
      const box = endpoint.boxes()[0]
      if (action === 'request') return await endpoint.request({ routeId: box.routeId, method: 'GET', path: '/health', authorization: '', body: new Uint8Array() })
      if (action === 'publish') {
        const record = await planMlsGrant(identity, box, '22'.repeat(32), '33'.repeat(32), { session: '44'.repeat(32), leaf: '55'.repeat(32), name: 'Fixture room' }, Math.floor(Date.now() / 1000))
        const carrier = endpoint.carrier(record, identity)
        try { await carrier.publish(record.active) } finally { carrier.close() }
      }
      return box ?? null
    } finally { await endpoint.stop() }
  })
}
export async function unprepared() {
  try { await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link']); return true } catch { return false }
}
export async function saved() {
  return foreground.run(() => true, new AbortController().signal, async () => {
    try { return await endpoint.pairedBoxes(identity.pubkey) } finally { await endpoint.stop() }
  })
}
export async function inspect() {
  const open = indexedDB.open(MLS_GRANT_LINK_OWNER)
  const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  try {
    const read = (store: string, key: string) => new Promise<any>((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const [key, record] = await Promise.all([read('keys','device'),read('records','active')])
    return { version: db.version, key: !!key, extractable: key?.key?.extractable, record: !!record,
      cipher: record ? [...new Uint8Array(record.ciphertext)] : null }
  } finally { db.close() }
}
export function holdEncryption() {
  const original = crypto.subtle.encrypt.bind(crypto.subtle)
  crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => {
    crypto.subtle.encrypt = original
    const result = await original(...args); stage = 'encrypt'; await hold('encrypt'); return result
  }
}
export async function vaultWrite() {
  return workflow('resume')
}
export function outsideOwnershipWrite(fake = false) {
  return foreground.run(() => true, new AbortController().signal, async () => {
    const vault = new BrowserMlsGrantLinkVault(foreground, fake ? { ownsScope: () => true } as any : endpoint)
    await vault.write({ account: identity.pubkey, transportSeed: new Uint8Array(32).fill(12), relayUrls: ['wss://fixture.invalid/link'], routes: [] })
  })
}
export function stopRace() {
  return foreground.run(() => true, new AbortController().signal, async () => {
    await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link'])
    return endpoint.stop()
  })
}
export function stopAgain() { return endpoint.stop() }
export async function duringStop(method: 'resume' | 'pair' | 'request' | 'socket' | 'carrier') {
  const box = { routeId: 'invalid', eventUrl: 'ws://fixture.invalid/events' }
  try {
    if (method === 'resume') await endpoint.resume(identity.pubkey)
    if (method === 'pair') await endpoint.pair(code())
    if (method === 'request') await endpoint.request({ routeId: box.routeId, method: 'GET', path: '/health', authorization: '', body: new Uint8Array() })
    if (method === 'socket') await endpoint.openSocket(box.eventUrl, box.routeId, {})
    if (method === 'carrier') endpoint.carrier({ issuer: identity.pubkey } as any, identity)
    return true
  } catch { return false }
}
export function socketHold() {
  return foreground.run(() => true, new AbortController().signal, async () => {
    try {
      await endpoint.resume(identity.pubkey)
      const box = endpoint.boxes()[0]
      heldSocket = await endpoint.openSocket(box.eventUrl, box.routeId, {})
      await hold('owner')
      return null
    } finally { await endpoint.stop() }
  })
}
export function staleSocketAction(method: 'text' | 'send' | 'path', account: boolean) {
  if (account) activeIdentity = { ...identity, pubkey: '66'.repeat(32) }
  else mode = 'quiet'
  try {
    if (method === 'text') nativeListener?.onText?.('late text')
    if (method === 'send') heldSocket!.sendText('late send')
    if (method === 'path') heldSocket!.path()
  } catch {}
}
export function failNextSeedWrite(store: 'keys' | 'records') {
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === store) { IDBObjectStore.prototype.put = original; throw new DOMException('Fixture quota failure', 'QuotaExceededError') }
    return key === undefined ? original.call(this, value) : original.call(this, value, key)
  }
}
export async function malformedKey(value: 'null' | 'false' | 'undefined') {
  const open = indexedDB.open(MLS_GRANT_LINK_OWNER)
  const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite')
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
      transaction.objectStore('keys').put({ null: null, false: false, undefined: undefined }[value], 'device')
    })
  } finally { db.close() }
}
export async function keySlot() {
  const open = indexedDB.open(MLS_GRANT_LINK_OWNER)
  const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  try {
    const read = (operation: IDBRequest<any>) => new Promise<any>((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error) })
    const keys = db.transaction('keys', 'readonly').objectStore('keys')
    const [present, value] = await Promise.all([read(keys.getKey('device')), read(keys.get('device'))])
    return { present: present !== undefined, value: value === undefined ? 'undefined' : value }
  } finally { db.close() }
}
export function replaceSigner() { activeIdentity = { ...identity, signEvent: template => identity.signEvent(template) } }
export function retiredScope() {
  return foreground.run(() => true, new AbortController().signal, async () => {
    await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link'])
    await endpoint.stop()
    return Promise.all(['resume','pair','request','socket','carrier'].map(method => duringStop(method as any)))
  })
}
export function transition(kind: 'initial-routes' | 'unchanged' | 'multiple' | 'one' | 'changed-seed' | 'corrupt') {
  return foreground.run(() => true, new AbortController().signal, async () => {
    try {
      await endpoint.resume(identity.pubkey, ['wss://fixture.invalid/link'])
      const vault = new BrowserMlsGrantLinkVault(foreground, endpoint)
      const state = (await vault.read())!
      try {
        const route = (index: number): LinkRoute => ({ routeId: `fixture-${index}`, card: card.slice(), pairedRouteSecret: new Uint8Array(32).fill(index), cardSerial: 1n, cardVerifiedAt: 1n })
        if (kind === 'initial-routes' || kind === 'corrupt') {
          const open = indexedDB.open(MLS_GRANT_LINK_OWNER)
          const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records')
              tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
              if (kind === 'initial-routes') store.delete('active')
              else store.put({ key: 'active', version: 1, nonce: new Uint8Array(12).buffer, ciphertext: new Uint8Array(16).buffer })
            })
          } finally { db.close() }
        }
        if (kind !== 'unchanged') state.routes.push(route(1))
        if (kind === 'multiple') state.routes.push(route(2))
        if (kind === 'changed-seed') state.transportSeed.fill(7)
        await vault.write(state)
        return null
      } finally { state.transportSeed.fill(0); state.routes.forEach(route => route.pairedRouteSecret.fill(0)) }
    } finally { await endpoint.stop() }
  })
}
