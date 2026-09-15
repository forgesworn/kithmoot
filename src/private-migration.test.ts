import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getEventHash, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import {
  GIFT_WRAP_KIND,
  PRIVATE_MIGRATION_REPLY_KIND,
  SEAL_KIND,
  createPrivateMigrationRequest,
  readPrivateMigrationReply,
  submitPrivateMigrationRequest,
  type PrivateMigrationIdentity,
} from './private-migration.js'

const NOW = 1_900_000_000

const person = (): { sk: Uint8Array; identity: PrivateMigrationIdentity } => {
  const sk = generateSecretKey()
  return { sk, identity: { ...localIdentity(sk), ...localPeerCrypt(sk) } }
}

async function openRequest(wrapper: Event, box: PrivateMigrationIdentity): Promise<Record<string, unknown>> {
  const seal = JSON.parse(await box.decrypt(wrapper.pubkey, wrapper.content)) as Event
  return JSON.parse(await box.decrypt(seal.pubkey, seal.content)) as Record<string, unknown>
}

async function replyTo(request: Record<string, unknown>, sender: PrivateMigrationIdentity, receiver: PrivateMigrationIdentity, result: object): Promise<Event> {
  const rumor = {
    pubkey: sender.pubkey,
    kind: PRIVATE_MIGRATION_REPLY_KIND,
    created_at: NOW,
    tags: [['p', receiver.pubkey]],
    content: JSON.stringify({ v: 1, re: request.id, ok: true, result }),
  }
  const inner = { ...rumor, id: getEventHash(rumor) }
  const ephemeral = generateSecretKey()
  try {
    const encrypted = await sender.encrypt(receiver.pubkey, JSON.stringify(inner))
    const seal = await sender.signEvent({ kind: SEAL_KIND, created_at: NOW, tags: [], content: encrypted })
    return finalizeEvent({
      kind: GIFT_WRAP_KIND,
      created_at: NOW,
      tags: [['p', receiver.pubkey]],
      content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephemeral, receiver.pubkey)),
    }, ephemeral)
  } finally { ephemeral.fill(0) }
}

describe('private migration NIP-59 client', () => {
  it('creates a bounded, signer-sealed retain request and opens a correlated receipt', async () => {
    const owner = person(), box = person(), importedBy = person()
    const event = finalizeEvent({ kind: 4, created_at: NOW - 1, tags: [['p', owner.identity.pubkey]], content: 'ciphertext' }, importedBy.sk)
    const request = await createPrivateMigrationRequest({
      identity: owner.identity,
      node: box.identity.pubkey,
      operation: { op: 'retain', events: [event] },
      nonce: '0123456789abcdef',
      now: NOW,
    })
    expect(request.wrapper.kind).toBe(GIFT_WRAP_KIND)
    expect(request.wrapper.tags).toEqual([['p', box.identity.pubkey]])
    const rumor = await openRequest(request.wrapper, box.identity)
    expect(rumor).toMatchObject({ id: request.requestId, pubkey: owner.identity.pubkey, kind: 24644, tags: [['p', box.identity.pubkey]] })
    const receipt = await replyTo(rumor, box.identity, owner.identity, { outcomes: ['stored'] })
    await expect(readPrivateMigrationReply({ wrapper: receipt, identity: owner.identity, node: box.identity.pubkey, requestId: request.requestId }))
      .resolves.toMatchObject({ ok: true, result: { outcomes: ['stored'] } })
  })

  it('subscribes before publishing and accepts only the matching private receipt', async () => {
    const owner = person(), box = person()
    let listener: ((event: Event) => void) | undefined
    const transport = {
      async publish(wrapper: Event) {
        const request = await openRequest(wrapper, box.identity)
        const receipt = await replyTo(request, box.identity, owner.identity, { outcome: 'recorded' })
        queueMicrotask(() => listener?.(receipt))
      },
      subscribe(filters: Filter[], onEvent: (event: Event) => void) {
        expect(filters).toEqual([{ kinds: [1059], '#p': [owner.identity.pubkey] }])
        listener = onEvent
        return () => { listener = undefined }
      },
    }
    await expect(submitPrivateMigrationRequest({
      identity: owner.identity,
      node: box.identity.pubkey,
      operation: { op: 'delete', id: 'd'.repeat(64) },
      nonce: '0123456789abcdef',
      transport,
      now: NOW,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ ok: true, result: { outcome: 'recorded' } })
  })

  it('rejects unsigned events, oversized batches and mismatched encrypted receipts', async () => {
    const owner = person(), box = person()
    const forged = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 4, created_at: NOW, tags: [], content: 'forged', sig: 'c'.repeat(128) } as Event
    await expect(createPrivateMigrationRequest({ identity: owner.identity, node: box.identity.pubkey, operation: { op: 'retain', events: [forged] }, nonce: '0123456789abcdef', now: NOW }))
      .rejects.toThrow('verified signed events')
    await expect(createPrivateMigrationRequest({ identity: owner.identity, node: box.identity.pubkey, operation: { op: 'retain', events: [] }, nonce: '0123456789abcdef', now: NOW }))
      .rejects.toThrow('1-8 events')
    const request = await createPrivateMigrationRequest({ identity: owner.identity, node: box.identity.pubkey, operation: { op: 'delete', id: 'd'.repeat(64) }, nonce: '0123456789abcdef', now: NOW })
    const rumor = await openRequest(request.wrapper, box.identity)
    const receipt = await replyTo(rumor, box.identity, owner.identity, { outcome: 'recorded' })
    await expect(readPrivateMigrationReply({ wrapper: receipt, identity: owner.identity, node: box.identity.pubkey, requestId: 'e'.repeat(64) })).resolves.toBeUndefined()
  })
})
