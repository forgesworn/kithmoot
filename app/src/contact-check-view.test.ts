import { expect, it } from 'vitest'
import { contactCheckView } from './contact-check-view.js'
import type { GrantedContactsView } from './granted-contacts.js'
const peer = 'a'.repeat(64)
function view(): GrantedContactsView { return { status: 'ready', blocked: new Set(), truncated: false,
  contacts: [{ pubkey: peer, checks: [{ pubkey: peer, method: 'nip05', checkedAt: 1800000000000 }] }] } }
it('labels the actual granted method without turning it into a local word comparison', () => {
  expect(contactCheckView(view(), peer, { status: 'unknown' })).toMatchObject({ label: 'Signet check', title: expect.stringContaining('NIP-05 check') })
  const granted = view(); granted.contacts[0].checks = []; granted.contacts[0].verification = 'proven'
  expect(contactCheckView(granted, peer, { status: 'unknown' })).toMatchObject({ label: 'Signet checked', title: expect.stringContaining('No dated check record') })
})
it('withdraws stale, revoked and missing granted claims without confusing local observations', () => {
  for (const status of ['stale', 'revoked', 'waiting', 'disconnected'] as const) {
    const granted = { ...view(), status }
    expect(contactCheckView(granted, peer, { status: 'unknown' }).label).toBe('not checked')
    expect(contactCheckView(granted, peer, { status: 'verified', verifiedAt: 1800000000 }).label).toBe('checked here')
  }
  expect(contactCheckView(view(), 'b'.repeat(64), { status: 'unknown' }).label).toBe('not checked')
})
it('blocks override local and granted checks, while name changes remain visible without a granted check', () => {
  const granted = view(); granted.blocked.add(peer)
  expect(contactCheckView(granted, peer, { status: 'verified' }).label).toBe('check unavailable')
  expect(contactCheckView({ ...view(), status: 'unavailable' }, peer, { status: 'verified' }).label).toBe('check unavailable')
  expect(contactCheckView(undefined, peer, { status: 'key-changed', expected: 'b'.repeat(64) }).label).toBe('code changed')
})
