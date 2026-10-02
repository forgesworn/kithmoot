// Moved to @forgesworn/fold-kit (see that package's EXTRACTION.md). Re-exported here,
// unchanged, so every existing import of `./credential.js` keeps working.
export type { CreateCredentialOptions, VerifyResult } from '@forgesworn/fold-kit'
export {
  PERSON_CREDENTIAL_MAX_SECONDS,
  createDeviceCredential,
  verifyDeviceCredential,
  RestampedCredentialExpiryError,
} from '@forgesworn/fold-kit'
