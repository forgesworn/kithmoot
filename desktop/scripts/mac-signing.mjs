import { fileURLToPath } from 'node:url'

/** Ad-hoc identities change with the code hash and cannot retain macOS consent. */
export function macSigningConfig(env = process.env) {
  if (env.KITHMOOT_MAC_LOCAL_PREVIEW === '1') return { localPreview: true }
  const identity = env.KITHMOOT_MAC_SIGNING_IDENTITY
  if (!identity?.startsWith('Developer ID Application: ')) {
    throw new Error('Mac releases require KITHMOOT_MAC_SIGNING_IDENTITY="Developer ID Application: …". For an unpublishable local build only, set KITHMOOT_MAC_LOCAL_PREVIEW=1.')
  }
  const profile = env.KITHMOOT_MAC_NOTARY_PROFILE
  if (!profile) throw new Error('Set KITHMOOT_MAC_NOTARY_PROFILE to the notarytool keychain profile for this release.')
  if (env.KITHMOOT_MAC_NOTARY_PASSWORD_FILE && !env.KITHMOOT_MAC_NOTARY_KEYCHAIN) {
    throw new Error('A notary password file requires an explicitly configured notary keychain.')
  }
  return { localPreview: false, identity, profile, keychain: env.KITHMOOT_MAC_SIGNING_KEYCHAIN,
    notaryKeychain: env.KITHMOOT_MAC_NOTARY_KEYCHAIN,
    notaryPasswordFile: env.KITHMOOT_MAC_NOTARY_PASSWORD_FILE }
}

/** A password-file path may be passed to the helper; password bytes never enter argv. */
export function notaryCommand(args, signing) {
  if (!signing.notaryPasswordFile) return { command: 'xcrun', args }
  if (!signing.notaryKeychain) throw new Error('A notary password file requires an explicitly configured notary keychain.')
  return { command: 'python3', args: [fileURLToPath(new URL('./notary-keychain.py', import.meta.url)),
    '--keychain', signing.notaryKeychain, '--password-file', signing.notaryPasswordFile, '--', ...args] }
}

/** Select the notary profile's own keychain instead of relying on login/search order. */
export function notarySubmissionArgs(archive, signing) {
  if (signing.localPreview || !signing.profile) throw new Error('Notarisation requires a production signing profile.')
  return ['notarytool', 'submit', archive, '--keychain-profile', signing.profile,
    ...(signing.notaryKeychain ? ['--keychain', signing.notaryKeychain] : []),
    '--wait', '--output-format', 'json']
}
