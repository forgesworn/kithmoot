import { schnorr } from '@noble/curves/secp256k1.js'
import type { DeviceCredential } from '../../src/types.js'
import { verifyDeviceCredential } from '../../src/credential.js'
import { CADENCE_VERSION, CADENCE_EPOCH_SECONDS, CADENCE_SLOT_SECONDS, CADENCE_BUCKET_BYTES, CADENCE_DEVICE_SLOTS,
  CADENCE_COUNTERS_PER_DEVICE, CADENCE_MAX_LEASE_EPOCHS, type CadenceLeaseRequest } from '../../src/box-cadence.js'
import { CADENCE_LEASE_PREFIX, type CadenceOwnership } from './cadence-store.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/, NODE = /^[a-z2-7]{52}$/
const REQUEST_FIELDS = ['v','request_id','lease_id','generation','server','room','traffic_room','persona','device','credential','grant_id',
  'device_slot','room_generation','epoch_seconds','slot_seconds','bucket_bytes','allowed_inner_kinds','device_slots','counter_lo','counter_hi',
  'start_epoch','end_epoch','real_send_until_epoch','cover_until_epoch','drop_keys','public_relays','circle_boxes'] as const
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function positive(value: unknown): value is number { return integer(value) && value > 0 }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(name => !Object.hasOwn(value, name)) ||
      Reflect.ownKeys(value).some(name => typeof name !== 'string' || !required.includes(name) && !optional.includes(name))) hold()
}
function exact(value: unknown, pattern: RegExp): asserts value is string { if (typeof value !== 'string' || !pattern.test(value)) hold() }
function publicKey(value: unknown): asserts value is string {
  exact(value, HEX)
  try { schnorr.utils.lift_x(BigInt('0x' + value)) } catch { hold() }
}
function parsed(raw: string): unknown {
  let value: unknown
  try { value = JSON.parse(raw) } catch { hold() }
  // Both client storage and byte-exact request bodies are JSON.stringify
  // output. Refuse duplicate names/lossy numbers instead of collapsing them.
  if (JSON.stringify(value) !== raw) hold()
  return value
}
function destinations(value: unknown, local: boolean): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || new Set(value).size !== value.length) hold()
  for (const raw of value) {
    if (local && raw === 'local') continue
    if (typeof raw !== 'string') hold()
    try {
      const url = new URL(raw)
      let canonical = url.toString()
      if (url.pathname === '/' && canonical.endsWith('/')) canonical = canonical.slice(0, -1)
      if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash || canonical !== raw) hold()
    } catch { hold() }
  }
  return value
}
function credential(value: unknown, room: string, persona: string, device: string, startEpoch: number, endEpoch: number): void {
  object(value, ['id','pubkey','kind','created_at','tags','content','sig'])
  exact(value.id, HEX); publicKey(value.pubkey)
  if (value.pubkey !== persona || value.kind !== 20460 || !integer(value.created_at) || value.content !== '' ||
      typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig) || !Array.isArray(value.tags) || value.tags.length < 3 || value.tags.length > 5) hold()
  const tags = new Map<string,string>()
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string' ||
        !['d','device','expiration','scope','label'].includes(tag[0]) || tags.has(tag[0])) hold()
    tags.set(tag[0], tag[1])
  }
  const expiration = Number(tags.get('expiration'))
  if (!integer(expiration) || String(expiration) !== tags.get('expiration') || expiration <= value.created_at ||
      expiration < endEpoch * CADENCE_EPOCH_SECONDS || value.created_at >= startEpoch * CADENCE_EPOCH_SECONDS ||
      tags.get('device') !== device ||
      tags.has('scope') && tags.get('scope') !== 'person' || tags.get('d') !== (tags.has('scope') ? persona : room)) hold()
  // Historical signature/scope check only. No wall-clock pruning or claim
  // that this credential/grant currently authorises the device or box.
  const verdict = verifyDeviceCredential(value as unknown as DeviceCredential, { roomId: room, now: expiration - 1, acceptPerson: true })
  if (!verdict.ok || verdict.participant !== persona || verdict.device !== device) hold()
}
export interface OrdinaryCadenceScope {
  readonly roomId: string
  readonly nodeId: string
  readonly device: string
  readonly account?: string
}
export interface OrdinaryCadenceChecks {
  readonly kind: 'browser' | 'tab'
  /** Pure/check-only same-image evidence: pinned node, stable room, traffic
   * epoch/root, account/device ownership, retained grant and every derived
   * public drop key. The signed credential alone does not bind those keys.
   * Never signs, dials, renews or changes ownership from this callback. */
  acceptsLease(request: CadenceLeaseRequest, scope: OrdinaryCadenceScope): boolean
}
export interface OrdinaryCadenceSnapshot {
  readonly leases: readonly (OrdinaryCadenceScope & { readonly leaseId: string; readonly generation: number; readonly ownership: CadenceOwnership })[]
}
/** Offline custody, never a delegation/termination receipt proof. Preserve
 * exact uncertain request bytes and all states, including expired/ended rows.
 * Receipts have no standalone signature: even a schema-valid ended row must
 * undergo authenticated box reconciliation before a restored sender can act.
 * The caller must construct same-image binding; no default accepts callback.
 * Async retention before handoff, authority and production wiring stay open. */
