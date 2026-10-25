import { storageInboxTransaction } from './mls-storage-inbox.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import { createVmlsRevocationRumor, type VmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { mlsBoxNode, mlsGrantScope, validateMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import type { MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import { readMlsMembership } from './mls-membership-store.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'

const id = bytesToHex(new TextEncoder().encode('kithmoot.storage-grants.v1'))
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
export interface StorageGrantApproval { operation: string; request: VmlsRevocationRequest; approvedAt: number; active: string; revocation: string }
export interface StorageGrantRecord { grant: MlsGrantRecord; revision: number; approval?: StorageGrantApproval }
interface Journal { version: 1; checkedAt: number; records: StorageGrantRecord[] }
export interface StorageGrantReview { operation: string; request: VmlsRevocationRequest; records: StorageGrantRecord[] }
const invalid = (): never => { throw new InvalidPersonaRecord('Unsupported or damaged storage grant custody') }
function validate(j: Journal, keeper: string): void {
  if (!j || !exact(j, 'checkedAt,records,version') || j.version !== 1 || !time(j.checkedAt) || !Array.isArray(j.records) || j.records.length > 64) invalid()
  const grants = new Set<string>()
  for (const r of j.records) {
    if (!r || !exact(r, r.approval ? 'approval,grant,revision' : 'grant,revision') || !time(r.revision)) invalid()
    try { validateMlsGrant(r.grant) } catch { invalid() }
    const g = r.grant
    if (g.issuer !== keeper || !time(g.active.created_at) || g.rooms.length || g.revokeAfter !== null || g.expiration > g.active.created_at + 3600 ||
        g.expiration <= g.active.created_at || g.revocation.created_at !== g.active.created_at + 1 || grants.has(g.grantId)) invalid()
    grants.add(g.grantId)
    if (r.approval) {
      const a = r.approval, q = a.request
      if (!exact(a, 'active,approvedAt,operation,request,revocation') || !hex(a.operation) || !time(a.approvedAt) || !q ||
          q.keeper !== keeper || q.sender !== g.persona || q.device !== g.device || a.active !== g.active.id || a.revocation !== g.revocation.id ||
          a.operation !== mlsStandaloneRevocationOperation(q.sender, keeper, q.device) || a.approvedAt < q.createdAt || a.approvedAt > j.checkedAt || a.approvedAt >= q.expiration) invalid()
      try { createVmlsRevocationRumor(q) } catch { invalid() }
    }
  }
  if (new Set(j.records.filter(r => r.grant.state !== 'revoked').map(r => `${r.grant.node}/${r.grant.device}`)).size !== j.records.filter(r => r.grant.state !== 'revoked').length) invalid()
}
async function read(tx: PersonaReader, keeper: string, now: number): Promise<Journal> {
  if (!time(now)) throw new Error('A trusted storage grant time is unavailable.')
  const bytes = await tx.readVault(id)
  if (!bytes) return { version: 1, checkedAt: now, records: [] }
  try {
    if (bytes.length > 512 * 1024) invalid()
    const j: Journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); validate(j, keeper)
    if (now < j.checkedAt) throw new Error('The storage grant clock moved backwards.')
    j.checkedAt = now; return j
  } finally { bytes.fill(0) }
}
async function save(tx: PersonaTransaction, keeper: string, j: Journal): Promise<void> {
  validate(j, keeper)
  const bytes = new TextEncoder().encode(JSON.stringify(j))
  try { if (bytes.length > 512 * 1024) throw new Error('Storage grant custody is full.'); await tx.putVault(id, bytes) } finally { bytes.fill(0) }
}
/** Separate protected persona object. Reuses signed storage wire terms only;
 * empty rooms are deliberate: this ledger grants no MLS authority. Legacy
 * journal versions, admission, room keepers and removal sagas are untouched. */
