// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./network-hints.js` keeps working.
export {
  MAX_RELAY_HINTS,
  MAX_ICE_HINTS,
  MAX_NETWORK_HINT_LENGTH,
  isSafeRelayUrl,
  safeRelayUrls,
  isSafeIceUrl,
  safeIceUrls,
  assertNetworkHintBounds,
} from '@forgesworn/fold-kit'
