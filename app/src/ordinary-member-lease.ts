import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import type { DeviceCredential } from '../../src/types.js'
import { credentialSeal } from '../../src/seal.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { ordinaryPairReadCustodyFor, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { readPersistentAdmissionProof, persistentProofName, accountPrefix,
  MAX_PERSISTENT_PROOF_BYTES, type PersistentAdmissionProof, type VerifiedPersistentProof } from './persistent-admission-proof.js'
import type { DeviceStore } from './device-store.js'

export const MEMBER_LEASE_PREFIX = 'kithmoot.member-lease.v1.'
// Two proof strings, each escaped at most twice, plus two fixed headers.
export const MAX_MEMBER_LEASE_BYTES = 4 * MAX_PERSISTENT_PROOF_BYTES + 16_384
const DOMAIN = 'kithmoot/member-lease/v1'
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function verifiedProof(raw: string): VerifiedPersistentProof {
  try { return readPersistentAdmissionProof(raw) } catch { return hold() }
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) hold()
  return value as number
}
function hex(value: unknown): string { if (typeof value !== 'string' || !HEX.test(value)) hold(); return value }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) hold()
}
export function memberLeaseDigest(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  try { return bytesToHex(sha256(bytes)) } finally { bytes.fill(0) }
}
export interface OrdinaryMemberAuthority {
  readonly tabExpiresAt: number
  readonly admissionEndsAt: number | null
  readonly foregroundExpiresAt: number | null
  // No current membership-lease producer exists. Never infer it from replay.
  readonly membershipEndsAt: null
}
function authority(raw: unknown): OrdinaryMemberAuthority {
  object(raw, ['tabExpiresAt','admissionEndsAt','foregroundExpiresAt','membershipEndsAt'])
  const tabExpiresAt = integer(raw.tabExpiresAt)
  const admissionEndsAt = raw.admissionEndsAt === null ? null : integer(raw.admissionEndsAt)
  const foregroundExpiresAt = raw.foregroundExpiresAt === null ? null : integer(raw.foregroundExpiresAt)
  if (!tabExpiresAt || raw.membershipEndsAt !== null) hold()
  return Object.freeze({ tabExpiresAt, admissionEndsAt, foregroundExpiresAt, membershipEndsAt: null })
}
export function ordinaryMemberAuthorityUntil(value: OrdinaryMemberAuthority): number {
  const a = authority(value)
  return Math.min(Math.floor(a.tabExpiresAt / 1000), a.admissionEndsAt ?? Infinity,
    a.foregroundExpiresAt === null ? Infinity : Math.floor(a.foregroundExpiresAt / 1000))
}
export interface OrdinaryMemberLeaseSource {
  readonly browserRevision: number
  readonly tabRevision: number
  readonly hash: string
}
export interface OrdinaryMemberLeaseHeader {
  readonly sequence: number
  readonly bootstrap: string
  readonly predecessor: string | null
  readonly proof: string
  readonly credential: string
  readonly seal: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly authority: OrdinaryMemberAuthority
  readonly source: OrdinaryMemberLeaseSource
  readonly operation: string
}
export interface OrdinaryMemberLease {
  readonly version: 1
  readonly domain: typeof DOMAIN
  readonly header: OrdinaryMemberLeaseHeader
  readonly bootstrapProof: string
  readonly predecessorProof: string
  readonly predecessorHeader: OrdinaryMemberLeaseHeader
}
export type OrdinaryMemberLeaseHeaderBody = Omit<OrdinaryMemberLeaseHeader, 'operation'>
export function ordinaryMemberLeaseHeader(input: unknown): OrdinaryMemberLeaseHeader {
  object(input, ['sequence','bootstrap','predecessor','proof','credential','seal','issuedAt','expiresAt','authority','source','operation'])
  object(input.source, ['browserRevision','tabRevision','hash'])
  const body: OrdinaryMemberLeaseHeaderBody = {
    sequence: integer(input.sequence), bootstrap: hex(input.bootstrap), predecessor: input.predecessor === null ? null : hex(input.predecessor),
    proof: hex(input.proof), credential: hex(input.credential), seal: hex(input.seal), issuedAt: integer(input.issuedAt), expiresAt: integer(input.expiresAt),
    authority: authority(input.authority), source: Object.freeze({ browserRevision: integer(input.source.browserRevision),
      tabRevision: integer(input.source.tabRevision), hash: hex(input.source.hash) }),
  }
  if (body.expiresAt <= body.issuedAt || body.expiresAt > ordinaryMemberAuthorityUntil(body.authority) ||
      memberLeaseDigest([DOMAIN, body]) !== hex(input.operation) || JSON.stringify({ ...body, operation: input.operation }) !== JSON.stringify(input)) hold()
  return Object.freeze({ ...body, operation: input.operation as string })
}
export function makeOrdinaryMemberLeaseHeader(body: OrdinaryMemberLeaseHeaderBody): OrdinaryMemberLeaseHeader {
  return ordinaryMemberLeaseHeader({ ...body, operation: memberLeaseDigest([DOMAIN, body]) })
}
function sameAdmission(proof: PersistentAdmissionProof): string {
  const { device: _device, operation: _operation, ...binding } = proof.binding
  return JSON.stringify({ ...proof, binding })
}
function sameDeviceEpoch(proof: PersistentAdmissionProof): string {
  const { credentialIds: _ids, credentials: _credentials, seals: _seals, recordsHash: _recordsHash, ...epoch } = proof.binding.device
  return JSON.stringify(epoch)
}
export function ordinaryMemberLeaseCredential(proof: PersistentAdmissionProof, id: string): DeviceCredential {
  if (proof.version !== 2 || !proof.binding.deviceCustody || proof.binding.browser.name !== 'invitation:' + proof.binding.participant + ':' + proof.binding.invitationId) hold()
  const values = proof.binding.device.credentials.map(raw => JSON.parse(raw) as DeviceCredential)
  if (values.length !== 1) hold() // Native renewal owns one exact own credential.
  const found = values.find(value => value.id === id)
  if (!found || found.kind !== 20460 || found.content !== '' || found.pubkey !== proof.binding.participant ||
      JSON.stringify(found.tags) !== JSON.stringify([['d',proof.binding.roomId],['device',proof.binding.device.pubkey],
        ['expiration',found.tags.find(tag => tag[0] === 'expiration')?.[1]],['seal',credentialSeal(found)]])) hold()
  return found
}
function credentialHeader(value: OrdinaryMemberLeaseHeader, proof: PersistentAdmissionProof): void {
  const event = ordinaryMemberLeaseCredential(proof, value.credential), seal = credentialSeal(event), a = value.authority
  if (value.proof !== proof.binding.operation || value.issuedAt !== event.created_at || value.expiresAt !== Number(event.tags[2]![1]) ||
      value.seal !== seal || a.tabExpiresAt !== proof.binding.tab.expiresAt || a.admissionEndsAt !== proof.selection.endsAt ||
      proof.binding.account === null && a.foregroundExpiresAt !== null) hold()
}
export function ordinaryMemberLeaseName(bound: PersistentAdmissionProof['binding']): string {
  return accountPrefix(bound.participant) + MEMBER_LEASE_PREFIX + bound.invitationId + '.' + bound.tab.purpose.slice(4)
}
/** Historical local lineage only. A hash grants neither current membership
 * nor independently permanent allocation continuity. No private bootstrap
 * seal is required to verify the signed historical bootstrap proof. */
