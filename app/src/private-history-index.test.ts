import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { localPeerCrypt } from '../../src/dm.js'
import { LocalHistoryIndex, type EncryptedHistoryDeletionReceipt, type EncryptedHistoryRecord, type HistoryIndexStorage } from './history-index.js'
import { indexAccessibleNip17GiftWraps, indexAccountAuthoredTextNotes, openIndexableNip17GiftWrap } from './private-history-index.js'

class MemoryStorage implements HistoryIndexStorage {
  saved?: CryptoKey
  values = new Map<string, EncryptedHistoryRecord>()
  receiptsByKey = new Map<string, EncryptedHistoryDeletionReceipt>()
  async key() { return this.saved }
  async saveKey(key: CryptoKey) { this.saved = key }
  async records() { return [...this.values.values()] }
  async receipts() { return [...this.receiptsByKey.values()] }
  async put(record: EncryptedHistoryRecord) { this.values.set(record.key, record) }
  async removeAndReceipt(keys: readonly string[], receipt: EncryptedHistoryDeletionReceipt) {
    for (const key of keys) this.values.delete(key)
    this.receiptsByKey.set(receipt.key, receipt)
  }
}

function identity(sk = generateSecretKey()) {
  const peer = localPeerCrypt(sk)
  return { pubkey: getPublicKey(sk), signEvent: async (event: Omit<Event, 'id' | 'pubkey' | 'sig'>) => finalizeEvent(event, sk), encrypt: peer.encrypt, decrypt: peer.decrypt }
}

function giftWrap(recipient = identity(), text = 'Private message'): { recipient: ReturnType<typeof identity>; event: Event } {
  const sender = generateSecretKey(), senderPubkey = getPublicKey(sender), now = 1_700_000_000
  const rumor = { pubkey: senderPubkey, kind: 14, created_at: now, tags: [['p', recipient.pubkey]], content: text }
  const unsigned = { ...rumor, id: getEventHash(rumor) }
  const seal = finalizeEvent({ kind: 13, created_at: now, tags: [], content: nip44.v2.encrypt(JSON.stringify(unsigned), nip44.v2.utils.getConversationKey(sender, recipient.pubkey)) }, sender)
  const ephemeral = generateSecretKey()
  const event = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', recipient.pubkey]], content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephemeral, recipient.pubkey)) }, ephemeral)
  return { recipient, event }
}

describe('private recovered history indexing', () => {
  it('opens only an addressed, correctly layered NIP-17 gift wrap', async () => {
    const { recipient, event } = giftWrap()
    await expect(openIndexableNip17GiftWrap({ event, identity: recipient })).resolves.toMatchObject({ id: event.id, text: 'Private message', conversation: 'nip17' })
    await expect(openIndexableNip17GiftWrap({ event, identity: identity() })).resolves.toBeUndefined()
  })

  it('keeps local index plaintext local and makes duplicate/import outcomes explicit', async () => {
    const { recipient, event } = giftWrap()
    const storage = new MemoryStorage(), index = new LocalHistoryIndex(storage, webcrypto as unknown as Crypto)
    await expect(indexAccessibleNip17GiftWraps({ events: [event, event], identity: recipient, index })).resolves.toEqual({ stored: 1, duplicate: 1, retired: 0, inaccessible: 0 })
    expect(JSON.stringify(await storage.records())).not.toContain('Private message')
  })

  it('indexes only a verified account-authored public text note as eligible for a later deletion request', async () => {
    const ownerKey = generateSecretKey(), otherKey = generateSecretKey()
    const owner = identity(ownerKey), other = identity(otherKey)
    const note = finalizeEvent({ kind: 1, created_at: 1_700_000_000, tags: [], content: 'A public note I can disown' }, ownerKey)
    const wrong = finalizeEvent({ kind: 1, created_at: 1_700_000_000, tags: [], content: 'Somebody else’s note' }, otherKey)
    const storage = new MemoryStorage(), index = new LocalHistoryIndex(storage, webcrypto as unknown as Crypto)
    await expect(indexAccountAuthoredTextNotes({ events: [note, wrong], account: owner.pubkey, index }))
      .resolves.toEqual({ stored: 1, duplicate: 0, retired: 0, ignored: 1 })
    await expect(index.search('disown')).resolves.toEqual([expect.objectContaining({
      document: expect.objectContaining({ id: note.id, accountAuthoredKind: 1, conversation: 'public' }),
    })])
  })

  it('does not index a wrapper whose unsigned rumour ID was altered', async () => {
    const { recipient, event } = giftWrap()
    const seal = JSON.parse(await recipient.decrypt(event.pubkey, event.content)) as Event
    const rumor = JSON.parse(await recipient.decrypt(seal.pubkey, seal.content)) as Record<string, unknown>
    rumor.id = '0'.repeat(64)
    const sender = generateSecretKey()
    const forgedSeal = finalizeEvent({ kind: 13, created_at: seal.created_at, tags: [], content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(sender, recipient.pubkey)) }, sender)
    const ephemeral = generateSecretKey()
    const forged = finalizeEvent({ kind: 1059, created_at: event.created_at, tags: [['p', recipient.pubkey]], content: nip44.v2.encrypt(JSON.stringify(forgedSeal), nip44.v2.utils.getConversationKey(ephemeral, recipient.pubkey)) }, ephemeral)
    await expect(openIndexableNip17GiftWrap({ event: forged, identity: recipient })).resolves.toBeUndefined()
  })

  it('does not let a valid seal substitute a different rumour author', async () => {
    const { recipient, event } = giftWrap()
    const seal = JSON.parse(await recipient.decrypt(event.pubkey, event.content)) as Event
    const rumor = JSON.parse(await recipient.decrypt(seal.pubkey, seal.content)) as Record<string, unknown>
    rumor.pubkey = getPublicKey(generateSecretKey())
    rumor.id = getEventHash({ pubkey: rumor.pubkey as string, kind: rumor.kind as number, created_at: rumor.created_at as number, tags: rumor.tags as string[][], content: rumor.content as string })
    const sender = generateSecretKey()
    const forgedSeal = finalizeEvent({ kind: 13, created_at: seal.created_at, tags: [], content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(sender, recipient.pubkey)) }, sender)
    const ephemeral = generateSecretKey()
    const forged = finalizeEvent({ kind: 1059, created_at: event.created_at, tags: [['p', recipient.pubkey]], content: nip44.v2.encrypt(JSON.stringify(forgedSeal), nip44.v2.utils.getConversationKey(ephemeral, recipient.pubkey)) }, ephemeral)
    await expect(openIndexableNip17GiftWrap({ event: forged, identity: recipient })).resolves.toBeUndefined()
  })
})
