// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./persistent-invitation.js` keeps working.
export type { PersistentRoomAdmission } from '@forgesworn/fold-kit'
export {
  encodePersistentInvitation,
  decodePersistentInvitation,
  requestPersistentRoomAdmission,
  PERSISTENT_INVITATION_LABELS,
} from '@forgesworn/fold-kit'