export class BrowserMlsStorageGrants {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>, private endpoint: BrowserMlsGrantEndpoint,
    private context: () => MlsRevocationInboxContext | undefined, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (!(endpoint instanceof BrowserMlsGrantEndpoint)) throw new Error('Use the dedicated grant endpoint.')
  }
  #scope(extra: () => boolean = () => true) {
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground() || !hex(scope.vault.persona)) throw new Error('Open the storage keeper in the foreground.')
    const binding = { ...scope.vault }, current = () => { const next = this.context(); return extra() === true && scope.current() && scope.foreground() && !!next && next.current() && next.foreground() && JSON.stringify(next.vault) === JSON.stringify(binding) }
    return { keeper: binding.persona, current }
  }
  records() { const s = this.#scope(); return this.coordinator.transact(s.keeper, async tx => structuredClone((await read(tx, s.keeper, this.now())).records), s.current) }
  async authority(tx: PersonaTransaction): Promise<MlsGrantRecord[]> {
    const s = this.#scope()
    return structuredClone((await read(tx, s.keeper, this.now())).records.map(r => r.grant))
  }
  /** Inbox authority adapter: only storage records, never legacy keeper scans. */
  async all(): Promise<MlsGrantRecord[]> {
    const result = await this.records()
    if (result.state !== 'active') throw new Error('Storage grant custody is unavailable.')
    return result.value.map(r => r.grant)
  }
  async prepare(routeId: string, persona: string, device: string, identity: ParticipantIdentity, operationCurrent: () => boolean) {
    const s = this.#scope(operationCurrent)
    if (identity.pubkey !== s.keeper || !hex(persona) || !hex(device)) throw new Error('Select an enrolled persona and device.')
    const box = (await this.endpoint.pairedBoxes(s.keeper)).find(b => b.routeId === routeId)
    if (!s.current() || !box) throw new Error('The selected storage route changed.')
    const node = mlsBoxNode(box), at = this.now(), expiration = at + 3600
    const before = await this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, at)
      if (j.records.length >= 64 || j.records.some(r => r.grant.node === node && r.grant.device === device && r.grant.state !== 'revoked')) throw new Error('Finish the retained storage grant before preparing a replacement.')
      // A replacement must sort after the exact terminal statement.
      if (j.records.some(r => r.grant.node === node && r.grant.device === device && r.grant.revocation.created_at >= at)) throw new Error('Wait before replacing this terminal storage grant.')
    }, s.current)
    if (before.state !== 'active') return before
    const grantId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const sign = async (status: 'active' | 'revoked') => {
      const template: EventTemplate = { kind: 24242, content: '', created_at: at + (status === 'revoked' ? 1 : 0), tags: [
        ['t','event-grant'], ['server',box.eventUrl], ['d',mlsGrantScope(device)], ['p',persona], ['device',device], ['grant',grantId],
        ['read','1460'], ['expiration',String(expiration)], ['vmls','67108864'], ['status',status]] }
      if (!s.current() || this.now() < at || this.now() >= expiration) throw new Error('The storage grant preparation changed.')
      const event = await identity.signEvent(structuredClone(template))
      if (!s.current() || !verifyEventUncached(event) || event.pubkey !== s.keeper || JSON.stringify({ kind: event.kind, content: event.content, created_at: event.created_at, tags: event.tags }) !== JSON.stringify(template)) throw new Error('The signer changed the storage grant.')
      return event
    }
    const revocation = await sign('revoked'), active = await sign('active')
    const record: StorageGrantRecord = { revision: 0, grant: { version: 1, box: { ...box }, node, issuer: s.keeper, persona, device, grantId, expiration, rooms: [], revokeAfter: null, state: 'installing', active, revocation } }
    return this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now())
      if (j.checkedAt >= expiration || j.records.some(r => r.grant.node === node && r.grant.device === device && r.grant.state !== 'revoked')) throw new Error('The storage grant preparation changed.')
      j.records.push(record); await save(tx, s.keeper, j); return structuredClone(record)
    }, s.current)
  }
  async publish(grantId: string, revision: number, revoke: boolean, operationCurrent: () => boolean) {
    const s = this.#scope(operationCurrent)
    const reserved = await this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now()), r = j.records.find(r => r.grant.grantId === grantId)
      if (!r || r.revision !== revision || !time(revision) || typeof revoke !== 'boolean') throw new Error('Review the current storage grant revision.')
      if (!revoke && ['revoking','revoked'].includes(r.grant.state)) throw new Error('Terminal storage withdrawal cannot be reactivated.')
      if (!revoke && r.grant.expiration <= j.checkedAt) throw new Error('The storage grant expired; installation remains unconfirmed.')
      if (r.grant.state === (revoke ? 'revoked' : 'active')) return { record: structuredClone(r), publish: false, at: j.checkedAt }
      if (r.revision === Number.MAX_SAFE_INTEGER) throw new Error('The storage grant revision is full.')
      r.revision++; r.grant.state = revoke ? 'revoking' : 'installing'
      await save(tx, s.keeper, j); return { record: structuredClone(r), publish: true, at: j.checkedAt }
    }, s.current)
    if (reserved.state !== 'active' || !reserved.value.publish) return reserved
    const r = reserved.value.record, g = r.grant
    let floor = reserved.value.at
    const live = () => { const at = this.now(); if (!s.current() || !time(at) || at < floor || !revoke && at >= g.expiration) return false; floor = at; return true }
    // Exact retained bytes. A timeout keeps installing/revoking; only this
    // selected node's authenticated OK permits an acknowledged state.
    await this.endpoint.resume(s.keeper)
    if (!live()) throw new Error('The storage grant operation changed.')
    await this.endpoint.publishLabDeviceGrant(g.box, revoke ? g.revocation : g.active, g.device, live)
    return this.coordinator.transact(s.keeper, async tx => {
      const j = await read(tx, s.keeper, this.now()), current = j.records.find(item => item.grant.grantId === grantId)
      if (!live() || JSON.stringify(current) !== JSON.stringify(r)) throw new Error('The storage grant changed before acknowledgement.')
      current!.grant.state = revoke ? 'revoked' : 'active'; await save(tx, s.keeper, j)
      return { record: structuredClone(current!), publish: false, at: j.checkedAt }
    }, live)
  }
  async review(operation: string) {
    const s = this.#scope()
    return this.coordinator.transact(s.keeper, async tx => this.#review(tx, s.keeper, operation), s.current)
  }
  async #review(tx: PersonaTransaction, keeper: string, operation: string): Promise<StorageGrantReview> {
    const j = await read(tx, keeper, this.now()), inbox = (await readMlsMembership(storageInboxTransaction(tx))).inbox
    const prompt = inbox?.prompts.find((p: MlsRevocationInboxPrompt) => p.operation === operation)
    if (inbox?.keeper !== keeper || !prompt || prompt.state !== 'pending' || prompt.request.expiration <= j.checkedAt) throw new Error('Review a current privately received storage request.')
    const q = prompt.request
    const records = j.records.filter(r => r.grant.issuer === keeper && r.grant.persona === q.sender && r.grant.device === q.device && r.grant.state !== 'revoked')
    if (!records.length) throw new Error('No retained storage grant authorises this request.')
    return { operation, request: structuredClone(q), records: structuredClone(records) }
  }
  /** Explicit storage-only intent, durable before any withdrawal. */
  async approve(review: StorageGrantReview, operationCurrent: () => boolean) {
    const s = this.#scope(operationCurrent), expected = structuredClone(review)
    return this.coordinator.transact(s.keeper, async tx => {
      const fresh = await this.#review(tx, s.keeper, expected.operation)
      if (JSON.stringify(fresh) !== JSON.stringify(expected)) throw new Error('The storage request or grant changed. Review it again.')
      const j = await read(tx, s.keeper, this.now())
      for (const item of fresh.records) {
        const r = j.records.find(r => r.grant.grantId === item.grant.grantId)!
        if (r.approval) throw new Error('This storage grant already has retained withdrawal approval; retry that approval.')
        r.approval = { operation: fresh.operation, request: fresh.request, approvedAt: j.checkedAt, active: r.grant.active.id, revocation: r.grant.revocation.id }
        await save(tx, s.keeper, j)
      }
      return structuredClone(j.records.filter(r => r.approval?.operation === fresh.operation))
    }, s.current)
  }
  /** Resumes only exact retained approvals; never calls a membership API. */
  async advance(operation: string, operationCurrent: () => boolean) {
    const records = await this.records()
    if (records.state !== 'active') return records
    const approved = records.value.filter(r => r.approval?.operation === operation)
    if (!approved.length) throw new Error('No retained storage-only approval exists.')
    const results = []
    for (const r of approved) {
      const result = await this.publish(r.grant.grantId, r.revision, true, operationCurrent)
      if (result.state !== 'active') return result
      results.push(result.value.record)
    }
    return { state: 'active' as const, value: { records: results, storage: 'withdrawn' as const, membership: 'unchanged' as const } }
  }
}
