import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { getPublicKey } from 'nostr-tools/pure'
import { revalidatePersistentInvitationEvidence, type PersistentInvitationEvidence,
  type PersistentInvitationEvidenceResult } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { deriveInvitationId, roomInvitation, type RoomInvitation } from '../../src/invitation.js'
import { deriveRoom } from '../../src/room.js'
import type { PersistentRoomAdmission } from '../../src/persistent-invitation.js'
import { memoryDeviceStore, storeKeptAdmission, KEPT_ADMISSION_PREFIX, type DeviceStore } from './device-store.js'
import { storeTabAdmission, TAB_ADMISSION_PREFIX } from './admission-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import type { OrdinaryScope } from './ordinary-state-owner.js'
import { validateOrdinaryIdentitySnapshot, validateOrdinaryIdentityPairSnapshot, validateOrdinaryEmbeddedDeviceCredential, type OrdinaryIdentitySnapshot } from './ordinary-identity-snapshot.js'
import { validateOrdinaryEpochSnapshot } from './ordinary-epoch-snapshot.js'
import { DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX } from './device-store.js'
import { credentialSeal } from '../../src/seal.js'
import type { DeviceCredential } from '../../src/types.js'
import { ROOM_EPOCH_PREFIX, ROOM_EPOCH_V2_PREFIX } from './room-epoch-store.js'
import { deriveEpoch, MAX_EPOCH, MAX_HISTORY_EPOCHS } from '../../src/epoch.js'

export const PERSISTENT_PROOF_PREFIX = 'kithmoot.invitation-proof.v1.'
export const PERSISTENT_PROOF_V2_PREFIX = 'kithmoot.invitation-proof.v2.'
export const PERSISTENT_TAB_PROOF_V2_PREFIX = 'kithmoot.admission-proof.v2.'
export const PERSISTENT_TAB_PROOF_PREFIX = 'kithmoot.admission-proof.v1.'
export const FIXED_INVITATION_RELAYS = 'kithmoot.room-relays-fixed.v1'
export const MAX_PERSISTENT_PROOF_BYTES = 1024 * 1024
export const MAX_PERSISTENT_PROOFS_PER_INVITATION = 64
const DOMAIN = 'kithmoot/persistent-admission-proof/v1'
const DOMAIN_V2 = 'kithmoot/persistent-admission-proof/v2'
const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) hold()
}
function hex(value: unknown): asserts value is string { if (typeof value !== 'string' || !HEX.test(value)) hold() }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) hold() }
function parsed(raw: string): unknown {
  if (typeof raw !== 'string') hold()
  ordinaryUtf8Length(raw, MAX_PERSISTENT_PROOF_BYTES)
  try { const value: unknown = JSON.parse(raw); if (JSON.stringify(value) !== raw) hold(); return value } catch { return hold() }
}
export type PersistentDeviceCustody =
  | { readonly owner: 'browser'; readonly scope: OrdinaryScope }
  | { readonly owner: 'tab'; readonly scope: OrdinaryScope & { readonly purpose: string; readonly expiresAt: number } }
