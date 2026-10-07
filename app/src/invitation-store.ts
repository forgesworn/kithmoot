import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import type { DeviceStore } from './device-store.js'
import { deriveRoom } from '../../src/room.js'
import { isRoomEnds } from '../../src/expiration.js'

export const INVITATION_OWNER_PREFIX = 'kithmoot.invitation-owner.v1.'
export const INVITATION_OWNER_TTL_SECONDS = 12 * 60 * 60

/** Clear all locally retained access for a room, including earlier links
 * after rotation. The same helper works over localStorage and tab storage. */
export function forgetRoomAccess(store: DeviceStore, roomId: string): void {
  for (const key of store.keys()) {
    if (![INVITATION_OWNER_PREFIX, 'kithmoot.admission-kept.v1.', 'kithmoot.admission.v1.'].some(prefix => key.startsWith(prefix))) continue
    try {
      const value = JSON.parse(store.get(key) ?? '')
      if (deriveRoom(hexToBytes(value.roomSecret)).roomId === roomId) store.remove(key)
    } catch { /* A malformed unrelated entry grants no access. */ }
  }
}

/** `endsAt` is a conference room's end: kept with the owner's record so the
 *  invitation is re-signed, and a rotated link retired, with the same end. */
export function storeInvitationOwner(store: DeviceStore, invitation: RoomInvitation, secret: Uint8Array, inviterSk: Uint8Array, now: number, endsAt?: number, destruct?: boolean): void {
  store.set(INVITATION_OWNER_PREFIX + deriveInvitationId(invitation), JSON.stringify({
    roomSecret: bytesToHex(secret), inviterSk: bytesToHex(inviterSk), createdAt: now,
    ...(invitation.persistent ? { persistent: true } : {}),
    ...(invitation.persistent && endsAt !== undefined ? { ends: endsAt } : {}),
    ...(invitation.persistent && destruct ? { destruct: true } : {}),
  }))
}

export function loadInvitationOwner(store: DeviceStore, invitation: RoomInvitation, now: number): { roomSecret: Uint8Array; inviterSk: Uint8Array; endsAt?: number; destruct?: true } | undefined {
  const key = INVITATION_OWNER_PREFIX + deriveInvitationId(invitation)
  const raw = store.get(key)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
        (value.persistent !== true && value.createdAt + INVITATION_OWNER_TTL_SECONDS <= now)) throw new Error('expired owner')
    const roomSecret = hexToBytes(value.roomSecret)
    const inviterSk = hexToBytes(value.inviterSk)
    if (roomSecret.length !== 32 || inviterSk.length !== 32 || getPublicKey(inviterSk) !== invitation.inviter) throw new Error('invalid owner')
    if (value.ends !== undefined && !isRoomEnds(value.ends)) throw new Error('invalid end')
    const owner: { roomSecret: Uint8Array; inviterSk: Uint8Array; endsAt?: number; destruct?: true } = value.ends === undefined ? { roomSecret, inviterSk } : { roomSecret, inviterSk, endsAt: value.ends }
    if (value.destruct === true) owner.destruct = true
    return owner
  } catch {
    store.remove(key)
    return undefined
  }
}
