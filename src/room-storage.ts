import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { isInvitationStorage, MAX_INVITATION_STORAGE_NODES, requireInvitationStorage } from '@forgesworn/fold-kit'

/**
 * A room's own storage nodes, signed by the room's authority (phase S5).
 *
 * The list is the one the room's keeper grants at: the keeper signs it into
 * the group invitation (kind 1463, key `storage`) and posts it as a `storage`
 * op on the control channel, so a member who is already in the room hears of
 * a change without joining again. Every member holds the room key and could
 * post a list, so only one the authority signed counts, and `version` orders
 * them: a member replaying an older list cannot undo a newer one.
 *
 * Unlike `relays`, the list is a preference order and is signed as given, not
 * sorted. `[]` is valid and means the room withdrew every node. Canonicality
 * is fold-kit's grammar (`isInvitationStorage`): a list that is not canonical
 * fails verification rather than being mended.
 */
export const MAX_ROOM_STORAGE_NODES = MAX_INVITATION_STORAGE_NODES

function storageMessage(roomId: string, version: number, nodes: readonly string[]): Uint8Array {
  return sha256(new TextEncoder().encode(`kithmoot/v1/storage:${roomId}:${version}:${JSON.stringify(nodes)}`))
}

function requireRoomId(roomId: string): string {
  if (!/^[0-9a-f]{64}$/i.test(roomId)) throw new Error('room id must be 64 hex characters')
  return roomId.toLowerCase()
}

function requireVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('version must be a non-negative integer')
  return version
}

export interface SignRoomStorageOptions {
  roomId: string
  /** Newest wins. Unix seconds of the change; the keeper uses its invitation copy's `created_at`. */
  version: number
  /** Canonical node base URLs, in order of preference. `[]` withdraws them all. */
  nodes: readonly string[]
  authoritySk: Uint8Array
}

export function signRoomStorage(opts: SignRoomStorageOptions): string {
  if (opts.authoritySk.length !== 32) throw new Error('authority secret key must be 32 bytes')
  const nodes = requireInvitationStorage(opts.nodes)
  return bytesToHex(schnorr.sign(storageMessage(requireRoomId(opts.roomId), requireVersion(opts.version), nodes), opts.authoritySk))
}

export interface VerifyRoomStorageOptions {
  roomId: string
  version: number
  nodes: readonly string[]
  sig: string
  authority: string
}

/** Never throws: this runs on anything a relay hands over. */
export function verifyRoomStorage(opts: VerifyRoomStorageOptions): boolean {
  try {
    if (!isInvitationStorage(opts.nodes)) return false
    const sig = hexToBytes(opts.sig)
    if (sig.length !== 64 || !/^[0-9a-f]{64}$/i.test(opts.authority)) return false
    return schnorr.verify(sig, storageMessage(requireRoomId(opts.roomId), requireVersion(opts.version), opts.nodes), hexToBytes(opts.authority))
  } catch {
    return false
  }
}

/** Every wire-format literal this module owns (each one a kithmoot protocol string), frozen for
 *  `src/labels.test.ts`, which checks each module against its own exported
 *  list. Pure data: adding this export changes no runtime behaviour. */
export const ROOM_STORAGE_LABELS = [
  "kithmoot/v1/storage:",
] as const
