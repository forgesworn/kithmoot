import { expect, it } from 'vitest'
import { applyProjection, emptyContactsState, type ContactProjectionV2, type PairingV2 } from '@forgesworn/signet-contacts'
import { grantedContactsView, grantedContactMeetsTier } from './granted-contacts.js'
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
  const minimal = grantedContactsView(args)
  expect(minimal.contacts[0]).toMatchObject({ name: 'Ada', tier: undefined, verification: undefined, checks: [] })
  expect(grantedContactMeetsTier(minimal, peer, 'ken')).toBe(false)
})
it('removes names and authority on expiry/revocation while preserving sticky blocks', () => {
  const args = fixture(); args.state.blockedPubkeys = [peer]
  expect(grantedContactsView(args).contacts).toEqual([])
  args.now += 600
  const stale = grantedContactsView(args)
  expect(stale.status).toBe('stale'); expect(stale.blocked.has(peer)).toBe(true)
  expect(grantedContactMeetsTier(stale, peer, 'ken')).toBe(false)
  args.state.revoked = true
  expect(grantedContactsView(args)).toMatchObject({ status: 'revoked', contacts: [] })
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
