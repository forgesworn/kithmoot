import { validateOrdinaryIdentitySnapshot, validateOrdinaryEmbeddedDeviceCredential } from './ordinary-identity-snapshot.js'
import { validateOrdinaryEpochSnapshot } from './ordinary-epoch-snapshot.js'
import { validateOrdinaryPendingSnapshot } from './ordinary-pending-snapshot.js'
import { validateOrdinaryQuietSnapshot, type OrdinaryQuietScope } from './ordinary-quiet-snapshot.js'
import { validateOrdinarySignetSnapshot } from './ordinary-signet-snapshot.js'
import { validateOrdinaryContactSnapshot } from './ordinary-contact-snapshot.js'
import { validateOrdinaryGrantedContactSnapshot } from './ordinary-granted-contact-snapshot.js'
import { validateOrdinaryMetadataSnapshot } from './ordinary-metadata-snapshot.js'
import { validateOrdinaryChannelCheckSnapshot } from './ordinary-channel-check-snapshot.js'
import { validateOrdinaryJournalSnapshot } from './ordinary-journal-snapshot.js'
import { validateOrdinaryPrivateFamilySnapshot } from './ordinary-private-family-snapshot.js'
import { validateOrdinaryMediaSnapshot } from './ordinary-media-snapshot.js'
import { validateOrdinaryRoutingSnapshot } from './ordinary-routing-snapshot.js'
import { validateOrdinaryUiSnapshot } from './ordinary-ui-snapshot.js'
import { validateOrdinaryEntryLayoutSnapshot } from './ordinary-entry-layout-snapshot.js'
import { deriveEpoch } from '../../src/epoch.js'
import { decodeChatEvent, type ChatMessage } from '../../src/chat.js'
import { reactionText } from '../../src/reactions.js'
import { ASSIGNMENT_CHANNEL, assignmentPayload } from '../../src/assignments.js'
import { CONTROL_CHANNEL, decodeControl } from '../../src/control.js'
import { roomLogoFromMessage } from '../../src/room-logo.js'
import { verifyRoomRelays } from '../../src/room-relays.js'
import { nip44 } from 'nostr-tools'
import { deriveChannel } from '@forgesworn/fold-kit'
import type { RoomPolicy } from '../../src/types.js'
import type { KeptPendingSend } from './pending-sends.js'
import type { OrdinaryPhysicalFamily } from './ordinary-physical-snapshot.js'
import { validateOrdinaryNavigationRecord, type OrdinaryNavigationContext } from './ordinary-navigation-snapshot.js'
import { base64, base64urlnopad } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { parseRoomLink, MAX_ROOM_LINK_FRAGMENT_LENGTH, type RoomLink } from '../../src/link.js'
import { deriveRoom } from '../../src/room.js'
import { deriveInvitationId, verifyInvitationDelegation, MAX_INVITATION_DELEGATION_DEPTH, type RoomInvitation, type InvitationDelegation } from '../../src/invitation.js'
import { sanitiseDisplayName } from '../../src/display-name.js'
import { MAX_EPOCH } from '../../src/epoch.js'
import { ROOM_PREFIX } from './rooms-store.js'
import { INVITATION_OWNER_PREFIX } from './invitation-store.js'
import { KEPT_ADMISSION_PREFIX, DEVICE_PREFIX } from './device-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { Event } from 'nostr-tools/pure'
import { classifyOrdinaryPhysicalName, validateOrdinaryPhysicalSnapshot } from './ordinary-physical-snapshot.js'
import { inspectPersistentAdmissionProofs, validatePersistentAdmissionDeviceContinuity, FIXED_INVITATION_RELAYS } from './persistent-admission-proof.js'
import { inspectPersistentCreatorProofs, creatorIsSelected, CREATOR_PROOF_PREFIX, CREATOR_INTENT_PREFIX } from './persistent-creator-proof.js'
import type { DeviceStore } from './device-store.js'
import { ordinaryPairCustodyFor, type OrdinaryPairCustody } from './ordinary-state-owner.js'

const HEX = /^[0-9a-f]{64}$/
const CACHE = 'kithmoot.admission.v1.'
const WAY_BACK = 'kithmoot.way-back'
function hold(): never { throw new OrdinaryStateHold() }
declare const startupBrand: unique symbol
export interface OrdinaryStartupContext {
  readonly [startupBrand]: true
  readonly links: number
  readonly browserAccess: number
  readonly bookmarks: number
  readonly tabAccess: number
  readonly navigation: number
}
export interface OrdinaryRoomAccessOptions {
  readonly kind: 'browser' | 'tab'
  readonly navigation?: OrdinaryNavigationContext
}
interface CapturedStartup {
  readonly browser: Map<string, string>
  readonly tab: Map<string, string>
  readonly href: string
  readonly creators: Map<string, string>
  readonly creatorLinks: readonly string[]
}
interface Composition {
  readonly kinds: ReadonlyMap<string, 'browser' | 'tab'>
  readonly migrated: ReadonlyMap<string, boolean>
  readonly candidates: readonly string[]
}
const capturedStartup = new WeakMap<object, CapturedStartup>()
function evidencePartition(records: ReadonlyMap<string, string>, kind: 'browser' | 'tab'): Map<string, string> {
  const retained = new Map<string, string>()
  for (const [name, raw] of records) {
    const family = classifyOrdinaryPhysicalName(name, kind)?.family
    if (family === 'access' || family === 'bookmarks' || family === 'navigation') retained.set(name, raw)
  }
  return retained
}
/** Capture the actual original startup location and both copied physical
 * images under the startup barrier, before history mutation/owner allocation.
 * No caller-supplied URL or account authority is accepted. */
export function captureOrdinaryStartupContext(browserRecords: ReadonlyMap<string, string>, tabRecords: ReadonlyMap<string, string>): OrdinaryStartupContext {
  try {
    const browser = new Map(browserRecords), tab = new Map(tabRecords)
    validateOrdinaryPhysicalSnapshot(browser, { kind: 'browser' })
    validateOrdinaryPhysicalSnapshot(tab, { kind: 'tab' })
    const href = globalThis.location.href
    ordinaryUtf8Length(href)
    const url = new URL(href)
    const browserEvidence = evidencePartition(browser, 'browser'), tabEvidence = evidencePartition(tab, 'tab')
    let browserAccess = 0, bookmarks = 0, tabAccess = 0, navigation = 0
    for (const name of browserEvidence.keys()) {
      if (classifyOrdinaryPhysicalName(name, 'browser')!.family === 'access') browserAccess++
      else bookmarks++
    }
    for (const [name, raw] of tabEvidence) {
      if (classifyOrdinaryPhysicalName(name, 'tab')!.family === 'access') tabAccess++
      else { validateOrdinaryNavigationRecord(name, raw); navigation++ }
    }
    const context = Object.freeze({ links: url.hash === '' ? 0 : 1, browserAccess, bookmarks, tabAccess, navigation }) as OrdinaryStartupContext
    const creators = new Map([...browser].filter(([name]) => name.includes(CREATOR_PROOF_PREFIX) || name.includes(CREATOR_INTENT_PREFIX)))
    const creatorStore: DeviceStore = { get: n => browser.get(n) ?? null, keys: () => [...browser.keys()], set: hold, remove: hold }
    const checked = inspectPersistentCreatorProofs(creatorStore)
    try { capturedStartup.set(context, { browser: browserEvidence, tab: tabEvidence, href, creators,
      creatorLinks: Object.freeze([...checked.proofs.values()].map(value => value.proof.link)) }) }
    finally { checked.close() }
    return context
  } catch { return hold() }
}
/** Abandon a captured startup without exposing retained bytes. */
export function releaseOrdinaryStartupContext(context: OrdinaryStartupContext): void {
  const captured = capturedStartup.get(context)
  captured?.browser.clear(); captured?.tab.clear(); captured?.creators.clear()
  capturedStartup.delete(context)
}
function sameEvidence(records: ReadonlyMap<string, string>, captured: ReadonlyMap<string, string>, kind: 'browser' | 'tab'): void {
  const current = evidencePartition(records, kind)
  if (current.size !== captured.size || [...current].some(([name, raw]) => captured.get(name) !== raw)) hold()
}
function accessOptions(options: OrdinaryRoomAccessOptions): void {
  object(options, ['kind'], ['navigation'])
  if (options.kind !== 'browser' && options.kind !== 'tab') hold()
}
/** Consume all four captured partitions exactly once. This composes custody
 * evidence across owners, not all ordinary families or live account authority.
 * Capture must precede URL scrubbing; later location changes do not erase the
 * original privately retained bearer. Every failure also consumes the token. */
