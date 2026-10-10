import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
export { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import { InvalidPersonaRecord, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'
import { validateMlsRevocationInbox, type MlsRevocationInboxState } from './mls-revocation-inbox-store.js'

export const MAX_MLS_REMOVALS = 64
export const MAX_MLS_STANDALONE_REVOCATIONS = 64
export const MAX_MLS_MEMBERSHIP_BYTES = 1024 * 1024
// Keep room for all 1024 verified attempt IDs, including safe-integer times.
// Seen bytes already present consume this reserve rather than paying twice.
export const MLS_MEMBERSHIP_SEEN_RESERVE_BYTES = 110 * 1024
const RECORD = bytesToHex(new TextEncoder().encode('kithmoot.mls-membership.v1'))
const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const byteHex = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{2})+$/.test(value) && value.length <= 131_072
const exact = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys
const invalid = (): never => { throw new InvalidPersonaRecord('Invalid MLS membership journal') }

export interface MlsRemovalRecord {
  operation: string
  session: string
  kind: 'device' | 'person'
  target: string
  compromised: boolean
  createdAt: number
  attempts: number
  failure: string | null
  journal: string
  request?: { keeper: string; device: string; sessions: string[]; boxes: string[] }
}
export interface MlsStandaloneRevocationRecord {
  operation: string
  sender: string
  keeper: string
  device: string
  sessions: string[]
  boxes: string[]
  createdAt: number
  sentAt: number | null
}
export interface MlsMembershipJournal { version: 1; removals: MlsRemovalRecord[]; requests: MlsStandaloneRevocationRecord[]; inbox?: MlsRevocationInboxState }

function validate(record: MlsMembershipJournal | (Omit<MlsMembershipJournal, 'requests'> & { requests?: MlsStandaloneRevocationRecord[] })): void {
  if (!record || typeof record !== 'object' || !exact(record, [...(record.inbox === undefined ? [] : ['inbox']), 'removals', ...(record.requests === undefined ? [] : ['requests']), 'version'].sort().join(',')) || record.version !== 1 ||
      !Array.isArray(record.removals) || record.removals.length > MAX_MLS_REMOVALS) invalid()
  if (record.inbox !== undefined) validateMlsRevocationInbox(record.inbox)
  const operations = new Set<string>()
  for (const removal of record.removals) {
    if (!removal || typeof removal !== 'object' || !exact(removal, ['attempts','compromised','createdAt','failure','journal','kind','operation', ...(removal.request ? ['request'] : []), 'session','target'].sort().join(',')) ||
        !hex32(removal.operation) || !hex32(removal.session) || !['device', 'person'].includes(removal.kind) || !hex32(removal.target) ||
        typeof removal.compromised !== 'boolean' || !Number.isSafeInteger(removal.createdAt) || removal.createdAt < 0 ||
        !Number.isSafeInteger(removal.attempts) || removal.attempts < 0 || removal.attempts > 1000 ||
        !(removal.failure === null || typeof removal.failure === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(removal.failure)) ||
        !byteHex(removal.journal) || operations.has(removal.operation)) invalid()
    if (removal.request && (!exact(removal.request, 'boxes,device,keeper,sessions') || !hex32(removal.request.keeper) ||
        !hex32(removal.request.device) || !Array.isArray(removal.request.sessions) || removal.request.sessions.length < 1 || removal.request.sessions.length > 64 ||
        !removal.request.sessions.every(hex32) || new Set(removal.request.sessions).size !== removal.request.sessions.length ||
        !Array.isArray(removal.request.boxes) || removal.request.boxes.length < 1 || removal.request.boxes.length > 64 ||
        !removal.request.boxes.every(hex32) || new Set(removal.request.boxes).size !== removal.request.boxes.length)) invalid()
    operations.add(removal.operation)
  }
  if (record.requests === undefined) return
  if (!Array.isArray(record.requests) || record.requests.length > MAX_MLS_STANDALONE_REVOCATIONS) invalid()
  const requestOperations = new Set<string>(), targets = new Set<string>()
  for (const request of record.requests) {
    if (!request || typeof request !== 'object' || !exact(request, 'boxes,createdAt,device,keeper,operation,sender,sentAt,sessions') ||
        !hex32(request.operation) || !hex32(request.sender) || !hex32(request.keeper) || request.sender === request.keeper || !hex32(request.device) ||
        request.operation !== mlsStandaloneRevocationOperation(request.sender, request.keeper, request.device) ||
        !Array.isArray(request.sessions) || request.sessions.length < 1 || request.sessions.length > 64 || !request.sessions.every(hex32) ||
        new Set(request.sessions).size !== request.sessions.length || request.sessions.some((value, index) => index > 0 && request.sessions[index - 1]! >= value) ||
        !Array.isArray(request.boxes) || request.boxes.length < 1 || request.boxes.length > 64 || !request.boxes.every(hex32) ||
        new Set(request.boxes).size !== request.boxes.length || request.boxes.some((value, index) => index > 0 && request.boxes[index - 1]! >= value) ||
        !Number.isSafeInteger(request.createdAt) || request.createdAt < 0 ||
        !(request.sentAt === null || Number.isSafeInteger(request.sentAt) && request.sentAt >= request.createdAt) ||
        requestOperations.has(request.operation) || targets.has(`${request.sender}/${request.keeper}/${request.device}`)) invalid()
    requestOperations.add(request.operation); targets.add(`${request.sender}/${request.keeper}/${request.device}`)
  }
}

export async function readMlsMembership(tx: PersonaReader): Promise<MlsMembershipJournal> {
  const bytes = await tx.readVault(RECORD)
  if (!bytes) return { version: 1, removals: [], requests: [] }
  try {
    if (bytes.length > MAX_MLS_MEMBERSHIP_BYTES) return invalid()
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as MlsMembershipJournal & { requests?: MlsStandaloneRevocationRecord[] }
    validate(record)
    return { ...record, requests: record.requests ?? [] }
  } catch (error) { if (error instanceof InvalidPersonaRecord) throw error; return invalid() }
  finally { bytes.fill(0) }
}

export async function saveMlsMembership(tx: PersonaTransaction, record: MlsMembershipJournal): Promise<void> {
  validate(record)
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  try {
    // Validated seen fields contain ASCII hex, decimal integers and fixed keys.
    const seenBytes = record.inbox ? JSON.stringify(record.inbox.seen).length - 2 : 0
    if (bytes.length + Math.max(0, MLS_MEMBERSHIP_SEEN_RESERVE_BYTES - seenBytes) > MAX_MLS_MEMBERSHIP_BYTES) throw new Error('MLS membership journal is full')
    await tx.putVault(RECORD, bytes)
  } finally { bytes.fill(0) }
}

export function removalBytes(record: MlsRemovalRecord): Uint8Array { return hexToBytes(record.journal) }
