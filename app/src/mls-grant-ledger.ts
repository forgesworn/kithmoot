import { base32nopad } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { VmlsGrantRef } from '../public/vmls-wasm/vmls_wasm.js'
import { BrowserLinkRelay } from './browser-link-relay.js'
import type { BrowserLink, PairedBox } from './browser-link.js'
import { BrowserRendezvousVaultStorage, type RendezvousVaultStorage } from './rendezvous-vault.js'
import type { MlsKeeperGrantAuthority } from './mls-revocation-decision-store.js'
import { BrowserMlsKeeperAdmission } from './mls-keeper-admission.js'

export const VMLS_GRANT_TERM = 30 * 86400
export const VMLS_GRANT_CEILING = 64 * 1024 * 1024
export const VMLS_REMOVAL_GRACE = 24 * 60 * 60
const aad = new TextEncoder().encode('kithmoot.vmls-grant-ledger.v1')
const scopeLabel = new TextEncoder().encode('VMLS/1 box grant')
const refLabel = new TextEncoder().encode('kithmoot/vmls-removal-grant/v1')
const snapshotLabel = new TextEncoder().encode('kithmoot/vmls-keeper-grant-snapshot/v1')
const hex32 = /^[0-9a-f]{64}$/
const hex16 = /^[0-9a-f]{32}$/
const exact = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys

export interface MlsGrantRecord {
  version: 1
  box: PairedBox
  node: string
  issuer: string
  persona: string
  device: string
  grantId: string
  expiration: number
  rooms: MlsGrantRoom[]
  revokeAfter: number | null
  state: 'installing' | 'active' | 'revoking' | 'revoked'
  active: Event
  revocation: Event
}
export interface MlsGrantRoom { session: string; name: string; leaf: string }
export interface MlsGrantWithdrawal { record: MlsGrantRecord; result: 'retained' | 'grace' | 'revoked' }

export const mlsGrantScope = (device: string): string => bytesToHex(sha256(concatBytes(scopeLabel, hexToBytes(device))))
export const mlsGrantReference = (node: string, grantId: string): string => bytesToHex(sha256(concatBytes(refLabel, hexToBytes(node), hexToBytes(grantId))))
/** Exact local record identity for a witnessed lapse; never remote revocation proof. */
export function mlsKeeperGrantRecordDigest(record: MlsGrantRecord): string {
  validateMlsGrant(record)
  return bytesToHex(sha256(concatBytes(snapshotLabel, new TextEncoder().encode(JSON.stringify(record)))))
}
export function mlsBoxNode(box: PairedBox): string {
  let bytes: Uint8Array
  try {
    const url = new URL(box.eventUrl)
    if (url.protocol !== 'ws:' || url.pathname !== '/events' || url.port || url.username || url.password || url.search || url.hash) throw new Error()
    bytes = base32nopad.decode(url.hostname.toUpperCase())
  } catch { throw new Error('The paired Bothy address has no canonical node key.') }
  if (bytes.length !== 32) throw new Error('The paired Bothy address has no canonical node key.')
  return bytesToHex(bytes)
}