export function validateOrdinaryRoomAccessAndBookmarksSnapshot(browserRecords: ReadonlyMap<string, string>, tabRecords: ReadonlyMap<string, string>,
  migrated: { browser: boolean; tab: boolean }, context: OrdinaryStartupContext): OrdinaryBookmarkSnapshot {
  return consumeAccessComposition(browserRecords, tabRecords, migrated, context)
}
interface RoomRoot { readonly id: string; readonly key: Uint8Array; readonly policy: RoomPolicy; endsAt?: number }
type RoomRoots = Map<string, RoomRoot>
type RoomInviters = Map<string, Set<string>>
function retainRoot(roots: RoomRoots | undefined, raw: string | Uint8Array, expected: string, policy: RoomPolicy): void {
  if (!roots) return
  const secret = typeof raw === 'string' ? hexToBytes(raw) : new Uint8Array(raw)
  let key: Uint8Array | undefined
  try {
    const root = deriveRoom(secret); key = root.roomKey
    if (root.roomId !== expected) hold()
    const prior = roots.get(expected)
    if (prior) {
      if (bookmarkCanonical(prior.policy) !== bookmarkCanonical(policy) || prior.key.some((v, i) => v !== key![i])) hold()
    } else { roots.set(expected, { id: expected, key, policy }); key = undefined }
  } finally { secret.fill(0); key?.fill(0) }
}
function consumeAccessComposition(browserRecords: ReadonlyMap<string, string>, tabRecords: ReadonlyMap<string, string>,
  migrated: { browser: boolean; tab: boolean }, context: OrdinaryStartupContext, roots?: RoomRoots, inviters?: RoomInviters): OrdinaryBookmarkSnapshot {
  const captured = capturedStartup.get(context)
  capturedStartup.delete(context)
  if (!captured) hold()
  const records = new Map<string, string>(), kinds = new Map<string, 'browser' | 'tab'>(), migration = new Map<string, boolean>(), candidates: string[] = []
  try {
    object(migrated, ['browser', 'tab'])
    if (typeof migrated.browser !== 'boolean' || typeof migrated.tab !== 'boolean') hold()
    const browser = new Map(browserRecords), tab = new Map(tabRecords)
    validateOrdinaryPhysicalSnapshot(browser, { kind: 'browser' })
    validateOrdinaryPhysicalSnapshot(tab, { kind: 'tab' })
    sameEvidence(browser, captured.browser, 'browser'); sameEvidence(tab, captured.tab, 'tab')
    const creators = new Map([...browser].filter(([name]) => name.includes(CREATOR_PROOF_PREFIX) || name.includes(CREATOR_INTENT_PREFIX)))
    if (creators.size !== captured.creators.size || [...creators].some(([name, raw]) => captured.creators.get(name) !== raw)) hold()
    candidates.push(...captured.creatorLinks)
    if (new URL(captured.href).hash !== '') candidates.push(captured.href)
    for (const [kind, partition] of [['browser', captured.browser], ['tab', captured.tab]] as const) {
      for (const [name, raw] of partition) {
        if (classifyOrdinaryPhysicalName(name, kind)!.family === 'navigation') {
          // Shape was checked at capture against these exact bytes.
          const value = parsed(raw) as Record<string, unknown>
          if (name === WAY_BACK) candidates.push(value.link as string)
          else if (value.hash !== '') candidates.push('https://ordinary.invalid/' + value.hash)
          continue
        }
        if (records.has(name)) hold()
        records.set(name, raw); kinds.set(name, kind); migration.set(name, migrated[kind])
      }
    }
    const result = validateBookmarks(records, false, { kind: 'browser' }, { kinds, migrated: migration, candidates }, roots, inviters)
    if (roots) {
      // These exact rows have completed their strict family validation. End
      // claims bind only to already proven traffic roots; absence is not a
      // claim that an older visit knew the room had no end.
      const end = (roomId: string, endsAt: unknown) => {
        if (endsAt === undefined) return
        const root = roots.get(roomId)
        if (!root) return
        if (root.endsAt !== undefined && root.endsAt !== endsAt) hold()
        root.endsAt = endsAt as number
      }
      for (const [physical, raw] of records) {
        const logical = physical.replace(/^kithmoot\.account\.[0-9a-f]{64}\./, '')
        const value = parsed(raw) as Record<string, unknown>
        if (logical.startsWith(ROOM_PREFIX)) end(logical.slice(ROOM_PREFIX.length), value.endsAt)
        else if ([INVITATION_OWNER_PREFIX, KEPT_ADMISSION_PREFIX, CACHE].some(p => logical.startsWith(p))) end(room(value.roomSecret), value.ends)
        else if (logical.startsWith('kithmoot.bookmarks.')) {
          const saved = value as { record?: { roomId: string; room?: { endsAt?: number } }; pending?: { value: { roomId: string; room?: { endsAt?: number } } } }
          for (const retained of [saved.record, saved.pending?.value]) if (retained?.room) end(retained.roomId, retained.room.endsAt)
        }
      }
    }
    return result
  } catch { return hold() }
  finally { captured.browser.clear(); captured.tab.clear(); captured.creators.clear(); records.clear(); kinds.clear(); migration.clear(); candidates.length = 0 }
}
interface CapturedNavigation {
  readonly kind: 'browser' | 'tab'
  readonly access: ReadonlyMap<string, string>
  readonly candidates: readonly string[]
}
const capturedNavigation = new WeakMap<object, CapturedNavigation>()
/** Capture the complete physical snapshot, before partitioning. Candidate bytes
 * stay private to the binding consumer and match this exact access partition.
 * This is custody provenance, never current account/admission authority. */
