import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { InvalidPersonaRecord, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'

export const MAX_ROOM_HISTORY_BYTES = 1024 * 1024
export const MAX_ROOM_MESSAGES = 512
const INDEX = bytesToHex(new TextEncoder().encode('kithmoot.mls-rooms.v1'))
const prefix = bytesToHex(new TextEncoder().encode('kithmoot.mls-room.v1:'))
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v)
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 0x7fffffffffffffffn
const keys = (v: object, expected: string) => Object.keys(v).sort().join(',') === expected
export interface MlsRoomBinding { device: string; credentialId: string; rendezvousKey: string; homeBox: string; installation: string | null }
export interface MlsJoinCeremony { operation: string; adderRz: string; introductionBox: string; counter: string; expiresAt: number }
export interface MlsPackageRoute { packageId: string; welcomeMailbox: string; homeBox: string; leafId: string; expiresAt: number }
export interface MlsHistoryEntry { id: string; direction: 'sent' | 'received'; leaf: string; epoch: string; body: Uint8Array }
interface StoredMessage extends Omit<MlsHistoryEntry, 'body'> { body: string }
export interface MlsRoomRecord {
  version: 1; session: string; generation: string; name: string; binding: MlsRoomBinding; history: StoredMessage[]
  ordering?: { slot: string; attempt: number }[]
  join?: MlsJoinCeremony
  packages?: MlsPackageRoute[]
}
export class MlsRoomRefused extends Error { constructor(readonly reason: string) { super(reason) } }
const invalid = (): never => { throw new InvalidPersonaRecord('Invalid MLS room record') }

/** These helpers perform local edits only, inside an already-held persona
 * transaction. The coordinator witnesses the room and engine snapshot as one
 * candidate. There is no independent, plaintext room database. */
