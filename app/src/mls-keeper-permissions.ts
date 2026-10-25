import { bytesToHex } from '@noble/hashes/utils.js'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { keeperInboxDestination } from './mls-keeper-inbox-auth.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { MlsRevocationOutboxContext } from './mls-revocation-outbox.js'

const HEX = /^[0-9a-f]{64}(?![\s\S])/, GRANT = /^[0-9a-f]{32}(?![\s\S])/, SIG = /^[0-9a-f]{128}(?![\s\S])/
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const KEEPER_PERMISSION_BYTES = 8192
export const KEEPER_PERMISSION_RECORD = bytesToHex(new TextEncoder().encode('kithmoot.keeper-inbox-permissions.v1'))
const MAX_RECORDS = 64, MAX_BYTES = 256 * 1024
export interface KeeperInboxPermission {
  event: Event; node: string; keeper: string; device: string; grant: string; expiration: number
}
/** Ordinary signed Event JSON is the interchange format. No identity or room
 * membership check here establishes that the issuer is a current node keeper. */
export function readKeeperInboxPermission(value: unknown, now: number, status: 'active' | 'revoked' = 'active'): KeeperInboxPermission {
  if (!object(value) || !exact(value, 'content,created_at,id,kind,pubkey,sig,tags') || value.kind !== 24242 || value.content !== '' ||
      !time(value.created_at) || !time(now) || value.created_at > now + 300 || typeof value.id !== 'string' || !HEX.test(value.id) ||
      typeof value.pubkey !== 'string' || !HEX.test(value.pubkey) || typeof value.sig !== 'string' || !SIG.test(value.sig) ||
      !Array.isArray(value.tags) || value.tags.length !== 6 || value.tags.some(t => !Array.isArray(t) || t.length !== 2 || t.some(p => typeof p !== 'string' || p.length > 128))) throw new Error('Invalid signed keeper inbox permission.')
  const tags = value.tags.map(t => [...t] as string[])
  if (tags.map(t => t[0]).sort().join(',') !== 'device,expiration,grant,server,status,t') throw new Error('Invalid keeper inbox permission tags.')
  const one = (name: string) => tags.find(t => t[0] === name)![1]!
  if (one('t') !== 'keeper-inbox-deposit' || one('status') !== status || !HEX.test(one('device')) || !GRANT.test(one('grant')) || !/^(0|[1-9][0-9]*)$/.test(one('expiration'))) throw new Error('Invalid keeper inbox permission scope.')
  const expiration = Number(one('expiration')), node = mlsBoxNode({ routeId: 'permission', eventUrl: one('server') })
  if (one('server') !== keeperInboxDestination(node) || !time(expiration) || expiration <= now || expiration > now + 30 * 86400) throw new Error('The keeper inbox permission is expired or outside its maximum lifetime.')
  const event: Event = { id: value.id, pubkey: value.pubkey, created_at: value.created_at, kind: 24242, tags, content: '', sig: value.sig }
  if (!verifyEventUncached(event)) throw new Error('The keeper inbox permission signature is invalid.')
  tags.forEach(Object.freeze); Object.freeze(tags); Object.freeze(event)
  return Object.freeze({ event, node, keeper: event.pubkey, device: one('device'), grant: one('grant'), expiration })
}
export function importKeeperInboxPermission(text: string, now = Math.floor(Date.now() / 1000)): KeeperInboxPermission {
  if (typeof text !== 'string' || text.length > KEEPER_PERMISSION_BYTES || new TextEncoder().encode(text).length > KEEPER_PERMISSION_BYTES) throw new Error('Paste one signed permission JSON object, at most 8 KiB.')
  return readKeeperInboxPermission(JSON.parse(text), now)
}
export type KeeperPermissionState = 'prepared' | 'installing' | 'installed' | 'revoking' | 'revoked'
export interface KeeperPermissionRecord {
  grant: string; keeper: string; device: string; node: string; box: { routeId: string; eventUrl: string }; expiration: number
  /** Exact canonical ordinary Event JSON, retained before any publication. */
  active: string; revocation: string; state: KeeperPermissionState; revision: number
}
interface Journal { version: 1; checkedAt: number; records: KeeperPermissionRecord[] }
const invalid = (): never => { throw new InvalidPersonaRecord('The keeper permission custody is unsupported or damaged.') }
function validate(j: Journal, keeper: string): void {
  if (!j || !exact(j, 'checkedAt,records,version') || j.version !== 1 || !time(j.checkedAt) || !Array.isArray(j.records) || j.records.length > MAX_RECORDS) invalid()
  const grants = new Set<string>()
  for (const r of j.records) {
    if (!r || !exact(r, 'active,box,device,expiration,grant,keeper,node,revision,revocation,state') || !GRANT.test(r.grant) || grants.has(r.grant) || r.keeper !== keeper ||
      !HEX.test(r.device) || !HEX.test(r.node) || !r.box || !exact(r.box, 'eventUrl,routeId') || typeof r.box.routeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(r.box.routeId) || r.box.eventUrl !== keeperInboxDestination(r.node) ||
      !time(r.expiration) || !time(r.revision) || !['prepared','installing','installed','revoking','revoked'].includes(r.state) || typeof r.active !== 'string' || typeof r.revocation !== 'string' || r.active.length > KEEPER_PERMISSION_BYTES || r.revocation.length > KEEPER_PERMISSION_BYTES) invalid()
    try {
      const active = JSON.parse(r.active), a = readKeeperInboxPermission(active, active.created_at), revoked = JSON.parse(r.revocation), b = readKeeperInboxPermission(revoked, active.created_at, 'revoked')
      if (a.keeper !== keeper || a.node !== r.node || a.device !== r.device || a.grant !== r.grant || a.expiration !== r.expiration ||
          b.keeper !== keeper || b.node !== r.node || b.device !== r.device || b.grant !== r.grant || b.expiration !== r.expiration || b.event.created_at !== a.event.created_at + 1 ||
          JSON.stringify(a.event) !== r.active || JSON.stringify(b.event) !== r.revocation) invalid()
    } catch { invalid() }
    grants.add(r.grant)
  }
}
async function read(tx: PersonaReader, keeper: string, now: number): Promise<Journal> {
  if (!time(now)) throw new Error('A trusted keeper permission time is unavailable.')
  const bytes = await tx.readVault(KEEPER_PERMISSION_RECORD)
  if (!bytes) return { version: 1, checkedAt: now, records: [] }
  if (bytes.length > MAX_BYTES) invalid()
  let j: Journal
  try { j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validate(j, keeper) } catch { return invalid() }
  if (now < j.checkedAt) throw new Error('The keeper permission clock moved backwards.')
  j.checkedAt = now; return j
}
async function save(tx: PersonaTransaction, keeper: string, j: Journal): Promise<void> {
  validate(j, keeper)
  const bytes = new TextEncoder().encode(JSON.stringify(j))
  try { if (bytes.length > MAX_BYTES) throw new Error('Keeper permission custody is full.'); await tx.putVault(KEEPER_PERMISSION_RECORD, bytes) } finally { bytes.fill(0) }
}
/** Dedicated witnessed custody uses its own object ID and strict version. Old
 * membership writers preserve unknown persona objects rather than decode it. */
