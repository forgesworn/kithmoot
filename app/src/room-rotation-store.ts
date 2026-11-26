import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { epochsInWindow, MAX_EPOCH, type LeftEpoch } from '../../src/epoch.js'
import type { OwnerApprovedRoomAdmission, RoomInvitation } from '@forgesworn/fold-kit'
import { parseRoomLink } from '../../src/link.js'
import { deriveRoom } from '../../src/room.js'
import type { DeviceStore } from './device-store.js'

export const ROOM_ROTATION_PREFIX = 'kithmoot.rotated-room.v1.'
const HEX = /^[0-9a-f]{64}$/

/** One retained approval. The room stays the same and a different persona
 *  on the same browser needs its own grant before it can use the new key. */
export interface RoomRotation {
  participant: string
  link: string
  admission: OwnerApprovedRoomAdmission
  past: LeftEpoch[]
  ownerSk?: Uint8Array
  members?: string[]
  removed?: string[]
  needsApproval?: true
}

interface StoredRotation {
  link: string
  roomSecret: string
  epoch: number
  epochSecret: string
  rotatedAt: number
  past: { epoch: number; secret: string; leftAt: number }[]
  ownerSk?: string
  members?: string[]
  removed?: string[]
  needsApproval?: true
}

function roomPrefix(roomId: string): string {
  return ROOM_ROTATION_PREFIX + roomId + '.'
}

function invalid(): never {
  throw new Error('This device could not verify its saved access to the rotated room.')
}

function invitationForRotation(link: string, roomId: string): RoomInvitation {
  const invitation = parseRoomLink(link).invitation
  if (!invitation || invitation.ownerApprovedRoom !== roomId) invalid()
  return invitation
}

function participants(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !HEX.test(key))) invalid()
  return [...new Set(value)]
}

function decodeRotation(raw: string, roomId: string, participant: string): RoomRotation {
  const value = JSON.parse(raw) as Partial<StoredRotation> | null
  if (!value || typeof value.link !== 'string' || !HEX.test(value.roomSecret ?? '') ||
      !HEX.test(value.epochSecret ?? '') || value.roomSecret === value.epochSecret ||
      typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_EPOCH ||
      typeof value.rotatedAt !== 'number' || !Number.isSafeInteger(value.rotatedAt) || value.rotatedAt < 1 ||
      !Array.isArray(value.past) || (value.needsApproval !== undefined && value.needsApproval !== true)) invalid()
  const original = hexToBytes(value.roomSecret!)
  if (deriveRoom(original).roomId !== roomId) invalid()
  const invitation = invitationForRotation(value.link, roomId)
  let ownerSk: Uint8Array | undefined
  if (value.ownerSk !== undefined) {
    if (!HEX.test(value.ownerSk)) invalid()
    ownerSk = hexToBytes(value.ownerSk)
    if (getPublicKey(ownerSk) !== invitation.inviter) invalid()
  }
  const epoch = value.epoch
  const rotatedAt = value.rotatedAt
  const past = value.past.map(item => {
    if (!item || !Number.isSafeInteger(item.epoch) || item.epoch < 1 || item.epoch >= epoch ||
        !HEX.test(item.secret) || item.secret === value.roomSecret || item.secret === value.epochSecret ||
        !Number.isSafeInteger(item.leftAt) || item.leftAt < rotatedAt) invalid()
    return { epoch: item.epoch, secret: hexToBytes(item.secret), leftAt: item.leftAt }
  })
  if (new Set(past.map(item => item.epoch)).size !== past.length) invalid()
  return {
    participant, link: value.link, past, ...(ownerSk ? { ownerSk } : {}),
    members: participants(value.members), removed: participants(value.removed),
    ...(value.needsApproval ? { needsApproval: true } : {}),
    admission: { secret: original, epoch: { epoch, secret: hexToBytes(value.epochSecret!), rotatedAt } },
  }
}

/** A corrupt record also fences the old link. Nobody may silently open a
 *  room with its original key once this browser has recorded a rotation. */
export function hasRoomRotation(store: DeviceStore, roomId: string): boolean {
  return store.get(ROOM_ROTATION_PREFIX + roomId) !== null || store.keys().some(key => key.startsWith(roomPrefix(roomId)))
}

