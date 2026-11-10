/**
 * A room's owner key as the account's other devices share it.
 *
 * The device that makes a room holds its owner key. Every device signed in
 * as the same account may hold it too: it travels in the account's own
 * encrypted room bookmark (see room-bookmarks.ts), so any of the person's
 * devices can let people in, remove them and run a moved room, not only
 * the one that made it. The cost, chosen by the owner: a signed-in device
 * that is lost keeps that control, and an owner key cannot be withdrawn.
 *
 * With the key come the people the room counts as members and those removed
 * from it, so a device that takes over keeping the room neither asks again
 * about people already in nor lets a removed person back. Both lists only
 * grow, and a removal always wins over membership.
 *
 * Kept apart from the record a room's maker holds (invitation-store.ts):
 * that one means "made on this device", which a shared key does not.
 */
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { DeviceStore } from './device-store.js'

export const ROOM_OWNER_PREFIX = 'kithmoot.room-owner.v1.'
/** Each list's cap, so a record stays well inside one NIP-44 message. */
export const OWNER_LIST_CAP = 256
const KEY = /^[0-9a-f]{64}$/

export interface SharedOwner { key: string; members: string[]; removed: string[] }

const list = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((p): p is string => typeof p === 'string' && KEY.test(p)))] : []

/** A well-formed owner record, or undefined. Removal wins over membership. */
export function readSharedOwner(value: unknown): SharedOwner | undefined {
  const raw = value as Partial<SharedOwner> | undefined
  if (!raw || typeof raw.key !== 'string' || !KEY.test(raw.key)) return undefined
  try { getPublicKey(hexToBytes(raw.key)) } catch { return undefined }
  const removed = list(raw.removed).slice(0, OWNER_LIST_CAP)
  return { key: raw.key, members: list(raw.members).filter(p => !removed.includes(p)).slice(0, OWNER_LIST_CAP), removed }
}

/** `held`'s key stays: a key arriving later never replaces one already kept. */
export function mergeSharedOwner(held: SharedOwner | undefined, incoming: SharedOwner | undefined): SharedOwner | undefined {
  if (!held) return incoming && readSharedOwner(incoming)
  if (!incoming) return readSharedOwner(held)
  return readSharedOwner({ key: held.key, members: [...held.members, ...incoming.members], removed: [...held.removed, ...incoming.removed] })
}

/** Whether `next` says anything `previous` does not: a key, a removal, or
 *  members where the record names none. New members on top of a list do not
 *  count, so a growing roster never costs a signer prompt; they travel with
 *  the next change that does. */
export function sharedOwnerNews(previous: SharedOwner | undefined, next: SharedOwner | undefined): boolean {
  if (!next) return false
  if (!previous || previous.key !== next.key) return true
  if (!previous.members.length && next.members.length) return true
  return next.removed.some(p => !previous.removed.includes(p))
}

const slot = (participant: string, room: string) => {
  if (!KEY.test(participant) || !KEY.test(room)) throw Error('Invalid room owner storage scope')
  return ROOM_OWNER_PREFIX + participant + '.' + room
}

export function loadSharedOwner(store: DeviceStore, participant: string, room: string): SharedOwner | undefined {
  try { return readSharedOwner(JSON.parse(store.get(slot(participant, room)) ?? 'null')) } catch { return undefined }
}

/** Merge into what this device keeps, for one account and room. */
export function keepSharedOwner(store: DeviceStore, participant: string, room: string, owner: SharedOwner): SharedOwner | undefined {
  const merged = mergeSharedOwner(loadSharedOwner(store, participant, room), owner)
  if (merged) store.set(slot(participant, room), JSON.stringify(merged))
  return merged
}

/** Forget every account's shared owner key for a room. */
export function forgetSharedOwner(store: DeviceStore, room: string): void {
  if (!KEY.test(room)) return
  for (const key of store.keys()) if (key.startsWith(ROOM_OWNER_PREFIX) && key.endsWith('.' + room)) store.remove(key)
}
