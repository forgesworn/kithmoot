import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { base64, base64urlnopad } from '@scure/base'
import type { PersonaWitnessRoute } from '../app/src/mls-persona-store.js'

/** Disposable test-only witness; keep signing in the runner, not the page. */
export function pairingFixture(seed = new Uint8Array(32).fill(91)) {
  const now = Math.floor(Date.now() / 1000), relay = new TextEncoder().encode('wss://witness.example/link')
  const body = new Uint8Array(65 + relay.length), view = new DataView(body.buffer)
  body.set(new TextEncoder().encode('FSL1')); body[4] = 1; body.set(ed25519.getPublicKey(seed), 5)
  view.setBigUint64(37, BigInt(now - 1)); view.setBigUint64(45, BigInt(now + 3600)); view.setBigUint64(53, 1n)
  body[61] = 1; body[62] = 1; view.setUint16(63, relay.length); body.set(relay, 65)
  const card = concatBytes(body, ed25519.sign(concatBytes(new TextEncoder().encode('forgesworn-link/card/v1\0'), body), seed))
  const route: PersonaWitnessRoute = { routeId: 'witness', card: bytesToHex(card), pairedRouteSecret: '03'.repeat(32), cardSerial: '1', cardVerifiedAt: String(now), relayUrls: ['wss://witness.example/link'] }
  const uri = 'bothy:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, bothy: bytesToHex(ed25519.getPublicKey(seed)), card: base64.encode(card), secret: '04'.repeat(16), role: 'phone', name: 'Fixture', exp: now + 120 })))
  return { route, uri, witness: bytesToHex(ed25519.getPublicKey(seed)) }
}