export function loadRoomRotation(store: DeviceStore, roomId: string, participant: string | undefined): RoomRotation | undefined {
  if (!participant || !HEX.test(participant)) return undefined
  const raw = store.get(roomPrefix(roomId) + participant)
  return raw === null ? undefined : decodeRotation(raw, roomId, participant)
}

export function requireRoomRotationOwner(store: DeviceStore, roomId: string, owner: string): void {
  const pin = store.get(ROOM_ROTATION_PREFIX + roomId)
  if (pin !== null && pin !== owner) throw new Error('This invitation does not match the owner already kept for this room.')
  const prefix = roomPrefix(roomId)
  for (const key of store.keys().filter(key => key.startsWith(prefix))) {
    const retained = loadRoomRotation(store, roomId, key.slice(prefix.length))
    if (!retained) invalid()
    if (invitationForRotation(retained.link, roomId).inviter !== owner) {
      throw new Error('This invitation does not match the owner already kept for this room.')
    }
  }
}

/** Pin the first authenticated owner and cutoff on this browser. A later
 *  answer cannot replace either or return an approved member to an old key.
 *  Callers serialise changes for this room across tabs before writing. */
export function storeRoomRotation(store: DeviceStore, roomId: string, state: RoomRotation, now: number): RoomRotation {
  if (!HEX.test(roomId) || !HEX.test(state.participant) || state.admission.epoch.rotatedAt > now) invalid()
  const prefix = roomPrefix(roomId)
  const invitation = invitationForRotation(state.link, roomId)
  requireRoomRotationOwner(store, roomId, invitation.inviter)
  const current = state.admission.epoch
  for (const key of store.keys().filter(key => key.startsWith(prefix))) {
    const retained = loadRoomRotation(store, roomId, key.slice(prefix.length))
    if (!retained) invalid()
    const held = retained.admission.epoch
    if (held.rotatedAt !== current.rotatedAt) {
      throw new Error('This invitation does not match the owner and key change already kept for this room.')
    }
    if (held.epoch === current.epoch && bytesToHex(held.secret) !== bytesToHex(current.secret)) {
      throw new Error('This invitation does not match the latest room key this device holds.')
    }
  }
  const previous = loadRoomRotation(store, roomId, state.participant)
  if (previous && (current.epoch < previous.admission.epoch.epoch ||
      (previous.needsApproval && !state.needsApproval && current.epoch === previous.admission.epoch.epoch))) {
    throw new Error('This invitation does not match the latest room key this device holds.')
  }
  const ownerSk = state.ownerSk ?? previous?.ownerSk
  const stored: StoredRotation = {
    link: state.link,
    roomSecret: bytesToHex(state.admission.secret),
    epoch: current.epoch,
    epochSecret: bytesToHex(current.secret),
    rotatedAt: current.rotatedAt,
    past: epochsInWindow(state.past.filter(item => item.epoch > 0), now).map(item => ({ ...item, secret: bytesToHex(item.secret) })),
    ...(ownerSk ? { ownerSk: bytesToHex(ownerSk) } : {}),
    members: state.members, removed: state.removed,
    ...(state.needsApproval ? { needsApproval: true } : {}),
  }
  const raw = JSON.stringify(stored)
  const validated = decodeRotation(raw, roomId, state.participant)
  store.set(prefix + state.participant, raw)
  return validated
}

/** Forget the persona's keys but keep the public owner pin so an older link
 *  still cannot reopen the original shared-key stream here. */
export function forgetRoomRotation(store: DeviceStore, roomId: string, participant: string | undefined): void {
  const rotation = loadRoomRotation(store, roomId, participant)
  if (!rotation) return
  store.set(ROOM_ROTATION_PREFIX + roomId, invitationForRotation(rotation.link, roomId).inviter)
  store.remove(roomPrefix(roomId) + rotation.participant)
}

export function rotationHistory(state: RoomRotation, now: number): LeftEpoch[] {
  return epochsInWindow([...state.past, { epoch: 0, secret: state.admission.secret, leftAt: state.admission.epoch.rotatedAt }], now)
}
