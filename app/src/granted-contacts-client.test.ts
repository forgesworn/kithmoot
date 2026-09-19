import { expect, it, vi } from 'vitest'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { sealVaultPayload, projectionEventTemplate, projectionTag, proposalTag,
  type ContactProjectionV2, type ContactsSigner, type PairingV2, type SignedNostrEvent } from '@forgesworn/signet-contacts'
import { GrantedContactsClient, BASIC_CONTACT_SCOPES } from './granted-contacts-client.js'
import { memoryDeviceStore } from './device-store.js'
const now = 1800000000, appKey = new Uint8Array(32).fill(1), railKey = new Uint8Array(32).fill(2)
const account = getPublicKey(appKey), rail = getPublicKey(railKey), grantId = '3'.repeat(32), peer = '4'.repeat(64)
function signer(key: Uint8Array): ContactsSigner {
  return { pubkey: getPublicKey(key), signEvent: async template => finalizeEvent(template, key),
    nip44Encrypt: async (pubkey, plaintext) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(key, pubkey)),
    nip44Decrypt: async (pubkey, ciphertext) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(key, pubkey)) }
}
function setup() {
  const store = memoryDeviceStore(), changed = vi.fn(), decrypt = vi.fn(signer(appKey).nip44Decrypt)
  const pairing: PairingV2 = { grantId, railPubkey: rail, projectionTag: projectionTag(grantId), proposalTag: proposalTag(grantId, account),
    relay: 'wss://relay.example/', grantedCapabilities: BASIC_CONTACT_SCOPES, maxStalenessSeconds: 21600, pairedAt: now }
  const prefix = `kithmoot.contacts.v2.${account}.`
  store.set(prefix + 'pairing', JSON.stringify(pairing))
  let event: SignedNostrEvent | null = null, current = true, time = now, tail = Promise.resolve()
  const lock = <T>(task: () => Promise<T>) => { const next = tail.then(task); tail = next.then(() => {}, () => {}); return next }
  const make = () => new GrantedContactsClient({ signer: { ...signer(appKey), nip44Decrypt: decrypt }, store, changed,
    current: () => current, now: () => time, lock, relay: { fetchNewest: async () => event, publish: async () => true } })
  const publish = async (offset: number, revoked = false, blocked = false) => {
    const projection: ContactProjectionV2 = { v: 2, grantId, scopes: BASIC_CONTACT_SCOPES, issuedAt: now - 100 + offset, expiresAt: now + 600,
      frontier: { publishedAt: now - 100 + offset, maxClock: 1, opCount: 0, deviceId: '5'.repeat(32) },
      contacts: revoked ? [] : [{ contactId: '6'.repeat(32), displayName: 'Ada', identities: [{ pubkey: peer }], blocked }], ...(revoked ? { revoked: true as const } : {}) }
    const content = await sealVaultPayload(JSON.stringify(projection), signer(railKey), account)
    event = finalizeEvent(projectionEventTemplate(rail, grantId, projection.issuedAt, content!), railKey)
  }
  return { store, prefix, changed, decrypt, make, publish, advance: (seconds: number) => { time += seconds }, close: () => { current = false },
    alter: (fn: (event: SignedNostrEvent) => SignedNostrEvent) => { event = fn(event!) } }
}
it('loads real signed/encrypted projections and retains revocation replay floors across clients', async () => {
  const t = setup(), client = t.make()
  await t.publish(80); await client.refresh()
  expect(client.view()).toMatchObject({ status: 'ready', contacts: [{ name: 'Ada', pubkey: peer }] })
  await t.publish(10, true); await client.refresh()
  expect(client.view().status).toBe('revoked')
  const restarted = t.make()
  await t.publish(40); await restarted.refresh()
  expect(restarted.view().status).toBe('revoked')
  await t.publish(90); await restarted.refresh()
  expect(restarted.view().status).toBe('ready')
})
it('rejects forged signatures and wrong event slots before calling the signer', async () => {
  const t = setup(), client = t.make()
  await t.publish(80); t.alter(event => ({ ...event, content: event.content + 'x' }))
  await client.refresh(); expect(t.decrypt).not.toHaveBeenCalled()
  await t.publish(80); t.alter(event => finalizeEvent({ ...event, tags: [['d', 'wrong']] }, railKey))
  await client.refresh(); expect(t.decrypt).not.toHaveBeenCalled()
  expect(client.view().contacts).toEqual([])
})
it('refuses corrupt cached state and publication state that cannot be saved', async () => {
  const t = setup(), client = t.make()
  t.store.set(t.prefix + `signet-contacts:state:${grantId}`, '{broken')
  await t.publish(80); await client.refresh()
  expect(client.view().status).toBe('unavailable'); expect(t.decrypt).not.toHaveBeenCalled()
  t.store.remove(t.prefix + `signet-contacts:state:${grantId}`)
  t.store.set = () => { throw new Error('quota') }
  await client.refresh()
  expect(client.view().status).toBe('unavailable'); expect(client.view().contacts).toEqual([])
})
it('drops the view and prevents later writes after account change or stop', async () => {
  const t = setup(), client = t.make()
  await t.publish(80); await client.refresh()
  t.close(); await t.publish(90); await client.refresh()
  expect(client.view().status).toBe('disconnected')
  client.stop(); expect(client.view().contacts).toEqual([])
})

it('emits expiry before network work and keeps known blocks when the cache becomes unreadable', async () => {
  const t = setup(), client = t.make()
  await t.publish(80, false, true); await client.refresh()
  expect(client.view().blocked.has(peer)).toBe(true)
  t.advance(601)
  const refreshing = client.refresh()
  expect(t.changed.mock.lastCall?.[0]).toMatchObject({ status: 'stale', contacts: [] })
  await refreshing
  t.store.set(t.prefix + `signet-contacts:state:${grantId}`, '{broken')
  await client.refresh()
  expect(client.view().status).toBe('unavailable')
  expect(client.view().blocked.has(peer)).toBe(true)
})