export interface PersistentAdmissionBinding {
  readonly account: string | null
  readonly participant: string
  readonly invitationId: string
  readonly roomId: string
  readonly browser: OrdinaryScope
  readonly tab: OrdinaryScope & { readonly purpose: string; readonly expiresAt: number }
  readonly device: PersistentAdmissionDevice
  readonly operation: string
  /** Absent only in v1, which always means browser-device continuity. */
  readonly deviceCustody?: PersistentDeviceCustody
}
export interface PersistentAdmissionDevice {
  readonly pubkey: string
  readonly credentialIds: readonly string[]
  readonly seals: readonly string[]
  readonly epoch: number
  readonly recordsHash: string
  readonly credentials: readonly string[]
  readonly epochs: readonly { readonly epoch: number; readonly id: string }[]
}
export interface PersistentAdmissionProof {
  readonly domain: typeof DOMAIN | typeof DOMAIN_V2
  readonly version: 1 | 2
  readonly binding: PersistentAdmissionBinding
  readonly capability: { readonly bearer: string; readonly inviter: string; readonly persistent: true }
  readonly roomSecret: string
  readonly evidence: PersistentInvitationEvidence
  readonly selection: { readonly contributors: { readonly room: readonly string[]; readonly ends: readonly string[];
    readonly destruct: readonly string[]; readonly relays: readonly string[] }; readonly endsAt: number | null;
    readonly destruct: boolean; readonly relays: readonly string[] | null }
  readonly kept: { readonly enabled: boolean; readonly at: number }
}
interface TabProof {
  readonly version: 1 | 2
  readonly binding: PersistentAdmissionBinding
  readonly roomSecret: string
  readonly eventIds: readonly string[]
  readonly privateProof: PersistentAdmissionProof | null
}
export interface VerifiedPersistentProof {
  readonly proof: PersistentAdmissionProof
  /** Owned buffer, erased by the consumer after admission has been copied. */
  readonly admission: PersistentRoomAdmission
}
export const accountPrefix = (account: string): string => 'kithmoot.account.' + account + '.'
export const persistentProofName = (binding: PersistentAdmissionBinding): string => accountPrefix(binding.participant) + (binding.deviceCustody ? PERSISTENT_PROOF_V2_PREFIX : PERSISTENT_PROOF_PREFIX) +
  binding.invitationId + '.' + binding.tab.purpose.slice(4)
export const persistentTabProofName = (binding: Pick<PersistentAdmissionBinding, 'participant' | 'invitationId' | 'deviceCustody'>): string =>
  accountPrefix(binding.participant) + (binding.deviceCustody ? PERSISTENT_TAB_PROOF_V2_PREFIX : PERSISTENT_TAB_PROOF_PREFIX) + binding.invitationId
