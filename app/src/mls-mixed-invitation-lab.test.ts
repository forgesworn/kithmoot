import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const session = '11'.repeat(32), leaf = '22'.repeat(32), commitment = '33'.repeat(32)
let lab: any, owner: any
async function setup(admin = true, legacy = !admin) {
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_MIXED_INVITATION_LAB', 'true')
  vi.stubEnv('VITE_BROWSER_MLS_PREVIEW', 'true')
  vi.stubEnv('VITE_BROWSER_MLS_INVITATION_PREVIEW', String(legacy))
  vi.stubEnv('VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', String(admin))
  vi.stubGlobal('window', {})
  const bridge = await import('./mls-mixed-invitation-lab.js')
  owner = { create: vi.fn().mockResolvedValue({ state: 'saved' }), invitation: vi.fn() }
  bridge.captureRoomOwner(owner)
  lab = (window as any).__mixedInvitationLab
}
const roles = () => ({ version: 1, profile: 'InvitationAdmins2', policy: 'designated-leaf-admins/1',
  adminSetCommitment: commitment, adminLeafIds: [leaf], ownLeafId: leaf, ownIsAdmin: true })
function active(profile = 'InvitationAdmins2', pending = false) {
  return { state: 'done', value: { state: 'active', value: { session, generation: '1', phase: { type: pending ? 'Pending' : 'Active' },
    updateRequired: false, profile, ...(pending ? {} : { adminRoles: roles() }), members: [], history: [], outbox: [], watch: [] } } }
}
beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

test('Admin2 create selects only the independent admin preview', async () => {
  await setup()
  expect(lab.profile()).toBe('InvitationAdmins2')
  await lab.step('create', { routeId: 'route', name: 'Synthetic', lifetime: 3600 })
  expect(owner.create).toHaveBeenCalledWith('route', 'Synthetic', 3600, false, true)
})
test('legacy create remains explicitly Invitation1', async () => {
  await setup(false)
  expect(lab.profile()).toBe('Invitation1')
  await lab.step('create', { routeId: 'route', name: 'Synthetic', lifetime: 3600 })
  expect(owner.create).toHaveBeenCalledWith('route', 'Synthetic', 3600, true, false)
  await expect(lab.step('role', { session, leafId: leaf, makeAdmin: false, expectedCommitment: commitment })).rejects.toThrow(/Admin2/)
})
test.each([[true, true], [false, false]])('mixed or missing profile flags refuse without creation (%s,%s)', async (admin, legacy) => {
  await setup(admin, legacy)
  await expect(lab.step('create', {})).rejects.toThrow(/exactly one/)
  expect(owner.create).not.toHaveBeenCalled()
})
test('outer preview is required even with the Admin2 flag', async () => {
  await setup()
  vi.stubEnv('VITE_BROWSER_MLS_PREVIEW', 'false')
  await expect(lab.step('create', {})).rejects.toThrow(/outer MLS/)
})
test('snapshot preserves applied native profile and roles while hashing and wiping message bodies', async () => {
  await setup()
  const value = active(), body = new TextEncoder().encode('synthetic private message')
  ;(value.value.value.history as any[]).push({ id: 'message', body })
  owner.invitation.mockResolvedValue(value)
  const read = await lab.step('snapshot', { session, routeId: 'route' })
  expect(read.value.value.profile).toBe('InvitationAdmins2')
  expect(read.value.value.adminRoles).toEqual(roles())
  expect(read.value.value.history[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(read.value.value.history[0].body).toBeUndefined()
  expect(body.every(byte => byte === 0)).toBe(true)
})
test('role changes bind one exact leaf, boolean and last reviewed commitment then consume that review', async () => {
  await setup()
  const args = { routeId: 'route', session, leafId: leaf, makeAdmin: false, expectedCommitment: commitment }
  await expect(lab.step('role', args)).rejects.toThrow(/Review/)
  owner.invitation.mockResolvedValue(active())
  const read = await lab.step('roles', args)
  expect(read.value.value.adminRoles).toEqual(roles())
  expect(read.value.value.history).toBeUndefined()
  for (const changed of [{ leafId: 'other' }, { makeAdmin: 'false' }, { expectedCommitment: '44'.repeat(32) }]) {
    await expect(lab.step('role', { ...args, ...changed })).rejects.toThrow(/Review/)
  }
  owner.invitation.mockResolvedValue({ state: 'done', value: { state: 'refused', reason: 'last-admin' } })
  expect((await lab.step('role', args)).value.reason).toBe('last-admin')
  expect(owner.invitation).toHaveBeenLastCalledWith('route', { type: 'role', session, leafId: leaf, makeAdmin: false, expectedCommitment: commitment })
  await expect(lab.step('role', args)).rejects.toThrow(/Review/)
})
test('pending native read clears applied role review and another profile refuses', async () => {
  await setup()
  owner.invitation.mockResolvedValue(active())
  await lab.step('roles', { session })
  owner.invitation.mockResolvedValue(active('InvitationAdmins2', true))
  expect((await lab.step('roles', { session })).value.value.adminRoles).toBeUndefined()
  await expect(lab.step('role', { session, leafId: leaf, makeAdmin: true, expectedCommitment: commitment })).rejects.toThrow(/Review/)
  owner.invitation.mockResolvedValue(active('Invitation1'))
  await expect(lab.step('roles', { session })).rejects.toThrow(/differs/)
})

test('room readiness uses only the captured actual owner and returns its bounded refusal enum', async () => {
  await setup()
  owner.deviceReadiness = vi.fn().mockResolvedValue({ state: 'done', value: { deviceReady: false, refusal: 'witness-pending' } })
  expect(await lab.step('room-device-readiness')).toEqual({ state: 'done', value: { deviceReady: false, refusal: 'witness-pending' } })
  expect(owner.deviceReadiness).toHaveBeenCalledWith()
})
