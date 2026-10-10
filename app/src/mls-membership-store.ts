import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { InvalidPersonaRecord, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'

export const MAX_MLS_REMOVALS = 64
export const MAX_MLS_MEMBERSHIP_BYTES = 1024 * 1024
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
export interface MlsMembershipJournal { version: 1; removals: MlsRemovalRecord[] }

function validate(record: MlsMembershipJournal): void {
  if (!record || typeof record !== 'object' || !exact(record, 'removals,version') || record.version !== 1 ||
      !Array.isArray(record.removals) || record.removals.length > MAX_MLS_REMOVALS) invalid()
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
}

export async function readMlsMembership(tx: PersonaReader): Promise<MlsMembershipJournal> {
  const bytes = await tx.readVault(RECORD)
  if (!bytes) return { version: 1, removals: [] }
  try {
    if (bytes.length > MAX_MLS_MEMBERSHIP_BYTES) return invalid()
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as MlsMembershipJournal
    validate(record)
    return record
  } catch (error) { if (error instanceof InvalidPersonaRecord) throw error; return invalid() }
  finally { bytes.fill(0) }
}

export async function saveMlsMembership(tx: PersonaTransaction, record: MlsMembershipJournal): Promise<void> {
  validate(record)
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  try {
    if (bytes.length > MAX_MLS_MEMBERSHIP_BYTES) throw new Error('MLS membership journal is full')
    await tx.putVault(RECORD, bytes)
  } finally { bytes.fill(0) }
}

export function removalBytes(record: MlsRemovalRecord): Uint8Array { return hexToBytes(record.journal) }
