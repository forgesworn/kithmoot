import { sha3_256 } from '@noble/hashes/sha3.js'
import { describe, expect, it } from 'vitest'
import { assertTorRoomTransport, assertV3OnionHostname, normaliseTorRelayUrl, requireFreshAnonymousPersona } from './anonymous.js'
import { NostrRelayPool, normaliseRelayConfig } from './relay-pool.js'

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
const prefix = new TextEncoder().encode('.onion checksum')

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits !== 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function onion(): string {
  const key = new Uint8Array(32).map((_, i) => i + 1)
  const input = new Uint8Array(prefix.length + key.length + 1)
  input.set(prefix)
  input.set(key, prefix.length)
  input[input.length - 1] = 3
  const address = new Uint8Array(35)
  address.set(key)
  address.set(sha3_256(input).subarray(0, 2), 32)
  address[34] = 3
  return `${base32(address)}.onion`
}

describe('anonymous Tor transport boundary', () => {
  const validOnion = onion()

  it('accepts only a checksum-valid exact v3 onion hostname', () => {
    expect(assertV3OnionHostname(validOnion.toUpperCase())).toBe(validOnion)
    expect(() => assertV3OnionHostname(`x${validOnion.slice(1)}`)).toThrow(/checksum/u)
    expect(() => assertV3OnionHostname(`sub.${validOnion}`)).toThrow(/exact/u)
    expect(() => assertV3OnionHostname('abcdefghijklmnop.onion')).toThrow(/exact/u)
  })

  it('allows only onion WebSocket relays and strips no credentials or fragments', () => {
    expect(normaliseTorRelayUrl(`ws://${validOnion}/relay`)).toBe(`ws://${validOnion}/relay`)
    expect(normaliseTorRelayUrl(`wss://${validOnion}`)).toBe(`wss://${validOnion}/`)
    expect(() => normaliseTorRelayUrl('wss://relay.example')).toThrow(/onion/u)
    expect(() => normaliseTorRelayUrl(`wss://user:pass@${validOnion}`)).toThrow(/credentials/u)
    expect(() => normaliseTorRelayUrl(`https://${validOnion}`)).toThrow(/ws/u)
    expect(() => normaliseTorRelayUrl(`ws://${validOnion}/#fragment`)).toThrow(/fragments/u)
  })

  it('holds rather than walking a room onto direct media or a duplicate relay', () => {
    expect(assertTorRoomTransport([`ws://${validOnion}/a`], [])).toEqual([`ws://${validOnion}/a`])
    expect(() => assertTorRoomTransport([], [])).toThrow(/at least one/u)
    expect(() => assertTorRoomTransport([`ws://${validOnion}`], ['stun:stun.example:3478'])).toThrow(/disables/u)
    expect(() => assertTorRoomTransport([`ws://${validOnion}`, `ws://${validOnion}/`], [])).toThrow(/already/u)
  })

  it('does not reuse a signed-in or persistent persona for anonymous mode', () => {
    expect(() => requireFreshAnonymousPersona('tor', true)).toThrow(/fresh local persona/u)
    expect(() => requireFreshAnonymousPersona('tor', false)).not.toThrow()
    expect(() => requireFreshAnonymousPersona('direct', true)).not.toThrow()
  })

  it('makes the shared relay pool enforce the same boundary', () => {
    expect(normaliseRelayConfig([`ws://${validOnion}`], 'tor')[0]?.url).toBe(`ws://${validOnion}/`)
    expect(() => normaliseRelayConfig(['wss://relay.example'], 'tor')).toThrow(/onion/u)
    expect(() => new NostrRelayPool([`ws://${validOnion}`], undefined, {
      profile: 'tor',
      authentication: [{ url: `ws://${validOnion}`, identity: null }],
    })).toThrow(/does not use relay authentication/u)
  })
})
