import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { verifyDeviceCredential } from '../../src/credential.js'
import { credentialSeal } from '../../src/seal.js'
import type { DeviceCredential } from '../../src/types.js'
import { DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, MAX_OWN_SEAL_KEYS } from './device-store.js'
import { classifyOrdinaryPhysicalName } from './ordinary-physical-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
const KEY_HEX = /^[0-9a-f]{64}$/i
const BINDING = 'kithmoot.device-owner.'
const PREFIXES = [DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, BINDING]
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) hold()
}
function parsed(value: string): unknown { try { return JSON.parse(value) } catch { hold() } }
function publicKey(raw: unknown, canonical = false): string {
  if (typeof raw !== 'string' || !(canonical ? HEX : KEY_HEX).test(raw)) hold()
  const key = hexToBytes(raw)
  try { return getPublicKey(key) } catch { hold() } finally { key.fill(0) }
}
function credential(raw: string, roomId: string): DeviceCredential {
  const value = parsed(raw)
  object(value, ['id','pubkey','kind','created_at','tags','content','sig'])
  if (typeof value.id !== 'string' || !KEY_HEX.test(value.id) || typeof value.pubkey !== 'string' || !KEY_HEX.test(value.pubkey) ||
      !integer(value.kind) || !integer(value.created_at) || typeof value.content !== 'string' || value.content.length > 4096 ||
      typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(value.sig) || !Array.isArray(value.tags) || value.tags.length > 128 ||
      value.tags.some(tag => !Array.isArray(tag) || tag.length > 32 || tag.some(part => typeof part !== 'string' || part.length > 1024))) hold()
  const event = value as unknown as DeviceCredential
  const binding = (name: string, required = true) => {
    const tags = event.tags.filter(tag => tag[0] === name)
    if (tags.length > 1 || required && tags.length !== 1 || tags.some(tag => tag.length !== 2)) hold()
    return tags[0]?.[1]
  }
  const scope = binding('d'), device = binding('device'), expiry = binding('expiration')
  binding('scope', false); binding('seal', false)
  if (!scope || !KEY_HEX.test(scope) || scope.toLowerCase() !== roomId || !device || !KEY_HEX.test(device) || !expiry) hold()
  const expiration = Number(expiry)
  if (!integer(expiration) || expiration <= event.created_at || String(expiration) !== expiry || credentialSeal(event) === null) hold()
  // Signature/scope integrity at the stored credential's lifetime, never a
  // claim that this expired credential currently authorises a session.
  if (!verifyDeviceCredential(event, { roomId, now: expiration - 1 }).ok) hold()
  return event
}
/** Strict historical credential shape/signature shared by the private image
 * binder. This check releases no credential or current session authority. */
export function validateOrdinaryEmbeddedDeviceCredential(value: unknown, roomId: string): void {
  credential(JSON.stringify(value), roomId)
}
interface Group {
  roomId: string
  account?: string
  device?: string
  secondary?: DeviceCredential
  own?: DeviceCredential
  seals?: string[]
  bound: boolean
}
export interface OrdinaryIdentitySnapshot {
  readonly participant?: string
  readonly secondary: boolean
  readonly rooms: readonly { readonly roomId: string; readonly account: string; readonly scoped: boolean }[]
}
/** Whole-image identity topology, for the composite production inventory
 * validator. Other record families still require their own validators. Never
 * calls permissive/pruning loaders, creates keys or rewrites captured values.
 * Legacy keys need signed room/account/device evidence; completed encrypted
 * custody also admits the native adapter's exact first-use owner binding. */
