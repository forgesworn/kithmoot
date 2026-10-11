/** Existing-ledger state only. No genesis/import/reset or authority API.
 * Edits are proposals inside the caller's persona transaction; only actual
 * coordinator promotion can make them witnessed. No production import. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { InvalidPersonaRecord, type PersonaReader, type PersonaTransaction } from './mls-persona-coordinator.js'

export const MAX_ADMISSION_INTENTS = 1024
export const MAX_ADMISSION_INTENT_BYTES = 4 * 1024 * 1024
const MAX = (1n << 64n) - 1n
const DOMAIN = new TextEncoder().encode('kithmoot.admission-intent-ledger.v1\0')
export interface AdmissionIntentNamespace { persona: string; rendezvous: string }
export interface AdmissionIntentOwner { principal: string; browserDevice: string; engineDevice: string; credentialId: string }
export interface AdmissionRequestBinding {
  root: string; requestPubkey: string; requestEventId: string; requestCoreDigest: string; pairedBox: string
  requestedExpiry: number; createdAt: number; deadline: number
}
export interface AdmissionIntent extends AdmissionIntentOwner {
  operation: string; challenge: string; counter: string; createdAt: number; deadline: number
  state: 'reserved' | 'request-bound' | 'abandoned' | 'uncertain'
  request: AdmissionRequestBinding | null
}
export interface AdmissionIntentLedger {
  version: 1; persona: string; installation: string; rendezvous: string
  /** Decimal is the next unburned value. MAX burns once, then exhausted. */
  nextCounter: string | 'exhausted'; entries: AdmissionIntent[]
}
export class AdmissionIntentHold extends Error {
  constructor(readonly reason: 'missing-ledger' | 'capacity' | 'exhausted' | 'busy' | 'conflict' | 'entropy') {
    super(`Admission intent held: ${reason}`)
  }
}
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v)
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0)
const counter = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(v) && BigInt(v) <= MAX
const invalid = (): never => { throw new InvalidPersonaRecord('The admission intent ledger is unsupported or damaged.') }
function input<T>(read: () => T): T {
  try { return read() } catch { throw new Error('Invalid admission intent input.') }
}
function data(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(raw)
  if (Object.keys(descriptors).sort().join(',') !== [...keys].sort().join(',') || Object.values(descriptors).some(p => !('value' in p))) invalid()
  return Object.fromEntries(keys.map(k => [k, descriptors[k].value]))
}
const ownerKeys = ['principal', 'browserDevice', 'engineDevice', 'credentialId']
function owner(raw: unknown): AdmissionIntentOwner {
  const o = data(raw, ownerKeys)
  if (typeof o.principal !== 'string' || !o.principal || new TextEncoder().encode(JSON.stringify(o.principal)).length > 2048 || ![o.browserDevice, o.engineDevice, o.credentialId].every(hex)) invalid()
  return o as unknown as AdmissionIntentOwner
}
function namespace(raw: unknown): AdmissionIntentNamespace {
  const n = data(raw, ['persona', 'rendezvous'])
  if (!hex(n.persona) || !hex(n.rendezvous)) invalid()
  return n as unknown as AdmissionIntentNamespace
}
function binding(raw: unknown): AdmissionRequestBinding {
  const b = data(raw, ['root', 'requestPubkey', 'requestEventId', 'requestCoreDigest', 'pairedBox', 'requestedExpiry', 'createdAt', 'deadline'])
  if (![b.root, b.requestPubkey, b.requestEventId, b.requestCoreDigest, b.pairedBox].every(hex) || ![b.requestedExpiry, b.createdAt, b.deadline].every(uint) || (b.createdAt as number) >= (b.deadline as number) || (b.deadline as number) > (b.requestedExpiry as number)) invalid()
  return b as unknown as AdmissionRequestBinding
}
function validate(raw: unknown, n: AdmissionIntentNamespace, installation: string): AdmissionIntentLedger {
  const r = data(raw, ['version', 'persona', 'installation', 'rendezvous', 'nextCounter', 'entries'])
  if (r.version !== 1 || r.persona !== n.persona || r.rendezvous !== n.rendezvous || !hex(installation) || r.installation !== installation || !(counter(r.nextCounter) || r.nextCounter === 'exhausted') || !Array.isArray(r.entries) || r.entries.length > MAX_ADMISSION_INTENTS) invalid()
  const operations = new Set<string>(), challenges = new Set<string>(), counters = new Set<string>()
  let previous = -1n
  const entries = (r.entries as unknown[]).map(rawEntry => {
    const e = data(rawEntry, [...ownerKeys, 'operation', 'challenge', 'counter', 'createdAt', 'deadline', 'state', 'request'])
    owner(Object.fromEntries(ownerKeys.map(k => [k, e[k]])))
    if (!hex(e.operation) || !hex(e.challenge) || e.operation === e.challenge || e.operation === '00'.repeat(32) || e.challenge === '00'.repeat(32) || !counter(e.counter) || !uint(e.createdAt) || !uint(e.deadline) || e.createdAt >= e.deadline || !['reserved', 'request-bound', 'abandoned', 'uncertain'].includes(e.state as string)) invalid()
    const c = BigInt(e.counter as string)
    if (c <= previous || (r.nextCounter !== 'exhausted' && c >= BigInt(r.nextCounter as string)) || operations.has(e.operation as string) || challenges.has(e.challenge as string) || counters.has(e.counter as string)) invalid()
    previous = c; operations.add(e.operation as string); challenges.add(e.challenge as string); counters.add(e.counter as string)
    if (e.state === 'reserved' || e.state === 'abandoned') { if (e.request !== null) invalid() }
    else {
      const b = binding(e.request)
      if (b.createdAt !== e.createdAt || b.deadline !== e.deadline) invalid()
      e.request = b
    }
    return e as unknown as AdmissionIntent
  })
  return { ...r, entries } as unknown as AdmissionIntentLedger
}
export function admissionIntentRecordId(rendezvous: string): string {
  if (!hex(rendezvous)) throw new Error('Invalid rendezvous ledger id.')
  const bytes = new Uint8Array(DOMAIN.length + 32); bytes.set(DOMAIN); bytes.set(hexToBytes(rendezvous), DOMAIN.length)
  return bytesToHex(sha256(bytes))
}
/** Missing is a hold, never an empty ledger or counter zero. The coordinator
 * must have reconciled this reader; structural readers confer no authority. */
