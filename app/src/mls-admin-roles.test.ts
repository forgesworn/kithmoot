import { expect, it } from 'vitest'
import { changedAdminLeaves, currentAdminRoles, type MlsAdminRoles } from './mls-admin-roles.js'
const a = '11'.repeat(32), b = '22'.repeat(32), commitment = '33'.repeat(32)
const roles: MlsAdminRoles = { version: 1, profile: 'InvitationAdmins2', policy: 'designated-leaf-admins/1', epoch: '7', adminSetCommitment: commitment, adminLeafIds: [a], ownLeafId: a, ownIsAdmin: true }
const members = [{ leafId: a, pending: false }, { leafId: b, pending: false }]
it('targets one exact current leaf and refuses stale reviewed intent and the last admin', () => {
  expect(changedAdminLeaves(roles, members, b, true, commitment)).toEqual([a, b])
  for (const run of [() => changedAdminLeaves(roles, members, b, true, '44'.repeat(32)), () => changedAdminLeaves(roles, members, a, false, commitment),
    () => changedAdminLeaves(roles, [{ leafId: b, pending: true }], b, true, commitment), () => changedAdminLeaves({ ...roles, ownIsAdmin: false }, members, b, true, commitment)]) expect(run).toThrow()
})
it('takes roles only from the native Admin2 view and rejects inconsistent or unordered leaves', () => {
  const bytes = (n: number) => new Uint8Array(32).fill(n)
  const raw = { version: 1 as const, profile: 'InvitationAdmins2' as const, policy: 'designated-leaf-admins/1' as const, epoch: 7n, adminSetCommitment: bytes(51), adminLeafIds: [bytes(17)], ownLeafId: bytes(17), ownIsAdmin: true }
  const session = { profile: () => 'InvitationAdmins2', getCurrentAdminRolesV1: () => raw }
  expect(currentAdminRoles(session)).toEqual(roles)
  raw.ownIsAdmin = false; expect(() => currentAdminRoles(session)).toThrow()
  raw.ownIsAdmin = true; raw.adminLeafIds = [bytes(34), bytes(17)]; expect(() => currentAdminRoles(session)).toThrow()
  expect(() => currentAdminRoles({ ...session, profile: () => 'Invitation1' })).toThrow()
})
