import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { MAX_RELAY_HINTS } from './network-hints.js'
import { MAX_POOL_RELAYS, normaliseRelayConfig, type RelayConfig } from './relay-pool.js'
import { isInvitationRelays, MAX_INVITATION_RELAYS } from './persistent-invitation.js'

/**
 * A room's own relay list, signed by the room's authority.
 *
 * The invite link fixes the relays a room starts on, and nobody could change
 * them for everybody, which is how a room came to depend on one relay. This
 * record lets the authority add relays for every member at once. Members
 * union it with the relays they already use: it adds, it never takes a
 * relay away from somebody.
 *
 * Every member holds the room key and could post a list, so only one the
 * authority signed counts, and `version` orders them: a member replaying an
 * older list cannot undo a newer one. It is not bound to an epoch, because a
 * relay list does not grant access to anything the epoch protects.
 */
export const MAX_ROOM_RELAYS = MAX_RELAY_HINTS

/** Canonical form: normalised, deduplicated, sorted. Throws on a URL that
 *  would not be accepted as a relay. */
export function canonicalRoomRelays(relays: readonly string[]): string[] {
  const urls = [...new Set(relays.map(url => normaliseRelayConfig([url])[0]!.url))].sort()
  if (urls.length === 0) throw new Error('a room relay list needs at least one relay')
  if (urls.length > MAX_ROOM_RELAYS) throw new Error(`a room can list at most ${MAX_ROOM_RELAYS} relays`)
  return urls
}

function relaysMessage(roomId: string, version: number, relays: string[]): Uint8Array {
  return sha256(new TextEncoder().encode(`kithmoot/v1/relays:${roomId}:${version}:${JSON.stringify(relays)}`))
}

function requireRoomId(roomId: string): string {
  if (!/^[0-9a-f]{64}$/i.test(roomId)) throw new Error('room id must be 64 hex characters')
  return roomId.toLowerCase()
}

function requireVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('version must be a non-negative integer')
  return version
}

export interface SignRoomRelaysOptions {
  roomId: string
  /** Newest wins. Unix seconds of the change is the natural choice. */
  version: number
  relays: readonly string[]
  authoritySk: Uint8Array
}

export function signRoomRelays(opts: SignRoomRelaysOptions): string {
  if (opts.authoritySk.length !== 32) throw new Error('authority secret key must be 32 bytes')
  const relays = canonicalRoomRelays(opts.relays)
  return bytesToHex(schnorr.sign(relaysMessage(requireRoomId(opts.roomId), requireVersion(opts.version), relays), opts.authoritySk))
}

export interface VerifyRoomRelaysOptions {
  roomId: string
  version: number
  relays: readonly string[]
  sig: string
  authority: string
}

/** Never throws: this runs on anything a relay hands over. */
export function verifyRoomRelays(opts: VerifyRoomRelaysOptions): boolean {
  try {
    const relays = canonicalRoomRelays(opts.relays)
    if (relays.length !== opts.relays.length || relays.some((url, i) => url !== opts.relays[i])) return false
    const sig = hexToBytes(opts.sig)
    if (sig.length !== 64 || !/^[0-9a-f]{64}$/i.test(opts.authority)) return false
    return schnorr.verify(sig, relaysMessage(requireRoomId(opts.roomId), requireVersion(opts.version), relays), hexToBytes(opts.authority))
  } catch {
    return false
  }
}

/** Every wire-format literal this module owns (each one a kithmoot protocol string), frozen for
 *  `src/labels.test.ts`, which checks each module against its own exported
 *  list rather than scanning file text for matching comments. Pure data -
 *  adding this export changes no runtime behaviour. */
export const ROOM_RELAYS_LABELS = [
  "kithmoot/v1/relays:",
] as const

/** The room relays a list of relay URLs can supply: each a safe relay URL in
 *  canonical form, without repeats, at most `MAX_INVITATION_RELAYS`. Whatever
 *  cannot be one is skipped. Empty when none can be. */
export function invitationRelaysFrom(urls: readonly string[]): string[] {
  const out: string[] = []
  for (const url of urls) {
    let normal: string
    try { normal = normaliseRelayConfig([url])[0]!.url } catch { continue }
    if (out.includes(normal) || !isInvitationRelays([normal])) continue
    out.push(normal)
    if (out.length === MAX_INVITATION_RELAYS) break
  }
  return out
}

/** A participant's pool for a room: the room's relays first, read and write,
 *  all of them; then `own`, without repeats, up to `MAX_POOL_RELAYS`. Own
 *  relays are cut first; the room's never are. */
export function withRoomRelays(room: readonly string[], own: readonly RelayConfig[]): RelayConfig[] {
  if (!room.length) return [...own]
  const out: RelayConfig[] = [...new Set(room)].slice(0, MAX_POOL_RELAYS).map(url => ({ url, read: true, write: true }))
  for (const relay of own) {
    if (out.length >= MAX_POOL_RELAYS) break
    if (!out.some(entry => entry.url === relay.url)) out.push(relay)
  }
  return out
}
