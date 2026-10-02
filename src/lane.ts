// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./lane.js` keeps working.
export type { Lane } from '@forgesworn/fold-kit'
export {
  LANES,
  LANE_MEANING,
  LANE_LABEL,
  LANE_GLYPH,
  isLane,
  laneOfRelayUrl,
  weakestLane,
  laneOfRelays,
  isDowngrade,
} from '@forgesworn/fold-kit'