function operation(proof: Omit<PersistentAdmissionProof, 'binding'> & { binding: Omit<PersistentAdmissionBinding, 'operation'> }): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(proof))))
}
function scope(raw: unknown, id: string, tab: boolean, family = 'invitation', actor?: string): OrdinaryScope & { purpose?: string } {
  object(raw, tab ? ['name','generation','fence','purpose','expiresAt'] : ['name','generation','fence'])
  if (raw.name !== family + ':' + id && !(family === 'invitation' && actor && raw.name === 'invitation:' + actor + ':' + id)) hold()
  hex(raw.generation); integer(raw.fence)
  if (tab) { integer(raw.expiresAt); if (raw.expiresAt === 0 || typeof raw.purpose !== 'string' || !/^tab:[0-9a-f]{64}$/.test(raw.purpose)) hold() }
  return { name: raw.name as string, generation: raw.generation, fence: raw.fence,
    ...(tab ? { purpose: raw.purpose as string, expiresAt: raw.expiresAt as number } : {}) }
}
function hexList(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 128) hold()
  let prior = ''
  for (const entry of value) { hex(entry); if (entry <= prior) hold(); prior = entry }
}
function deviceHash(value: Omit<PersistentAdmissionDevice, 'recordsHash'>): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([DOMAIN + '/device', value]))))
}
function device(raw: unknown, room: string, participant: string): PersistentAdmissionDevice {
  object(raw, ['pubkey','credentialIds','seals','epoch','recordsHash','credentials','epochs'])
  hex(raw.pubkey); hex(raw.recordsHash); integer(raw.epoch); hexList(raw.credentialIds); hexList(raw.seals)
  const seals = raw.seals
  if (raw.credentialIds.length === 0) hold()
  if (!Array.isArray(raw.credentials) || raw.credentials.length < 1 || raw.credentials.length > 2 ||
      raw.credentials.some(value => typeof value !== 'string') || !Array.isArray(raw.epochs) || raw.epochs.length < 1 || raw.epochs.length > MAX_HISTORY_EPOCHS + 2) hold()
  const credentials = raw.credentials as string[]
  const events = credentials.map(source => {
    const event = parsed(source) as unknown as DeviceCredential
    validateOrdinaryEmbeddedDeviceCredential(event, room)
    if (event.pubkey !== participant || event.tags.find(tag => tag[0] === 'device')?.[1] !== raw.pubkey) hold()
    const seal = credentialSeal(event)
    if (seal && !seals.includes(seal)) hold()
    return event
  })
  if (JSON.stringify([...new Set(events.map(event => event.id))].sort()) !== JSON.stringify(raw.credentialIds) ||
      events.some((event, i) => i > 0 && event.id <= events[i - 1]!.id)) hold()
  const expectedSeals = [...new Set(events.flatMap(event => { const seal = credentialSeal(event); return seal ? [seal] : [] }))].sort()
  if (JSON.stringify(expectedSeals) !== JSON.stringify(seals)) hold()
  const epochs: { epoch: number; id: string }[] = []
  for (const entry of raw.epochs) {
    object(entry, ['epoch','id']); integer(entry.epoch); hex(entry.id)
    if (entry.epoch > MAX_EPOCH || epochs.length && entry.epoch <= epochs.at(-1)!.epoch) hold()
    epochs.push({ epoch: entry.epoch, id: entry.id })
  }
  if (!epochs.some(entry => entry.epoch === raw.epoch) || epochs.some(entry => entry.epoch > (raw.epoch as number)) ||
      epochs.some(entry => entry.epoch === 0 && entry.id !== room)) hold()
  const base = { pubkey: raw.pubkey, credentialIds: [...raw.credentialIds], seals: [...raw.seals], epoch: raw.epoch,
    credentials: [...credentials], epochs }
  if (deviceHash(base) !== raw.recordsHash) hold()
  return { ...base, recordsHash: raw.recordsHash }
}
function binding(raw: unknown, version: 1 | 2 = 1): PersistentAdmissionBinding {
  object(raw, ['account','participant','invitationId','roomId','browser','tab','device','operation', ...(version === 2 ? ['deviceCustody'] : [])])
  if (raw.account !== null) hex(raw.account)
  hex(raw.participant); hex(raw.invitationId); hex(raw.roomId); hex(raw.operation)
  if (raw.account !== null && raw.account !== raw.participant) hold()
  let deviceCustody: PersistentDeviceCustody | undefined
  if (version === 2) {
    object(raw.deviceCustody, ['owner','scope'])
    if (raw.deviceCustody.owner !== 'browser' && raw.deviceCustody.owner !== 'tab') hold()
    const owner = raw.deviceCustody.owner
    const captured = scope(raw.deviceCustody.scope, raw.roomId, owner === 'tab', 'room')
    deviceCustody = owner === 'browser' ? { owner, scope: captured } :
      { owner, scope: captured as Extract<PersistentDeviceCustody, { owner: 'tab' }>['scope'] }
  }
  const bound: PersistentAdmissionBinding = { account: raw.account as string | null, participant: raw.participant, invitationId: raw.invitationId, roomId: raw.roomId,
    browser: scope(raw.browser, raw.invitationId, false, 'invitation', version === 2 ? raw.participant : undefined),
    tab: scope(raw.tab, raw.invitationId, true, 'invitation', version === 2 ? raw.participant : undefined) as PersistentAdmissionBinding['tab'], device: device(raw.device, raw.roomId, raw.participant), ...(deviceCustody ? { deviceCustody } : {}), operation: raw.operation }
  if (version === 2 && bound.browser.name !== bound.tab.name) hold()
  if (deviceCustody) {
    const owner = deviceCustody.owner === 'browser' ? bound.browser : bound.tab
    if (deviceCustody.scope.generation !== owner.generation) hold()
    if (deviceCustody.owner === 'tab' && (deviceCustody.scope.purpose !== bound.tab.purpose ||
        deviceCustody.scope.expiresAt !== bound.tab.expiresAt || bound.device.epoch !== 0 ||
        JSON.stringify(bound.device.epochs) !== JSON.stringify([{ epoch: 0, id: bound.roomId }]))) hold()
  }
  return bound
}
function roomId(secret: Uint8Array): string {
  const room = deriveRoom(secret)
  try { return room.roomId } finally { room.roomKey.fill(0) }
}
function withoutOperation(proof: PersistentAdmissionProof): Parameters<typeof operation>[0] {
  const { operation: _operation, ...base } = proof.binding
  return { domain: proof.domain, version: proof.version, binding: base, capability: proof.capability,
    roomSecret: proof.roomSecret, evidence: proof.evidence, selection: proof.selection, kept: proof.kept }
}
// What the proof records of the selection stays exactly this. The room's group
// storage nodes (fold-kit 0.14.0, `admission.storage` and `storageAt`) are not
// added: `contributors` already names the copies that carried them whenever any
// did, and the evidence kept beside it yields the list again on every read, so
// recording it twice would only be a second thing to disagree. It would also
// stop every proof stored before the key existed from reading back, because the
// comparison in `readPersistentAdmissionProof` is of the whole object. The list
// the app acts on is a verified record of its own (`room-storage-record.ts`).
const selected = (result: Extract<PersistentInvitationEvidenceResult['outcome'], { status: 'admitted' }>) => ({
  contributors: result.contributors, endsAt: result.admission.endsAt ?? null,
  destruct: result.admission.destruct === true, relays: result.admission.relays ?? null,
})
/** Bind the retained admission to actual verified per-room identity records.
 * An unequipped first join must finish credential construction separately;
 * this function cannot invent a device or use a storage generation as one. */
