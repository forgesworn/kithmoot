import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsBoxNode, mlsGrantReference, type MlsGrantRecord, type MlsGrantRoom } from './mls-grant-ledger.js'
import type { MlsMemberStatus } from './mls-room-operations.js'
import type { VmlsRevocationRequest } from '../../src/vmls-revocation-request.js'

export interface MlsKeeperGrantAuthority {
  node: string
  reference: string
  grantId: string
  active: string
  revocation: string
  box: MlsGrantRecord['box']
  rooms: MlsGrantRoom[]
}
export interface MlsKeeperRoomIntent {
  session: string
  name: string
  rendezvousKey: string
  operation: string
  member: MlsMemberStatus
  action: 'remove' | 'ledger-only'
}
export interface MlsKeeperApproval {
  approvedAt: number
  grants: MlsKeeperGrantAuthority[]
  rooms: MlsKeeperRoomIntent[]
}
const label = new TextEncoder().encode('kithmoot/vmls-keeper-request-removal/v1')
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v)
export function mlsKeeperRemovalOperation(request: string, session: string, leaf: string): string {
  if (![request, session, leaf].every(hex)) throw new Error('Invalid keeper removal binding.')
  return bytesToHex(sha256(concatBytes(label, hexToBytes(request), hexToBytes(session), hexToBytes(leaf))))
}

/** Frozen operator scope. No event bodies, device secrets or mutable status
 * are stored here; later effects must resolve these exact signed references. */
export function validateMlsKeeperApproval(value: MlsKeeperApproval, request: VmlsRevocationRequest, operation: string, receivedAt: number): void {
  const invalid = (): never => { throw new InvalidPersonaRecord('Invalid keeper request approval') }
  if (!value || typeof value !== 'object' || !exact(value, 'approvedAt,grants,rooms') || !time(value.approvedAt) || value.approvedAt < receivedAt || value.approvedAt >= request.expiration ||
      !Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > 256 || !Array.isArray(value.rooms) || value.rooms.length > 64) invalid()
  const nodes = new Set<string>(), operations = new Set<string>()
  for (const grant of value.grants) {
    if (!grant || typeof grant !== 'object' || !exact(grant, 'active,box,grantId,node,reference,revocation,rooms') ||
        !hex(grant.node) || !hex(grant.reference) || !hex(grant.active) || !hex(grant.revocation) || grant.active === grant.revocation ||
        typeof grant.grantId !== 'string' || !/^[0-9a-f]{32}$/.test(grant.grantId) || grant.reference !== mlsGrantReference(grant.node, grant.grantId) ||
        !grant.box || !exact(grant.box, 'eventUrl,routeId') || typeof grant.box.routeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(grant.box.routeId) ||
        !Array.isArray(grant.rooms) || grant.rooms.length > 64 || nodes.has(grant.node)) invalid()
    try { if (mlsBoxNode(grant.box) !== grant.node) invalid() } catch { invalid() }
    const uses = new Set<string>()
    for (const room of grant.rooms) {
      if (!room || typeof room !== 'object' || !exact(room, 'leaf,name,session') || !hex(room.session) || !hex(room.leaf) || !name(room.name) || uses.has(room.session)) invalid()
      uses.add(room.session)
    }
    nodes.add(grant.node)
  }
  for (const room of value.rooms) {
    const m = room?.member
    if (!room || typeof room !== 'object' || !exact(room, 'action,member,name,operation,rendezvousKey,session') || !hex(room.session) || !name(room.name) ||
        !hex(room.rendezvousKey) || !hex(room.operation) || !['remove', 'ledger-only'].includes(room.action) || !m ||
        !exact(m, 'bindingExpiresAt,device,homeBox,identity,leafId,own,pending') || !hex(m.leafId) || !hex(m.homeBox) ||
        m.device !== request.device || m.identity !== request.sender || m.own !== false || typeof m.pending !== 'boolean' || !time(m.bindingExpiresAt) ||
        room.action === 'remove' && m.pending || room.operation !== mlsKeeperRemovalOperation(operation, room.session, m.leafId) || operations.has(room.operation)) invalid()
    operations.add(room.operation)
  }
}

export function mlsKeeperGrantAuthority(record: MlsGrantRecord): MlsKeeperGrantAuthority {
  return { node: record.node, reference: mlsGrantReference(record.node, record.grantId), grantId: record.grantId,
    active: record.active.id, revocation: record.revocation.id, box: structuredClone(record.box), rooms: structuredClone(record.rooms) }
}
