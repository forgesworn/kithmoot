import { validateOrdinaryNavigationRecord, type OrdinaryNavigationContext } from './ordinary-navigation-snapshot.js'
import { base64urlnopad } from '@scure/base'
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
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { classifyOrdinaryPhysicalName, validateOrdinaryPhysicalSnapshot } from './ordinary-physical-snapshot.js'

const HEX = /^[0-9a-f]{64}$/
const CACHE = 'kithmoot.admission.v1.'
const WAY_BACK = 'kithmoot.way-back'
function hold(): never { throw new OrdinaryStateHold() }
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
interface Binding { invitation: RoomInvitation; roomId?: string }
interface Access { id: string; raw: Record<string, unknown>; owner: boolean; account?: string }
export interface OrdinaryRoomAccessSnapshot {
  readonly rooms: readonly { readonly roomId: string; readonly account?: string }[]
  readonly invitations: readonly { readonly invitationId: string; readonly roomId: string; readonly kind: 'owner' | 'kept' | 'tab'; readonly persistent: boolean }[]
}
/** Complete snapshots of this family, without pruning expiry, guessing a
 * missing pinned invitation or granting current responder authority. Exact
 * links from captured startup and explicit navigation context may bind creator
 * records written before a room was listed, and rotated links. Missing such
 * evidence holds the original records for explicit recovery. Bookmark caches
 * and the other production families still need their composite validators. */
export function validateOrdinaryRoomAccessSnapshot(records: ReadonlyMap<string,string>, migrated: boolean,
  options: { kind: 'browser' | 'tab'; links?: readonly string[]; navigation?: OrdinaryNavigationContext; retainedRooms?: readonly { roomId: string; link: string }[] }): OrdinaryRoomAccessSnapshot {
  const kind = options.kind, hints = [...(options.links ?? [])]
  const retainedRooms = [...(options.retainedRooms ?? [])]
  if (kind !== 'browser' && kind !== 'tab') hold()
  const navigation = options.navigation === undefined ? undefined : navigationFor(records, kind, options.navigation)
  const allocated: RoomLink[] = [], bindings = new Map<string,Binding>(), access: (Access & { kind: 'owner' | 'kept' | 'tab' })[] = []
  const rooms: { roomId: string; account?: string }[] = []
  const bind = (value: RoomLink, expected?: string) => {
    if (value.secret) { if (expected && roomHex(value.secret) !== expected) hold(); return }
    if (!value.invitation) hold()
    const id = deriveInvitationId(value.invitation), prior = bindings.get(id)
    // Conversion from a meeting to a group preserves the same bearer/root.
    // A URL mode alone never changes a retained record's persistence flag.
    if (prior && (prior.invitation.inviter !== value.invitation.inviter || expected && prior.roomId && expected !== prior.roomId)) hold()
    bindings.set(id, { invitation: value.invitation, ...(expected || prior?.roomId ? { roomId: expected ?? prior!.roomId } : {}) })
  }
  try {
    for (const raw of hints) bind(link(raw,allocated))
    for (const value of retainedRooms) {
      if (kind !== 'browser') hold()
      object(value,['roomId','link']); hex(value.roomId)
      bind(link(value.link,allocated),value.roomId)
    }
    for (const [physical,raw] of records) {
      let logical = physical, account: string | undefined
      if (logical.startsWith('kithmoot.account.')) {
        const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(logical)
        if (!match) hold()
        account = match[1]!; logical = match[2]!
        if (logical.startsWith('kithmoot.account.')) hold()
      }
      if (logical.startsWith(ROOM_PREFIX)) {
        if (kind !== 'browser') hold()
        const roomId = logical.slice(ROOM_PREFIX.length); hex(roomId)
        const value = parsed(raw)
        object(value,['link','openedAt'],['readAt','readIds','name','keep','endedAt','endsAt','destruct','startsAt'])
        for (const time of ['openedAt','readAt','endedAt','startsAt']) if (Object.hasOwn(value,time) && !integer(value[time])) hold()
        if (Object.hasOwn(value,'endsAt') && (!integer(value.endsAt) || value.endsAt === 0)) hold()
        if (Object.hasOwn(value,'name')) name(value.name)
        if (Object.hasOwn(value,'keep') && typeof value.keep !== 'boolean' || Object.hasOwn(value,'destruct') && value.destruct !== true) hold()
        if (Object.hasOwn(value,'readIds')) {
          const ids = value.readIds
          if (!Array.isArray(ids) || ids.length > 2048 || new Set(ids).size !== ids.length ||
              ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) hold()
        }
        bind(link(value.link,allocated),roomId)
        // Account-scoped metadata is an existing plaintext writer format.
        rooms.push(Object.freeze({ roomId, ...(account ? { account } : {}) }))
        continue
      }
      // Navigation is a separately captured physical partition. Never parse
      // or dispatch those rows through access a second time.
      if (logical === WAY_BACK || logical.startsWith(WAY_BACK + '.') || logical === 'kithmoot.room-switch' || logical.startsWith('kithmoot.room-switch.')) hold()
      const prefix = [INVITATION_OWNER_PREFIX,KEPT_ADMISSION_PREFIX,CACHE].find(prefix => logical.startsWith(prefix))
      if (!prefix) continue
      if (account !== undefined && !migrated || (prefix === CACHE ? kind !== 'tab' : kind !== 'browser')) hold()
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
    if (navigation && access.some(value => !bindings.has(value.id))) {
      for (const raw of navigation.candidates) bind(link(raw, allocated))
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
    for (const value of allocated) { value.secret?.fill(0); value.invitation?.bearer.fill(0); value.pairingCode?.fill(0) }
    bindings.clear(); access.length=0; hints.length=0; retainedRooms.length=0
  }
}
function roomHex(secret: Uint8Array): string {
  const keys=deriveRoom(secret)
  try { return keys.roomId } finally { keys.roomKey.fill(0) }
}
