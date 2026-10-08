import { base64 } from '@scure/base'
import { BrowserRendezvousVaultStorage, type RendezvousVaultStorage } from './rendezvous-vault.js'
import { linkEventUrl, linkRelays } from './browser-link-pairing.js'
import type { LinkConfig, LinkRoute } from './browser-link-types.js'

export interface LinkState extends LinkConfig { account: string }
export interface LinkVault { read(): Promise<LinkState | undefined>; write(state: LinkState): Promise<void>; clear?(): Promise<void> }
const aad = new TextEncoder().encode('kithmoot.browser-link.v1')

/** All callers hold the browser-link ownership Web Lock, including key
 * creation. One opaque encrypted record contains account, seed and routes. */
export class BrowserLinkVault implements LinkVault {
  constructor(private storage: RendezvousVaultStorage = new BrowserRendezvousVaultStorage('kithmoot-browser-link-v1')) {}
  async clear(): Promise<void> { await this.storage.remove() }
  async read(): Promise<LinkState | undefined> {
    const record = await this.storage.record()
    if (!record) return undefined
    const key = await this.storage.key()
    if (!key || record.version !== 1 || record.nonce.byteLength !== 12 || record.ciphertext.byteLength > 256 * 1024) throw new Error('Bothy connection storage is invalid.')
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: aad }, key, record.ciphertext))
    try {
      const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const state: LinkState = { account: v.account, transportSeed: base64.decode(v.seed), relayUrls: v.relays, routes: v.routes.map((r: Record<string, string>) => ({
        routeId: r.routeId, card: base64.decode(r.card), pairedRouteSecret: base64.decode(r.secret),
        cardSerial: BigInt(r.serial), cardVerifiedAt: BigInt(r.verified),
      })) }
      try { validate(state); return state } catch (e) { wipeLinkState(state); throw e }
    } finally { bytes.fill(0) }
  }
  async write(state: LinkState): Promise<void> {
    validate(state)
    let key = await this.storage.key()
    if (!key) { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await this.storage.saveKey(key) }
    const bytes = new TextEncoder().encode(JSON.stringify({ account: state.account, seed: base64.encode(state.transportSeed), relays: state.relayUrls,
      routes: state.routes.map(r => ({ routeId: r.routeId, card: base64.encode(r.card), secret: base64.encode(r.pairedRouteSecret), serial: String(r.cardSerial), verified: String(r.cardVerifiedAt) })) }))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    try {
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, bytes)
      await this.storage.put({ key: 'active', version: 1, nonce: nonce.buffer, ciphertext })
    } finally { bytes.fill(0) }
  }
}
function validate(state: LinkState): void {
  if (!/^[0-9a-f]{64}$/.test(state.account) || state.transportSeed.length !== 32 || !Array.isArray(state.routes) || state.routes.length > 16) throw new Error('Invalid Bothy connection storage.')
  linkRelays(state.relayUrls)
  const seen = new Set<string>()
  for (const r of state.routes) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(r.routeId) || seen.has(r.routeId) || r.pairedRouteSecret.length !== 32 || r.cardSerial < 0n || r.cardSerial > 0xffffffffffffffffn || r.cardVerifiedAt < 0n || r.cardVerifiedAt > 0xffffffffffffffffn) throw new Error('Invalid Bothy route storage.')
    linkEventUrl(r.card); seen.add(r.routeId)
  }
}
export function wipeRoute(route: LinkRoute): void { route.pairedRouteSecret.fill(0) }
export function wipeLinkState(state: LinkState): void { state.transportSeed.fill(0); state.routes.forEach(wipeRoute) }
