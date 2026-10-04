// Moved to @forgesworn/fold-kit (see that package's docs/seal-key.md). Re-exported
// here, so the session imports it like every other circle-layer module.
export type { SealKey } from '@forgesworn/fold-kit'
export {
  SEAL_TAG,
  isSealPubkey,
  generateSealKey,
  credentialSeal,
  sealTarget,
  sealTo,
  openSealed,
  newerCredential,
} from '@forgesworn/fold-kit'
