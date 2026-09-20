/** Ad-hoc identities change with the code hash and cannot retain macOS consent. */
export function macSigningConfig(env = process.env) {
  if (env.KITHMOOT_MAC_LOCAL_PREVIEW === '1') return { localPreview: true }
  const identity = env.KITHMOOT_MAC_SIGNING_IDENTITY
  if (!identity?.startsWith('Developer ID Application: ')) {
    throw new Error('Mac releases require KITHMOOT_MAC_SIGNING_IDENTITY="Developer ID Application: …". For an unpublishable local build only, set KITHMOOT_MAC_LOCAL_PREVIEW=1.')
  }
  const profile = env.KITHMOOT_MAC_NOTARY_PROFILE
  if (!profile) throw new Error('Set KITHMOOT_MAC_NOTARY_PROFILE to the notarytool keychain profile for this release.')
  return { localPreview: false, identity, profile, keychain: env.KITHMOOT_MAC_SIGNING_KEYCHAIN }
}