export function persistentAdmissionDevice(store: DeviceStore, room: string, participant: string, account: string | null): PersistentAdmissionDevice {
  const records = new Map(store.keys().map(name => [name, store.get(name)!]))
  try { return admissionDevice(store, records, room, participant, account, validateOrdinaryIdentitySnapshot(records, true)) }
  finally { records.clear() }
}
/** Explicit physical owner, with one global topology check before selection.
 * No lookup fallback may reinterpret a v1 browser proof as tab custody. */
export function persistentAdmissionDeviceInPair(browser: DeviceStore, tab: DeviceStore, room: string, participant: string,
  account: string | null, owner: 'browser' | 'tab'): PersistentAdmissionDevice {
  if (owner !== 'browser' && owner !== 'tab') hold()
  const b = new Map(browser.keys().map(name => [name, browser.get(name)!])), t = new Map(tab.keys().map(name => [name, tab.get(name)!]))
  try {
    const identities = validateOrdinaryIdentityPairSnapshot(b, t, { browser: true, tab: true })
    if (!identities.rooms.some(value => value.roomId === room && value.account === participant && value.owner === owner)) hold()
    return admissionDevice(owner === 'browser' ? browser : tab, owner === 'browser' ? b : t, room, participant, account, identities)
  } finally { b.clear(); t.clear() }
}
function admissionDevice(store: DeviceStore, records: ReadonlyMap<string, string>, room: string, participant: string,
  account: string | null, identities: OrdinaryIdentitySnapshot): PersistentAdmissionDevice {
  const found = identities.rooms.find(value => value.roomId === room && value.account === participant)
  if (!found || account === null && identities.participant !== participant || account !== null && account !== participant) hold()
  const prefix = found.scoped ? accountPrefix(participant) : ''
  const rawKey = store.get(prefix + DEVICE_PREFIX + room)
  if (rawKey === null) hold()
  const key = hexToBytes((JSON.parse(rawKey) as { sk: string }).sk)
  try {
    // Activity timestamps do not change the room device. Bind its verified
    // public key and the public seal history, rather than raw secret encodings.
    const devicePubkey = getPublicKey(key)
    const events = [CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX].flatMap(name => {
      const raw = store.get(prefix + name + room); return raw === null ? [] : [JSON.parse(raw) as DeviceCredential]
    })
    if (!events.length || events.some(event => event.pubkey !== participant)) hold()
    const epochs = validateOrdinaryEpochSnapshot(records, true)
    const epoch = epochs.rooms.find(value => value.roomId === room && value.account === (found.scoped ? participant : undefined))?.watchedEpoch ?? 0
    const canonicalEvents = [...new Map(events.map(event => [event.id, event])).values()].sort((a, b) => a.id.localeCompare(b.id))
    const base = { pubkey: devicePubkey, credentialIds: canonicalEvents.map(event => event.id),
      seals: [...new Set(events.flatMap(event => { const seal = credentialSeal(event); return seal ? [seal] : [] }))].sort(),
      epoch, credentials: canonicalEvents.map(event => JSON.stringify(event)),
      epochs: (() => {
        const ids = new Map<number, string>()
        if (epoch === 0) ids.set(0, room)
        const v1 = store.get(prefix + ROOM_EPOCH_PREFIX + room)
        if (v1) { const value = JSON.parse(v1) as { epoch: number; id: string }; ids.set(value.epoch, value.id) }
        const v2 = store.get(prefix + ROOM_EPOCH_V2_PREFIX + room)
        if (v2) {
          const value = JSON.parse(v2) as { epoch: number; secret: string; past: { epoch: number; secret: string }[] }
          for (const source of [value, ...value.past]) {
            const secret = hexToBytes(source.secret)
            try { const derived = deriveEpoch({ epoch: source.epoch, secret }); ids.set(source.epoch, derived.id); derived.key.fill(0) }
            finally { secret.fill(0) }
          }
        }
        return [...ids].sort(([a], [b]) => a - b).map(([epoch, id]) => ({ epoch, id }))
      })() }
    return device({ ...base, recordsHash: deviceHash(base) }, room, participant)
  } finally { key.fill(0) }
}
/** Historical signed credentials survive renewal. Current custody must retain
 * the same room device and any replaced own seal key, and epoch history must
 * connect the observed epoch, including zero. Only public derived IDs persist. This local monotonicity is not independent
 * antirollback evidence or current membership/rekey authority. */
