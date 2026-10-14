export { roomAccessFixture } from './ordinary-room-access.browser-entry.js'
export { bookmarkFixture } from './ordinary-bookmark-fixture.js'
export {
  captureOrdinaryStartupContext,
  releaseOrdinaryStartupContext,
  validateOrdinaryRoomAccessAndBookmarksSnapshot,
} from '../app/src/ordinary-room-access-snapshot.js'

import { buildCard, encodeCard } from 'nostr-contact-card'
import { getPublicKey } from 'nostr-tools/pure'
/** Actual signed contact-card encoding, prepared before the no-effect probe. */
export function startupCardFragment(): string {
  const identity = new Uint8Array(32), ephemeral = new Uint8Array(32).fill(3), rz = new Uint8Array(32).fill(2)
  identity[31] = 4
  const p = getPublicKey(identity)
  try {
    return encodeCard(buildCard({ identityPrivateKey: identity, rz: getPublicKey(rz), ephemeralPrivateKey: ephemeral,
      name: 'Ada', now: () => 1_800_000_000, ttlSeconds: 604_800, relays: [], boxes: [], attest: 'key-capsule',
      bond: { pubkey: p, displayName: 'Ada', nonce: 'b'.repeat(32), personas: [{ pubkey: p, label: 'Home' }] } }))
  } finally { identity.fill(0); ephemeral.fill(0); rz.fill(0) }
}

export { base64urlnopad } from '@scure/base'
