import { bytesToHex } from '@noble/hashes/utils'
import { deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import type { DeviceStore, SavedRoomAdmission } from './device-store.js'

export const TAB_ADMISSION_PREFIX = 'kithmoot.admission.v1.'

/** The existing main cache writer, over an injected synchronous private view.
 * Persistent evidence is retained separately by the protected adapter. */
export function storeTabAdmission(store: DeviceStore, invitation: RoomInvitation, admission: SavedRoomAdmission): void {
  store.set(TAB_ADMISSION_PREFIX + deriveInvitationId(invitation), JSON.stringify({
    roomSecret: bytesToHex(admission.secret),
    ...('delegate' in admission
      ? { delegateSk: bytesToHex(admission.delegate.delegateSk), delegation: admission.delegate.chain }
      : { persistent: true as const }),
    ...(admission.epoch !== undefined ? { epoch: admission.epoch } : {}),
    ...('endsAt' in admission && admission.endsAt !== undefined ? { ends: admission.endsAt } : {}),
    ...('destruct' in admission && admission.destruct ? { destruct: true as const } : {}),
  }))
}
