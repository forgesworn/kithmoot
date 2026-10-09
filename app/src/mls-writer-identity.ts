import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { PersonaWitnessRoute } from './mls-persona-store.js'

export function personaWriter(seed: string): string {
  const bytes = hexToBytes(seed)
  try { return bytesToHex(ed25519.getPublicKey(bytes)) } finally { bytes.fill(0) }
}

/** Re-authenticate the identity on a card already accepted by Link's full
 * card/hint verifier during pairing. This is deliberately not a standalone
 * Link card parser: it checks its signature, framing, serial and validity at
 * the recorded verification time. The endpoint validates all hints again. */
export function pairedWitnessIdentity(route: PersonaWitnessRoute): string {
  try {
    const card = hexToBytes(route.card), end = card.length - 64
    if (card.length < 126 || card.length > 4096 || bytesToHex(card.subarray(0, 5)) !== '46534c3101') throw new Error()
    const view = new DataView(card.buffer, card.byteOffset, card.byteLength)
    const issued = view.getBigUint64(37), expires = view.getBigUint64(45), serial = view.getBigUint64(53), at = BigInt(route.cardVerifiedAt)
    if (serial > BigInt(Number.MAX_SAFE_INTEGER) || serial !== BigInt(route.cardSerial) || at < 0n || at > BigInt(Number.MAX_SAFE_INTEGER) ||
      issued > at + 300n || expires <= at || expires <= issued || expires - issued > 604800n) throw new Error()
    if (card[61] > 16) throw new Error()
    let offset = 62
    for (let i = 0; i < card[61]; i++) {
      if (offset + 3 > end) throw new Error()
      offset += 3 + view.getUint16(offset + 1)
      if (offset > end) throw new Error()
    }
    if (offset !== end) throw new Error()
    const key = card.subarray(5, 37)
    if (!ed25519.verify(card.subarray(end), concatBytes(new TextEncoder().encode('forgesworn-link/card/v1\0'), card.subarray(0, end)), key, { zip215: false })) throw new Error()
    return bytesToHex(key)
  } catch { throw new Error('The paired witness identity could not be verified.') }
}