export class BrowserMlsKeeperPermissions {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>, private endpoint: BrowserMlsGrantEndpoint,
    private context: () => MlsRevocationOutboxContext | undefined, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (!(endpoint instanceof BrowserMlsGrantEndpoint)) throw new Error('Use the dedicated grant endpoint.')
  }
  #scope(extra: () => boolean = () => true) {
    const scope = this.context()
    if (!scope || !scope.current() || !HEX.test(scope.vault.persona)) throw new Error('Open the keeper account in the foreground.')
    const captured = { ...scope.vault }
    const current = () => { const permitted = extra() === true; const next = this.context(); return permitted && !!next && next.current() && JSON.stringify(next.vault) === JSON.stringify(captured) }
    return { keeper: captured.persona, current }
  }
  records() { const s = this.#scope(); return this.coordinator.transact(s.keeper, async tx => { const j = await read(tx, s.keeper, this.now()); await save(tx, s.keeper, j); return structuredClone(j.records) }, s.current) }
  async prepare(routeId: string, device: string, seconds: number, identity: ParticipantIdentity, current: () => boolean) {
    const s = this.#scope(current)
    if (identity.pubkey !== s.keeper || !HEX.test(device) || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 30 * 86400) throw new Error('Choose a transmitting device and lifetime between one minute and thirty days.')
    const box = (await this.endpoint.pairedBoxes(s.keeper)).find(b => b.routeId === routeId)
    if (!s.current() || !box) throw new Error('The selected saved Bothy route changed.')
    const node = mlsBoxNode(box), grant = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const before = await this.coordinator.transact(s.keeper, async tx => { const j = await read(tx, s.keeper, this.now()); if (j.records.length >= MAX_RECORDS) throw new Error('Keeper permission custody is full.'); return j.checkedAt }, s.current)
    if (before.state !== 'active') return before
    const created_at = before.value, expiration = created_at + seconds
    let floor = created_at
    const live = () => { const at = this.now(); if (!s.current() || !time(at) || at < floor || at >= expiration) return false; floor = at; return true }
    if (!time(expiration)) throw new Error('Invalid permission expiration.')
    const template = (status: 'active' | 'revoked'): EventTemplate => ({ kind: 24242, content: '', created_at: created_at + (status === 'revoked' ? 1 : 0),
      tags: [['t','keeper-inbox-deposit'], ['server',box.eventUrl], ['device',device], ['grant',grant], ['expiration',String(expiration)], ['status',status]] })
    const sign = async (status: 'active' | 'revoked') => {
      if (!live()) throw new Error('The keeper operation changed.')
      const unsigned = template(status), expected = JSON.stringify(unsigned), event = await identity.signEvent(unsigned)
      if (!live()) throw new Error('The keeper operation changed.')
      const terms = readKeeperInboxPermission(event, this.now(), status)
      if (terms.keeper !== s.keeper || JSON.stringify({ kind: terms.event.kind, content: terms.event.content, created_at: terms.event.created_at, tags: terms.event.tags }) !== expected) throw new Error('The keeper signer changed the permission.')
      return JSON.stringify(terms.event)
    }
    const active = await sign('active'), revocation = await sign('revoked')
    const record: KeeperPermissionRecord = { grant, keeper: s.keeper, device, node, box: { ...box }, expiration, active, revocation, state: 'prepared', revision: 0 }
    return this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now())
      if (!live() || expiration <= j.checkedAt || j.records.length >= MAX_RECORDS || j.records.some(r => r.grant === grant)) throw new Error('The keeper permission preparation changed.')
      j.records.push(record); await save(tx, s.keeper, j); return structuredClone(record)
    }, live)
  }
  async publish(grant: string, revision: number, revoke: boolean, operationCurrent: () => boolean) {
    const s = this.#scope(operationCurrent)
    if (!GRANT.test(grant) || !time(revision) || typeof revoke !== 'boolean') throw new Error('Review the current keeper permission revision first.')
    const reserved = await this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now()), r = j.records.find(r => r.grant === grant)
      if (!r || r.revision !== revision) throw new Error('The keeper permission changed. Read its current revision.')
      if (!revoke && ['revoking','revoked'].includes(r.state)) throw new Error('Terminal revocation cannot be reactivated.')
      if (r.expiration <= j.checkedAt) throw new Error('Saved permission material expired; remote installation or revocation remains unconfirmed.')
      if (r.state === (revoke ? 'revoked' : 'installed')) return { record: structuredClone(r), publish: false, at: j.checkedAt }
      if (r.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Permission revision is full.')
      r.state = revoke ? 'revoking' : 'installing'; r.revision++
      await save(tx, s.keeper, j); return { record: structuredClone(r), publish: true, at: j.checkedAt }
    }, s.current)
    if (reserved.state !== 'active') return reserved
    const frozen = reserved.value.record
    if (!reserved.value.publish) return { ...reserved, value: frozen }
    let floor = reserved.value.at
    const live = () => { const at = this.now(); if (!s.current() || !time(at) || at < floor || at >= frozen.expiration) return false; floor = at; return true }
    if (!live()) throw new Error('The keeper permission operation expired.')
    await this.endpoint.publishKeeperInboxPermission(frozen.box, JSON.parse(revoke ? frozen.revocation : frozen.active), live)
    return this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now()), r = j.records.find(r => r.grant === grant)
      if (!live() || !r || JSON.stringify(r) !== JSON.stringify(frozen)) throw new Error('The keeper permission changed before acknowledgement was retained.')
      r.state = revoke ? 'revoked' : 'installed'; await save(tx, s.keeper, j); return structuredClone(r)
    }, live)
  }
  async exportInstalled(grant: string, revision: number) {
    const s = this.#scope()
    let validBefore: number | undefined
    const live = () => s.current() && (validBefore === undefined || this.now() < validBefore)
    return this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now()), r = j.records.find(r => r.grant === grant)
      if (!r || r.revision !== revision || r.state !== 'installed' || r.expiration <= j.checkedAt) throw new Error('Only an unexpired node-acknowledged active permission can be exported as installed.')
      validBefore = r.expiration
      if (!live()) throw new Error('The installed permission expired before export.')
      return r.active
    }, live)
  }
}
