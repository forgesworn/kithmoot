import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import { BrowserRendezvousVaultStorage, type RendezvousVaultStorage } from './rendezvous-vault.js'
import type { PairedBox } from './browser-link.js'

export const ROOM_READ_KINDS = [1460, 1462, 20461] as const
export const ROOM_WRITE_KINDS = [1460, 20461] as const
export const ROOM_GRANT_TERM = 30 * 86400
export interface RoomGrant { active: Event; revoked: Event }
export interface RoomConsent {
  account: string
  room: string
  box: PairedBox
  device: string
  scopes: string[]
  aliases: string[]
  expires: number
  phase: 'installing' | 'active' | 'renewing' | 'withdrawing' | 'retired'
  grants: RoomGrant[]
}
export const consentKey = (c: Pick<RoomConsent, 'account' | 'room'>): string => `${c.account}/${c.room}`
const hex = /^[0-9a-f]{64}$/
const aad = new TextEncoder().encode('kithmoot.browser-room-consent.v1')
const lockName = 'kithmoot.browser-room-consent.v1'

/** Exact signed authority is retained before a single grant is sent. The
 * vault is separate from pairing so forgetting a connection cannot erase
 * the only revocation record. Every read/modify/write holds the same lock. */
export class BrowserRoomConsents {
  constructor(private storage: RendezvousVaultStorage = new BrowserRendezvousVaultStorage('kithmoot-browser-room-consent-v1'),
    private exclusive: <T>(work: () => Promise<T>) => Promise<T> = async work => navigator.locks ? await navigator.locks.request(lockName, work) : await work()) {}
  all(): Promise<RoomConsent[]> { return this.exclusive(() => this.#read()) }
  async put(consent: RoomConsent): Promise<void> {
    validateConsent(consent)
    const copy = structuredClone(consent)
    await this.exclusive(async () => {
      const entries = (await this.#read()).filter(c => consentKey(c) !== consentKey(copy))
      entries.push(copy)
      if (entries.length > 100) throw new Error('Too many saved Bothy room permissions.')
      let key = await this.storage.key()
      if (!key) { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await this.storage.saveKey(key) }
      const bytes = new TextEncoder().encode(JSON.stringify(entries))
      try {
        if (bytes.length > 512 * 1024) throw new Error('Bothy room permissions are full.')
        const nonce = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, bytes)
        await this.storage.put({ key: 'active', version: 1, nonce: nonce.buffer, ciphertext })
      } finally { bytes.fill(0) }
    })
  }
  async #read(): Promise<RoomConsent[]> {
    const record = await this.storage.record()
    if (!record) return []
    const key = await this.storage.key()
    if (!key || record.version !== 1 || record.nonce.byteLength !== 12 || record.ciphertext.byteLength > 512 * 1024 + 16) throw new Error('Bothy room permissions could not be opened.')
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: aad }, key, record.ciphertext))
    try {
      const entries: RoomConsent[] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!Array.isArray(entries) || entries.length > 100 || new Set(entries.map(consentKey)).size !== entries.length) throw new Error('Invalid Bothy room permissions.')
      entries.forEach(validateConsent)
      return entries
    } finally { bytes.fill(0) }
  }
}