function terms(record: MlsGrantRecord, status: 'active' | 'revoked'): string[][] {
  return [['t','event-grant'], ['server',record.box.eventUrl], ['d',mlsGrantScope(record.device)], ['p',record.persona],
    ['device',record.device], ['grant',record.grantId], ['read','1460'], ['expiration',String(record.expiration)],
    ['vmls',String(VMLS_GRANT_CEILING)], ['status',status]]
}
function validateEvent(record: MlsGrantRecord, event: Event, status: 'active' | 'revoked'): void {
  if (!verifyEventUncached(event) || event.pubkey !== record.issuer || event.kind !== 24242 || event.content !== '' ||
      JSON.stringify(event.tags) !== JSON.stringify(terms(record, status))) throw new Error('Invalid saved VMLS grant.')
}
export function validateMlsGrant(record: MlsGrantRecord): void {
  if (!record || typeof record !== 'object' || !exact(record, 'active,box,device,expiration,grantId,issuer,node,persona,revocation,revokeAfter,rooms,state,version') ||
      record.version !== 1 || !record.box || !exact(record.box, 'eventUrl,routeId') || !/^[A-Za-z0-9._:-]{1,128}$/.test(record.box.routeId) ||
      !hex32.test(record.node) || record.node !== mlsBoxNode(record.box) || !hex32.test(record.issuer) || !hex32.test(record.persona) ||
      !hex32.test(record.device) || !hex16.test(record.grantId) || !Number.isSafeInteger(record.expiration) || record.expiration <= 0 ||
      !Array.isArray(record.rooms) || record.rooms.length > 64 || new Set(record.rooms.map(room => room.session)).size !== record.rooms.length ||
      record.rooms.some(room => !room || !exact(room, 'leaf,name,session') || !hex32.test(room.session) || !hex32.test(room.leaf) || typeof room.name !== 'string' || room.name.length < 1 || room.name.length > 120 || /[\u0000-\u001f\u007f]/.test(room.name)) ||
      record.rooms.some((room, index) => index > 0 && record.rooms[index - 1].session >= room.session) ||
      record.revokeAfter !== null && (!Number.isSafeInteger(record.revokeAfter) || record.revokeAfter <= 0) ||
      record.rooms.length > 0 && record.revokeAfter !== null ||
      !['installing','active','revoking','revoked'].includes(record.state)) throw new Error('Invalid saved VMLS grant.')
  validateEvent(record, record.active, 'active'); validateEvent(record, record.revocation, 'revoked')
  if (record.revocation.created_at <= record.active.created_at) throw new Error('Invalid saved VMLS grant.')
}

/** Encrypted, account-independent custody of exact active and withdrawal
 * statements. It deliberately outlives one MLS session and room record. */
export class BrowserMlsGrantStore {
  constructor(private storage: RendezvousVaultStorage = new BrowserRendezvousVaultStorage('kithmoot-vmls-grants-v1'),
    private exclusive: <T>(work: () => Promise<T>) => Promise<T> = async work => navigator.locks.request('kithmoot-vmls-grants-v1', work)) {}
  all(): Promise<MlsGrantRecord[]> { return this.exclusive(() => this.#read()) }
  async put(record: MlsGrantRecord): Promise<void> {
    validateMlsGrant(record); const copy = structuredClone(record)
    await this.exclusive(async () => {
      const records = (await this.#read()).filter(item => item.node !== copy.node || item.device !== copy.device)
      records.push(copy)
      if (records.length > 256) throw new Error('The VMLS grant ledger is full.')
      let key = await this.storage.key()
      if (!key) { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']); await this.storage.saveKey(key) }
      const bytes = new TextEncoder().encode(JSON.stringify(records))
      try {
        if (bytes.length > 2 * 1024 * 1024) throw new Error('The VMLS grant ledger is full.')
        const nonce = crypto.getRandomValues(new Uint8Array(12))
        await this.storage.put({ key: 'active', version: 1, nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, bytes) })
      } finally { bytes.fill(0) }
    })
  }
  async #read(): Promise<MlsGrantRecord[]> {
    const encrypted = await this.storage.record()
    if (!encrypted) return []
    const key = await this.storage.key()
    if (!key || encrypted.version !== 1 || encrypted.nonce.byteLength !== 12 || encrypted.ciphertext.byteLength > 2 * 1024 * 1024 + 16) throw new Error('The VMLS grant ledger could not be opened.')
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.nonce, additionalData: aad }, key, encrypted.ciphertext))
    try {
      const records: MlsGrantRecord[] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!Array.isArray(records) || records.length > 256 || new Set(records.map(item => `${item.node}/${item.device}`)).size !== records.length) throw new Error('Invalid VMLS grant ledger.')
      records.forEach(validateMlsGrant); return records
    } finally { bytes.fill(0) }
  }
}

