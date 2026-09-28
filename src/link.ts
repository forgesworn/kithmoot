// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./link.js` keeps working.
export type { RoomLink } from '@forgesworn/fold-kit'
export {
  safeIceUrls,
  safeRelayUrls,
  MAX_ROOM_LINK_FRAGMENT_LENGTH,
  parseRoomLink,
  encodeRoomLink,
} from '@forgesworn/fold-kit'
