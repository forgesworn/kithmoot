// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./room.js` keeps working.
export {
  generateRoomSecret,
  deriveRoom,
  parseRoomPolicy,
  encodeJoinUrl,
  decodeJoinUrl,
  ROOM_LABELS,
} from '@forgesworn/fold-kit'