export function validatePersistentAdmissionDeviceContinuity(store: DeviceStore, bound: PersistentAdmissionBinding): void {
  if (bound.deviceCustody?.owner === 'tab') hold()
  continuity(store, bound, persistentAdmissionDevice(store, bound.roomId, bound.participant, bound.account))
}
export function validatePersistentAdmissionDeviceContinuityInPair(browser: DeviceStore, tab: DeviceStore, bound: PersistentAdmissionBinding): void {
  const owner = bound.deviceCustody?.owner ?? 'browser'
  const current = persistentAdmissionDeviceInPair(browser, tab, bound.roomId, bound.participant, bound.account, owner)
  continuity(owner === 'browser' ? browser : tab, bound, current)
}
function continuity(store: DeviceStore, bound: PersistentAdmissionBinding, current: PersistentAdmissionDevice): void {
  if (current.pubkey !== bound.device.pubkey || current.epoch < bound.device.epoch) hold()
  const identities = validateOrdinaryIdentitySnapshot(new Map(store.keys().map(name => [name, store.get(name)!])), true)
  const scoped = identities.rooms.find(room => room.roomId === bound.roomId && room.account === bound.participant)!.scoped
  const seals = new Set<string>()
  const raw = store.get((scoped ? accountPrefix(bound.participant) : '') + OWN_SEAL_PREFIX + bound.roomId)
  for (const encoded of raw === null ? [] : JSON.parse(raw) as string[]) {
    const key = hexToBytes(encoded)
    try { seals.add(getPublicKey(key)) } finally { key.fill(0) }
  }
  for (const encoded of bound.device.credentials) {
    const event = JSON.parse(encoded) as DeviceCredential, seal = credentialSeal(event)
    if (!current.credentialIds.includes(event.id) && seal && !seals.has(seal)) hold()
  }
  const priorId = bound.device.epochs.find(value => value.epoch === bound.device.epoch)!.id
  if (current.epochs.find(value => value.epoch === bound.device.epoch)?.id !== priorId) hold()

}
/** The actual query's canonical evidence is independently reverified. No
 * caller-supplied decoded admission or fixed-list boolean is trusted. */
