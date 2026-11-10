import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { readNodeRoom, readNodeTurnPorts, verifyNodeRoomGrant, type NodeRoomRecord } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from '../../src/room.js'
import { sanitiseDisplayName } from '../../src/display-name.js'
import type { PairedKithmootNode } from '../../src/kithmoot-node.js'
import type { NodeDeviceStore, NodeDeviceSnapshot } from '../../src/node-device-access.js'
import type { NodeKeeperStore, NodeKeeperSnapshot } from '../../src/node-admission.js'
import { pendingNodeRoomClose, type NodeRoomCloseStore, type NodeCloseReference, type PendingNodeRoomClose } from '../../src/node-room-close.js'
import type { DeviceStore } from './device-store.js'
import { forgetSharedOwner, loadSharedOwner } from './room-owner-share.js'

export const NODE_PAIR_PREFIX = 'kithmoot.node-pair.v1.'
export const NODE_ROOM_PREFIX = 'kithmoot.node-room.v1.'
export const NODE_DEVICE_PREFIX = 'kithmoot.node-device.v1.'
export const NODE_ACCESS_PREFIX = 'kithmoot.node-access.v1.'
export const NODE_KEEPER_PREFIX = 'kithmoot.node-keeper.v1.'
export const NODE_PENDING_CLOSE_PREFIX = 'kithmoot.node-close-pending.v1.'
export const NODE_OPERATION_PREFIX = 'kithmoot.node-operation.v1.'
const KEY = /^[a-f0-9]{64}$/
const OPERATION = /^[a-f0-9]{32}$/
const privatePrefixes = [NODE_ROOM_PREFIX, NODE_DEVICE_PREFIX, NODE_ACCESS_PREFIX, NODE_KEEPER_PREFIX, NODE_PENDING_CLOSE_PREFIX]
const slot = (prefix: string, participant: string, room: string) => {
  if (!KEY.test(participant) || !KEY.test(room)) throw Error('Invalid node room storage scope')
  return prefix + participant + '.' + room
}
function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && !url.port && url.hostname.includes('.')
      && !/^[0-9.]+$/.test(url.hostname) && !url.hostname.includes(':') && !/\.(localhost|local|internal|home|invalid)$/.test(url.hostname)
      && url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  } catch { return false }
}
function publicPair(value: unknown, participant?: string): PairedKithmootNode | undefined {
  if (!value || typeof value !== 'object') return undefined
  const pair = value as Partial<PairedKithmootNode>
  if (pair.v !== 1 || !canonicalOrigin(pair.origin) || typeof pair.serviceKey !== 'string' || !KEY.test(pair.serviceKey)
    || typeof pair.owner !== 'string' || !KEY.test(pair.owner) || pair.serviceKey === pair.owner || participant !== undefined && pair.owner !== participant) return undefined
  const ports = readNodeTurnPorts(pair.turnPorts)
  if (!ports) return undefined
  return { v: 1, origin: pair.origin, serviceKey: pair.serviceKey, owner: pair.owner,
    ...(ports.udpTcp === 3478 && ports.tls === 5349 ? {} : { turnPorts: ports }) }
}
export function loadPairedNode(store: DeviceStore, participant: string): PairedKithmootNode | undefined {
  if (!KEY.test(participant)) return undefined
  const raw = store.get(NODE_PAIR_PREFIX + participant)
  if (!raw || raw.length > 2048) return undefined
  try { return publicPair(JSON.parse(raw), participant) } catch { return undefined }
}
export function storePairedNode(store: DeviceStore, participant: string, pair: PairedKithmootNode): void {
  const value = publicPair(pair, participant)
  if (!value) throw Error('This node pairing belongs to another account')
  store.set(NODE_PAIR_PREFIX + participant, JSON.stringify(value))
}
export function unpairNode(store: DeviceStore, participant: string): void {
  if (KEY.test(participant)) store.remove(NODE_PAIR_PREFIX + participant)
}
/** A node device is scoped to both the room and participant. Changing account
 * cannot reuse a device grant recorded for another participant. */
export function nodeDeviceKeyFor(store: DeviceStore, participant: string, room: string): Uint8Array {
  const key = slot(NODE_DEVICE_PREFIX, participant, room), held = store.get(key)
  if (held !== null) {
    if (!KEY.test(held)) throw Error('This node room device key cannot be read')
    const secret = hexToBytes(held)
    try { getPublicKey(secret); return secret } catch { secret.fill(0); throw Error('This node room device key cannot be read') }
  }
  const secret = generateSecretKey()
  try { store.set(key, bytesToHex(secret)); return secret } catch (error) { secret.fill(0); throw error }
}

