import type { VmlsCurrentAdminRolesV1 } from '../public/vmls-wasm-admin-invitation/vmls_wasm.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MlsRoomRefused } from './mls-room-store.js'
export interface MlsAdminRoles { version: 1; profile: 'InvitationAdmins2'; policy: 'designated-leaf-admins/1'; epoch: string; adminSetCommitment: string; adminLeafIds: string[]; ownLeafId: string; ownIsAdmin: boolean }
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
/** Applied authenticated native roles only. Pending joins have no role view. */
export function currentAdminRoles(session: { profile(): string; getCurrentAdminRolesV1(): VmlsCurrentAdminRolesV1 }): MlsAdminRoles {
  if (session.profile() !== 'InvitationAdmins2') throw new MlsRoomRefused('wrong-profile')
  const raw = session.getCurrentAdminRolesV1()
  const leaves: string[] = raw.adminLeafIds.map((id: Uint8Array) => bytesToHex(id))
  const own = bytesToHex(raw.ownLeafId), commitment = bytesToHex(raw.adminSetCommitment)
  if (raw.version !== 1 || raw.profile !== 'InvitationAdmins2' || raw.policy !== 'designated-leaf-admins/1' || typeof raw.epoch !== 'bigint' || raw.epoch < 0n ||
      !hex(own) || !hex(commitment) || leaves.length < 1 || leaves.length > 64 || !leaves.every(hex) || leaves.some((id, i) => i > 0 && id <= leaves[i - 1]) || raw.ownIsAdmin !== leaves.includes(own)) throw new MlsRoomRefused('invalid-native-roles')
  return { version: 1, profile: raw.profile, policy: raw.policy, epoch: String(raw.epoch), adminSetCommitment: commitment, adminLeafIds: leaves, ownLeafId: own, ownIsAdmin: raw.ownIsAdmin }
}
export function changedAdminLeaves(roles: MlsAdminRoles, members: readonly { leafId: string; pending: boolean }[], leafId: string, makeAdmin: boolean, expected: string): string[] {
  if (!roles.ownIsAdmin) throw new MlsRoomRefused('admin-required')
  if (roles.adminSetCommitment !== expected) throw new MlsRoomRefused('stale-admin-policy')
  if (!members.some(member => member.leafId === leafId && !member.pending)) throw new MlsRoomRefused('not-current-member')
  if (roles.adminLeafIds.includes(leafId) === makeAdmin) throw new MlsRoomRefused('unchanged-role')
  const result = makeAdmin ? [...roles.adminLeafIds, leafId].sort() : roles.adminLeafIds.filter(id => id !== leafId)
  if (!result.length) throw new MlsRoomRefused('last-admin')
  return result
}