export async function readAdmissionIntentLedger(tx: PersonaReader, rawNamespace: AdmissionIntentNamespace): Promise<AdmissionIntentLedger> {
  const n = input(() => namespace(rawNamespace))
  const bytes = await tx.readVault(admissionIntentRecordId(n.rendezvous))
  if (!bytes) throw new AdmissionIntentHold('missing-ledger')
  try {
    if (bytes.length > MAX_ADMISSION_INTENT_BYTES) invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const raw: unknown = JSON.parse(text)
    if (JSON.stringify(raw) !== text) invalid()
    return validate(raw, n, tx.installation)
  } catch { return invalid() }
  finally { bytes.fill(0) }
}
async function save(tx: PersonaTransaction, n: AdmissionIntentNamespace, ledger: AdmissionIntentLedger): Promise<void> {
  const checked = validate(ledger, n, tx.installation)
  const bytes = new TextEncoder().encode(JSON.stringify(checked))
  try {
    if (bytes.length > MAX_ADMISSION_INTENT_BYTES) throw new AdmissionIntentHold('capacity')
    await tx.putVault(admissionIntentRecordId(n.rendezvous), bytes)
  } finally { bytes.fill(0) }
}
const sameOwner = (a: AdmissionIntentOwner, b: AdmissionIntentOwner) => ownerKeys.every(k => a[k as keyof AdmissionIntentOwner] === b[k as keyof AdmissionIntentOwner])
/** A proposal only: never sign/publish using this provisional callback result.
 * One unsettled intent per owner prevents a lost acknowledgement from burning
 * a second counter on an ordinary retry. Reconcile/read the retained row first. */