export function captureOrdinaryNavigationContext(records: ReadonlyMap<string, string>, options: { kind: 'browser' | 'tab' }): OrdinaryNavigationContext {
  try {
    const snapshot = new Map(records)
    validateOrdinaryPhysicalSnapshot(snapshot, options)
    const access = new Map<string, string>(), candidates: string[] = []
    let wayBacks = 0, roomSwitches = 0
    for (const [name, raw] of snapshot) {
      const route = classifyOrdinaryPhysicalName(name, options.kind)
      if (route?.family === 'access') access.set(name, raw)
      if (route?.family !== 'navigation') continue
      validateOrdinaryNavigationRecord(name, raw)
      const value = JSON.parse(raw)
      if (name === WAY_BACK) { wayBacks++; candidates.push(value.link) }
      else { roomSwitches++; if (value.hash !== '') candidates.push('https://ordinary.invalid/' + value.hash) }
    }
    const context = Object.freeze({ wayBacks, roomSwitches }) as OrdinaryNavigationContext
    capturedNavigation.set(context, { kind: options.kind, access, candidates: Object.freeze(candidates) })
    return context
  } catch { return hold() }
}
function navigationFor(records: ReadonlyMap<string, string>, kind: 'browser' | 'tab', context: OrdinaryNavigationContext): CapturedNavigation {
  const captured = capturedNavigation.get(context)
  capturedNavigation.delete(context)
  if (!captured || captured.kind !== kind) hold()
  let count = 0
  for (const [name, raw] of records) {
    const route = classifyOrdinaryPhysicalName(name, kind)
    if (route?.family === 'navigation') hold() // Once-only dispatch.
    if (route?.family !== 'access') continue
    if (captured.access.get(name) !== raw) hold()
    count++
  }
  if (count !== captured.access.size) hold()
  return captured
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function hex(value: unknown): asserts value is string { if (typeof value !== 'string' || !HEX.test(value)) hold() }
function parsed(raw: string): unknown { try { return JSON.parse(raw) } catch { return hold() } }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(name => !Object.hasOwn(value, name)) || Reflect.ownKeys(value).some(name => typeof name !== 'string' || !required.includes(name) && !optional.includes(name))) hold()
}
function scalar(raw: unknown): string {
  hex(raw); const key = hexToBytes(raw)
  try { return getPublicKey(key) } catch { return hold() } finally { key.fill(0) }
}
function room(raw: unknown): string {
  hex(raw); const secret = hexToBytes(raw)
  let key: Uint8Array | undefined
  try { const derived = deriveRoom(secret); key = derived.roomKey; return derived.roomId }
  catch { return hold() } finally { secret.fill(0); key?.fill(0) }
}
function name(raw: unknown): void { if (typeof raw !== 'string' || sanitiseDisplayName(raw) !== raw) hold() }
function link(raw: unknown, allocated: RoomLink[]): RoomLink {
  if (typeof raw !== 'string') hold()
  let value: RoomLink
  try {
    const fragment = new URL(raw).hash.slice(1)
    if (!fragment || fragment.length > MAX_ROOM_LINK_FRAGMENT_LENGTH) hold()
    const bytes = base64urlnopad.decode(fragment)
    let payload: unknown
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } finally { bytes.fill(0) }
    object(payload, [], ['v','s','j','h','r','i','a','n']) // Pairing codes are never retained room links.
    if (payload.v === undefined ? typeof payload.s !== 'string' || Object.hasOwn(payload,'j') || Object.hasOwn(payload,'h') :
        ![2,3].includes(payload.v as number) || typeof payload.j !== 'string' || typeof payload.h !== 'string' || Object.hasOwn(payload,'s')) hold()
    if (Object.hasOwn(payload,'n')) name(payload.n)
    // Fold validates known policy values, but its parser tolerates null and
    // unknown fields. Retained custody cannot silently lose a restriction.
    if (Object.hasOwn(payload,'a')) object(payload.a,['tier'],['admitted','agents','members','quiet'])
    value = parseRoomLink(raw); allocated.push(value)
    for (const [field, safe] of [['r',value.relays],['i',value.iceUrls]] as const) {
      if (Object.hasOwn(payload,field) && JSON.stringify(payload[field]) !== JSON.stringify(safe)) hold()
    }
    if (value.pairingCode) hold()
    return value
  } catch { return hold() }
}
/** Non-room startup/navigation fragments are inert. Recognisable room payloads
 * still go through the strict parser, so a malformed rule is never dropped. */
function roomCandidate(raw: string): boolean {
  let bytes: Uint8Array | undefined
  try {
    const fragment = new URL(raw).hash.slice(1)
    if (!fragment) return false
    if (fragment.length > MAX_ROOM_LINK_FRAGMENT_LENGTH) return false
    bytes = base64urlnopad.decode(fragment)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      ['s', 'j', 'h'].some(field => Object.hasOwn(value, field))
  } catch (error) {
    if (error instanceof OrdinaryStateHold) throw error
    return false
  } finally { bytes?.fill(0) }
}
function roomMetadata(value: unknown, allocated: RoomLink[]): RoomLink {
  object(value, ['link', 'openedAt'], ['readAt', 'readIds', 'name', 'keep', 'endedAt', 'endsAt', 'destruct', 'startsAt'])
  for (const time of ['openedAt', 'readAt', 'endedAt', 'startsAt']) if (Object.hasOwn(value, time) && !integer(value[time])) hold()
  if (Object.hasOwn(value, 'endsAt') && (!integer(value.endsAt) || value.endsAt === 0)) hold()
  if (Object.hasOwn(value, 'name')) name(value.name)
  if (Object.hasOwn(value, 'keep') && typeof value.keep !== 'boolean' || Object.hasOwn(value, 'destruct') && value.destruct !== true) hold()
  if (Object.hasOwn(value, 'readIds')) {
    const ids = value.readIds
    if (!Array.isArray(ids) || ids.length > 2048 || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) hold()
  }
  return link(value.link, allocated)
}
function wipeLinks(allocated: readonly RoomLink[]): void {
  for (const value of allocated) { value.secret?.fill(0); value.invitation?.bearer.fill(0); value.pairingCode?.fill(0) }
}
interface Binding { invitation: RoomInvitation; policy: string; roomId?: string }
interface Access { id: string; raw: Record<string, unknown>; owner: boolean; account?: string }
export interface OrdinaryRoomAccessSnapshot {
  readonly rooms: readonly { readonly roomId: string; readonly account?: string }[]
  readonly invitations: readonly { readonly invitationId: string; readonly roomId: string; readonly kind: 'owner' | 'kept' | 'tab'; readonly persistent: boolean }[]
}
/** Complete snapshots of this family, without pruning expiry, guessing a
 * missing pinned invitation or granting current responder authority. Exact
 * links from captured startup and explicit navigation context may bind creator
 * records written before a room was listed, and rotated links. Missing such
 * evidence holds the original records for explicit recovery. Startup evidence
 * belongs to the both-owner access/bookmark composer. Other families still
 * require their complete same-image validators. */
