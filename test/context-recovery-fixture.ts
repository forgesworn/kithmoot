import { finalizeEvent, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { ContextVault, CONTEXT_EVENT_BYTES } from '../packages/context/src/index.js'

/** Synthetic unsigned JSON fields exercise callable writer limits. The Nostr
 * signature authenticates its standard tuple, not these extra properties.
 * Snapshot bytes are protected by envelope GCM and the encrypted signed hash.
 * This is neither typical content nor independent external-signer acceptance. */
export function recoveryIdentity(options: { snapshotCeiling?: boolean; policyPadding?: number; cachePadding?: number; secretByte?: number } = {}) {
  const secret = new Uint8Array(32).fill(options.secretByte ?? 7)
  return {
    pubkey: getPublicKey(secret),
    async signEvent(template: EventTemplate) {
      const signed = finalizeEvent(template, secret)
      const purpose = template.tags[0]?.[1]?.split('/').at(-1)
      if (purpose === 'snapshot' && options.snapshotCeiling) {
        const extended = { ...signed, producerFixturePadding: '' }
        extended.producerFixturePadding = 'x'.repeat(CONTEXT_EVENT_BYTES - new TextEncoder().encode(JSON.stringify(extended)).length)
        return extended
      }
      const padding = purpose === 'policy' ? options.policyPadding : purpose === 'cache' ? options.cachePadding : 0
      return padding ? { ...signed, producerFixturePadding: 'x'.repeat(padding) } : signed
    },
    async encrypt(peer: string, text: string) {
      const key = nip44.v2.utils.getConversationKey(secret, peer)
      try { return nip44.v2.encrypt(text, key) } finally { key.fill(0) }
    },
    async decrypt(peer: string, text: string) {
      const key = nip44.v2.utils.getConversationKey(secret, peer)
      try { return nip44.v2.decrypt(text, key) } finally { key.fill(0) }
    },
    dispose() { secret.fill(0) },
  }
}

/** >90MiB requires permitted cache-event padding as well as maximum
 * envelopes: envelopes alone are only 85.34MiB. No Storage quota claim. */
export async function aggregateRecoveryFixture() {
  const identity = recoveryIdentity({ snapshotCeiling: true, cachePadding: 200_000 })
  const vault = new ContextVault({ identity })
  try {
    for (let i = 0; i < 32; i++) await vault.create({ title: `Synthetic ceiling ${i}`, scope: 'personal' })
    return await vault.save()
  } finally { identity.dispose() }
}
