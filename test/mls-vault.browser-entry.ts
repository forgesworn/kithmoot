// Bundled into a page by mls-vault.spec.ts: the vault and what its browser
// tests need to drive it, under one global.
export { MlsVault, BrowserMlsVaultStorage, base64Encode, SIGN_METHOD } from '../app/src/mls-vault.js'
export { bindingDigest } from '../src/vmls/binding.js'
export { encodeUnsignedBinding } from './vmls-encode.js'
export { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
export { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
