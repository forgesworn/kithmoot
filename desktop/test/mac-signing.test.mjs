import test from 'node:test'
import assert from 'node:assert/strict'
import { macSigningConfig, notarySubmissionArgs, notaryCommand } from '../scripts/mac-signing.mjs'

test('release packaging refuses ad-hoc and App Store identities instead of silently losing consent', () => {
  for (const identity of [undefined, '-', 'Apple Distribution: Example', 'Apple Development: Example']) {
    assert.throws(() => macSigningConfig({ KITHMOOT_MAC_SIGNING_IDENTITY: identity }), /Developer ID/)
  }
  assert.throws(() => macSigningConfig({ KITHMOOT_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example' }), /NOTARY_PROFILE/)
  assert.equal(macSigningConfig({ KITHMOOT_MAC_LOCAL_PREVIEW: '1' }).localPreview, true)
})

test('notarisation selects its configured keychain independently of signing and the login search order', () => {
  const config = macSigningConfig({
    KITHMOOT_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example',
    KITHMOOT_MAC_NOTARY_PROFILE: 'kithmoot-notary',
    KITHMOOT_MAC_SIGNING_KEYCHAIN: '/private/signing.keychain-db',
    KITHMOOT_MAC_NOTARY_KEYCHAIN: '/private/Notary credentials.keychain-db',
  })
  const args = notarySubmissionArgs('/private/Release candidate.zip', config)
  assert.equal(config.keychain, '/private/signing.keychain-db')
  assert.equal(args[args.indexOf('--keychain') + 1], '/private/Notary credentials.keychain-db')
  assert.equal(args[args.indexOf('--keychain-profile') + 1], 'kithmoot-notary')
  assert.equal(args[2], '/private/Release candidate.zip')
  assert.ok(!args.includes(config.keychain))
})

test('existing default-profile setups remain supported and local previews cannot be notarised', () => {
  const config = macSigningConfig({ KITHMOOT_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example',
    KITHMOOT_MAC_NOTARY_PROFILE: 'kithmoot-notary' })
  assert.ok(!notarySubmissionArgs('release.zip', config).includes('--keychain'))
  assert.throws(() => notarySubmissionArgs('preview.zip', { localPreview: true }), /production signing profile/)
})

test('automated notarisation unlocks only its explicit keychain using a private file path', () => {
  const env = { KITHMOOT_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example',
    KITHMOOT_MAC_NOTARY_PROFILE: 'kithmoot-notary', KITHMOOT_MAC_NOTARY_PASSWORD_FILE: '/private/notary.password' }
  assert.throws(() => macSigningConfig(env), /explicitly configured notary keychain/)
  const config = macSigningConfig({ ...env, KITHMOOT_MAC_NOTARY_KEYCHAIN: '/private/notary.keychain-db' })
  const command = notaryCommand(notarySubmissionArgs('release.zip', config), config)
  assert.equal(command.command, 'python3')
  assert.equal(command.args[command.args.indexOf('--password-file') + 1], '/private/notary.password')
  assert.equal(command.args[command.args.indexOf('--') + 1], 'notarytool')
  assert.ok(!command.args.includes('--password'))
  assert.equal(notaryCommand(['notarytool', 'submit'], { }).command, 'xcrun')
})