export function validateOrdinaryCadenceSnapshot(records: ReadonlyMap<string,string>, migrated: boolean,
  input: OrdinaryCadenceChecks): OrdinaryCadenceSnapshot {
  const options = { ...input }, leases: (OrdinaryCadenceScope & { leaseId: string; generation: number; ownership: CadenceOwnership })[] = []
  const checks: { request: CadenceLeaseRequest; scope: OrdinaryCadenceScope }[] = []
  const roomOwners = new Map<string,Set<string>>(), requests = new Map<string,string>(), leaseScopes = new Map<string,string>()
  const exclusions: { room: string; device: string; lo: number; hi: number; start: number; end: number }[] = []
  if (!['browser','tab'].includes(options.kind) || typeof options.acceptsLease !== 'function') hold()
  try {
    for (const [physical, raw] of records) {
      let name = physical, account: string | undefined
      if (name.startsWith('kithmoot.account.')) {
        const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(name)
        if (!match) hold()
        account = match[1]!; name = match[2]!
        if (name.startsWith('kithmoot.account.')) hold()
      }
      if (!name.startsWith('kithmoot.cadence-lease.')) continue
      if (options.kind !== 'browser' || !name.startsWith(CADENCE_LEASE_PREFIX) || account !== undefined && !migrated || raw.length > ORDINARY_VALUE_UNITS) hold()
      const match = /^([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{32})\.([1-9][0-9]*)$/.exec(name.slice(CADENCE_LEASE_PREFIX.length))
      if (!match) hold()
      const [room, device, leaseId, generation] = match.slice(1)
      const saved = parsed(raw)
      object(saved, ['v','nodeId','room','device','leaseId','generation','requestId','requestBody','startEpoch','endEpoch','counterLo','counterHi','ownership','updatedAt'], ['receipt'])
      exact(saved.nodeId, NODE); exact(saved.requestId, ID)
      if (saved.v !== CADENCE_VERSION || saved.room !== room || saved.device !== device || saved.leaseId !== leaseId ||
          !positive(saved.generation) || String(saved.generation) !== generation || !integer(saved.updatedAt) ||
          !['client-excluded','box-owned','ended'].includes(saved.ownership as string) || typeof saved.requestBody !== 'string' ||
          saved.requestBody.length > ORDINARY_VALUE_UNITS) hold()
      const request = parsed(saved.requestBody)
      object(request, REQUEST_FIELDS)
      exact(request.request_id, ID); exact(request.lease_id, ID); exact(request.grant_id, ID)
      publicKey(request.persona); publicKey(request.device); exact(request.room, HEX); exact(request.traffic_room, HEX)
      if (request.v !== CADENCE_VERSION || request.server !== `ws://${saved.nodeId}/events` || request.room !== room || request.device !== device ||
          request.lease_id !== leaseId || request.generation !== saved.generation || request.request_id !== saved.requestId ||
          account !== undefined && request.persona !== account || !positive(request.room_generation) ||
          !integer(request.device_slot) || request.device_slot >= CADENCE_DEVICE_SLOTS || request.epoch_seconds !== CADENCE_EPOCH_SECONDS ||
          request.slot_seconds !== CADENCE_SLOT_SECONDS || request.bucket_bytes !== CADENCE_BUCKET_BYTES || request.device_slots !== CADENCE_DEVICE_SLOTS ||
          !Array.isArray(request.allowed_inner_kinds) || request.allowed_inner_kinds.length !== 1 || request.allowed_inner_kinds[0] !== 1460 ||
          request.counter_lo !== request.device_slot * CADENCE_COUNTERS_PER_DEVICE || request.counter_hi !== (request.counter_lo as number) + CADENCE_COUNTERS_PER_DEVICE ||
          !integer(request.start_epoch) || !integer(request.end_epoch) || request.end_epoch > Math.floor(Number.MAX_SAFE_INTEGER / CADENCE_EPOCH_SECONDS) ||
          request.end_epoch <= request.start_epoch || request.end_epoch - request.start_epoch > CADENCE_MAX_LEASE_EPOCHS ||
          request.real_send_until_epoch !== request.end_epoch || request.cover_until_epoch !== request.end_epoch) hold()
      for (const [field, value] of [['startEpoch',request.start_epoch],['endEpoch',request.end_epoch],['counterLo',request.counter_lo],['counterHi',request.counter_hi]] as const)
        if (saved[field] !== value) hold()
      credential(request.credential, request.room, request.persona, request.device, request.start_epoch, request.end_epoch)
      const relays = destinations(request.public_relays, false), boxes = destinations(request.circle_boxes, true)
      if (relays.length < 2 || !boxes.includes('local') || boxes.some(box => relays.includes(box))) hold()
      if (!Array.isArray(request.drop_keys) || request.drop_keys.length !== (request.end_epoch - request.start_epoch) * CADENCE_COUNTERS_PER_DEVICE) hold()
      const publicKeys = new Set<string>()
      for (const [index, key] of request.drop_keys.entries()) {
        object(key, ['epoch','counter','pubkey']); publicKey(key.pubkey)
        if (key.epoch !== request.start_epoch + Math.floor(index / CADENCE_COUNTERS_PER_DEVICE) ||
            key.counter !== (request.counter_lo as number) + index % CADENCE_COUNTERS_PER_DEVICE || publicKeys.has(key.pubkey)) hold()
        publicKeys.add(key.pubkey)
      }
      if (Object.hasOwn(saved,'receipt')) {
        const receipt = saved.receipt
        object(receipt, ['v','code','lease_id','generation','state','server_time','start_epoch','end_epoch','queue_count','sent_item_ids','failed_item_ids'])
        if (receipt.v !== CADENCE_VERSION || receipt.lease_id !== leaseId || receipt.generation !== saved.generation ||
            receipt.start_epoch !== request.start_epoch || receipt.end_epoch !== request.end_epoch ||
            !['staged','queued','status','withdrawn','stopping','rekeyed'].includes(receipt.code as string) ||
            !['staged','active','cover','ended'].includes(receipt.state as string) || !integer(receipt.server_time) ||
            !integer(receipt.queue_count) || receipt.queue_count > 256 ||
            saved.ownership !== (receipt.state === 'ended' ? 'ended' : 'box-owned')) hold()
        for (const ids of [receipt.sent_item_ids, receipt.failed_item_ids]) {
          if (!Array.isArray(ids) || new Set(ids).size !== ids.length) hold()
          for (const id of ids) exact(id, HEX)
        }
        // Bothy's stage producer has not queued or completed any items.
        if (receipt.code === 'staged' && (receipt.state !== 'staged' || receipt.queue_count !== 0 ||
            (receipt.sent_item_ids as unknown[]).length !== 0 || (receipt.failed_item_ids as unknown[]).length !== 0)) hold()
        // A failed item can be queued again and later succeed; Bothy's real
        // producer keeps it in both histories. Never prune or infer resends.
      } else if (saved.ownership !== 'client-excluded') hold()
      let owners = roomOwners.get(room!)
      if (!owners) { owners = new Set(); roomOwners.set(room!, owners) }
      if (account === undefined && [...owners].some(owner => owner !== 'legacy') || account !== undefined && owners.has('legacy')) hold()
      owners.add(account ?? 'legacy')
      const requestName = request.server + ':' + request.request_id, priorRequest = requests.get(requestName)
      if (priorRequest !== undefined && priorRequest !== saved.requestBody) hold()
      requests.set(requestName, saved.requestBody)
      const leaseName = request.server + ':' + request.lease_id, scopeValue = JSON.stringify([request.room,request.persona,request.device,request.device_slot])
      if (leaseScopes.has(leaseName) && leaseScopes.get(leaseName) !== scopeValue) hold()
      leaseScopes.set(leaseName,scopeValue)
      if (saved.ownership !== 'ended') {
        const next = { room: request.room, device: request.device, lo: request.counter_lo as number, hi: request.counter_hi as number, start: request.start_epoch, end: request.end_epoch }
        if (exclusions.some(prior => prior.room === next.room && prior.device === next.device && prior.start < next.end && next.start < prior.end && prior.lo < next.hi && next.lo < prior.hi)) hold()
        exclusions.push(next)
      }
      const scope = Object.freeze({ roomId: request.room, nodeId: saved.nodeId, device: request.device, ...(account ? { account } : {}) })
      checks.push({ request: request as unknown as CadenceLeaseRequest, scope })
      leases.push(Object.freeze({ ...scope, leaseId: request.lease_id, generation: saved.generation, ownership: saved.ownership as CadenceOwnership }))
    }
    for (const { request, scope } of checks) if (options.acceptsLease(structuredClone(request), scope) !== true) hold()
    leases.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.device.localeCompare(b.device) || a.leaseId.localeCompare(b.leaseId) || a.generation - b.generation)
    return Object.freeze({ leases: Object.freeze(leases) })
  } catch { return hold() }
  finally { checks.length = 0 }
}
