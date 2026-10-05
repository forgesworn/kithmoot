import { expect, it } from 'vitest'
import { applyProjection, emptyContactsState, type ContactProjectionV2, type PairingV2 } from '@forgesworn/signet-contacts'
import { grantedContactsView, grantedContactMeetsTier, NAMES_OUTLIVE_EXPIRY_SECONDS } from './granted-contacts.js'
const account = '1'.repeat(64), peer = '2'.repeat(64), grantId = '3'.repeat(32)
const now = 1800000000
const scopes: PairingV2['grantedCapabilities'] = ['signet.contacts.read:directory', 'signet.contacts.blocks.read', 'signet.contacts.read:tier', 'signet.contacts.read:checks', 'signet.contacts.read:check-records']
const pairing: PairingV2 = { grantId, railPubkey: '4'.repeat(64), projectionTag: '5'.repeat(32), proposalTag: '6'.repeat(32),
  relay: 'wss://relay.example/', grantedCapabilities: scopes, maxStalenessSeconds: 21600, pairedAt: now }
function fixture() {
  const projection: ContactProjectionV2 = { v: 2, grantId, scopes, issuedAt: now, expiresAt: now + 600,
    frontier: { maxClock: 1, opCount: 0, publishedAt: now, deviceId: '7'.repeat(32) },
    contacts: [{ contactId: '8'.repeat(32), displayName: 'Ada', identities: [{ pubkey: peer, verification: 'proven' }], effectiveTier: 'kin',
      checks: [{ pubkey: peer, method: 'words', checkedAt: (now - 1) * 1000 }] }] }
  return { account, binding: { account, pairing }, state: applyProjection(emptyContactsState(), projection, now), now, storageHealthy: true }
}
it('uses only explicitly granted fields and never fills a missing tier with Ken', () => {
  const args = fixture(), full = grantedContactsView(args)
  expect(full.contacts[0]).toMatchObject({ name: 'Ada', tier: 'kin', verification: 'proven' })
  expect(grantedContactMeetsTier(full, peer, 'kith')).toBe(true)
  expect(full.contacts[0].checks).toEqual([{ pubkey: peer, method: 'words', checkedAt: (now - 1) * 1000 }])
  args.state.projection!.scopes = scopes.slice(0, 2)
  args.state.projection!.contacts = [{ contactId: '8'.repeat(32), displayName: 'Ada', identities: [{ pubkey: peer }] }]
  const minimal = grantedContactsView(args)
  expect(minimal.contacts[0]).toMatchObject({ name: 'Ada', tier: undefined, verification: undefined, checks: [] })
  expect(grantedContactMeetsTier(minimal, peer, 'ken')).toBe(false)
})
it('refuses a whole projection that carries a field its scopes do not cover', () => {
  // The contacts SDK treats this as a producer going beyond what the owner
  // approved, so nothing in the projection is used, the covered fields included.
  const args = fixture()
  args.state.projection!.scopes = scopes.slice(0, 2)
  const view = grantedContactsView(args)
  expect(view).toMatchObject({ status: 'unavailable', contacts: [] })
  expect(grantedContactMeetsTier(view, peer, 'ken')).toBe(false)
})
it('keeps names past expiry but drops tiers and checks, which people act on', () => {
  const args = fixture(); args.now += 600
  const stale = grantedContactsView(args)
  expect(stale).toMatchObject({ status: 'stale', issuedAt: now, contacts: [{ pubkey: peer, name: 'Ada', tier: undefined, verification: undefined, checks: [] }] })
  expect(grantedContactMeetsTier(stale, peer, 'ken')).toBe(false)
})
it('drops names a month past expiry and keeps blocks throughout', () => {
  const args = fixture(); args.state.blockedPubkeys = ['9'.repeat(64)]
  args.now += 600 + NAMES_OUTLIVE_EXPIRY_SECONDS - 1
  expect(grantedContactsView(args).contacts).toHaveLength(1)
  args.now++
  const lapsed = grantedContactsView(args)
  expect(lapsed).toMatchObject({ status: 'lapsed', contacts: [] }); expect(lapsed.blocked.has('9'.repeat(64))).toBe(true)
})
it('hides a contact the expired copy itself blocks, though no earlier copy had', () => {
  const args = fixture(); args.state.projection!.contacts[0].blocked = true; args.now += 600
  const stale = grantedContactsView(args)
  expect(stale).toMatchObject({ status: 'stale', contacts: [] }); expect(stale.blocked.has(peer)).toBe(true)
})
it('removes names and authority on revocation, expired or not, while preserving sticky blocks', () => {
  const args = fixture(); args.state.blockedPubkeys = [peer]
  expect(grantedContactsView(args).contacts).toEqual([])
  args.now += 600
  const stale = grantedContactsView(args)
  expect(stale.status).toBe('stale'); expect(stale.contacts).toEqual([]); expect(stale.blocked.has(peer)).toBe(true)
  expect(grantedContactMeetsTier(stale, peer, 'ken')).toBe(false)
  args.state.revoked = true
  expect(grantedContactsView(args)).toMatchObject({ status: 'revoked', contacts: [] })
  expect(grantedContactsView(args).blocked.has(peer)).toBe(true)
})
it('refuses a different account, grant, future projection or failed durable storage', () => {
  expect(grantedContactsView({ ...fixture(), account: '9'.repeat(64) }).status).toBe('disconnected')
  expect(grantedContactsView({ ...fixture(), storageHealthy: false }).status).toBe('unavailable')
  const args = fixture(); args.state.grantId = 'a'.repeat(32)
  expect(grantedContactsView(args).status).toBe('unavailable')
  const future = fixture(); future.state.projection!.issuedAt++
  expect(grantedContactsView(future).status).toBe('unavailable')
})
it('intersects duplicate claims and lets a block beat every visible duplicate', () => {
  const args = fixture(), contacts = args.state.projection!.contacts
  contacts.push({ ...contacts[0], contactId: '9'.repeat(32), displayName: 'Another name', effectiveTier: 'ken', checks: [] })
  const view = grantedContactsView(args)
  expect(view.contacts[0]).toMatchObject({ name: undefined, tier: 'ken', checks: [] })
  expect(grantedContactMeetsTier(view, peer, 'kin')).toBe(false)
  contacts[1].blocked = true
  expect(grantedContactsView(args).contacts).toEqual([])
  expect(grantedContactsView(args).blocked.has(peer)).toBe(true)
})
it('requires the block scope and rejects a projection exceeding the grant ceiling', () => {
  const args = fixture()
  args.binding = { account, pairing: { ...pairing, grantedCapabilities: scopes.slice(0, 2) } }
  expect(grantedContactsView(args).status).toBe('unavailable')
  args.state.projection!.scopes = [scopes[0]]
  expect(grantedContactsView(args).status).toBe('unavailable')
})