/** Preserve an existing room's own device key when its route changes. */
export function adoptExistingNodeDeviceKey(store: DeviceStore, node: NodeRoomRecord, participant: string, deviceSk: Uint8Array): void {
  if (!node.existing) throw Error('This is not an existing-room node destination')
  const device = getPublicKey(deviceSk)
  if ([node.authority, node.serviceKey].includes(device)) throw Error('Invalid room device identity')
  const key = slot(NODE_DEVICE_PREFIX, participant, node.room), saved = store.get(key), value = bytesToHex(deviceSk)
  if (saved !== null && saved !== value) throw Error('Another node device identity is already saved for this room')
  if (saved === null) store.set(key, value)
}

export interface BrowserNodeRoom {
  node: NodeRoomRecord
  /** The original route remains available for explicit recovery. */
  source?: { link: string; activated: boolean }
  participant: string
  secret: Uint8Array
  deviceSk: Uint8Array
  /** Present on the devices that keep the room: the one that made or moved
   *  it, and the owner's other devices once its key has reached them. */
  authoritySk?: Uint8Array
  /** Creation is durable before enrolment; an active member always has a grant. */
  phase: 'creating' | 'active'
  grant?: Event
  epochHint: number
  startsAt: number
  name?: string
}
interface StoredNodeRoom {
  v: 1; node: Event; source?: { link: string; activated: boolean }; participant: string; secret: string; authoritySk?: string
  phase: 'creating' | 'active'; grant?: Event; epochHint: number; startsAt: number; name?: string
}
function decodeRoom(raw: StoredNodeRoom, store: DeviceStore, participant: string, room: string, now: number): BrowserNodeRoom | undefined {
  let secret: Uint8Array | undefined, authoritySk: Uint8Array | undefined, deviceSk: Uint8Array | undefined
  try {
    if (raw.v !== 1 || raw.participant !== participant || !KEY.test(raw.secret) || !['creating', 'active'].includes(raw.phase)
      || !Number.isSafeInteger(raw.epochHint) || raw.epochHint < 0 || raw.epochHint > 0x7fffffff
      || !Number.isSafeInteger(raw.startsAt) || raw.startsAt < 0 || raw.startsAt > now + 30) return undefined
    // Keep the signed end available for the local expiry wiper. Reading this
    // evidence never grants access: the access controller checks the real clock.
    const node = readNodeRoom(raw.node, Math.min(now, raw.node.created_at))
    if (!node || node.room !== room) return undefined
    if (raw.source !== undefined && (!node.existing || typeof raw.source.link !== 'string' || raw.source.link.length > 32768
      || !raw.source.link.includes('#') || typeof raw.source.activated !== 'boolean'
      || Object.keys(raw.source).sort().join(',') !== 'activated,link')) return undefined
    secret = hexToBytes(raw.secret); const derived = deriveRoom(secret)
    const matches = derived.roomId === room; derived.roomKey.fill(0)
    if (!matches) return undefined
    const key = store.get(slot(NODE_DEVICE_PREFIX, participant, room))
    if (!key || !KEY.test(key)) return undefined
    deviceSk = hexToBytes(key)
    if (raw.authoritySk !== undefined) {
      if (!KEY.test(raw.authoritySk)) return undefined
      authoritySk = hexToBytes(raw.authoritySk)
      if (getPublicKey(authoritySk) !== node.authority) return undefined
    }
    if (raw.phase === 'creating' && !authoritySk) return undefined
    if (raw.phase === 'active' || raw.grant !== undefined) {
      const expiration = raw.grant?.tags.find(tag => tag[0] === 'expiration')?.[1]
      if (!expiration || !verifyNodeRoomGrant(raw.grant, node, getPublicKey(deviceSk), Math.min(now, Number(expiration) - 1))) return undefined
    }
    const value: BrowserNodeRoom = { node, ...(raw.source ? { source: { ...raw.source } } : {}), participant, secret, deviceSk, ...(authoritySk ? { authoritySk } : {}), phase: raw.phase,
      ...(raw.grant ? { grant: raw.grant } : {}), epochHint: raw.epochHint, startsAt: raw.startsAt,
      ...(sanitiseDisplayName(raw.name) ? { name: sanitiseDisplayName(raw.name) } : {}) }
    secret = undefined; authoritySk = undefined; deviceSk = undefined
    return value
  } catch { return undefined } finally { secret?.fill(0); authoritySk?.fill(0); deviceSk?.fill(0) }
}
export function loadNodeRoom(store: DeviceStore, participant: string, room: string, now = Math.floor(Date.now() / 1000)): BrowserNodeRoom | undefined {
  if (!KEY.test(participant) || !KEY.test(room)) return undefined
  const raw = store.get(slot(NODE_ROOM_PREFIX, participant, room))
  if (!raw || raw.length > 65536) return undefined
  try { return decodeRoom(JSON.parse(raw), store, participant, room, now) } catch { return undefined }
}
/** Every node room this participant holds on this device, decoded and checked. */
export function listNodeRooms(store: DeviceStore, participant: string, now = Math.floor(Date.now() / 1000)): BrowserNodeRoom[] {
  if (!KEY.test(participant)) return []
  const prefix = NODE_ROOM_PREFIX + participant + '.'
  return store.keys().filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).filter(room => KEY.test(room))
    .map(room => loadNodeRoom(store, participant, room, now)).filter((room): room is BrowserNodeRoom => room !== undefined)
}
export function storeNodeRoom(store: DeviceStore, value: BrowserNodeRoom, now = Math.floor(Date.now() / 1000)): void {
  const raw: StoredNodeRoom = { v: 1, node: value.node.event, ...(value.source ? { source: { ...value.source } } : {}), participant: value.participant, secret: bytesToHex(value.secret),
    ...(value.authoritySk ? { authoritySk: bytesToHex(value.authoritySk) } : {}), phase: value.phase, ...(value.grant ? { grant: value.grant } : {}),
    epochHint: value.epochHint, startsAt: value.startsAt, ...(value.name ? { name: sanitiseDisplayName(value.name) } : {}) }
  const checked = decodeRoom(raw, store, value.participant, value.node.room, now)
  if (!checked) throw Error('Node room recovery could not be saved')
  try {
    if (getPublicKey(checked.deviceSk) !== getPublicKey(value.deviceSk)) throw Error('Node room recovery could not be saved')
    store.set(slot(NODE_ROOM_PREFIX, value.participant, value.node.room), JSON.stringify(raw))
  } finally { checked.secret.fill(0); checked.authoritySk?.fill(0); checked.deviceSk.fill(0) }
}
function jsonStore<T>(store: DeviceStore, key: string): { load(): Promise<T | undefined>; save(value: T): Promise<void> } {
  return {
    async load() { const raw = store.get(key); return raw === null ? undefined : JSON.parse(raw) as T },
    async save(value) { store.set(key, JSON.stringify(value)) },
  }
}
export const nodeAccessStore = (store: DeviceStore, participant: string, room: string): NodeDeviceStore => jsonStore<NodeDeviceSnapshot>(store, slot(NODE_ACCESS_PREFIX, participant, room))
export const nodeKeeperStore = (store: DeviceStore, participant: string, room: string): NodeKeeperStore => jsonStore<NodeKeeperSnapshot>(store, slot(NODE_KEEPER_PREFIX, participant, room))
/** A device that followed its room's move with the room's authority starts
 * its keeper journal from the members and removals the source room knew, so
 * it recognises them as the moving device does. An existing journal is kept. */