export function validateOrdinaryIdentitySnapshot(records: ReadonlyMap<string, string>, migrated: boolean): OrdinaryIdentitySnapshot {
  let participant: string | undefined, secondary = false
  const groups = new Map<string, Group>()
  for (const [physical, raw] of records) {
    if (physical === 'kithmoot.participant') { participant = publicKey(raw, true); continue }
    // The obsolete shared-device records have no safe per-room assignment.
    // Preserve them under hold for explicit recovery; never silently discard.
    if (physical === 'kithmoot.device' || physical === 'kithmoot.credential') hold()
    let name = physical, account: string | undefined
    if (name.startsWith('kithmoot.account.')) {
      const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(name)
      if (!match) hold()
      account = match[1]!; name = match[2]!
      if (name.startsWith('kithmoot.account.') || name === 'kithmoot.participant') hold()
    }
    const prefix = PREFIXES.find(prefix => name.startsWith(prefix))
    if (!prefix) continue // Composite validation must classify the remainder.
    const roomId = name.slice(prefix.length)
    if (!HEX.test(roomId) || account !== undefined && !migrated || prefix === BINDING && account === undefined) hold()
    const id = (account ?? 'legacy') + ':' + roomId
    let group = groups.get(id)
    if (!group) { group = { roomId, account, bound: false }; groups.set(id, group) }
    if (prefix === DEVICE_PREFIX) {
      const value = parsed(raw); object(value, ['sk','at'])
      if (!integer(value.at)) hold()
      group.device = publicKey(value.sk)
    } else if (prefix === BINDING) {
      const value = parsed(raw); object(value, ['account','roomId'])
      if (value.account !== account || value.roomId !== roomId) hold()
      group.bound = true
    } else if (prefix === OWN_SEAL_PREFIX) {
      const value = parsed(raw)
      if (!Array.isArray(value) || value.length > MAX_OWN_SEAL_KEYS || new Set(value).size !== value.length) hold()
      group.seals = value.map(key => publicKey(key, true))
    } else {
      const event = credential(raw, roomId)
      if (prefix === CREDENTIAL_PREFIX) { group.secondary = event; secondary = true }
      else group.own = event
    }
  }
  const rooms: { roomId: string; account: string; scoped: boolean }[] = []
  const scopedRooms = new Set([...groups.values()].filter(group => group.account !== undefined).map(group => group.roomId))
  // Device keys are fresh per room; a shared relay-visible identifier would
  // link otherwise separate rooms/accounts. Seal histories also retain only
  // keys created for that room, including credentials since rotated out.
  const devices = new Set<string>(), seals = new Set<string>()
  for (const group of groups.values()) {
    if (!group.device || group.account !== undefined && !group.bound) hold()
    if (devices.has(group.device)) hold()
    devices.add(group.device)
    for (const seal of group.seals ?? []) {
      if (seals.has(seal)) hold()
      seals.add(seal)
    }
    const credentials = [group.secondary, group.own].filter((event): event is DeviceCredential => !!event)
    if (credentials.length === 0 && !group.bound) hold() // No guessed legacy owner.
    if (group.seals && !group.own) hold()
    let account = group.account
    for (const event of credentials) {
      const issuer = event.pubkey.toLowerCase()
      if (account !== undefined && account !== issuer || event.tags.find(tag => tag[0] === 'device')![1]!.toLowerCase() !== group.device) hold()
      account = issuer
      if (event === group.own) {
        const seal = credentialSeal(event)
        if (seal && !group.seals?.includes(seal)) hold()
      }
    }
    if (!account) hold()
    // A room cannot silently retain both an unconverted and a scoped owner.
    if (group.account === undefined && scopedRooms.has(group.roomId)) hold()
    rooms.push(Object.freeze({ roomId: group.roomId, account, scoped: group.account !== undefined }))
  }
  rooms.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.account.localeCompare(b.account))
  return Object.freeze({ ...(participant ? { participant } : {}), secondary, rooms: Object.freeze(rooms) })
}

export interface OrdinaryIdentityPairSnapshot extends Omit<OrdinaryIdentitySnapshot, 'rooms'> {
  readonly rooms: readonly { readonly roomId: string; readonly account: string; readonly scoped: boolean; readonly owner: 'browser' | 'tab' }[]
}
/** Validate one topology across both physical owners. Tab primary identities
 * cannot split a room/account group with browser records, alias legacy names,
 * share room devices/seals, or carry a participant/secondary credential. The
 * full composer separately requires exact private proof and native headers. */
export function validateOrdinaryIdentityPairSnapshot(browser: ReadonlyMap<string, string>, tab: ReadonlyMap<string, string>,
  migrated: { readonly browser: boolean; readonly tab: boolean }): OrdinaryIdentityPairSnapshot {
  const records = new Map<string, string>(), owners = new Map<string, 'browser' | 'tab'>()
  try {
    for (const [kind, source] of [['browser', browser], ['tab', tab]] as const) {
      for (const [name, raw] of source) {
        if (classifyOrdinaryPhysicalName(name, kind)?.family !== 'identity') continue
        if (records.has(name) || name.startsWith('kithmoot.account.') && !migrated[kind]) hold()
        const match = /^(?:kithmoot\.account\.([0-9a-f]{64})\.)?kithmoot\.(?:device|device-owner|credential|own-credential|own-seal)\.([0-9a-f]{64})$/.exec(name)
        if (match) {
          const group = (match[1] ?? 'legacy') + ':' + match[2]
          const prior = owners.get(group)
          if (prior !== undefined && prior !== kind) hold()
          owners.set(group, kind)
        }
        records.set(name, raw)
      }
    }
    const snapshot = validateOrdinaryIdentitySnapshot(records, true)
    const rooms = snapshot.rooms.map(room => Object.freeze({ ...room,
      owner: owners.get((room.scoped ? room.account : 'legacy') + ':' + room.roomId)! }))
    return Object.freeze({ ...(snapshot.participant ? { participant: snapshot.participant } : {}),
      secondary: snapshot.secondary, rooms: Object.freeze(rooms) })
  } finally { records.clear(); owners.clear() }
}
