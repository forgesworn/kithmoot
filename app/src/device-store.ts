/**
 * Where this browser keeps its device keys and device credentials: one of
 * each PER ROOM.
 *
 * A relay learns every device pubkey in a room from the roster events it
 * carries, because those are signed by the device key. One device key for
 * every room a browser ever joins would let a relay link one person across
 * all of them, and across time. A fresh key per room stops a relay drawing
 * that line, and it costs the protocol nothing: a device credential is
 * already minted per room, so the key it names may as well be too. The
 * participant key, which is what actually identifies a person, only ever
 * rides inside the room-key ciphertext and is unaffected.
 *
 * This is the same reasoning as ForgeSworn Link's rendezvous-tag routing -
 * the relay must learn no stable pseudonym - applied to what can be fixed in
 * the app today, without a wire change. Blinding the roster and signalling
 * themselves is the wire-level version, and belongs to the spec.
 *
 * Pure functions over an injected store, so the rules are tested with no
 * browser; `browserDeviceStore` is the adapter over `localStorage`.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { DeviceCredential } from '../../src/types.js'

export interface DeviceStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  keys(): string[]
}

export const DEVICE_PREFIX = 'kithmoot.device.'
export const CREDENTIAL_PREFIX = 'kithmoot.credential.'

/** A room key not used for this long is forgotten. A credential lasts twelve
 *  hours, so nothing depends on a key this old; keeping it would only grow
 *  localStorage by one line per room for ever. */
export const DEVICE_KEY_MAX_AGE_SECONDS = 30 * 24 * 3600

/** The storage keys from before device keys were per room. */
const LEGACY_KEYS = ['kithmoot.device', 'kithmoot.credential']

interface StoredDeviceKey {
  sk: string
  /** Unix seconds this key was last used. */
  at: number
}

export function memoryDeviceStore(): DeviceStore {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  }
}

export function browserDeviceStore(storage: Storage): DeviceStore {
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
    keys: () => Object.keys(storage),
  }
}

function readDeviceKey(store: DeviceStore, roomId: string): StoredDeviceKey | undefined {
  const raw = store.get(DEVICE_PREFIX + roomId)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDeviceKey>
    if (typeof parsed.sk !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.sk)) return undefined
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return undefined
    return { sk: parsed.sk, at: parsed.at }
  } catch {
    return undefined
  }
}

/** Forget every room key that has not been used within the age limit. */
function pruneDeviceKeys(store: DeviceStore, now: number): void {
  for (const key of store.keys()) {
    if (!key.startsWith(DEVICE_PREFIX)) continue
    const stored = readDeviceKey(store, key.slice(DEVICE_PREFIX.length))
    if (!stored || stored.at + DEVICE_KEY_MAX_AGE_SECONDS <= now) store.remove(key)
  }
}

/**
 * This device's key for one room: the one it used there before, or a fresh
 * one. Using it refreshes its age, and every key past the age limit is
 * forgotten on the way through.
 */
export function deviceKeyFor(
  store: DeviceStore,
  roomId: string,
  now: number,
  generate: () => Uint8Array,
): Uint8Array {
  pruneDeviceKeys(store, now)
  const existing = readDeviceKey(store, roomId)
  const sk = existing ? hexToBytes(existing.sk) : generate()
  store.set(DEVICE_PREFIX + roomId, JSON.stringify({ sk: bytesToHex(sk), at: now } satisfies StoredDeviceKey))
  return sk
}

export function loadCredentialFor(store: DeviceStore, roomId: string): DeviceCredential | undefined {
  const raw = store.get(CREDENTIAL_PREFIX + roomId)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as DeviceCredential) : undefined
  } catch {
    return undefined
  }
}

export function storeCredentialFor(store: DeviceStore, roomId: string, credential: DeviceCredential): void {
  store.set(CREDENTIAL_PREFIX + roomId, JSON.stringify(credential))
}

export function forgetCredentialFor(store: DeviceStore, roomId: string): void {
  store.remove(CREDENTIAL_PREFIX + roomId)
}

/** Whether this browser has been paired as somebody's secondary device, in
 *  any room. Such a browser must never mint a participant key of its own,
 *  which would silently turn it back into a separate person. */
export function isPairedSecondary(store: DeviceStore): boolean {
  return store.keys().some((key) => key.startsWith(CREDENTIAL_PREFIX))
}

/** Remove the single shared device key and credential this module
 *  replaces. A credential lasts twelve hours, so nothing of value is lost. */
export function forgetLegacyStorage(store: DeviceStore): void {
  for (const key of LEGACY_KEYS) store.remove(key)
}
