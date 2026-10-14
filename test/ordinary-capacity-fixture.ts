import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { ContextVault, type ContextIdentity } from '../packages/context/src/index.js'

/** Actual writer output: 25 legitimate empty collections exceed 2 MiB because
 * the primary envelope writer pads each collection to at least 64 KiB. No
 * manually manufactured ciphertext, loader, network or runtime authority. */
export async function largeContextJournal() {
  const secret = new Uint8Array(32).fill(3), account = getPublicKey(secret)
  const identity: ContextIdentity = {
    pubkey: account,
    async signEvent(template) { return finalizeEvent(template, secret) },
    async encrypt(peer, plaintext) {
      const key = nip44.v2.utils.getConversationKey(secret, peer)
      try { return nip44.v2.encrypt(plaintext, key) } finally { key.fill(0) }
    },
    async decrypt() { throw new Error('Capacity fixture must not restore or decrypt a journal') },
  }
  try {
    const vault = new ContextVault({ identity, now: () => 1700000000,
      fetch: async () => { throw new Error('Capacity fixture must not use a network') } })
    for (let i = 0; i < 25; i++) await vault.create({ title: `Private collection ${i}`, scope: 'personal' })
    const raw = await vault.save()
    return { account, raw, records: new Map([[`kithmoot.context.v1.${account}`, raw]]), collections: 25 }
  } finally { secret.fill(0) }
}
