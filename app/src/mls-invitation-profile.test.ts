import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { admin2ProductSelected, browserMlsEnabled, mlsInvitationProfile, roomProfileAllowed, selectedRoomCreateOptions } from './mls-invitation-profile.js'
import { adminInvitationPreviewEnabled } from './mls-admin-invitation-engine.js'
import { invitationPreviewEnabled } from './mls-invitation-engine.js'
const product = { VITE_MLS_INVITATION_PROFILE: 'admin2', VITE_ACCOUNT_NETWORK_DEFAULT: 'private-invitations' }
beforeEach(() => {
  vi.stubEnv('DEV', false)
  for (const flag of ['VITE_MLS_INVITATION_PROFILE', 'VITE_ACCOUNT_NETWORK_DEFAULT', 'VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB']) vi.stubEnv(flag, '')
})
afterEach(() => vi.unstubAllEnvs())
function select() { for (const [key, value] of Object.entries(product)) vi.stubEnv(key, value) }
test('strict selector defaults off and requires private distribution policy', () => {
  expect(mlsInvitationProfile({})).toBe('disabled')
  expect(mlsInvitationProfile({ VITE_MLS_INVITATION_PROFILE: 'disabled' })).toBe('disabled')
  for (const value of ['Admin2', ' admin2', 'true', false, null]) expect(() => mlsInvitationProfile({ VITE_MLS_INVITATION_PROFILE: value })).toThrow('VITE_MLS_INVITATION_PROFILE')
  expect(() => mlsInvitationProfile({ VITE_MLS_INVITATION_PROFILE: 'admin2' })).toThrow('private-invitations')
  expect(mlsInvitationProfile(product)).toBe('admin2')
})
test.each(['VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB'])('rejects mixed product/lab property %s', flag => {
  expect(() => mlsInvitationProfile({ ...product, [flag]: 'true' })).toThrow(flag)
})
test('non-DEV product forces Admin2 independently of checkbox state and holds other snapshots', () => {
  expect(browserMlsEnabled()).toBe(false)
  expect(roomProfileAllowed({ profile: 'InvitationAdmins2', invitation: {} })).toBe(false)
  select()
  expect(admin2ProductSelected()).toBe(true)
  expect(browserMlsEnabled()).toBe(true)
  expect(adminInvitationPreviewEnabled()).toBe(true)
  expect(invitationPreviewEnabled()).toBe(false)
  expect(selectedRoomCreateOptions({ experimentalAdminInvitation: false })).toEqual({ experimentalInvitation: false, experimentalAdminInvitation: true })
  expect(() => selectedRoomCreateOptions({ experimentalInvitation: true })).toThrow('refuses legacy')
  for (const room of [{}, { profile: 'FullVmls1' }, { profile: 'Invitation1', invitation: {} }, { profile: 'InvitationAdmins2' }]) expect(roomProfileAllowed(room)).toBe(false)
  expect(roomProfileAllowed({ profile: 'InvitationAdmins2', invitation: {} })).toBe(true)
})
test('explicit DEV legacy and Full paths retain their own selection', () => {
  vi.stubEnv('DEV', true); vi.stubEnv('VITE_BROWSER_MLS_PREVIEW', 'true'); vi.stubEnv('VITE_BROWSER_MLS_INVITATION_PREVIEW', 'true')
  expect(browserMlsEnabled()).toBe(true)
  expect(invitationPreviewEnabled()).toBe(true)
  expect(roomProfileAllowed({})).toBe(true)
  expect(roomProfileAllowed({ profile: 'Invitation1', invitation: {} })).toBe(true)
  expect(selectedRoomCreateOptions({ experimentalInvitation: true })).toEqual({ experimentalInvitation: true })
})