export function validateOrdinaryRoomAccessSnapshot(records: ReadonlyMap<string,string>, migrated: boolean,
  options: OrdinaryRoomAccessOptions): OrdinaryRoomAccessSnapshot {
  accessOptions(options)
  return validateAccess(new Map(records), migrated, options, [])
}
function validateAccess(records: ReadonlyMap<string,string>, migrated: boolean,
  options: OrdinaryRoomAccessOptions, retainedRooms: readonly { roomId: string; value: RoomLink }[], composition?: Composition, roots?: RoomRoots, inviters?: RoomInviters): OrdinaryRoomAccessSnapshot {
  const kind = options.kind
  if (kind !== 'browser' && kind !== 'tab') hold()
  const navigation = options.navigation === undefined ? undefined : navigationFor(records, kind, options.navigation)
  const allocated: RoomLink[] = [], bindings = new Map<string,Binding>(), roomPolicies = new Map<string,string>(), access: (Access & { kind: 'owner' | 'kept' | 'tab' })[] = []
  const rooms: { roomId: string; account?: string }[] = [], roomLinks: { roomId: string; value: RoomLink }[] = []
  const claimPolicy = (roomId: string, policy: string) => {
    const prior = roomPolicies.get(roomId)
    if (prior !== undefined && prior !== policy) hold()
    roomPolicies.set(roomId, policy)
  }
  const bind = (value: RoomLink, expected?: string) => {
    const policy = bookmarkCanonical(value.policy ?? { tier: 'open' })
    if (value.secret) {
      const roomId = roomHex(value.secret)
      if (expected && roomId !== expected) hold()
      claimPolicy(roomId, policy)
      retainRoot(roots, value.secret, roomId, value.policy ?? { tier: 'open' })
      return
    }
    if (!value.invitation) hold()
    const id = deriveInvitationId(value.invitation), prior = bindings.get(id)
    // An explicit meeting/group conversion preserves the same bearer/root;
    // retained record flags govern persistence. Labels and transport hints are
    // not policy. Conflicting security evidence never selects the last link.
    if (prior && (prior.invitation.inviter !== value.invitation.inviter ||
        base64urlnopad.encode(prior.invitation.bearer) !== base64urlnopad.encode(value.invitation.bearer) ||
        prior.policy !== policy || expected && prior.roomId && expected !== prior.roomId)) hold()
    const roomId = expected ?? prior?.roomId
    if (roomId) claimPolicy(roomId, policy)
    bindings.set(id, { invitation: prior?.invitation ?? value.invitation, policy, ...(roomId ? { roomId } : {}) })
  }
  try {
    for (const [physical,raw] of records) {
      const recordKind = composition?.kinds.get(physical) ?? kind, recordMigrated = composition?.migrated.get(physical) ?? migrated
      let logical = physical, account: string | undefined
      if (logical.startsWith('kithmoot.account.')) {
        const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(logical)
        if (!match) hold()
        account = match[1]!; logical = match[2]!
        if (logical.startsWith('kithmoot.account.')) hold()
      }
      if (logical.startsWith(ROOM_PREFIX)) {
        if (recordKind !== 'browser') hold()
        const roomId = logical.slice(ROOM_PREFIX.length); hex(roomId)
        roomLinks.push({ roomId, value: roomMetadata(parsed(raw), allocated) })
        // Account-scoped metadata is an existing plaintext writer format.
        rooms.push(Object.freeze({ roomId, ...(account ? { account } : {}) }))
        continue
      }
      // Navigation is a separately captured physical partition. Never parse
      // or dispatch those rows through access a second time.
      if (logical === WAY_BACK || logical.startsWith(WAY_BACK + '.') || logical === 'kithmoot.room-switch' || logical.startsWith('kithmoot.room-switch.')) hold()
      const prefix = [INVITATION_OWNER_PREFIX,KEPT_ADMISSION_PREFIX,CACHE].find(prefix => logical.startsWith(prefix))
      if (!prefix) continue
      if (account !== undefined && !recordMigrated || (prefix === CACHE ? recordKind !== 'tab' : recordKind !== 'browser')) hold()
      const id = logical.slice(prefix.length); hex(id)
      const value = parsed(raw)
      const owner = prefix === INVITATION_OWNER_PREFIX, kept = prefix === KEPT_ADMISSION_PREFIX
      object(value,owner ? ['roomSecret','inviterSk','createdAt'] : kept ? ['roomSecret','createdAt'] : ['roomSecret'],
        owner ? ['persistent','ends','destruct'] : ['persistent','epoch','ends','destruct','delegateSk','delegation'])
      if ((owner || kept) && !integer(value.createdAt)) hold()
      if (Object.hasOwn(value,'persistent') && value.persistent !== true || Object.hasOwn(value,'destruct') && value.destruct !== true) hold()
      if (Object.hasOwn(value,'ends') && (!integer(value.ends) || value.ends === 0)) hold()
      if (value.persistent !== true && (Object.hasOwn(value,'ends') || Object.hasOwn(value,'destruct'))) hold()
      if (!owner) {
        if (Object.hasOwn(value,'epoch') && (!integer(value.epoch) || value.epoch > MAX_EPOCH)) hold()
        if (value.persistent === true ? value.epoch !== 0 || Object.hasOwn(value,'delegateSk') || Object.hasOwn(value,'delegation') :
            !Object.hasOwn(value,'delegateSk') || !Object.hasOwn(value,'delegation')) hold()
      }
      access.push({ id, raw: value, owner, ...(account ? { account } : {}), kind: owner ? 'owner' : kept ? 'kept' : 'tab' })
    }
    // All access and bookmark rows have passed structural parsing. Resolve
    // their retained links together once, including cross-owner signer claims.
    for (const value of [...retainedRooms, ...roomLinks]) bind(value.value, value.roomId)
    if (composition && (roots !== undefined || access.some(value => !bindings.has(value.id)))) {
      for (const raw of composition.candidates) if (roomCandidate(raw)) bind(link(raw, allocated))
    }
    if (navigation && access.some(value => !bindings.has(value.id))) {
      for (const raw of navigation.candidates) if (roomCandidate(raw)) bind(link(raw, allocated))
    }
    const invitations: { invitationId: string; roomId: string; kind: 'owner' | 'kept' | 'tab'; persistent: boolean }[] = []
    const signerOwners = new Map<string,string>()
    const claimSigner = (pub: string, role: string) => {
      const prior = signerOwners.get(pub)
      if (prior !== undefined && prior !== role) hold()
      signerOwners.set(pub,role)
    }
    const legacy = new Set(access.filter(value=>value.account===undefined).map(value=>value.kind+':'+value.id))
    for (const value of access) {
      if (value.account !== undefined && legacy.has(value.kind+':'+value.id)) hold()
      const pinned = bindings.get(value.id)
      if (!pinned) hold()
      const roomId = room(value.raw.roomSecret)
      if (pinned.roomId && pinned.roomId !== roomId) hold()
      pinned.roomId = roomId
      claimPolicy(roomId, pinned.policy)
      if (value.owner) {
        const pub = scalar(value.raw.inviterSk)
        if (pub !== pinned.invitation.inviter) hold()
        claimSigner(pub,'owner:'+value.id)
      } else if (value.raw.persistent !== true) {
        const pub = scalar(value.raw.delegateSk), chain = value.raw.delegation
        if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_INVITATION_DELEGATION_DEPTH) hold()
        let at = Number.MAX_SAFE_INTEGER
        for (const cert of chain) {
          object(cert,['invitation','room','issuer','delegate','expiresAt','sig'])
          for (const field of ['invitation','room','issuer','delegate']) hex(cert[field])
          if (cert.invitation !== value.id || cert.room !== roomId || !integer(cert.expiresAt) || cert.expiresAt === 0 ||
              typeof cert.sig !== 'string' || !/^[0-9a-f]{128}$/.test(cert.sig)) hold()
          at = Math.min(at,cert.expiresAt)
        }
        if (verifyInvitationDelegation(pinned.invitation,chain as InvitationDelegation[],at-1) !== pub) hold()
        claimSigner(pub,'delegate:'+roomId)
      }
      retainRoot(roots, value.raw.roomSecret as string, roomId, JSON.parse(pinned.policy) as RoomPolicy)
      invitations.push(Object.freeze({ invitationId:value.id,roomId,kind:value.kind,persistent:value.raw.persistent===true }))
    }
    if (inviters) for (const binding of bindings.values()) {
      if (!binding.roomId) continue
      // Rotation can leave distinct old invitations for this same room.
      // These candidates authenticate historical custody, never select the
      // current inviter or permit routing. Conflicts within one invitation
      // have already held during resolution above.
      const known = inviters.get(binding.roomId) ?? new Set<string>()
      known.add(binding.invitation.inviter); inviters.set(binding.roomId, known)
    }
    rooms.sort((a,b)=>a.roomId.localeCompare(b.roomId)||(a.account??'').localeCompare(b.account??''))
    invitations.sort((a,b)=>a.invitationId.localeCompare(b.invitationId)||a.kind.localeCompare(b.kind))
    return Object.freeze({ rooms:Object.freeze(rooms),invitations:Object.freeze(invitations) })
  } finally {
    wipeLinks(allocated)
    bindings.clear(); roomPolicies.clear(); access.length=0; roomLinks.length=0
  }
}
function roomHex(secret: Uint8Array): string {
  const keys=deriveRoom(secret)
  try { return keys.roomId } finally { keys.roomKey.fill(0) }
}

const BOOKMARK_PREFIX='kithmoot.bookmarks.', BOOKMARK_APP='kithmoot.rooms.v1'
// Exact randomUUID writer format. Its shape cannot prove actual randomness.
const BOOKMARK_HEX=/^[0-9a-f]{64}$/, BOOKMARK_ADDRESS=/^kithmoot\.rooms\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function bookmarkHold():never { throw new OrdinaryStateHold() }
function bookmarkObject(value:unknown,required:readonly string[],optional:readonly string[]=[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||
    required.some(name=>!Object.hasOwn(value,name))||Reflect.ownKeys(value).some(name=>typeof name!=='string'||!required.includes(name)&&!optional.includes(name)))bookmarkHold()
}
function bookmarkInteger(value:unknown):value is number { return Number.isSafeInteger(value)&&(value as number)>=0 }
function bookmarkHex(value:unknown):asserts value is string { if(typeof value!=='string'||!BOOKMARK_HEX.test(value))bookmarkHold() }
function bookmarkParsed(raw:string):unknown { try{return JSON.parse(raw)}catch{return bookmarkHold()} }
function bookmarkCanonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(bookmarkCanonical).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+bookmarkCanonical(item)).join(',')+'}'
  return JSON.stringify(value)
}
export interface OrdinaryBookmarkSnapshot {
  readonly access:OrdinaryRoomAccessSnapshot
  readonly bookmarks:readonly {readonly account:string;readonly roomId:string;readonly record:boolean;readonly pending:boolean;readonly removed:boolean}[]
}
/** Offline custody checks only. A signed ciphertext authenticates its exact
 * event and address/account, never the separately cached plaintext. Restoration
 * still needs the account signer to decrypt and compare it before effects.
 * No expiry pruning, relay repair, signing or publication occurs here. */