/** The members and removals a keeper journal holds, read without opening it. */
export function readNodeKeeperLists(store: DeviceStore, participant: string, room: string): { members: string[]; removed: string[] } | undefined {
  try {
    const raw = JSON.parse(store.get(slot(NODE_KEEPER_PREFIX, participant, room)) ?? 'null') as Partial<NodeKeeperSnapshot> | null
    if (!raw || !Array.isArray(raw.members) || !Array.isArray(raw.removed)) return undefined
    return { members: raw.members.filter(p => typeof p === 'string' && KEY.test(p)), removed: raw.removed.filter(p => typeof p === 'string' && KEY.test(p)) }
  } catch { return undefined }
}

/** Give the owner key that reached this device from the account's other
 *  devices to the node rooms it is a member of but does not yet keep, with
 *  the members and removals that came with it. Returns the rooms that this
 *  device now keeps. */
export function adoptSharedNodeAuthority(store: DeviceStore, participant: string, now = Math.floor(Date.now() / 1000)): string[] {
  const adopted: string[] = []
  for (const held of listNodeRooms(store, participant, now)) {
    try {
      const shared = held.authoritySk ? undefined : loadSharedOwner(store, participant, held.node.room)
      if (!shared) continue
      const authoritySk = hexToBytes(shared.key)
      try {
        if (getPublicKey(authoritySk) !== held.node.authority) continue
        storeNodeRoom(store, { ...held, authoritySk }, now)
        seedNodeKeeper(store, participant, held.node, shared.members, shared.removed)
        adopted.push(held.node.room)
      } finally { authoritySk.fill(0) }
    } catch { /* One room's failure leaves the others to adopt. */ }
    finally { held.secret.fill(0); held.deviceSk.fill(0); held.authoritySk?.fill(0) }
  }
  return adopted
}