export async function readMlsRoom(tx: PersonaReader, id: string): Promise<MlsRoomRecord> {
  if (!hex(id)) throw new MlsRoomRefused('malformed')
  const bytes = await tx.readVault(prefix + id)
  if (!bytes) return invalid()
  try {
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    validate(r, id)
    return r
  } catch (error) { if (error instanceof InvalidPersonaRecord) throw error; return invalid() }
  finally { bytes.fill(0) }
}
function validate(r: MlsRoomRecord, id: string): void {
  if (!r || typeof r !== 'object' || !keys(r, ['binding', 'generation', 'history', ...(r.join ? ['join'] : []), 'name', ...(r.ordering ? ['ordering'] : []), ...(r.packages ? ['packages'] : []), 'session', 'version'].join(',')) || r.version !== 1 || r.session !== id || !uint(r.generation) || r.generation === '0' ||
    typeof r.name !== 'string' || r.name.length < 1 || r.name.length > 120 || !r.binding || !keys(r.binding, 'credentialId,device,homeBox,installation,rendezvousKey') ||
    ![r.binding.device, r.binding.credentialId, r.binding.rendezvousKey, r.binding.homeBox].every(hex) ||
    !(hex(r.binding.installation) || r.binding.installation === null && r.join) || !Array.isArray(r.history) || r.history.length > MAX_ROOM_MESSAGES) invalid()
  if (r.join && (!keys(r.join, 'adderRz,counter,expiresAt,introductionBox,operation') || !hex(r.join.operation) || !hex(r.join.adderRz) || !hex(r.join.introductionBox) || !uint(r.join.counter) || !Number.isSafeInteger(r.join.expiresAt) || r.join.expiresAt < 0)) invalid()
  if (r.ordering && (!Array.isArray(r.ordering) || r.ordering.length > 1024 || r.ordering.some(q => !q || !keys(q, 'attempt,slot') || !hex(q.slot) || !Number.isInteger(q.attempt) || q.attempt < 0 || q.attempt > 0xffffffff) || new Set(r.ordering.map(q => `${q.slot}:${q.attempt}`)).size !== r.ordering.length)) invalid()
  if (r.packages && (!Array.isArray(r.packages) || r.packages.length > 64 || r.packages.some(p => !p || !keys(p, 'expiresAt,homeBox,leafId,packageId,welcomeMailbox') ||
      !hex(p.packageId) || !hex(p.welcomeMailbox) || !hex(p.homeBox) || !hex(p.leafId) || !Number.isSafeInteger(p.expiresAt) || p.expiresAt < 0) ||
      new Set(r.packages.map(p => p.packageId)).size !== r.packages.length || new Set(r.packages.map(p => p.welcomeMailbox)).size !== r.packages.length)) invalid()
  let total = 0
  const ids = new Set<string>()
  for (const m of r.history) {
    if (!m || !keys(m, 'body,direction,epoch,id,leaf') || !/^(sent|received):[0-9a-f]{64}$/.test(m.id) ||
      !['sent', 'received'].includes(m.direction) || !m.id.startsWith(m.direction + ':') || !hex(m.leaf) || !uint(m.epoch) ||
      typeof m.body !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(m.body) || ids.has(m.id)) invalid()
    ids.add(m.id); total += m.body.length / 2
  }
  if (total > MAX_ROOM_HISTORY_BYTES) invalid()
}
export async function saveMlsRoom(tx: PersonaTransaction, room: MlsRoomRecord): Promise<void> {
  validate(room, room.session)
  const bytes = new TextEncoder().encode(JSON.stringify(room))
  try { await tx.putVault(prefix + room.session, bytes) } finally { bytes.fill(0) }
}
export async function createMlsRoom(tx: PersonaTransaction, room: MlsRoomRecord): Promise<void> {
  const ids = await mlsRoomIds(tx)
  if (ids.includes(room.session)) throw new MlsRoomRefused('room-exists')
  // 60 room records + the index, typed vault and session-id ledger fit the
  // persona's 64-record bound. The sealed-container byte quota also applies.
  if (ids.length >= 60) throw new MlsRoomRefused('room-limit')
  await saveMlsRoom(tx, room)
  const bytes = new TextEncoder().encode(JSON.stringify([...ids, room.session]))
  try { await tx.putVault(INDEX, bytes) } finally { bytes.fill(0) }
}
export async function mlsRoomIds(tx: PersonaReader): Promise<string[]> {
  const bytes = await tx.readVault(INDEX)
  if (!bytes) return []
  try {
    const ids = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(ids) || ids.length > 60 || !ids.every(hex) || new Set(ids).size !== ids.length) return invalid()
    return ids
  } catch { return invalid() } finally { bytes.fill(0) }
}
export function appendMlsHistory(room: MlsRoomRecord, message: MlsHistoryEntry): void {
  const old = room.history.find(m => m.id === message.id), body = bytesToHex(message.body)
  if (old) {
    if (old.body !== body || old.direction !== message.direction || old.leaf !== message.leaf || old.epoch !== message.epoch) throw new MlsRoomRefused('replay')
    return
  }
  if (room.history.length >= MAX_ROOM_MESSAGES || room.history.reduce((n, m) => n + m.body.length / 2, 0) + message.body.length > MAX_ROOM_HISTORY_BYTES) throw new MlsRoomRefused('history-full')
  room.history.push({ ...message, body })
}
export function mlsHistory(room: MlsRoomRecord): MlsHistoryEntry[] { return room.history.map(m => ({ ...m, body: hexToBytes(m.body) })) }

/** Save once-raised ordering work alongside the snapshot that raised it. */
export function rememberMlsOrdering(room: MlsRoomRecord, events: readonly any[]): void {
  for (const e of events) if (e.type === 'OrderingUnconfirmed') {
    const slot = bytesToHex(e.slot), attempt = e.attempt
    room.ordering ??= []
    if (!room.ordering.some(q => q.slot === slot && q.attempt === attempt)) {
      if (room.ordering.length >= 1024) throw new MlsRoomRefused('ordering-full')
      room.ordering.push({ slot, attempt })
    }
  }
}