function terms(event: Event): string[][] { return event.tags.filter(t => t[0] !== 'status') }
export function validateConsent(c: RoomConsent): void {
  if (!c || !hex.test(c.account) || !hex.test(c.room) || !hex.test(c.device) || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.box?.routeId) || !/^ws:\/\/[a-z2-7]{52}\/events$/.test(c.box?.eventUrl) || !Number.isSafeInteger(c.expires) || c.expires <= 0 || !['installing','active','renewing','withdrawing','retired'].includes(c.phase) || !Array.isArray(c.grants) || c.grants.length > 16 || !Array.isArray(c.scopes) || c.scopes.length < 1 || c.scopes.length > 8 || !c.scopes.includes(c.room) || c.scopes.some(s => !hex.test(s)) || new Set(c.scopes).size !== c.scopes.length || !Array.isArray(c.aliases) || c.aliases.length > 4 || c.aliases.some(s => !/^lookup:[0-9a-f]{64}$/.test(s))) throw new Error('Invalid Bothy room permission.')
  const seen = new Set<string>()
  for (const plan of c.grants) {
    for (const [event, status] of [[plan.active, 'active'], [plan.revoked, 'revoked']] as const) {
      if (!verifyEventUncached(event) || event.kind !== 24242 || event.pubkey !== c.account || event.content !== '') throw new Error('Invalid signed room grant.')
      const one = (key: string): string | undefined => { const values = event.tags.filter(t => t[0] === key); return values.length === 1 && values[0].length === 2 ? values[0][1] : undefined }
      if (one('t') !== 'event-grant' || one('server') !== c.box.eventUrl || !c.scopes.includes(one('d') ?? '') || one('status') !== status || !hex.test(one('p') ?? '') || !hex.test(one('device') ?? '') || !/^[0-9a-f]{32}$/.test(one('grant') ?? '') || (status === 'active' || !['withdrawing','retired'].includes(c.phase) ? one('expiration') !== String(c.expires) : !Number.isSafeInteger(Number(one('expiration'))) || Number(one('expiration')) < c.expires)) throw new Error('Room grant does not match its saved consent.')
      const allowed = ['t','server','d','p','device','grant','read','write','expiration','status']
      if (event.tags.some(t => t.length !== 2 || !allowed.includes(t[0])) || JSON.stringify(event.tags.filter(t => t[0] === 'read').map(t => t[1])) !== JSON.stringify(ROOM_READ_KINDS.map(String)) || JSON.stringify(event.tags.filter(t => t[0] === 'write').map(t => t[1])) !== JSON.stringify(ROOM_WRITE_KINDS.map(String))) throw new Error('Invalid room grant kinds.')
    }
    if (plan.revoked.created_at <= plan.active.created_at || JSON.stringify(terms(plan.active).filter(t => t[0] !== 'expiration')) !== JSON.stringify(terms(plan.revoked).filter(t => t[0] !== 'expiration'))) throw new Error('Grant withdrawal does not match activation.')
    const scope = plan.active.tags.filter(t => t[0] === 'd' || t[0] === 'p' || t[0] === 'device').map(t => t[1]).join('/')
    if (seen.has(scope)) throw new Error('Duplicate room grant scope.')
    seen.add(scope)
  }
}

export async function planRoomGrants(identity: ParticipantIdentity, box: PairedBox, room: string,
  devices: { persona: string; device: string }[], now: number, previous: RoomGrant[] = []): Promise<{ grants: RoomGrant[]; expires: number }> {
  if (!hex.test(room) || !devices.length || devices.length > 16 || devices.some(d => !hex.test(d.persona) || !hex.test(d.device))) throw new Error('Choose current room devices before granting access.')
  const expires = Math.max(now + ROOM_GRANT_TERM, ...previous.map(p => Number(p.active.tags.find(t => t[0] === 'expiration')?.[1]) + 1))
  const grants: RoomGrant[] = []
  for (const d of devices) {
    const old = previous.find(p => p.active.tags.some(t => t[0] === 'p' && t[1] === d.persona) && p.active.tags.some(t => t[0] === 'device' && t[1] === d.device))
    const at = Math.max(now, (old?.revoked.created_at ?? 0) + 1)
    if (at > now + 60) throw new Error('Wait a minute before changing these grants again.')
    const id = old?.active.tags.find(t => t[0] === 'grant')?.[1] ?? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
    const tags = [['t','event-grant'], ['server',box.eventUrl], ['d',room], ['p',d.persona], ['device',d.device], ['grant',id],
      ...ROOM_READ_KINDS.map(k => ['read',String(k)]), ...ROOM_WRITE_KINDS.map(k => ['write',String(k)]), ['expiration',String(expires)]]
    const sign = async (status: string, created_at: number) => {
      const template: EventTemplate = { kind: 24242, content: '', created_at, tags: [...tags, ['status',status]] }
      const event = await identity.signEvent(structuredClone(template))
      if (!verifyEventUncached(event) || event.pubkey !== identity.pubkey || event.kind !== template.kind || event.content !== '' || event.created_at !== created_at || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) throw new Error('The signer changed the requested room grant.')
      return event
    }
    // Withdrawal is obtained first. Refusal can never leave a published
    // active grant without its exact signed withdrawal material.
    const revoked = await sign('revoked', at + 1)
    grants.push({ active: await sign('active', at), revoked })
  }
  return { grants, expires }
}
