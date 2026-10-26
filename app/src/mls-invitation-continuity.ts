import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { PersonaReader } from './mls-persona-coordinator.js'
import type { MlsRoomRecord } from './mls-room-store.js'
const KEY = 'kithmoot.mls-invitation.local-installation.v1'
/** This local marker is outside the protected snapshot. Only first creation
 * may mint it; reopening cannot repair a missing marker. It detects known
 * import, marker mismatch/clone and state loss, not jointly restored backups. */
export function invitationAnchor(storage: Storage = localStorage, create = false): string | undefined {
  let value = storage.getItem(KEY)
  if (value === null && create) { value = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); storage.setItem(KEY, value) }
  return value && /^[0-9a-f]{64}$/.test(value) ? bytesToHex(sha256(new TextEncoder().encode(value))) : undefined
}
export function invitationRestart(tx: PersonaReader, room: MlsRoomRecord): string {
  if (!room.invitation) throw new Error('Invitation profile has no protected host association.')
  if (room.invitation.hostInstallation !== tx.installation) return 'DetectedImport'
  const anchor = invitationAnchor()
  if (!anchor) return 'DetectedStateLoss'
  return anchor === room.invitation.localAnchor ? 'TrustedLocalRestart' : 'DetectedClone'
}