export function readOrdinaryMemberLease(raw: string, currentProofRaw: string): OrdinaryMemberLease {
  if (typeof raw !== 'string') hold()
  ordinaryUtf8Length(raw, MAX_MEMBER_LEASE_BYTES)
  let value: unknown
  try { value = JSON.parse(raw) } catch { return hold() }
  object(value, ['version','domain','header','bootstrapProof','predecessorProof','predecessorHeader'])
  if (value.version !== 1 || value.domain !== DOMAIN || typeof value.bootstrapProof !== 'string' || typeof value.predecessorProof !== 'string') hold()
  const current = verifiedProof(currentProofRaw)
  let bootstrap: VerifiedPersistentProof | undefined, predecessor: VerifiedPersistentProof | undefined
  try {
    bootstrap = verifiedProof(value.bootstrapProof); predecessor = verifiedProof(value.predecessorProof)
    const h = ordinaryMemberLeaseHeader(value.header), previous = ordinaryMemberLeaseHeader(value.predecessorHeader)
    if (sameAdmission(current.proof) !== sameAdmission(bootstrap.proof) || sameAdmission(current.proof) !== sameAdmission(predecessor.proof) ||
        sameDeviceEpoch(current.proof) !== sameDeviceEpoch(predecessor.proof) || current.proof.binding.device.pubkey !== bootstrap.proof.binding.device.pubkey ||
        h.sequence < 1 || h.sequence !== previous.sequence + 1 || h.predecessor !== previous.operation ||
        h.bootstrap !== bootstrap.proof.binding.operation || previous.bootstrap !== h.bootstrap ||
        JSON.stringify(h.authority) !== JSON.stringify(previous.authority) ||
        h.issuedAt <= previous.issuedAt || h.expiresAt <= previous.expiresAt || h.credential === previous.credential || h.seal === previous.seal ||
        previous.sequence === 0 && (previous.predecessor !== null || value.predecessorProof !== value.bootstrapProof) ||
        previous.sequence > 0 && previous.predecessor === null ||
        h.source.browserRevision < previous.source.browserRevision || h.source.tabRevision < previous.source.tabRevision ||
        previous.sequence > 0 && (h.source.browserRevision <= previous.source.browserRevision || h.source.tabRevision <= previous.source.tabRevision)) hold()
    credentialHeader(h, current.proof); credentialHeader(previous, predecessor.proof)
    const answer: OrdinaryMemberLease = { version: 1, domain: DOMAIN, header: h, bootstrapProof: value.bootstrapProof,
      predecessorProof: value.predecessorProof, predecessorHeader: previous }
    if (JSON.stringify(answer) !== raw) hold()
    return Object.freeze(answer)
  } finally { current.admission.secret.fill(0); bootstrap?.admission.secret.fill(0); predecessor?.admission.secret.fill(0) }
}
const sorted = <T>(value: ReadonlyMap<string, T>) => [...value].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
/** Complete native predecessor image, excluding keys and transport frames.
 * A durable lease does not pin its source hash to later unrelated writes. */
