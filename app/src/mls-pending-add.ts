import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import type { MlsPackageRoute } from './mls-room-store.js'
import type { MlsMemberStatus } from './mls-room-operations.js'
import type { MlsRemovalRecord } from './mls-membership-store.js'
import type { loadMlsEngine } from './mls-engine.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

/** Stored only inside the sealed, witnessed room. The proposal and candidate
 * are written atomically with Session.add; a route is not identity evidence. */
export interface MlsPendingAdd {
  identity: string; device: string; credentialId: string
  credentialExpiresAt: number; bindingExpiresAt: number; route: MlsPackageRoute
  proposal: { generation: string; recordId: string; mailbox: string; envelopeHash: string; epoch: string; attempt: number }
  carrier?: { recordId: string; mailbox: string; envelopeHash: string; attempt: number }
  readback?: { kind: 'proposal-committed' | 'current-observed'; generation: string; envelopeHash: string }
}
/** A genuine removal already witnessed before keeper consent. It proves only
 * historical MLS closure, never grant withdrawal or remote access expiry. */
export interface MlsPriorAddRemoval { operation: string; recordDigest: string; readbackDigest: string }
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})(?![\s\S])/.test(v) && BigInt(v) <= 0x7fffffffffffffffn
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
export function validateMlsPendingAdd(value: MlsPendingAdd): void {
  const invalid = (): never => { throw new InvalidPersonaRecord('Invalid authenticated pending Add') }
  if (!value || typeof value !== 'object' || !exact(value, ['bindingExpiresAt', ...(value.carrier ? ['carrier'] : []), 'credentialExpiresAt', 'credentialId', 'device', 'identity', 'proposal', ...(value.readback ? ['readback'] : []), 'route'].join(',')) ||
      ![value.identity, value.device, value.credentialId].every(hex) || !time(value.credentialExpiresAt) || !time(value.bindingExpiresAt)) invalid()
  const r = value.route, p = value.proposal, seen = value.readback
  if (!r || !exact(r, 'expiresAt,homeBox,leafId,packageId,welcomeMailbox') || ![r.homeBox, r.leafId, r.packageId, r.welcomeMailbox].every(hex) || !time(r.expiresAt) ||
      !p || !exact(p, 'attempt,envelopeHash,epoch,generation,mailbox,recordId') || !uint(p.generation) || p.generation === '0' || !uint(p.epoch) ||
      ![p.recordId, p.mailbox, p.envelopeHash].every(hex) || !Number.isInteger(p.attempt) || p.attempt < 0 || p.attempt > 0xffffffff ||
      seen && (!exact(seen, 'envelopeHash,generation,kind') || !['proposal-committed', 'current-observed'].includes(seen.kind) || !uint(seen.generation) || BigInt(seen.generation) <= BigInt(p.generation) || !hex(seen.envelopeHash))) invalid()
  const c = value.carrier
  if (c && (!exact(c, 'attempt,envelopeHash,mailbox,recordId') || ![c.recordId, c.mailbox, c.envelopeHash].every(hex) || !Number.isInteger(c.attempt) || c.attempt <= p.attempt || c.attempt > 0xffffffff)) invalid()
}
export function mlsPendingAddMember(candidate: MlsPendingAdd): MlsMemberStatus {
  validateMlsPendingAdd(candidate)
  return { leafId: candidate.route.leafId, identity: candidate.identity, device: candidate.device, homeBox: candidate.route.homeBox,
    bindingExpiresAt: candidate.bindingExpiresAt, own: false, pending: true }
}
export function mlsPendingAddMatches(candidate: MlsPendingAdd, member: MlsMemberStatus): boolean {
  const expected = mlsPendingAddMember(candidate)
  return !member.own && ['leafId', 'identity', 'device', 'homeBox', 'bindingExpiresAt'].every(key =>
    expected[key as keyof MlsMemberStatus] === member[key as keyof MlsMemberStatus])
}
export function validateMlsPriorAddRemoval(value: MlsPriorAddRemoval): void {
  if (!value || typeof value !== 'object' || !exact(value, 'operation,readbackDigest,recordDigest') || ![value.operation, value.recordDigest, value.readbackDigest].every(hex)) throw new InvalidPersonaRecord('Invalid prior Add removal proof')
}
const priorLabel = new TextEncoder().encode('kithmoot/vmls-prior-add-removal/v1')
const readbackLabel = new TextEncoder().encode('kithmoot/vmls-prior-add-readback/v1')
export function mlsPriorAddRemoval(record: MlsRemovalRecord, candidate: MlsPendingAdd): MlsPriorAddRemoval {
  validateMlsPendingAdd(candidate)
  if (!candidate.readback) throw new InvalidPersonaRecord('Prior Add closure lost its authenticated readback')
  const bytes = new TextEncoder().encode(JSON.stringify([record.operation, record.session, record.kind, record.target, record.compromised,
    record.createdAt, record.attempts, record.failure, record.journal, record.request ?? null]))
  const readback = new TextEncoder().encode(JSON.stringify([candidate.readback.kind, candidate.readback.generation, candidate.readback.envelopeHash]))
  try { return { operation: record.operation, recordDigest: bytesToHex(sha256(concatBytes(priorLabel, bytes))), readbackDigest: bytesToHex(sha256(concatBytes(readbackLabel, readback))) } }
  finally { bytes.fill(0); readback.fill(0) }
}
export function mlsPriorAddRemovalCommitted(wasm: Awaited<ReturnType<typeof loadMlsEngine>>, prior: MlsPriorAddRemoval,
  candidate: MlsPendingAdd, session: string, record: MlsRemovalRecord | undefined, approvedAt: number): boolean {
  validateMlsPriorAddRemoval(prior)
  if (!record || record.operation !== prior.operation || record.session !== session || record.kind !== 'device' || record.target !== candidate.route.leafId ||
      record.request || record.createdAt > approvedAt) throw new InvalidPersonaRecord('The frozen prior Add removal changed or disappeared')
  const current = mlsPriorAddRemoval(record, candidate)
  if (current.recordDigest !== prior.recordDigest || current.readbackDigest !== prior.readbackDigest) throw new InvalidPersonaRecord('The frozen prior Add removal or readback changed')
  const bytes = hexToBytes(record.journal)
  let removal: ReturnType<typeof wasm.removalDecode> | undefined
  try {
    try { removal = wasm.removalDecode(bytes) } catch { throw new InvalidPersonaRecord('Prior Add removal cannot be decoded') }
    if (bytesToHex(removal.sessionId()) !== session || removal.personIdentity() !== undefined ||
        JSON.stringify(removal.leafIds().map(bytesToHex)) !== JSON.stringify([candidate.route.leafId])) throw new InvalidPersonaRecord('Prior Add removal is not the exact genuine leaf removal')
    return removal.mls() === 'Committed'
  } finally { bytes.fill(0); removal?.free() }
}
export function verifyMlsPriorAddRemoval(...args: Parameters<typeof mlsPriorAddRemovalCommitted>): void {
  if (!mlsPriorAddRemovalCommitted(...args)) throw new InvalidPersonaRecord('Prior Add removal is not the exact genuine Committed leaf removal')
}