export async function planMlsGrant(identity: ParticipantIdentity, box: PairedBox, persona: string, device: string, room: MlsGrantRoom,
  boxNow: number, previous?: MlsGrantRecord, phoneNow = boxNow): Promise<MlsGrantRecord> {
  const node = mlsBoxNode(box)
  if (!hex32.test(persona) || !hex32.test(device) || !room || !hex32.test(room.session) || !hex32.test(room.leaf) || typeof room.name !== 'string' || room.name.length < 1 || room.name.length > 120 || /[\u0000-\u001f\u007f]/.test(room.name) || !Number.isSafeInteger(boxNow) || !Number.isSafeInteger(phoneNow)) throw new Error('Invalid VMLS grant request.')
  if (previous?.state === 'revoking') throw new Error('Finish revoking this VMLS grant before renewing it.')
  const keep = previous && previous.node === node && previous.device === device && previous.state !== 'revoked' && previous.expiration > Math.min(boxNow, phoneNow) ? previous : undefined
  if (keep && (keep.issuer !== identity.pubkey || keep.persona !== persona || keep.box.routeId !== box.routeId || keep.box.eventUrl !== box.eventUrl)) throw new Error('That VMLS device already has different saved authority.')
  const grantId = keep?.grantId ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const expiration = Math.max(boxNow + VMLS_GRANT_TERM, keep?.expiration ?? 0)
  // A revoked grant id is terminal, but its replacement still shares the
  // device scope. It must sort after that tombstone at the box.
  const createdAt = Math.max(boxNow, (previous?.revocation.created_at ?? 0) + 1)
  if (createdAt > boxNow + 60) throw new Error('Wait a minute before changing this VMLS grant again.')
  const rooms = [...(previous?.state === 'revoked' ? [] : previous?.rooms ?? []).filter(saved => saved.session !== room.session), { ...room }].sort((a, b) => a.session.localeCompare(b.session))
  const unsigned: Omit<MlsGrantRecord, 'active' | 'revocation'> = { version: 1, box: { ...box }, node, issuer: identity.pubkey, persona, device, grantId, expiration, rooms, revokeAfter: null, state: 'installing' }
  const sign = async (status: 'active' | 'revoked', created_at: number): Promise<Event> => {
    const template: EventTemplate = { kind: 24242, content: '', created_at, tags: terms(unsigned as MlsGrantRecord, status) }
    const event = await identity.signEvent(structuredClone(template))
    if (!verifyEventUncached(event) || event.pubkey !== identity.pubkey || event.kind !== template.kind || event.created_at !== template.created_at || event.content !== '' || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) throw new Error('The signer changed the requested VMLS grant.')
    return event
  }
  const revocation = await sign('revoked', createdAt + 1)
  const active = await sign('active', createdAt)
  const record: MlsGrantRecord = { ...unsigned, active, revocation }
  validateMlsGrant(record); return record
}

type Store = Pick<BrowserMlsGrantStore, 'all' | 'put'>
type Carrier = (record: MlsGrantRecord, identity: ParticipantIdentity) => { publish(event: Event): Promise<void>; close(): void }
export type MlsGrantInstallationGate = <T>(device: string, mode: 'shared' | 'exclusive', work: () => Promise<T>) => Promise<T>

/** Installs and withdraws exact VMLS device grants over an authenticated Link
 * route. State moves before network I/O, so uncertain replies retry the same
 * signed event and can never lose the withdrawal material. */
