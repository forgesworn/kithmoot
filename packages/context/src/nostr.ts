import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import type { ContextIdentity } from './index.js'

/** Optional local Nostr identity. Remote/browser signers can implement
 * ContextIdentity directly; applications own key storage and authorisation. */
export function createNostrIdentity(secretKey: Uint8Array): ContextIdentity {
  const key = Uint8Array.from(secretKey)
  return {
    pubkey: getPublicKey(key),
    async signEvent(unsigned) { return finalizeEvent(unsigned, key) },
    async encrypt(peer, plaintext) { return encrypt(plaintext, getConversationKey(key, peer.toLowerCase())) },
    async decrypt(peer, ciphertext) { return decrypt(ciphertext, getConversationKey(key, peer.toLowerCase())) },
  }
}