export function ordinaryMemberLeaseSource(browser: DeviceStore, tab: DeviceStore, token: OrdinaryPairCustody): OrdinaryMemberLeaseSource {
  const b = new Map(browser.keys().map(name => [name, browser.get(name)!])), t = new Map(tab.keys().map(name => [name, tab.get(name)!]))
  try {
    const headers = ordinaryPairReadCustodyFor(token, b, t)
    const image = (name: 'browser' | 'tab', records: ReadonlyMap<string,string>) => {
      const h = headers[name]
      return [h.purpose, h.expiresAt, h.generation, h.revision, sorted(h.fences), sorted(records)]
    }
    return Object.freeze({ browserRevision: headers.browser.revision, tabRevision: headers.tab.revision,
      hash: memberLeaseDigest([DOMAIN + '/source', 1, image('browser', b), image('tab', t)]) })
  } finally { b.clear(); t.clear() }
}
/** Every recognised lease must have its exact independently verified V2
 * proof. Historical browser slots are inert. Selected slots require equal
 * paired bytes. The caller supplies the already authenticated current image. */
export function inspectOrdinaryMemberLeases(browser: DeviceStore, tab: DeviceStore,
  verified: { readonly proofs: ReadonlyMap<string, VerifiedPersistentProof>; readonly selected: ReadonlyMap<string, VerifiedPersistentProof> }):
  Readonly<{ browserLeases: number; selectedTabLeases: number }> {
  let browserLeases = 0, selectedTabLeases = 0
  const selected = new Map([...verified.selected.values()].map(v => [ordinaryMemberLeaseName(v.proof.binding), v.proof]))
  for (const [kind, store] of [['browser', browser], ['tab', tab]] as const) for (const name of store.keys()) {
    if (!name.includes(MEMBER_LEASE_PREFIX)) continue
    const proof = kind === 'tab' ? selected.get(name) : [...verified.proofs.values()].find(v => ordinaryMemberLeaseName(v.proof.binding) === name)?.proof
    if (!proof || proof.version !== 2 || name !== ordinaryMemberLeaseName(proof.binding) || kind === 'browser' && !proof.kept.enabled) hold()
    const raw = store.get(name)!
    readOrdinaryMemberLease(raw, JSON.stringify(proof))
    if (kind === 'tab') {
      // This is historical custody, including after sign-out. Current Fore
      // permission belongs to preparation/open, not a matching expiry cell.
      if (proof.kept.enabled && browser.get(name) !== raw || !proof.kept.enabled && browser.get(name) !== null) hold()
      selectedTabLeases++
    } else {
      if (browser.get(persistentProofName(proof.binding)) !== JSON.stringify(proof)) hold()
      browserLeases++
    }
  }
  for (const [name, proof] of selected) if (proof.kept.enabled && browser.get(name) !== tab.get(name)) hold()
  return Object.freeze({ browserLeases, selectedTabLeases })
}