export class BrowserMlsGrantLedger {
  constructor(private identity: () => ParticipantIdentity | undefined, private link: Pick<BrowserLink, 'resume' | 'boxes' | 'openSocket' | 'pairedBoxes'>,
    readonly store: Store = new BrowserMlsGrantStore(),
    private carrier: Carrier = (record, identity) => new BrowserLinkRelay(link, record.box, identity, { room: mlsGrantScope(record.device), kinds: [24242] }),
    private now: () => number = () => Math.floor(Date.now() / 1000),
    private exclusive: <T>(key: string, work: () => Promise<T>) => Promise<T> = async (key, work) => navigator.locks.request(`kithmoot.vmls-grant.${key}`, work),
    private installation: MlsGrantInstallationGate = async (device, mode, work) => navigator.locks.request(`kithmoot.vmls-grant-install.v1.${device}`, { mode }, work),
    private admission?: BrowserMlsKeeperAdmission) {}
  #identity(account?: string): ParticipantIdentity {
    const identity = this.identity()
    if (!identity || account && identity.pubkey !== account) throw new Error('Sign in as this grant’s keeper before changing VMLS access.')
    return identity
  }
  async records(): Promise<MlsGrantRecord[]> { return this.store.all() }
  /** Hold every installation for this device, including a previously unseen
   * node. The callback must await the actual witness settlement; never race
   * it against a timeout that would release this lock while work continues.
   * This is a local concurrency guard, not approval or completion evidence. */
  async withDeviceInstallHold<T>(expectedStore: Pick<BrowserMlsGrantStore, 'all'>, keeper: string, device: string,
    current: () => boolean, work: (current: () => boolean) => Promise<T>): Promise<T> {
    if (expectedStore !== this.store || !hex32.test(keeper) || !hex32.test(device)) throw new Error('The grant-install hold has a different ledger or device binding.')
    const live = () => current() && this.identity()?.pubkey === keeper
    const check = () => { if (!live()) throw new Error('The keeper account or foreground session changed.'); this.#identity(keeper) }
    check()
    return this.installation(device, 'exclusive', async () => {
      check()
      const result = await work(live)
      check()
      return result
    })
  }
  /** Local account-bound pairing evidence only. No endpoint starts here.
   * False means this exact route is absent, never that remote access ended. */
  async available(authority: MlsKeeperGrantAuthority, sender: string, device: string, current: () => boolean): Promise<boolean> {
    const expected = structuredClone(authority), keeper = this.#identity()
    if (!hex32.test(sender) || !hex32.test(device) || sender === keeper.pubkey || !current()) throw new Error('Review this request in the current keeper account.')
    const check = () => { if (!current()) throw new Error('The keeper account or foreground session changed.'); this.#identity(keeper.pubkey) }
    return this.exclusive(`${expected.node}.${device}`, async () => {
      const exactRecord = async () => {
        check()
        const records = await this.store.all()
        if (!Array.isArray(records) || records.length > 256 || new Set(records.map(record => `${record.node}/${record.device}`)).size !== records.length) throw new Error('The keeper grant ledger could not be verified.')
        records.forEach(validateMlsGrant)
        const record = records.find(item => item.node === expected.node && item.device === device)
        if (!record) throw new Error('The approved grant is no longer retained.')
        this.#approvedAuthority(record, expected, keeper.pubkey, sender, device)
        return record
      }
      const before = await exactRecord(), routes = await this.link.pairedBoxes(keeper.pubkey)
      check()
      const after = await exactRecord()
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The approved grant changed while checking its pairing.')
      if (!Array.isArray(routes) || routes.some(route => !route || typeof route.routeId !== 'string' || typeof route.eventUrl !== 'string')) throw new Error('The keeper pairings could not be verified.')
      return routes.some(route => route.routeId === expected.box.routeId && route.eventUrl === expected.box.eventUrl)
    })
  }
  async install(box: PairedBox, persona: string, device: string, room: MlsGrantRoom, boxNow = this.now()): Promise<MlsGrantRecord> {
    const keeper = this.#identity(), node = mlsBoxNode(box)
    if (!hex32.test(device)) throw new Error('Invalid VMLS grant request.')
    // Lock order: device gate, fresh persona admission (released), then
    // node/device and store. Approval uses the device gate exclusively.
    // Shared mode preserves parallel installations at different nodes.
    return this.installation(device, 'shared', async () => {
      this.#identity(keeper.pubkey)
      if (!(this.admission instanceof BrowserMlsKeeperAdmission)) throw new Error('A witnessed keeper admission owner is required before grant installation.')
      const live = await this.admission.admit(keeper.pubkey, persona, device, () => this.identity()?.pubkey === keeper.pubkey)
      const check = () => { this.#identity(keeper.pubkey); if (!live()) throw new Error('The keeper account or foreground session changed.') }
      return this.exclusive(`${node}.${device}`, async () => {
        check()
        let record = (await this.store.all()).find(item => item.node === node && item.device === device)
        check()
        if (record && (record.issuer !== keeper.pubkey || record.persona !== persona || record.box.routeId !== box.routeId || record.box.eventUrl !== box.eventUrl)) {
          throw new Error('That VMLS device already has different saved authority.')
        }
        if (record?.state === 'revoking') throw new Error('Finish revoking this VMLS grant before renewing it.')
        if (!record || record.state === 'revoked' || record.expiration <= Math.min(boxNow, this.now())) {
          record = await planMlsGrant(this.#identity(keeper.pubkey), box, persona, device, room, boxNow, record, this.now())
          check()
          await this.store.put(record)
          check()
        }
        const rooms = [...record.rooms.filter(saved => saved.session !== room.session), { ...room }].sort((a, b) => a.session.localeCompare(b.session))
        if (JSON.stringify(rooms) !== JSON.stringify(record.rooms) || record.revokeAfter !== null) {
          record = { ...record, rooms, revokeAfter: null }; await this.store.put(record)
          check()
        }
        if (record.state === 'active') return record
        await this.#route(record, keeper, record.active, check)
        record = { ...record, state: 'active' }; await this.store.put(record)
        check()
        return record
      })
    })
  }
  async withdraw(node: string, device: string, expectedReference: string, session: string, expectedLeaves: readonly string[], compromised: boolean): Promise<MlsGrantWithdrawal> {
    const keeper = this.#identity()
    if (!hex32.test(session) || !expectedLeaves.length || expectedLeaves.some(leaf => !hex32.test(leaf))) throw new Error('Invalid VMLS grant withdrawal.')
    return this.exclusive(`${node}.${device}`, async () => {
      let record = (await this.store.all()).find(item => item.node === node && item.device === device)
      if (!record || mlsGrantReference(record.node, record.grantId) !== expectedReference) throw new Error('The reviewed VMLS grant changed before withdrawal.')
      if (record.state === 'revoked') return { record, result: 'revoked' }
      if (record.issuer !== keeper.pubkey) throw new Error('This account did not issue that VMLS grant.')
      if (!compromised) {
        const leaves = new Set(expectedLeaves), reviewedUse = record.rooms.some(room => room.session === session && leaves.has(room.leaf))
        if (record.rooms.some(room => room.session === session && !leaves.has(room.leaf))) return { record, result: 'retained' }
        const rooms = reviewedUse ? record.rooms.filter(room => room.session !== session) : record.rooms
        if (rooms.length) {
          if (rooms.length !== record.rooms.length || record.revokeAfter !== null) { record = { ...record, rooms, revokeAfter: null }; await this.store.put(record) }
          return { record, result: 'retained' }
        }
        const revokeAfter = record.revokeAfter ?? this.now() + VMLS_REMOVAL_GRACE
        if (record.rooms.length || record.revokeAfter === null) { record = { ...record, rooms: [], revokeAfter }; await this.store.put(record) }
        if (this.now() < revokeAfter) return { record, result: 'grace' }
      }
      if (record.state !== 'revoking') { record = { ...record, state: 'revoking' }; await this.store.put(record) }
      await this.#route(record, keeper, record.revocation)
      record = { ...record, state: 'revoked' }; await this.store.put(record); return { record, result: 'revoked' }
    })
  }
  /** Exact, already-reviewed device authority. No room leaf or grace is
   * required; the caller must witness explicit operator intent before use. */
  async withdrawRequestedDevice(authority: MlsKeeperGrantAuthority, sender: string, device: string, current: () => boolean): Promise<MlsGrantWithdrawal> {
    const expected = structuredClone(authority), keeper = this.#identity()
    if (!hex32.test(sender) || !hex32.test(device) || sender === keeper.pubkey || !current()) throw new Error('Review this request in the current keeper account.')
    const check = () => { if (!current()) throw new Error('The keeper account or foreground session changed.'); this.#identity(keeper.pubkey) }
    return this.exclusive(`${expected.node}.${device}`, async () => {
      check()
      let record = (await this.store.all()).find(item => item.node === expected.node && item.device === device)
      if (!record) throw new Error('The approved grant is no longer retained.')
      validateMlsGrant(record)
      this.#approvedAuthority(record, expected, keeper.pubkey, sender, device)
      check()
      if (record.state === 'revoked') return { record, result: 'revoked' }
      if (record.state !== 'revoking') { record = { ...record, state: 'revoking' }; await this.store.put(record) }
      check()
      await this.#route(record, keeper, record.revocation, check)
      check()
      record = { ...record, state: 'revoked' }; await this.store.put(record)
      check()
      return { record, result: 'revoked' }
    })
  }
  #approvedAuthority(record: MlsGrantRecord, expected: MlsKeeperGrantAuthority, keeper: string, sender: string, device: string): void {
    if (record.issuer !== keeper || record.persona !== sender || record.device !== device || record.node !== expected.node || record.grantId !== expected.grantId ||
        mlsGrantReference(record.node, record.grantId) !== expected.reference || record.active.id !== expected.active || record.revocation.id !== expected.revocation ||
        record.box.routeId !== expected.box.routeId || record.box.eventUrl !== expected.box.eventUrl || expected.expiration !== undefined && record.expiration !== expected.expiration ||
        !Array.isArray(expected.rooms) || record.rooms.some(use => !expected.rooms.some(reviewed => reviewed.session === use.session && reviewed.leaf === use.leaf))) {
      throw new Error('The approved grant authority or affected rooms changed. Review the request again.')
    }
  }
  async #route(record: MlsGrantRecord, keeper: ParticipantIdentity, event: Event, current: () => void = () => undefined): Promise<void> {
    current()
    await this.link.resume(keeper.pubkey)
    current()
    this.#identity(keeper.pubkey)
    if (!this.link.boxes().some(box => box.routeId === record.box.routeId && box.eventUrl === record.box.eventUrl)) throw new Error('The saved Bothy pairing is unavailable.')
    const relay = this.carrier(record, keeper)
    try { current(); await relay.publish(event); current() } finally { relay.close() }
    this.#identity(keeper.pubkey)
  }
}

export function removalGrantRefs(issuer: string, devices: Iterable<string>, records: readonly MlsGrantRecord[]): VmlsGrantRef[] {
  const selected = new Set(devices), refs: VmlsGrantRef[] = []
  for (const record of records) if (record.issuer === issuer && record.persona !== issuer && selected.has(record.device) && record.state !== 'revoked') refs.push({
    node: hexToBytes(record.node), grant: hexToBytes(mlsGrantReference(record.node, record.grantId)), keeper: true,
  })
  refs.sort((a, b) => bytesToHex(a.node).localeCompare(bytesToHex(b.node)) || bytesToHex(a.grant).localeCompare(bytesToHex(b.grant)))
  return refs
}

export function grantRecordByReference(node: string, reference: string, records: readonly MlsGrantRecord[]): MlsGrantRecord | undefined {
  return records.find(record => record.node === node && mlsGrantReference(record.node, record.grantId) === reference)
}