export function makePersistentAdmissionProof(input: {
  invitation: RoomInvitation; evidence: unknown; account: string | null; participant: string; browser: OrdinaryScope;
  tab: OrdinaryScope & { purpose: string; expiresAt: number }; device: PersistentAdmissionDevice;
  keep: boolean; now: number; expectedRoomSecret?: Uint8Array; deviceCustody?: PersistentDeviceCustody
}): VerifiedPersistentProof {
  if (input.account !== null) hex(input.account)
  hex(input.participant); integer(input.now)
  if (typeof input.keep !== 'boolean' || input.invitation.persistent !== true) hold()
  const result = revalidatePersistentInvitationEvidence({ evidence: input.evidence, invitation: input.invitation,
    ...(input.expectedRoomSecret !== undefined ? { expectedRoomSecret: input.expectedRoomSecret } : {}) })
  if (result.outcome.status !== 'admitted') hold()
  const admission = result.outcome.admission
  try {
    const id = deriveInvitationId(input.invitation)
    const base = { account: input.account, participant: input.participant, invitationId: id, roomId: roomId(admission.secret),
      browser: { ...input.browser }, tab: { ...input.tab }, device: device(input.device, roomId(admission.secret), input.participant),
      ...(input.deviceCustody ? { deviceCustody: structuredClone(input.deviceCustody) } : {}) }
    const version = input.deviceCustody ? 2 as const : 1 as const
    // Hash only reconstructed canonical fields, never caller insertion order.
    const { operation: _operation, ...canonical } = binding({ ...base, operation: '0'.repeat(64) }, version)
    const body = { domain: (version === 2 ? DOMAIN_V2 : DOMAIN) as PersistentAdmissionProof['domain'], version, binding: canonical,
      capability: { bearer: bytesToHex(input.invitation.bearer), inviter: input.invitation.inviter, persistent: true as const },
      roomSecret: bytesToHex(admission.secret), evidence: result.evidence, selection: selected(result.outcome), kept: { enabled: input.keep, at: input.now } }
    const proof: PersistentAdmissionProof = { ...body, binding: { ...canonical, operation: operation(body) } }
    binding(proof.binding, version)
    custodyPolicy(proof, admission)
    const raw = JSON.stringify(proof); ordinaryUtf8Length(raw, MAX_PERSISTENT_PROOF_BYTES)
    return { proof, admission }
  } catch (error) { admission.secret.fill(0); throw error }
}
/** V2 is explicit primary-device custody. Historical parsing checks the
 * bounded credential lifetime; callers still check wall-clock usability at
 * each effect. Legacy v1 semantics and canonical bytes stay unchanged. */
function custodyPolicy(proof: PersistentAdmissionProof, admission: PersistentRoomAdmission): void {
  if (proof.version === 1) { if (proof.binding.deviceCustody) hold(); return }
  const custody = proof.binding.deviceCustody
  if (!custody || proof.kept.enabled !== (custody.owner === 'browser')) hold()
  const until = Math.min(admission.endsAt ?? Number.MAX_SAFE_INTEGER,
    custody.owner === 'tab' ? Math.floor(custody.scope.expiresAt / 1000) : Number.MAX_SAFE_INTEGER)
  for (const raw of proof.binding.device.credentials) {
    const event = JSON.parse(raw) as DeviceCredential
    const expiry = Number(event.tags.find(tag => tag[0] === 'expiration')?.[1])
    if (expiry > until || expiry <= proof.kept.at) hold()
  }
}
/** Reload produces a new owned secret, not the persisted decoded assertion.
 * EOSE remains a local observation, never global absence or current authority. */
