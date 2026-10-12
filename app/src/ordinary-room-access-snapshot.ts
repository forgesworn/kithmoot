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
import { KEPT_ADMISSION_PREFIX } from './device-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { Event } from 'nostr-tools/pure'
import { classifyOrdinaryPhysicalName, validateOrdinaryPhysicalSnapshot } from './ordinary-physical-snapshot.js'

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
    capturedStartup.set(context, { browser: browserEvidence, tab: tabEvidence, href })
    return context
  } catch { return hold() }
}
/** Abandon a captured startup without exposing retained bytes. */
export function releaseOrdinaryStartupContext(context: OrdinaryStartupContext): void {
  const captured = capturedStartup.get(context)
  captured?.browser.clear(); captured?.tab.clear()
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
    return validateBookmarks(records, false, { kind: 'browser' }, { kinds, migrated: migration, candidates })
  } catch { return hold() }
  finally { captured.browser.clear(); captured.tab.clear(); records.clear(); kinds.clear(); migration.clear(); candidates.length = 0 }
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
  options: OrdinaryRoomAccessOptions, retainedRooms: readonly { roomId: string; value: RoomLink }[], composition?: Composition): OrdinaryRoomAccessSnapshot {
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
    if (composition && access.some(value => !bindings.has(value.id))) {
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
      invitations.push(Object.freeze({ invitationId:value.id,roomId,kind:value.kind,persistent:value.raw.persistent===true }))
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
function validateBookmarks(records: ReadonlyMap<string,string>, migrated: boolean, options: OrdinaryRoomAccessOptions, composition?: Composition): OrdinaryBookmarkSnapshot {
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
      try{const derived=deriveRoom(secret);key=derived.roomKey;if(derived.roomId!==roomId)bookmarkHold()}finally{secret.fill(0);key?.fill(0)}
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
    const access=validateAccess(records,migrated,options,links,composition)
    bookmarks.sort((a,b)=>a.account.localeCompare(b.account)||a.roomId.localeCompare(b.roomId))
    return Object.freeze({access,bookmarks:Object.freeze(bookmarks)})
  }finally{wipeLinks(allocated);links.length=0;addresses.clear();ids.clear();events.clear()}
}
