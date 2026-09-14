import { sha3_256 } from '@noble/hashes/sha3.js'

/**
 * The network policy selected for a room. `tor` is deliberately narrow: it
 * means a Tor Browser page talking only to v3 onion relays. It is not a claim
 * that an ordinary browser, a signer, or a WebRTC media path is anonymous.
 */
export type NetworkProfile = 'direct' | 'tor'

const ONION = /^([a-z2-7]{56})\.onion$/u
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const CHECKSUM_PREFIX = new TextEncoder().encode('.onion checksum')

function decodeV3Address(value: string): Uint8Array {
  let bits = 0
  let accumulator = 0
  const output: number[] = []
  for (const character of value) {
    const digit = BASE32.indexOf(character)
    if (digit < 0) throw new Error('invalid v3 onion service address')
    accumulator = (accumulator << 5) | digit
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((accumulator >>> bits) & 0xff)
    }
  }
  if (bits !== 0 || output.length !== 35) throw new Error('invalid v3 onion service address')
  return new Uint8Array(output)
}

/** Refuses look-alike, v2 and checksum-invalid onion hostnames before any I/O. */
export function assertV3OnionHostname(hostname: string): string {
  const match = ONION.exec(hostname.toLowerCase())
  if (!match?.[1]) throw new Error('Tor-only mode accepts exact v3 .onion hostnames only')
  const decoded = decodeV3Address(match[1])
  const key = decoded.subarray(0, 32)
  const checksum = decoded.subarray(32, 34)
  const version = decoded[34]
  if (version !== 3) throw new Error('invalid v3 onion service version')
  const input = new Uint8Array(CHECKSUM_PREFIX.length + key.length + 1)
  input.set(CHECKSUM_PREFIX)
  input.set(key, CHECKSUM_PREFIX.length)
  input[input.length - 1] = version
  const expected = sha3_256(input)
  if (checksum[0] !== expected[0] || checksum[1] !== expected[1]) throw new Error('invalid v3 onion service checksum')
  return `${match[1]}.onion`
}

/**
 * Parse a Nostr relay that is admissible to the anonymous profile. Onion
 * services are authenticated by their address, so `ws:` is valid inside Tor;
 * this function never allows an ordinary HTTP(S) or clearnet WebSocket route.
 */
export function normaliseTorRelayUrl(value: string): string {
  if (value.length === 0 || value.length > 2048) throw new Error('relay URL is invalid')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('relay URL is invalid') }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Tor-only relays must use ws:// or wss://')
  assertV3OnionHostname(url.hostname)
  if (url.username || url.password || url.hash) throw new Error('relay URLs cannot contain credentials or fragments')
  return url.toString()
}

/**
 * The anonymous profile owns every outbound endpoint. A room's normal ICE
 * hints would cause direct/STUN/TURN traffic outside Tor, so they are not a
 * degraded route: they are rejected. Callers must hold the send instead.
 */
export function assertTorRoomTransport(relays: readonly string[], iceUrls: readonly string[]): string[] {
  if (relays.length === 0) throw new Error('Tor-only mode needs at least one onion relay')
  if (iceUrls.length !== 0) throw new Error('Tor-only mode disables direct media, STUN and TURN')
  const normalised = relays.map(normaliseTorRelayUrl)
  if (new Set(normalised).size !== normalised.length) throw new Error('that relay is already in the list')
  return normalised
}

/**
 * Make policy crossings explicit at the boundary. A caller must discard its
 * direct-mode signer/session before entering Tor mode; the anonymous profile
 * always begins with a fresh local persona rather than a linked account.
 */
export function requireFreshAnonymousPersona(profile: NetworkProfile, hasExistingIdentity: boolean): void {
  if (profile === 'tor' && hasExistingIdentity) {
    throw new Error('Tor-only mode requires a fresh local persona; sign out and start a new anonymous session')
  }
}