export function readPersistentAdmissionProof(raw: string): VerifiedPersistentProof {
  const value = parsed(raw)
  object(value, ['domain','version','binding','capability','roomSecret','evidence','selection','kept'])
  if (!(value.domain === DOMAIN && value.version === 1 || value.domain === DOMAIN_V2 && value.version === 2)) hold()
  const version = value.version as 1 | 2, domain = value.domain as PersistentAdmissionProof['domain']
  const bound = binding(value.binding, version)
  object(value.capability, ['bearer','inviter','persistent']); object(value.kept, ['enabled','at'])
  hex(value.capability.bearer); hex(value.capability.inviter); hex(value.roomSecret); integer(value.kept.at)
  if (value.capability.persistent !== true || typeof value.kept.enabled !== 'boolean') hold()
  const bearer = hexToBytes(value.capability.bearer), root = hexToBytes(value.roomSecret)
  let result: PersistentInvitationEvidenceResult | undefined
  try {
    const invitation = roomInvitation(bearer, value.capability.inviter, true)
    if (deriveInvitationId(invitation) !== bound.invitationId || roomId(root) !== bound.roomId) hold()
    result = revalidatePersistentInvitationEvidence({ evidence: value.evidence, invitation, expectedRoomSecret: root })
    if (result.outcome.status !== 'admitted') hold()
    if (JSON.stringify(selected(result.outcome)) !== JSON.stringify(value.selection)) hold()
    const proof: PersistentAdmissionProof = { domain, version, binding: bound,
      capability: { bearer: value.capability.bearer, inviter: value.capability.inviter, persistent: true },
      roomSecret: value.roomSecret, evidence: result.evidence, selection: selected(result.outcome), kept: { enabled: value.kept.enabled, at: value.kept.at } }
    custodyPolicy(proof, result.outcome.admission)
    if (operation(withoutOperation(proof)) !== bound.operation || JSON.stringify(proof) !== raw) hold()
    return { proof, admission: result.outcome.admission }
  } catch (error) { if (result?.outcome.status === 'admitted') result.outcome.admission.secret.fill(0); throw error }
  finally { bearer.fill(0); root.fill(0) }
}
export function tabProofBytes(proof: PersistentAdmissionProof): string {
  return JSON.stringify({ version: proof.version, binding: proof.binding, roomSecret: proof.roomSecret, eventIds: proof.evidence.eventIds,
    privateProof: proof.kept.enabled ? null : proof } satisfies TabProof)
}
/** A stored proof this copy of the app could not read, left where it is. */
export interface SkippedPersistentProof {
  /** The storage name of the row. */
  readonly name: string
  /** `unreadable`: the row, or the evidence it holds, would not verify here (a proof kept by a newer or an older copy of the app, say one whose evidence carries a key this copy does not know). `dependent`: a tab record whose browser proof was unreadable. */
  readonly why: 'unreadable' | 'dependent'
}

/** Sensitive internal result; always close it. Browser proofs for expired or
 * other tabs remain inert historical custody. A tab proof must have its exact
 * browser counterpart and actual admission writer records.
 *
 * One proof this copy cannot read is skipped and reported (`skipped`), not
 * allowed to hold every room: a tab on an older release, or a rollback, cannot
 * read evidence a newer release kept, and the rooms whose proofs it can read
 * are no less true for that. Only a failure to READ is isolated. A row that
 * reads but is out of place (wrong name, a repeated slot, too many for an
 * invitation, a tab record that disagrees with its browser counterpart) still
 * holds, and so does everything a caller checks afterwards against these
 * proofs: a room that depended on a skipped one is held by that check. */