export async function reserveAdmissionIntent(tx: PersonaTransaction, rawNamespace: AdmissionIntentNamespace, rawOwner: AdmissionIntentOwner,
  createdAt: number, deadline: number): Promise<AdmissionIntent> {
  const n = input(() => namespace(rawNamespace)), o = input(() => owner(rawOwner))
  if (!uint(createdAt) || !uint(deadline) || createdAt >= deadline) throw new Error('Invalid admission intent time.')
  const ledger = await readAdmissionIntentLedger(tx, n)
  if (ledger.entries.some(e => sameOwner(e, o) && e.state !== 'abandoned')) throw new AdmissionIntentHold('busy')
  if (ledger.entries.length >= MAX_ADMISSION_INTENTS) throw new AdmissionIntentHold('capacity')
  if (ledger.nextCounter === 'exhausted') throw new AdmissionIntentHold('exhausted')
  const operationBytes = new Uint8Array(32), challengeBytes = new Uint8Array(32)
  let operation: string, challenge: string
  try {
    globalThis.crypto.getRandomValues(operationBytes); globalThis.crypto.getRandomValues(challengeBytes)
    operation = bytesToHex(operationBytes); challenge = bytesToHex(challengeBytes)
  } catch { throw new AdmissionIntentHold('entropy') }
  finally { operationBytes.fill(0); challengeBytes.fill(0) }
  if (operation === challenge || operation === '00'.repeat(32) || challenge === '00'.repeat(32) || ledger.entries.some(e => e.operation === operation || e.challenge === challenge)) throw new AdmissionIntentHold('entropy')
  const entry: AdmissionIntent = { ...o, operation, challenge, counter: ledger.nextCounter, createdAt, deadline, state: 'reserved', request: null }
  ledger.nextCounter = BigInt(entry.counter) === MAX ? 'exhausted' : (BigInt(entry.counter) + 1n).toString()
  ledger.entries.push(entry); await save(tx, n, ledger)
  return structuredClone(entry)
}
async function selected(tx: PersonaTransaction, n: AdmissionIntentNamespace, o: AdmissionIntentOwner, operation: string) {
  if (!hex(operation)) throw new Error('Invalid admission intent operation.')
  const ledger = await readAdmissionIntentLedger(tx, n)
  const entry = ledger.entries.find(e => e.operation === operation)
  if (!entry || !sameOwner(entry, o)) throw new AdmissionIntentHold('conflict')
  return { ledger, entry }
}
/** Fixed request data, not verified proofs. The future private owner must
 * validate its actual core/event and promote this binding BEFORE signing. */
export async function bindAdmissionRequest(tx: PersonaTransaction, rawNamespace: AdmissionIntentNamespace, rawOwner: AdmissionIntentOwner,
  operation: string, rawBinding: AdmissionRequestBinding): Promise<AdmissionIntent> {
  const n = input(() => namespace(rawNamespace)), o = input(() => owner(rawOwner)), b = input(() => binding(rawBinding))
  const { ledger, entry } = await selected(tx, n, o, operation)
  if (b.createdAt !== entry.createdAt || b.deadline !== entry.deadline) throw new AdmissionIntentHold('conflict')
  if (entry.state === 'request-bound' && JSON.stringify(entry.request) === JSON.stringify(b)) return structuredClone(entry)
  if (entry.state !== 'reserved') throw new AdmissionIntentHold('conflict')
  entry.state = 'request-bound'; entry.request = b; await save(tx, n, ledger); return structuredClone(entry)
}
/** Only a pre-binding intent can be safely labelled abandoned before signing.
 * Neither abandonment nor expiry removes the burned counter or retained row. */
export async function abandonAdmissionIntent(tx: PersonaTransaction, rawNamespace: AdmissionIntentNamespace, rawOwner: AdmissionIntentOwner,
  operation: string): Promise<AdmissionIntent> {
  const n = input(() => namespace(rawNamespace)), o = input(() => owner(rawOwner)), { ledger, entry } = await selected(tx, n, o, operation)
  if (entry.state === 'abandoned') return structuredClone(entry)
  if (entry.state !== 'reserved') throw new AdmissionIntentHold('conflict')
  entry.state = 'abandoned'; await save(tx, n, ledger); return structuredClone(entry)
}
/** Possible signing/external effects remain held, with their exact binding. */
export async function markAdmissionIntentUncertain(tx: PersonaTransaction, rawNamespace: AdmissionIntentNamespace, rawOwner: AdmissionIntentOwner,
  operation: string): Promise<AdmissionIntent> {
  const n = input(() => namespace(rawNamespace)), o = input(() => owner(rawOwner)), { ledger, entry } = await selected(tx, n, o, operation)
  if (entry.state === 'uncertain') return structuredClone(entry)
  if (entry.state !== 'request-bound') throw new AdmissionIntentHold('conflict')
  entry.state = 'uncertain'; await save(tx, n, ledger); return structuredClone(entry)
}