export function validateOrdinaryRoomBookmarkSnapshot(records:ReadonlyMap<string,string>,migrated:boolean,
  options:OrdinaryRoomAccessOptions):OrdinaryBookmarkSnapshot {
  accessOptions(options)
  return validateBookmarks(new Map(records), migrated, options)
}
function validateBookmarks(records: ReadonlyMap<string,string>, migrated: boolean, options: OrdinaryRoomAccessOptions, composition?: Composition, roots?: RoomRoots, inviters?: RoomInviters): OrdinaryBookmarkSnapshot {
  const allocated: RoomLink[] = [], links:{roomId:string;value:RoomLink}[]=[],bookmarks:{account:string;roomId:string;record:boolean;pending:boolean;removed:boolean}[]=[]
  const addresses=new Map<string,string>(),ids=new Map<string,string>(),events=new Map<string,{scope:string;d:string;value:string}>()
  const claimId=(id:string,scope:string)=>{
    const prior=ids.get(id);if(prior!==undefined&&prior!==scope)bookmarkHold();ids.set(id,scope)
  }
  const claimAddress=(raw:unknown,scope:string):string=>{
    if(typeof raw!=='string'||!BOOKMARK_ADDRESS.test(raw))bookmarkHold()
    const prior=addresses.get(raw);if(prior!==undefined&&prior!==scope)bookmarkHold();addresses.set(raw,scope);return raw
  }
  const value=(raw:unknown,roomId:string):Record<string,unknown>=>{
    bookmarkObject(raw,['roomId','at'],['room','admission'])
    if(raw.roomId!==roomId||!bookmarkInteger(raw.at))bookmarkHold()
    if(Object.hasOwn(raw,'room')){
      bookmarkObject(raw.room,['roomId','link','openedAt','readAt'],['readIds','name','keep','endedAt','endsAt','destruct','startsAt'])
      if(raw.room.roomId!==roomId)bookmarkHold()
      const {roomId:_,...metadata}=raw.room
      // Parse once inside the closure; resolve against the complete image later.
      links.push({roomId,value:roomMetadata(metadata,allocated)})
    }
    if(Object.hasOwn(raw,'admission')){
      if(!Object.hasOwn(raw,'room'))bookmarkHold()
      bookmarkObject(raw.admission,['secret']);bookmarkHex(raw.admission.secret)
      const secret=hexToBytes(raw.admission.secret);let key:Uint8Array|undefined
      try{const derived=deriveRoom(secret);key=derived.roomKey;if(derived.roomId!==roomId)bookmarkHold();retainRoot(roots,secret,roomId,links.at(-1)!.value.policy??{tier:'open'})}finally{secret.fill(0);key?.fill(0)}
    }
    return raw
  }
  const event=(raw:unknown,account:string,roomId:string,d:string,stored:Record<string,unknown>,id?:string)=>{
    bookmarkObject(raw,['id','pubkey','kind','created_at','tags','content','sig'])
    bookmarkHex(raw.id);bookmarkHex(raw.pubkey)
    if(raw.pubkey!==account||raw.kind!==30078||!bookmarkInteger(raw.created_at)||raw.created_at!==Math.floor((stored.at as number)/1000)||
      id!==undefined&&raw.id!==id||typeof raw.sig!=='string'||!/^[0-9a-f]{128}$/.test(raw.sig)||
      typeof raw.content!=='string'||raw.content.length<132||raw.content.length>60_000||!Array.isArray(raw.tags)||raw.tags.length!==2||
      raw.tags.some(tag=>!Array.isArray(tag)||tag.length!==2||typeof tag[0]!=='string'||typeof tag[1]!=='string')||
      raw.tags.filter(tag=>tag[0]==='d'&&tag[1]===d).length!==1||raw.tags.filter(tag=>tag[0]==='l'&&tag[1]===BOOKMARK_APP).length!==1)bookmarkHold()
    if(!verifyEventUncached(raw as unknown as Event))bookmarkHold()
    // NIP-44 v2 envelope only. No MAC or plaintext assertion without signer.
    let bytes:Uint8Array|undefined
    try{bytes=base64.decode(raw.content);if(bytes.length<99||bytes[0]!==2||base64.encode(bytes)!==raw.content)bookmarkHold()}
    catch{return bookmarkHold()}finally{bytes?.fill(0)}
    const scope=account+':'+roomId,encoded=bookmarkCanonical(stored),prior=events.get(raw.id)
    claimId(raw.id,scope)
    if(prior&&(prior.scope!==scope||prior.d!==d||prior.value!==encoded))bookmarkHold()
    events.set(raw.id,{scope,d,value:encoded})
  }
  try{
    for(const [physical,raw]of records){
      let name=physical
      if(name.startsWith('kithmoot.account.')){
        const scoped=/^kithmoot\.account\.[0-9a-f]{64}\.(.+)$/.exec(name)
        if(!scoped)bookmarkHold();name=scoped[1]!
        if(name.startsWith(BOOKMARK_PREFIX))bookmarkHold() // Existing bookmark key already includes its account.
      }
      if(!name.startsWith(BOOKMARK_PREFIX))continue
      if(options.kind!=='browser')bookmarkHold()
      const match=/^kithmoot\.bookmarks\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(name)
      if(!match)bookmarkHold()
      const account=match[1]!,roomId=match[2]!,scope=account+':'+roomId,saved=bookmarkParsed(raw)
      bookmarkObject(saved,[],['record','pending'])
      if(!Object.hasOwn(saved,'record')&&!Object.hasOwn(saved,'pending'))bookmarkHold()
      let recordValue:Record<string,unknown>|undefined,recordId:string|undefined,recordD:string|undefined
      if(Object.hasOwn(saved,'record')){
        bookmarkObject(saved.record,['roomId','at','d','id'],['room','admission','event'])
        const {d,id,event:signed,...plain}=saved.record;recordValue=value(plain,roomId);bookmarkHex(id);recordId=id;claimId(id,scope);recordD=claimAddress(d,scope)
        if(Object.hasOwn(saved.record,'event'))event(signed,account,roomId,recordD,recordValue,recordId)
      }
      if(Object.hasOwn(saved,'pending')){
        bookmarkObject(saved.pending,['value','d'],['event'])
        const plain=value(saved.pending.value,roomId),d=claimAddress(saved.pending.d,scope)
        if(Object.hasOwn(saved.pending,'event')){
          event(saved.pending.event,account,roomId,d,plain)
          const id=(saved.pending.event as Record<string,unknown>).id
          if(id===recordId&&(d!==recordD||bookmarkCanonical(plain)!==bookmarkCanonical(recordValue)))bookmarkHold()
        }
      }
      const current=Object.hasOwn(saved,'pending')?(saved.pending as Record<string,unknown>).value:recordValue
      bookmarks.push(Object.freeze({account,roomId,record:Object.hasOwn(saved,'record'),pending:Object.hasOwn(saved,'pending'),removed:!Object.hasOwn(current as object,'room')}))
    }
    const access=validateAccess(records,migrated,options,links,composition,roots,inviters)
    bookmarks.sort((a,b)=>a.account.localeCompare(b.account)||a.roomId.localeCompare(b.roomId))
    return Object.freeze({access,bookmarks:Object.freeze(bookmarks)})
  }finally{wipeLinks(allocated);links.length=0;addresses.clear();ids.clear();events.clear()}
}

declare const snapshotBrand: unique symbol
export interface OrdinarySnapshotContext {
  readonly [snapshotBrand]: true
  readonly browserRecords: number
  readonly tabRecords: number
}
interface CapturedImage {
  readonly browser: Map<string, string>
  readonly tab: Map<string, string>
  readonly startup: OrdinaryStartupContext
  readonly origin: string
  readonly custody?: ReturnType<typeof ordinaryPairCustodyFor>
}
const capturedImages = new WeakMap<object, CapturedImage>()
function privateImage(records: ReadonlyMap<string, string>, kind: 'browser' | 'tab'): Map<string, string> {
  return new Map([...records].filter(([name]) => classifyOrdinaryPhysicalName(name, kind) !== undefined))
}
/** Capture one complete reserved image for each owner and the original native
 * location before startup effects. Caller mutations cannot change these copies.
 * The entry barrier and current authority are still separate runtime work. */