export function seedNodeKeeper(store: DeviceStore, participant: string, node: NodeRoomRecord, members: readonly string[], removed: readonly string[]): void {
  const key = slot(NODE_KEEPER_PREFIX, participant, node.room)
  if (store.get(key) !== null) return
  const gone = [...new Set(removed.filter(p => KEY.test(p) && p !== participant))].slice(0, 4096)
  const known = [...new Set([participant, ...members.filter(p => KEY.test(p))])].filter(p => !gone.includes(p)).slice(0, 4096)
  const snapshot: NodeKeeperSnapshot = { v: 1, descriptor: node.event.id, members: known, removed: gone, grants: [] }
  store.set(key, JSON.stringify(snapshot))
}

function referenceOnly(value: NodeCloseReference): NodeCloseReference {
  const node = publicPair(value?.node)
  if (value?.v !== 1 || !node || !OPERATION.test(value.operation)) throw Error('Invalid node operation reference')
  return { v: 1, node, operation: value.operation }
}
export function nodeCloseStore(store: DeviceStore): NodeRoomCloseStore {
  return {
    async stage(value: PendingNodeRoomClose) {
      const reference = referenceOnly(value.reference), node = readNodeRoom(value.descriptor, value.descriptor.created_at)
      if (!node || node.origin !== reference.node.origin || node.serviceKey !== reference.node.serviceKey || value.instruction.operation !== reference.operation) throw Error('Invalid pending node closure')
      // The reference goes first. It can survive losing the HTTP ACK and
      // room state, but contains no room identifiers or keys.
      store.set(NODE_OPERATION_PREFIX + reference.node.owner + '.' + reference.operation, JSON.stringify(reference))
      store.set(slot(NODE_PENDING_CLOSE_PREFIX, reference.node.owner, node.room), JSON.stringify(value))
    },
    async forgetRoom(value: NodeCloseReference) {
      const reference = referenceOnly(value)
      for (const key of store.keys().filter(key => key.startsWith(NODE_PENDING_CLOSE_PREFIX))) {
        try {
          const held = JSON.parse(store.get(key) ?? '') as PendingNodeRoomClose
          if (held.reference?.operation === reference.operation && held.reference.node.owner === reference.node.owner
            && held.reference.node.origin === reference.node.origin && held.reference.node.serviceKey === reference.node.serviceKey) store.remove(key)
        } catch { /* A room-scoped wipe removes unreadable pending state too. */ }
      }
    },
  }
}
export function loadPendingNodeClose(store: DeviceStore, participant: string, room: string, now = Math.floor(Date.now() / 1000)): PendingNodeRoomClose | undefined {
  if (!KEY.test(participant) || !KEY.test(room)) return undefined
  const raw = store.get(slot(NODE_PENDING_CLOSE_PREFIX, participant, room))
  if (!raw || raw.length > 1024 * 1024) return undefined
  try {
    const value = JSON.parse(raw) as PendingNodeRoomClose, reference = referenceOnly(value.reference)
    const node = readNodeRoom(value.descriptor, Math.min(now, value.descriptor.created_at))
    return value.v === 1 && reference.node.owner === participant && node?.room === room
      ? pendingNodeRoomClose(reference.node, node, value.instruction, now) : undefined
  } catch { return undefined }
}
export function nodeCloseReferences(store: DeviceStore, participant: string): NodeCloseReference[] {
  if (!KEY.test(participant)) return []
  return store.keys().filter(key => key.startsWith(NODE_OPERATION_PREFIX + participant + '.')).flatMap(key => {
    try { const value = referenceOnly(JSON.parse(store.get(key) ?? '')); return value.node.owner === participant ? [value] : [] } catch { return [] }
  })
}
export function forgetNodeCloseReference(store: DeviceStore, participant: string, operation: string): void {
  if (KEY.test(participant) && OPERATION.test(operation)) store.remove(NODE_OPERATION_PREFIX + participant + '.' + operation)
}
export function forgetNodeRoom(store: DeviceStore, room: string): void {
  if (!KEY.test(room)) return
  for (const key of store.keys()) if (privatePrefixes.some(prefix => key.startsWith(prefix)) && key.endsWith('.' + room)) store.remove(key)
  forgetSharedOwner(store, room)
}
