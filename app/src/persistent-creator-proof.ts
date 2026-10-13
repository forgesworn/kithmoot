import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { getPublicKey } from 'nostr-tools/pure'
import { revalidatePersistentInvitationSource } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { roomInvitation, deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import { deriveRoom } from '../../src/room.js'
import { parseRoomLink } from '../../src/link.js'
import { normaliseRelayConfig, MAX_POOL_RELAYS } from '../../src/relay-pool.js'
import type { NetworkProfile } from '../../src/anonymous.js'
import type { PersistentRoomAdmission } from '../../src/persistent-invitation.js'
import type { DeviceStore } from './device-store.js'
import { INVITATION_OWNER_PREFIX } from './invitation-store.js'
import { ROOM_PREFIX } from './rooms-store.js'
import { accountPrefix, FIXED_INVITATION_RELAYS } from './persistent-admission-proof.js'
import type { OrdinaryScope } from './ordinary-state-owner.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'

export const CREATOR_PROOF_PREFIX = 'kithmoot.invitation-creator.v1.'
export const CREATOR_INTENT_PREFIX = 'kithmoot.invitation-publication.v1.'
export const MAX_CREATOR_PROOF_BYTES = 1024 * 1024
export const MAX_CREATOR_PROOFS_PER_ROOM = 64
export const MAX_CREATOR_SOURCE_EVENTS = 64
const DOMAIN = 'kithmoot/persistent-invitation-creator/v1'
const HEX = /^[0-9a-f]{64}$/
export type CreatorSourceKind = 'new-room' | 'dm' | 'rotation' | 'renewal'
const kinds: readonly CreatorSourceKind[] = ['new-room', 'dm', 'rotation', 'renewal']
function hold(): never { throw new OrdinaryStateHold() }
function object(raw: unknown, fields: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.keys(raw).sort().join(',') !== [...fields].sort().join(',')) hold()
}
function hex(raw: unknown): asserts raw is string { if (typeof raw !== 'string' || !HEX.test(raw)) hold() }
function integer(raw: unknown): asserts raw is number { if (!Number.isSafeInteger(raw) || (raw as number) < 0) hold() }
function parse(raw: string): unknown {
  try { ordinaryUtf8Length(raw, MAX_CREATOR_PROOF_BYTES); const value: unknown = JSON.parse(raw); if (JSON.stringify(value) !== raw) hold(); return value }
  catch { return hold() }
}
export interface CreatorBinding {
  readonly account: string | null
  readonly participant: string
  readonly invitationId: string
  readonly roomId: string
  readonly browser: OrdinaryScope
  readonly operation: string
}
export interface PersistentCreatorProof {
  readonly domain: typeof DOMAIN
  readonly version: 1
  readonly binding: CreatorBinding
  readonly capability: { readonly bearer: string; readonly inviter: string; readonly persistent: true }
  readonly roomSecret: string
  readonly event: string
  readonly eventId: string
  readonly createdAt: number
  readonly link: string
  readonly keep: boolean
  readonly destinations: readonly string[]
  readonly profile: NetworkProfile
  readonly sourceKind: CreatorSourceKind
  readonly predecessorOperation: string | null
  /** Earlier authored events, oldest first. No query-completion claim. */
  readonly history: readonly string[]
}
export interface CreatorPublicationIntent {
  readonly version: 1
  readonly operation: string
  readonly eventId: string
  readonly eventHash: string
  readonly state: 'pending' | 'acknowledged'
  /** Only destinations known to have acknowledged this exact event. */
  readonly acknowledged: readonly string[]
}
export interface VerifiedCreatorProof {
  readonly proof: PersistentCreatorProof
  /** Owned buffer: the consumer must erase it. */
  readonly admission: PersistentRoomAdmission
}
export const creatorProofName = (b: Pick<CreatorBinding, 'participant' | 'invitationId'>): string => accountPrefix(b.participant) + CREATOR_PROOF_PREFIX + b.invitationId
export const creatorIntentName = (b: Pick<CreatorBinding, 'participant' | 'invitationId'>): string => accountPrefix(b.participant) + CREATOR_INTENT_PREFIX + b.invitationId
export function creatorDestinations(input: readonly string[], profile: NetworkProfile): readonly string[] {
  if (!['direct','tor'].includes(profile) || !Array.isArray(input) || !input.length || input.length > MAX_POOL_RELAYS || input.some(url => typeof url !== 'string')) hold()
  try { return Object.freeze([...new Set(input.map(url => normaliseRelayConfig([url], profile)[0]!.url))].sort()) } catch { return hold() }
}
function operation(proof: Omit<PersistentCreatorProof, 'binding'> & { binding: Omit<CreatorBinding, 'operation'> }): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(proof))))
}
function withoutOperation(proof: PersistentCreatorProof): Parameters<typeof operation>[0] {
  return { domain: DOMAIN, version: 1, binding: { account: proof.binding.account, participant: proof.binding.participant,
    invitationId: proof.binding.invitationId, roomId: proof.binding.roomId,
    browser: { name: proof.binding.browser.name, generation: proof.binding.browser.generation, fence: proof.binding.browser.fence } },
    capability: { bearer: proof.capability.bearer, inviter: proof.capability.inviter, persistent: true }, roomSecret: proof.roomSecret,
    event: proof.event, eventId: proof.eventId, createdAt: proof.createdAt, link: proof.link, keep: proof.keep,
    destinations: proof.destinations, profile: proof.profile, sourceKind: proof.sourceKind,
    predecessorOperation: proof.predecessorOperation, history: proof.history }
}
export function makePersistentCreatorProof(input: {
  event: unknown; invitation: RoomInvitation; expectedRoomSecret: Uint8Array; account: string | null; participant: string;
  browser: OrdinaryScope; link: string; keep: boolean; destinations: readonly string[]; profile: NetworkProfile; sourceKind: CreatorSourceKind
  predecessorOperation?: string
  history?: readonly string[]
}): VerifiedCreatorProof {
  const source = revalidatePersistentInvitationSource({ event: input.event, invitation: input.invitation, expectedRoomSecret: input.expectedRoomSecret })
  try {
    const room = deriveRoom(source.admission.secret)
    let roomId: string
    try { roomId = room.roomId } finally { room.roomKey.fill(0) }
    const base: Parameters<typeof operation>[0] = { domain: DOMAIN, version: 1 as const, binding: { account: input.account, participant: input.participant,
      invitationId: source.invitationId, roomId, browser: { ...input.browser } },
      capability: { bearer: bytesToHex(input.invitation.bearer), inviter: source.inviter, persistent: true as const },
      roomSecret: bytesToHex(source.admission.secret), event: source.event, eventId: source.eventId, createdAt: source.createdAt,
      link: input.link, keep: input.keep, destinations: creatorDestinations(input.destinations, input.profile), profile: input.profile, sourceKind: input.sourceKind,
      predecessorOperation: input.predecessorOperation ?? null, history: [...(input.history ?? [])] }
    const proof = { ...base, binding: { ...base.binding, operation: operation(base) } }
    return readPersistentCreatorProof(JSON.stringify(proof))
  } finally { source.admission.secret.fill(0) }
}
/** Reverify a single authored source. Never substitute member query evidence. */
export function readPersistentCreatorProof(raw: string): VerifiedCreatorProof {
  let bearer: Uint8Array | undefined, root: Uint8Array | undefined, admission: PersistentRoomAdmission | undefined
  let transferred = false
  try {
    const p = parse(raw)
    object(p, ['domain','version','binding','capability','roomSecret','event','eventId','createdAt','link','keep','destinations','profile','sourceKind','predecessorOperation','history'])
    if (p.domain !== DOMAIN || p.version !== 1 || !['direct','tor'].includes(p.profile as string) || !kinds.includes(p.sourceKind as CreatorSourceKind) || typeof p.keep !== 'boolean') hold()
    if (p.sourceKind === 'rotation' || p.sourceKind === 'renewal') hex(p.predecessorOperation)
    else if (p.predecessorOperation !== null) hold()
    object(p.binding, ['account','participant','invitationId','roomId','browser','operation'])
    const b = p.binding; hex(b.participant); hex(b.invitationId); hex(b.roomId); hex(b.operation)
    if (b.account !== null && b.account !== b.participant) hold()
    object(b.browser, ['name','generation','fence']); hex(b.browser.generation); integer(b.browser.fence)
    if (b.browser.name !== 'invitation:' + b.invitationId) hold()
    object(p.capability, ['bearer','inviter','persistent']); hex(p.capability.bearer); hex(p.capability.inviter)
    if (p.capability.persistent !== true) hold()
    hex(p.roomSecret); hex(p.eventId); integer(p.createdAt)
    if (typeof p.event !== 'string' || typeof p.link !== 'string') hold()
    if (JSON.stringify(creatorDestinations(p.destinations as string[], p.profile as NetworkProfile)) !== JSON.stringify(p.destinations)) hold()
    bearer = hexToBytes(p.capability.bearer); root = hexToBytes(p.roomSecret)
    const invitation = roomInvitation(bearer, p.capability.inviter, true)
    if (deriveInvitationId(invitation) !== b.invitationId) hold()
    const source = revalidatePersistentInvitationSource({ event: p.event, invitation, expectedRoomSecret: root })
    admission = source.admission
    if (source.eventId !== p.eventId || source.createdAt !== p.createdAt) hold()
    if (!Array.isArray(p.history) || p.history.length >= MAX_CREATOR_SOURCE_EVENTS || p.history.some(value => typeof value !== 'string') ||
        (p.sourceKind === 'renewal' ? p.history.length === 0 : p.history.length !== 0)) hold()
    let previousAt = -1
    const ids = new Set<string>([source.eventId])
    for (const event of p.history) {
      const older = revalidatePersistentInvitationSource({ event, invitation, expectedRoomSecret: root })
      try {
        if (ids.has(older.eventId) || older.createdAt <= previousAt || older.createdAt >= source.createdAt ||
            older.admission.endsAt !== undefined && (admission.endsAt === undefined || admission.endsAt > older.admission.endsAt) ||
            older.admission.destruct && !admission.destruct || older.admission.relays !== undefined && admission.relays === undefined) hold()
        previousAt = older.createdAt; ids.add(older.eventId)
      } finally { older.admission.secret.fill(0) }
    }
    const derived = deriveRoom(root)
    try { if (derived.roomId !== b.roomId) hold() } finally { derived.roomKey.fill(0) }
    const link = parseRoomLink(p.link)
    try {
      if (!link.invitation?.persistent || link.secret || link.pairingCode || deriveInvitationId(link.invitation) !== b.invitationId ||
          link.invitation.inviter !== invitation.inviter || bytesToHex(link.invitation.bearer) !== p.capability.bearer) hold()
    } finally { link.secret?.fill(0); link.invitation?.bearer.fill(0); link.pairingCode?.fill(0) }
    const proof = p as unknown as PersistentCreatorProof
    if (operation(withoutOperation(proof)) !== b.operation) hold()
    if (JSON.stringify({ ...withoutOperation(proof), binding: { ...withoutOperation(proof).binding, operation: b.operation } }) !== raw) hold()
    transferred = true
    return { proof, admission }
  } catch { return hold() } finally {
    bearer?.fill(0); root?.fill(0); if (!transferred) admission?.secret.fill(0)
  }
}
export function creatorIntent(proof: PersistentCreatorProof, acknowledged: readonly string[] = []): CreatorPublicationIntent {
  const urls = [...new Set(acknowledged)].sort()
  if (urls.some(url => !proof.destinations.includes(url))) hold()
  return { version: 1, operation: proof.binding.operation, eventId: proof.eventId,
    eventHash: bytesToHex(sha256(new TextEncoder().encode(proof.event))), state: urls.length === proof.destinations.length ? 'acknowledged' : 'pending', acknowledged: urls }
}
export function readCreatorIntent(raw: string, proof: PersistentCreatorProof): CreatorPublicationIntent {
  const intent = parse(raw)
  object(intent, ['version','operation','eventId','eventHash','state','acknowledged'])
  if (!Array.isArray(intent.acknowledged) || intent.acknowledged.some(url => typeof url !== 'string') ||
      JSON.stringify(intent) !== JSON.stringify(creatorIntent(proof, intent.acknowledged))) hold()
  return intent as unknown as CreatorPublicationIntent
}
export function validateCreatorOwner(store: DeviceStore, verified: VerifiedCreatorProof): void {
  const { proof, admission } = verified, raw = store.get(accountPrefix(proof.binding.participant) + INVITATION_OWNER_PREFIX + proof.binding.invitationId)
  if (raw === null) hold()
  const owner = parse(raw)
  if (!owner || typeof owner !== 'object' || typeof (owner as Record<string,unknown>).inviterSk !== 'string') hold()
  const sk = (owner as { inviterSk: string }).inviterSk; hex(sk)
  const key = hexToBytes(sk)
  try { if (getPublicKey(key) !== proof.capability.inviter) hold() } finally { key.fill(0) }
  if (raw !== JSON.stringify({ roomSecret: proof.roomSecret, inviterSk: sk, createdAt: proof.createdAt, persistent: true,
    ...(admission.endsAt === undefined ? {} : { ends: admission.endsAt }), ...(admission.destruct ? { destruct: true } : {}) })) hold()
}
export function creatorIsSelected(store: DeviceStore, proof: PersistentCreatorProof): boolean {
  const raw = store.get(accountPrefix(proof.binding.participant) + ROOM_PREFIX + proof.binding.roomId) ?? store.get(ROOM_PREFIX + proof.binding.roomId)
  if (raw === null) return false
  const metadata = parse(raw) as { link: string }
  const link = parseRoomLink(metadata.link)
  try { return !!link.invitation?.persistent && deriveInvitationId(link.invitation) === proof.binding.invitationId &&
    link.invitation.inviter === proof.capability.inviter && bytesToHex(link.invitation.bearer) === proof.capability.bearer }
  finally { link.secret?.fill(0); link.invitation?.bearer.fill(0); link.pairingCode?.fill(0) }
}
export function inspectPersistentCreatorProofs(store: DeviceStore): { proofs: ReadonlyMap<string, VerifiedCreatorProof>; close(): void } {
  const proofs = new Map<string, VerifiedCreatorProof>()
  try {
    const counts = new Map<string, number>(), expectedIntents = new Set<string>()
    for (const name of store.keys().filter(name => name.includes('.' + CREATOR_PROOF_PREFIX))) {
      const verified = readPersistentCreatorProof(store.get(name)!)
      proofs.set(name, verified)
      if (name !== creatorProofName(verified.proof.binding)) hold()
      const group = verified.proof.binding.participant + ':' + verified.proof.binding.roomId
      const count = (counts.get(group) ?? 0) + 1; if (count > MAX_CREATOR_PROOFS_PER_ROOM) hold(); counts.set(group, count)
      validateCreatorOwner(store, verified)
      const intentName = creatorIntentName(verified.proof.binding), raw = store.get(intentName)
      if (raw === null) hold(); readCreatorIntent(raw, verified.proof); expectedIntents.add(intentName)
      if (creatorIsSelected(store, verified.proof)) {
        const metadata = parse(store.get(accountPrefix(verified.proof.binding.participant) + ROOM_PREFIX + verified.proof.binding.roomId) ?? store.get(ROOM_PREFIX + verified.proof.binding.roomId)!) as { link: string; keep?: boolean; endsAt?: number; destruct?: true }
        if (metadata.link !== verified.proof.link || metadata.keep !== verified.proof.keep || metadata.endsAt !== verified.admission.endsAt ||
            (metadata.destruct === true) !== (verified.admission.destruct === true)) hold()
        const rawFixed = store.get(FIXED_INVITATION_RELAYS) ?? '{}'
        ordinaryUtf8Length(rawFixed)
        const fixed = JSON.parse(rawFixed) as Record<string, { c: string[]; signed: boolean }>
        const row = fixed[verified.proof.binding.roomId]
        if (verified.admission.relays === undefined ? row?.signed :
            JSON.stringify(row) !== JSON.stringify({ c: verified.admission.relays, signed: true })) hold()
      }
    }
    for (const name of store.keys().filter(name => name.includes('.' + CREATOR_INTENT_PREFIX))) if (!expectedIntents.has(name)) hold()
    return { proofs, close: () => { for (const value of proofs.values()) value.admission.secret.fill(0); proofs.clear() } }
  } catch (error) { for (const value of proofs.values()) value.admission.secret.fill(0); proofs.clear(); throw error }
}