export function captureOrdinarySnapshotContext(browserRecords: ReadonlyMap<string, string>, tabRecords: ReadonlyMap<string, string>, token?: OrdinaryPairCustody): OrdinarySnapshotContext {
  try {
    const browser = new Map(browserRecords), tab = new Map(tabRecords)
    validateOrdinaryPhysicalSnapshot(browser, { kind: 'browser' })
    validateOrdinaryPhysicalSnapshot(tab, { kind: 'tab' })
    const keptBrowser = privateImage(browser, 'browser'), keptTab = privateImage(tab, 'tab')
    const startup = captureOrdinaryStartupContext(keptBrowser, keptTab)
    const origin = new URL(capturedStartup.get(startup)!.href).origin
    const context = Object.freeze({ browserRecords: keptBrowser.size, tabRecords: keptTab.size }) as OrdinarySnapshotContext
    const custody = token ? ordinaryPairCustodyFor(token, browser, tab) : undefined
    capturedImages.set(context, { browser: keptBrowser, tab: keptTab, startup, origin, custody })
    return context
  } catch { return hold() }
}
export function releaseOrdinarySnapshotContext(context: OrdinarySnapshotContext): void {
  const image = capturedImages.get(context)
  capturedImages.delete(context)
  if (image) { releaseOrdinaryStartupContext(image.startup); image.browser.clear(); image.tab.clear() }
}
interface DeviceBinding { readonly account: string; readonly roomId: string; readonly device: string }
interface TrafficRoot { readonly epoch: number; readonly id: string; readonly key: Uint8Array }
export interface OrdinarySnapshotCounts {
  readonly browserRecords: number
  readonly tabRecords: number
  readonly families: Readonly<Partial<Record<OrdinaryPhysicalFamily, number>>>
  readonly rooms: number
  readonly identities: number
  readonly epochs: number
  readonly invitations: number
  readonly bookmarks: number
  readonly quietRooms: number
  readonly pendingQueues: number
  readonly pendingRecords: number
  readonly historicalRoomRelayRecords: number
  readonly historicalFixedInvitationProofs?: number
  readonly historicalCreatorInvitationProofs?: number
}
/** Whole captured image custody preflight with actual room/identity/epoch and
 * inner-message bindings. No raw keys, links, records or live authority escape.
 * Opaque family carriers still need signer-backed/current restoration proof.
 * Cadence requires separate authenticated node/grant evidence, unavailable in
 * this raw image. Such records HOLD; no synthetic predicate supplies it. */
