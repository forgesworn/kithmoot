/** Local purpose boundary for the witnessed vault. This module never signs,
 * exposes a scalar, stores a bearer or claims current keeper/admission authority. */
import { MLS_ADMISSION_LABELS, mlsAdmissionProofTemplatesV4, type VerifiedMlsAdmissionRequest } from '@forgesworn/fold-kit/mls-admission'
import { getEventHash, type Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import { verifyPersonCredential } from '../../src/vmls/binding.js'
import { InvalidPersonaRecord, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { DeviceRecord, VaultContext } from './mls-vault.js'
import type { UnsignedEvent } from '../../src/identity.js'

export const ADMISSION_PROOF_METHOD = 'signMlsAdmissionProofV4/1'
export const MAX_ADMISSION_PROOF_RECORDS = 1024
export const MAX_ADMISSION_PROOF_JOURNAL_BYTES = 4 * 1024 * 1024
export const ADMISSION_PROOF_RECORD = '6b6974686d6f6f742e61646d697373696f6e2d70726f6f662d6a6f75726e616c2e7631'
export type AdmissionProofRole = 'engine-device' | 'keeper-device'
export type AdmissionProofInput = { v: 4; role: AdmissionProofRole; fragment: string; core: string; request?: VerifiedMlsAdmissionRequest }
export interface AdmissionProofConsent {
  readonly method: typeof ADMISSION_PROOF_METHOD
  readonly principal: string
  readonly persona: string
  readonly device: string
  readonly credentialId: string
  readonly role: AdmissionProofRole
  readonly operation: string
  readonly coreDigest: string
  readonly eventId: string
  readonly deadline: number
  /** Exact consented public ceremony tuple, private to the app. No bearer. */
  readonly core: string
}
export type AdmissionProofPrompt = (scope: AdmissionProofConsent) => Promise<'approve' | 'deny'>
export interface AdmissionProofReply {
  readonly v: 4
  readonly role: AdmissionProofRole
  readonly operation: string
  readonly coreDigest: string
  readonly device: string
  readonly credentialId: string
  readonly deadline: number
  /** Canonical seven-field signed Nostr event array, not admission authority. */
  readonly event: string
}
export interface AdmissionProofPlan {
  consent: AdmissionProofConsent
  template: UnsignedEvent
  key: string
}
export interface AdmissionProofEntry {
  principal: string
  role: AdmissionProofRole
  operation: string
  coreDigest: string
  eventId: string
  device: string
  credentialId: string
  createdAt: number
  deadline: number
  generation: number
  revision: string
  reservation: string
  outcome: 'pending' | 'denied' | { event: string }
}
interface Journal { version: 1; persona: string; installation: string; entries: AdmissionProofEntry[] }
const hex = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
const uint = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0)
const bad = (): never => { throw new Error('Invalid admission proof operation.') }
const shape = (o: unknown, keys: string[]) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === keys.sort().join(',')

/** Snapshot data properties before any asynchronous work. Nominal request
 * evidence is passed unchanged to the codec's private issuance check. */
export function admissionProofInput(raw: unknown): AdmissionProofInput | undefined {
  try {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return undefined
  if (Object.getOwnPropertySymbols(raw).length) return undefined
  const props = Object.getOwnPropertyDescriptors(raw)
  if (Object.values(props).some(p => !('value' in p))) return undefined
  const value = Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.value]))
  const keeper = value.role === 'keeper-device'
  if (!shape(value, keeper ? ['v', 'role', 'fragment', 'core', 'request'] : ['v', 'role', 'fragment', 'core'])) return undefined
  if (value.v !== 4 || (value.role !== 'engine-device' && !keeper) || typeof value.fragment !== 'string' || value.fragment.length > 1024 || typeof value.core !== 'string' || value.core.length > 16384) return undefined
  return Object.freeze({ v: 4, role: value.role as AdmissionProofRole, fragment: value.fragment, core: value.core, ...(keeper ? { request: value.request as VerifiedMlsAdmissionRequest } : {}) })
  } catch { return undefined }
}
export function admissionProofPlan(input: AdmissionProofInput, ctx: VaultContext, device: DeviceRecord, revoked: readonly string[], now: number): AdmissionProofPlan {
  if (!uint(now)) bad()
  const keeper = input.role === 'keeper-device'
  const { spec, core } = selectedTemplate(input, now)
  const c = core[keeper ? 17 : 11] as unknown[]
  const checked = verifyPersonCredential(device.credential, now, ctx.persona)
  const own = [device.credentialId, ctx.persona, device.credential.created_at, device.credential.kind, device.credential.tags, device.credential.content, device.credential.sig]
  if (checked.id !== device.credentialId || checked.device !== device.device || checked.expiresAt !== device.credentialExpiresAt || revoked.includes(checked.id) || core[keeper ? 15 : 7] !== ctx.persona || spec.pubkey !== device.device || JSON.stringify(c) !== JSON.stringify(own)) bad()
  const deadline = Math.min(core[keeper ? 26 : 16] as number, checked.expiresAt)
  if (now >= deadline || checked.expiresAt < (core[keeper ? 23 : 14] as number)) bad()
  const content = JSON.parse(spec.event.content) as [4, string]
  const eventId = getEventHash({ ...spec.event, pubkey: spec.pubkey })
  const consent: AdmissionProofConsent = Object.freeze({ method: ADMISSION_PROOF_METHOD, principal: ctx.principal, persona: ctx.persona, device: device.device, credentialId: device.credentialId,
    role: input.role, operation: core[keeper ? 7 : 5] as string, coreDigest: content[1], eventId, deadline, core: input.core })
  return { consent, template: spec.event, key: JSON.stringify([4, input.role, consent.operation, content[1], eventId, deadline, device.device, device.credentialId]) }
}
function selectedTemplate(input: AdmissionProofInput, now: number) {
  const specs = mlsAdmissionProofTemplatesV4({ fragment: input.fragment, core: input.core, request: input.request, now })
  const core = JSON.parse(input.core) as unknown[]
  const keeper = input.role === 'keeper-device'
  if (keeper ? core.length !== 27 || core[1] !== MLS_ADMISSION_LABELS[4] || core[2] !== 'allow' || specs.length !== 2
    : core.length !== 17 || core[1] !== MLS_ADMISSION_LABELS[3] || specs.length !== 3) bad()
  return { core, spec: specs[keeper ? 1 : 2] }
}
export function admissionProofTemplates(input: AdmissionProofInput, now: number): { pubkey: string; id: string } {
  const { spec } = selectedTemplate(input, now)
  return { pubkey: spec.pubkey, id: getEventHash({ ...spec.event, pubkey: spec.pubkey }) }
}
export function admissionProofKey(reply: AdmissionProofReply): string {
  const event = admissionProofEvent(reply.event)
  return JSON.stringify([4, reply.role, reply.operation, reply.coreDigest, event.id, reply.deadline, reply.device, reply.credentialId])
}
export function admissionProofEvent(raw: string): Event {
  if (typeof raw !== 'string' || raw.length > 4096 || new TextEncoder().encode(raw).length > 4096) bad()
  const e = JSON.parse(raw) as unknown[]
  if (!Array.isArray(e) || e.length !== 7 || JSON.stringify(e) !== raw || !hex(e[0]) || !hex(e[1]) || !uint(e[2]) || !uint(e[3]) || !Array.isArray(e[4]) || typeof e[5] !== 'string' || typeof e[6] !== 'string' || !/^[0-9a-f]{128}$/.test(e[6])) bad()
  const event: Event = { id: e[0] as string, pubkey: e[1] as string, created_at: e[2] as number, kind: e[3] as number, tags: e[4] as string[][], content: e[5] as string, sig: e[6] as string }
  if (!verifyEventUncached(event)) bad()
  return event
}
export function admissionProofWire(event: Event): string {
  return JSON.stringify([event.id, event.pubkey, event.created_at, event.kind, event.tags, event.content, event.sig])
}
export function admissionProofReply(entry: AdmissionProofEntry): AdmissionProofReply {
  const outcome = entry.outcome
  if (typeof outcome !== 'object') return bad()
  return Object.freeze({ v: 4, role: entry.role, operation: entry.operation, coreDigest: entry.coreDigest, device: entry.device, credentialId: entry.credentialId, deadline: entry.deadline, event: outcome.event })
}
export function matchingAdmissionProof(entry: AdmissionProofEntry, plan: AdmissionProofPlan): boolean {
  const c = plan.consent
  return entry.coreDigest === c.coreDigest && entry.eventId === c.eventId && entry.deadline === c.deadline && entry.device === c.device && entry.credentialId === c.credentialId
}
function validateJournal(raw: unknown, persona: string, installation: string): asserts raw is Journal {
  const invalid = (): never => { throw new InvalidPersonaRecord('The admission proof journal is unsupported or damaged.') }
  if (!shape(raw, ['version', 'persona', 'installation', 'entries'])) invalid()
  const j = raw as Journal
  if (j.version !== 1 || j.persona !== persona || j.installation !== installation || !Array.isArray(j.entries) || j.entries.length > MAX_ADMISSION_PROOF_RECORDS) invalid()
  const seen = new Set<string>()
  for (const e of j.entries) {
    if (!shape(e, ['principal', 'role', 'operation', 'coreDigest', 'eventId', 'device', 'credentialId', 'createdAt', 'deadline', 'generation', 'revision', 'reservation', 'outcome'])) invalid()
    if (typeof e.principal !== 'string' || !e.principal || new TextEncoder().encode(JSON.stringify(e.principal)).length > 2048 || !['engine-device', 'keeper-device'].includes(e.role) || ![e.operation, e.coreDigest, e.eventId, e.device, e.credentialId, e.reservation].every(hex) || !uint(e.createdAt) || !uint(e.deadline) || e.createdAt >= e.deadline || !uint(e.generation) || typeof e.revision !== 'string' || !e.revision || new TextEncoder().encode(JSON.stringify(e.revision)).length > 256) invalid()
    const key = JSON.stringify([e.role, e.operation])
    if (seen.has(key)) invalid(); seen.add(key)
    if (e.outcome === 'pending' || e.outcome === 'denied') continue
    if (!shape(e.outcome, ['event'])) invalid()
    try {
      const event = admissionProofEvent(e.outcome.event)
      if (event.id !== e.eventId || event.pubkey !== e.device || event.created_at !== e.createdAt || event.kind !== (e.role === 'engine-device' ? 20466 : 20467) || JSON.stringify(event.tags) !== JSON.stringify([['t', MLS_ADMISSION_LABELS[e.role === 'engine-device' ? 7 : 9]]]) || event.content !== JSON.stringify([4, e.coreDigest])) invalid()
    } catch { invalid() }
  }
}
export async function readAdmissionProofJournal(tx: PersonaReader, persona: string): Promise<AdmissionProofEntry[]> {
  const bytes = await tx.readVault(ADMISSION_PROOF_RECORD)
  if (!bytes) return []
  try {
    if (bytes.length > MAX_ADMISSION_PROOF_JOURNAL_BYTES) throw new InvalidPersonaRecord('The admission proof journal exceeds its bound.')
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    validateJournal(raw, persona, tx.installation)
    return raw.entries
  } catch { throw new InvalidPersonaRecord('The admission proof journal is unsupported or damaged.') }
  finally { bytes.fill(0) }
}
export async function saveAdmissionProofJournal(tx: PersonaTransaction, persona: string, entries: AdmissionProofEntry[]): Promise<void> {
  const record: Journal = { version: 1, persona, installation: tx.installation, entries }
  validateJournal(record, persona, tx.installation)
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  try {
    if (bytes.length > MAX_ADMISSION_PROOF_JOURNAL_BYTES) throw new Error('The admission proof journal exceeds its bound.')
    await tx.putVault(ADMISSION_PROOF_RECORD, bytes)
  } finally { bytes.fill(0) }
}