export function inspectPersistentAdmissionProofs(browser: DeviceStore, tab: DeviceStore, options: { requireSelectedContinuity?: boolean } = {}): {
  readonly proofs: ReadonlyMap<string, VerifiedPersistentProof>
  readonly selected: ReadonlyMap<string, VerifiedPersistentProof>
  readonly skipped: readonly SkippedPersistentProof[]
  close(): void
} {
  const proofs = new Map<string, VerifiedPersistentProof>(), selected = new Map<string, VerifiedPersistentProof>()
  const skipped: SkippedPersistentProof[] = [], unreadable = new Set<string>()
  const owned: VerifiedPersistentProof[] = []
  const slots = new Set<string>()
  const counts = new Map<string, number>(), selectedGroups = new Set<string>()
  const close = () => { for (const value of owned) value.admission.secret.fill(0); owned.length = 0; proofs.clear(); selected.clear() }
  try {
    for (const name of browser.keys()) {
      if (![PERSISTENT_PROOF_PREFIX, PERSISTENT_PROOF_V2_PREFIX].some(prefix => name.includes(prefix))) continue
      let verified: VerifiedPersistentProof
      try { verified = readPersistentAdmissionProof(browser.get(name)!) } catch {
        skipped.push({ name, why: 'unreadable' })
        const operation = operationOf(browser.get(name)!)
        if (operation) unreadable.add(operation)
        continue
      }
      if (!verified.proof.kept.enabled || name !== persistentProofName(verified.proof.binding) || proofs.has(verified.proof.binding.operation)) {
        verified.admission.secret.fill(0); hold()
      }
      owned.push(verified)
      const group = verified.proof.binding.participant + ':' + verified.proof.binding.invitationId
      const slot = group + ':' + verified.proof.binding.tab.purpose
      if (slots.has(slot)) hold()
      slots.add(slot)
      const count = (counts.get(group) ?? 0) + 1
      if (count > MAX_PERSISTENT_PROOFS_PER_INVITATION) hold()
      counts.set(group, count)
      proofs.set(verified.proof.binding.operation, verified)
    }
    for (const name of tab.keys()) {
      if (![PERSISTENT_TAB_PROOF_PREFIX, PERSISTENT_TAB_PROOF_V2_PREFIX].some(prefix => name.includes(prefix))) continue
      const raw = tab.get(name)!, value = parsed(raw)
      object(value, ['version','binding','roomSecret','eventIds','privateProof'])
      if (value.version !== 1 && value.version !== 2) hold()
      const bound = binding(value.binding, value.version)
      let privateProof: VerifiedPersistentProof | undefined
      if (value.privateProof !== null) {
        try { privateProof = readPersistentAdmissionProof(JSON.stringify(value.privateProof)) } catch { skipped.push({ name, why: 'unreadable' }); continue }
      }
      if (privateProof) owned.push(privateProof)
      // Its counterpart is a browser proof this copy could not read: nothing here to check it against.
      if (!privateProof && !proofs.has(bound.operation) && unreadable.has(bound.operation)) { skipped.push({ name, why: 'dependent' }); continue }
      const verified = privateProof ?? proofs.get(bound.operation)
      if (privateProof && privateProof.proof.kept.enabled) hold()
      if (!verified || name !== persistentTabProofName(bound) || tabProofBytes(verified.proof) !== raw) hold()
      const group = bound.participant + ':' + bound.invitationId
      if (selectedGroups.has(group)) hold()
      selectedGroups.add(group)
      const invitation = roomInvitation(hexToBytes(verified.proof.capability.bearer), verified.proof.capability.inviter, true)
      const expected = memoryDeviceStore()
      try {
        storeTabAdmission(expected, invitation, verified.admission)
        const prefix = accountPrefix(bound.participant)
        if (tab.get(prefix + TAB_ADMISSION_PREFIX + bound.invitationId) !== expected.get(TAB_ADMISSION_PREFIX + bound.invitationId)) hold()
        if (verified.proof.kept.enabled) {
          storeKeptAdmission(expected, bound.invitationId, verified.admission, verified.proof.kept.at)
          if (browser.get(prefix + KEPT_ADMISSION_PREFIX + bound.invitationId) !== expected.get(KEPT_ADMISSION_PREFIX + bound.invitationId)) hold()
        } else if (browser.get(prefix + KEPT_ADMISSION_PREFIX + bound.invitationId) !== null ||
          [...proofs.values()].some(p => p.proof.binding.participant === bound.participant && p.proof.binding.invitationId === bound.invitationId)) hold()
        if (options.requireSelectedContinuity !== false) validatePersistentAdmissionDeviceContinuityInPair(browser, tab, bound)
        if (verified.proof.selection.relays !== null && verified.proof.selection.contributors.relays.length === 0) hold()
        if (verified.proof.kept.enabled) {
          const fixed = JSON.parse(browser.get(FIXED_INVITATION_RELAYS) ?? '{}') as Record<string, { c: string[]; signed: boolean }>
          const row = fixed[bound.roomId]
          if (row?.signed && (verified.proof.selection.relays === null || JSON.stringify(row.c) !== JSON.stringify(verified.proof.selection.relays)) ||
              verified.proof.selection.relays !== null && (!row?.signed || JSON.stringify(row.c) !== JSON.stringify(verified.proof.selection.relays))) hold()
        }
        if (bound.deviceCustody?.owner === 'tab') {
          const fixed = JSON.parse(browser.get(FIXED_INVITATION_RELAYS) ?? '{}') as Record<string, unknown>
          if (Object.hasOwn(fixed, bound.roomId)) hold()
        }
        selected.set(name, verified)
      } finally { invitation.bearer.fill(0) }
    }
    return { proofs, selected, skipped, close }
  } catch (error) { close(); throw error }
}

/** The operation id a stored proof claims, read without trusting the rest of it. */
function operationOf(raw: string): string | undefined {
  try {
    const operation = ((JSON.parse(raw) as { binding?: { operation?: unknown } }).binding ?? {}).operation
    return typeof operation === 'string' && HEX.test(operation) ? operation : undefined
  } catch { return undefined }
}