export function validateOrdinarySnapshot(browserRecords: ReadonlyMap<string, string>, tabRecords: ReadonlyMap<string, string>,
  migrated: { browser: boolean; tab: boolean }, context: OrdinarySnapshotContext): OrdinarySnapshotCounts {
  const image = capturedImages.get(context)
  capturedImages.delete(context)
  if (!image) hold()
  const roots: RoomRoots = new Map(), allocated: Uint8Array[] = [], devices = new Map<string, DeviceBinding>(), traffic = new Map<string, Map<number, TrafficRoot>>()
  const assignmentQueues = new Map<string, Set<string>>()
  const inviters: RoomInviters = new Map()
  const partitions = { browser: new Map<OrdinaryPhysicalFamily, Map<string, string>>(), tab: new Map<OrdinaryPhysicalFamily, Map<string, string>>() }
  const families: Partial<Record<OrdinaryPhysicalFamily, number>> = {}
  let proofCustody: ReturnType<typeof inspectPersistentAdmissionProofs> | undefined
  let creatorCustody: ReturnType<typeof inspectPersistentCreatorProofs> | undefined
  const namespace = (roomId: string, account?: string) => (account ?? 'legacy') + ':' + roomId
  try {
    object(migrated, ['browser', 'tab'])
    if (typeof migrated.browser !== 'boolean' || typeof migrated.tab !== 'boolean') hold()
    for (const [kind, input] of [['browser', browserRecords], ['tab', tabRecords]] as const) {
      const current = new Map(input)
      validateOrdinaryPhysicalSnapshot(current, { kind })
      const selected = privateImage(current, kind), captured = image[kind]
      if (selected.size !== captured.size || [...selected].some(([n, v]) => captured.get(n) !== v)) hold()
      for (const [name, raw] of captured) {
        const route = classifyOrdinaryPhysicalName(name, kind)!
        let part = partitions[kind].get(route.family)
        if (!part) { part = new Map(); partitions[kind].set(route.family, part) }
        part.set(name, raw); families[route.family] = (families[route.family] ?? 0) + 1
      }
    }
    const part = (kind: 'browser' | 'tab', family: OrdinaryPhysicalFamily) => partitions[kind].get(family) ?? new Map<string, string>()
    // Independent family structure is checked before inner-message bindings.
    const simple = [
      ['contacts', validateOrdinaryContactSnapshot], ['grantedContacts', validateOrdinaryGrantedContactSnapshot],
      ['metadata', validateOrdinaryMetadataSnapshot], ['channelChecks', validateOrdinaryChannelCheckSnapshot],
      ['journals', validateOrdinaryJournalSnapshot], ['private', validateOrdinaryPrivateFamilySnapshot],
      ['media', validateOrdinaryMediaSnapshot], ['routing', validateOrdinaryRoutingSnapshot],
      ['ui', validateOrdinaryUiSnapshot], ['entryLayout', validateOrdinaryEntryLayoutSnapshot],
    ] as const
    for (const kind of ['browser', 'tab'] as const) {
      for (const [family, validate] of simple) validate(part(kind, family), migrated[kind], { kind })
      validateOrdinarySignetSnapshot(part(kind, 'signet'), { kind, origin: image.origin, appName: 'KithMoot' })
    }
    if ((families.cadence ?? 0) !== 0) hold()
    const identity = validateOrdinaryIdentitySnapshot(part('browser', 'identity'), migrated.browser)
    const epochs = validateOrdinaryEpochSnapshot(part('browser', 'epoch'), migrated.browser)
    const access = consumeAccessComposition(image.browser, image.tab, migrated, image.startup, roots, inviters)
    const readonlyStore = (records: ReadonlyMap<string, string>): DeviceStore => ({
      get: name => records.get(name) ?? null, keys: () => [...records.keys()], set: hold, remove: hold,
    })
    if (part('browser', 'invitationProofs').size && !migrated.browser || part('tab', 'invitationProofs').size && !migrated.tab) hold()
    proofCustody = inspectPersistentAdmissionProofs(readonlyStore(image.browser), readonlyStore(image.tab))
    creatorCustody = inspectPersistentCreatorProofs(readonlyStore(image.browser))
    for (const verified of creatorCustody.proofs.values()) {
      const bound = verified.proof.binding, retained = roots.get(bound.roomId), derived = deriveRoom(verified.admission.secret)
      try {
        if (!image.custody || bound.browser.generation !== image.custody.browser.generation ||
            bound.browser.fence !== (image.custody.browser.fences.get(bound.browser.name) ?? 0) || !retained ||
            retained.id !== derived.roomId || retained.key.some((value, i) => value !== derived.roomKey[i]) ||
            !inviters.get(bound.roomId)?.has(verified.proof.capability.inviter) ||
            !access.access.invitations.some(value => value.kind === 'owner' && value.invitationId === bound.invitationId && value.roomId === bound.roomId && value.persistent)) hold()
      } finally { derived.roomKey.fill(0) }
    }
    const proven = new Set([...proofCustody.proofs.values(), ...proofCustody.selected.values()])
    for (const verified of proven) {
      const bound = verified.proof.binding, retained = roots.get(bound.roomId)
      const derived = deriveRoom(verified.admission.secret)
      try {
        if (!image.custody || bound.browser.generation !== image.custody.browser.generation ||
            bound.browser.fence !== (image.custody.browser.fences.get(bound.browser.name) ?? 0)) hold()
        if ([...proofCustody.selected.values()].includes(verified) &&
            (bound.tab.generation !== image.custody.tab.generation || bound.tab.purpose !== image.custody.tab.purpose ||
              bound.tab.expiresAt !== image.custody.tab.expiresAt || bound.tab.fence !== (image.custody.tab.fences.get(bound.tab.name) ?? 0))) hold()
        if (!retained || derived.roomId !== retained.id || retained.key.some((v, i) => v !== derived.roomKey[i]) ||
            !inviters.get(bound.roomId)?.has(verified.proof.capability.inviter) ||
            !access.access.invitations.some(value => value.invitationId === bound.invitationId && value.roomId === bound.roomId && value.persistent)) hold()
        if ([...proofCustody.selected.values()].includes(verified)) validatePersistentAdmissionDeviceContinuity(readonlyStore(image.browser), bound)
      } finally { derived.roomKey.fill(0) }
    }
    let historicalRoomRelayRecords = 0
    let historicalFixedInvitationProofs = 0
    for (const [name, raw] of part('browser', 'routing')) {
      if (name === FIXED_INVITATION_RELAYS) {
        const fixed = parsed(raw) as Record<string, { c: string[]; signed: boolean }>
        for (const [roomId, row] of Object.entries(fixed)) if (row.signed) {
          // A bare historical flag still holds. Only retained, independently
          // verified contributor events bind this exact writer list. This is
          // historical custody, never current routing or membership authority.
          const member = [...proofCustody.proofs.values()].some(value => value.proof.binding.roomId === roomId &&
              value.proof.selection.relays !== null && value.proof.selection.contributors.relays.length > 0 &&
              JSON.stringify(value.proof.selection.relays) === JSON.stringify(row.c))
          const creator = [...creatorCustody.proofs.values()].some(value => value.proof.binding.roomId === roomId &&
            creatorIsSelected(readonlyStore(image.browser), value.proof) && JSON.stringify(value.admission.relays) === JSON.stringify(row.c))
          if (!member && !creator) hold()
          historicalFixedInvitationProofs++
        }
      } else if (name.startsWith('kithmoot.room-relays.v1.')) {
        const roomId = name.slice('kithmoot.room-relays.v1.'.length)
        const record = parsed(raw) as { relays: string[]; version: number; sig: string }
        let matches = 0
        for (const authority of inviters.get(roomId) ?? []) if (verifyRoomRelays({ roomId, ...record, authority })) matches++
        if (matches !== 1) hold()
        historicalRoomRelayRecords++
      }
    }
    for (const binding of identity.rooms) {
      if (!roots.has(binding.roomId)) hold()
      const prefix = binding.scoped ? 'kithmoot.account.' + binding.account + '.' : ''
      const raw = part('browser', 'identity').get(prefix + DEVICE_PREFIX + binding.roomId)
      if (!raw) hold()
      const device = scalar((parsed(raw) as Record<string, unknown>).sk)
      const value = { account: binding.account, roomId: binding.roomId, device }
      devices.set(namespace(binding.roomId, binding.account), value)
      if (!binding.scoped) devices.set(namespace(binding.roomId), value)
    }
    const addTraffic = (scope: string, root: TrafficRoot) => {
      const prior = traffic.get(scope) ?? new Map<number, TrafficRoot>()
      const known = prior.get(root.epoch)
      if (known && (known.id !== root.id || known.key.some((v, i) => v !== root.key[i]))) hold()
      if (!known) prior.set(root.epoch, root)
      traffic.set(scope, prior)
    }
    for (const binding of epochs.rooms) {
      const room = roots.get(binding.roomId)
      if (!room || !devices.has(namespace(binding.roomId, binding.account))) hold()
      const scope = namespace(binding.roomId, binding.account), prefix = binding.account ? 'kithmoot.account.' + binding.account + '.' : ''
      const v1 = part('browser', 'epoch').get(prefix + 'kithmoot.room-epoch.v1.' + binding.roomId)
      const v2 = part('browser', 'epoch').get(prefix + 'kithmoot.room-epoch.v2.' + binding.roomId)
      if (v1) {
        const value = parsed(v1) as { epoch: number; id: string; key: string }, key = hexToBytes(value.key)
        allocated.push(key); addTraffic(scope, { epoch: value.epoch, id: value.id, key })
      }
      if (v2) {
        const value = parsed(v2) as { epoch: number; secret: string; past: { epoch: number; secret: string }[] }
        for (const retained of [value, ...value.past]) {
          const secret = hexToBytes(retained.secret)
          try {
            const derived = deriveEpoch({ epoch: retained.epoch, secret });
            allocated.push(derived.key); addTraffic(scope, derived)
          } finally { secret.fill(0) }
        }
      }
    }
    const rootsFor = (roomId: string, account: string): readonly TrafficRoot[] => {
      const device = devices.get(namespace(roomId, account)), room = roots.get(roomId)
      if (!device || !room) hold()
      const scoped = traffic.get(namespace(roomId, account)), legacy = traffic.get(namespace(roomId))
      // Legacy epochs belong only to the credential-bound legacy device owner.
      const chosen = scoped ?? (devices.get(namespace(roomId))?.account === account ? legacy : undefined)
      const unique: TrafficRoot[] = []
      for (const root of [{ epoch: 0, id: roomId, key: room.key }, ...chosen?.values() ?? []]) {
        if (!unique.some(prior => prior.epoch === root.epoch && prior.id === root.id && prior.key.every((v, i) => v === root.key[i]))) unique.push(root)
      }
      return unique
    }
    const decode = (event: Event, roomId: string, account: string, channel: string | undefined, candidates: readonly TrafficRoot[]): ChatMessage | null => {
      const room = roots.get(roomId), device = devices.get(namespace(roomId, account))
      if (!room || !device) return null
      let result: ChatMessage | null = null
      for (const candidate of candidates) {
        const derived = deriveChannel(candidate.id, candidate.key, channel)
        try {
          if (event.tags.find(t => t[0] === 'd')?.[1] !== derived.id) continue
          // The chat reader deliberately repairs malformed optional fields.
          // Custody must preserve what was written, so inspect the authenticated
          // plaintext too and refuse any repair, hidden field or duplicate key.
          const tags = [['d', derived.id]]
          if (room.endsAt !== undefined) tags.push(['expiration', String(room.endsAt)])
          if (bookmarkCanonical(event.tags) !== bookmarkCanonical(tags)) hold()
          const plaintext = nip44.v2.decrypt(event.content, derived.key), raw = JSON.parse(plaintext)
          if (JSON.stringify(raw) !== plaintext) hold()
          object(raw, ['id', 'participant', 'device', 'credential', 'text', 'sentAt'],
            ['assignment', 'proof', 'name', 'reaction', 'sentAtMs', 'kind', 'speaker', 'attachments', 'artwork', 'roomLogo', 'owner', 'ownerClaim', 'reply', 'thread', 'replaces', 'retracts', 'mentions', 'invite'])
          if (typeof raw.id !== 'string' || !/^[0-9a-f]{32}$/.test(raw.id)) hold()
          validateOrdinaryEmbeddedDeviceCredential(raw.credential, roomId)
          const message = decodeChatEvent(event, { roomId, roomKey: room.key, epoch: candidate, policy: room.policy, channel, now: event.created_at })
          if (!message || bookmarkCanonical(raw) !== bookmarkCanonical(message) || message.participant !== account || message.device !== device.device || message.device !== event.pubkey || message.sentAt !== event.created_at) continue
          if (result) hold()
          result = message
        } finally { if (derived.key !== candidate.key) derived.key.fill(0) }
      }
      return result
    }
    const assignmentInner = (value: unknown, roomId: string) => {
      object(value, ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig'])
      if (!integer(value.created_at) || typeof value.id !== 'string' || !HEX.test(value.id) || typeof value.pubkey !== 'string' || !HEX.test(value.pubkey) ||
          typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig) || typeof value.content !== 'string' ||
          JSON.stringify(JSON.parse(value.content)) !== value.content) hold()
      const payload = assignmentPayload(value as unknown as Event, roomId)
      if (!payload) hold()
      return payload
    }
    const assignmentMessage = (message: ChatMessage, roomId: string): boolean => {
      if (!message.assignment) return false
      const payload = assignmentInner(message.assignment, roomId)
      return payload.device === message.device && message.text === 'Assignment ' + payload.operation.op
    }
    for (const [name, raw] of part('browser', 'journals')) {
      const match = /^kithmoot\.assignments\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(name)
      if (!match) continue
      const account = match[1]!, roomId = match[2]!, room = roots.get(roomId)
      if (!room) hold()
      // AssignmentLog always encrypts its journal with the stable room key,
      // even when an outgoing outer envelope uses a later protocol epoch.
      const journal = parsed(raw) as { events: string[]; outbox: string[] }
      const open = (cipher: string): unknown => {
        const text = nip44.v2.decrypt(cipher, room.key), value: unknown = JSON.parse(text)
        if (JSON.stringify(value) !== text) hold()
        return value
      }
      const events = new Set<string>(), requests = new Set<string>(), outerIds = new Set<string>(), outers = new Set<string>()
      for (const cipher of journal.events) {
        const inner = open(cipher); assignmentInner(inner, roomId)
        const id = (inner as Event).id
        if (events.has(id)) hold()
        events.add(id)
      }
      for (const cipher of journal.outbox) {
        const pending = open(cipher); object(pending, ['inner', 'outer'])
        const payload = assignmentInner(pending.inner, roomId)
        object(pending.outer, ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig'])
        const outer = pending.outer as unknown as Event
        if (!integer(outer.created_at) || typeof outer.id !== 'string' || !HEX.test(outer.id) || typeof outer.pubkey !== 'string' || !HEX.test(outer.pubkey) || typeof outer.sig !== 'string' ||
            !/^[0-9a-f]{128}$/.test(outer.sig) || typeof outer.content !== 'string' || !Array.isArray(outer.tags) ||
            outer.tags.some(t => !Array.isArray(t) || t.length !== 2 || t.some(v => typeof v !== 'string'))) hold()
        const message = decode(outer, roomId, account, ASSIGNMENT_CHANNEL, rootsFor(roomId, account))
        if (!message || !assignmentMessage(message, roomId) || JSON.stringify(message.assignment) !== JSON.stringify(pending.inner) ||
            requests.has(payload.request) || outerIds.has(outer.id)) hold()
        requests.add(payload.request); outerIds.add(outer.id); outers.add(JSON.stringify(outer))
      }
      // History may already include the pending inner after a relay echo;
      // reject duplicates within each writer Map, not legitimate cross-list cuts.
      assignmentQueues.set(namespace(roomId, account), outers)
    }
    const knownChannels = new Map<string, Set<string>>()
    // Quiet reload writes a display row with no attachment/artwork labels.
    // Permit that historical writer form only with byte-identical browser
    // quiet custody, validated below against its explicit protocol epoch.
    const quietOverlaps: { account: string; roomId: string; event: Event }[] = []
    const pending = validateOrdinaryPendingSnapshot(part('browser', 'pending'), part('tab', 'pending'), {
      accepts: (account, roomId, row: KeptPendingSend, owner) => {
        const channel = row.channel === 'Chat' ? undefined : row.channel
        const message = decode(row.event, roomId, account, channel, rootsFor(roomId, account))
        if (!message || message.id !== row.id || message.text !== row.text) return false
        const statement = !!(message.reaction || message.retracts || message.invite)
        // These are the actual PWA pending producers. Agent-only transcript,
        // assignment and room-logo envelopes do not have a pending writer.
        if (message.kind || message.assignment || message.roomLogo !== undefined) return false
        if (owner === 'browser' && (channel !== undefined || roots.get(roomId)!.policy.quiet || statement)) return false
        if (owner === 'tab' && channel === undefined && roots.get(roomId)!.policy.quiet !== true && !statement) return false
        if (row.editable && (statement || message.replaces || message.reply || message.thread || message.attachments?.length)) return false
        if (message.reaction && message.text !== reactionText(message.reaction) || message.retracts && message.text !== 'Retracted a message' ||
            message.invite && !['Invited you to a room.', 'Started a private conversation'].includes(message.text)) return false
        const labelsMatch = bookmarkCanonical(message.artwork ?? []) === bookmarkCanonical(row.artwork ?? []) &&
          bookmarkCanonical((message.attachments ?? []).map(a => a.name ?? 'Encrypted file')) === bookmarkCanonical(row.files)
        if (!labelsMatch) {
          if (owner !== 'tab' || channel !== undefined || roots.get(roomId)!.policy.quiet !== true || row.files.length || row.artwork !== undefined || row.editable !== undefined) return false
          quietOverlaps.push({ account, roomId, event: row.event })
        }
        const scope = namespace(roomId, account), names = knownChannels.get(scope) ?? new Set<string>()
        if (channel !== undefined) names.add(channel)
        knownChannels.set(scope, names)
        return true
      },
    })
    const quietRoot = (scope: OrdinaryQuietScope): { room: RoomRoot; root: TrafficRoot; device?: DeviceBinding } => {
      const room = roots.get(scope.roomId), name = namespace(scope.roomId, scope.account), retained = traffic.get(name), device = devices.get(name)
      if (!room || room.policy.quiet !== true || !room.policy.members?.length || !device) hold()
      if (scope.epoch === undefined && [...epochs.rooms].some(v => v.roomId === scope.roomId)) hold()
      const n = scope.epoch ?? 0, root = n === 0 ? { epoch: 0, id: room.id, key: room.key } : retained?.get(n)
      if (!root) hold()
      return { room, root, device }
    }
    const provenQuiet = new Set<string>()
    const quiet = validateOrdinaryQuietSnapshot(part('browser', 'quiet'), migrated.browser, {
      kind: 'browser',
      acceptsCounters: (participant, scope) => {
        const { room, device } = quietRoot(scope)
        return participant === device!.account && room.policy.members!.includes(participant)
      },
      acceptsQueued: (event, scope) => {
        const { room, root, device } = quietRoot(scope)
        if (!device || !room.policy.members!.includes(device.account)) return false
        const channels = new Set<string | undefined>([undefined, ASSIGNMENT_CHANNEL, CONTROL_CHANNEL, ...knownChannels.get(namespace(scope.roomId, device.account)) ?? []])
        let matches = 0
        for (const channel of channels) {
          const message = decode(event, scope.roomId, device.account, channel, [root])
          if (!message) continue
          if (channel === ASSIGNMENT_CHANNEL) {
            if (!assignmentMessage(message, scope.roomId) ||
                !assignmentQueues.get(namespace(scope.roomId, device.account))?.has(JSON.stringify(event))) continue
          }
          if (channel === CONTROL_CHANNEL) {
            const control = decodeControl(message.text)
            if (!control) continue
            const raw = JSON.parse(message.text)
            if (JSON.stringify(raw) !== message.text || bookmarkCanonical(raw) !== bookmarkCanonical(control) ||
                control.op === 'logo' && !roomLogoFromMessage(message)) continue
          }
          matches++
        }
        if (matches !== 1) return false
        provenQuiet.add(namespace(scope.roomId, device.account) + ':' + JSON.stringify(event))
        return true
      },
    })
    for (const scope of quiet.rooms) quietRoot(scope) // Empty used dictionaries still need exact room/epoch evidence.
    for (const overlap of quietOverlaps) if (!provenQuiet.has(namespace(overlap.roomId, overlap.account) + ':' + JSON.stringify(overlap.event))) hold()
    return Object.freeze({ browserRecords: image.browser.size, tabRecords: image.tab.size, families: Object.freeze(families), rooms: roots.size,
      identities: identity.rooms.length, epochs: epochs.rooms.length, invitations: access.access.invitations.length, bookmarks: access.bookmarks.length,
      quietRooms: quiet.rooms.length, pendingQueues: pending.queues, pendingRecords: pending.records, historicalRoomRelayRecords,
      ...(historicalFixedInvitationProofs ? { historicalFixedInvitationProofs } : {}),
      ...(creatorCustody.proofs.size ? { historicalCreatorInvitationProofs: creatorCustody.proofs.size } : {}) })
  } catch { return hold() }
  finally {
    proofCustody?.close()
    creatorCustody?.close()
    for (const root of roots.values()) root.key.fill(0)
    for (const key of allocated) key.fill(0)
    roots.clear(); devices.clear(); traffic.clear()
    for (const outers of assignmentQueues.values()) outers.clear()
    assignmentQueues.clear()
    for (const candidates of inviters.values()) candidates.clear()
    inviters.clear()
    for (const owner of Object.values(partitions)) { for (const part of owner.values()) part.clear(); owner.clear() }
    releaseOrdinaryStartupContext(image.startup); image.browser.clear(); image.tab.clear()
  }
}
