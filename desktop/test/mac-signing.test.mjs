import test from 'node:test'
import assert from 'node:assert/strict'
import { macSigningConfig } from '../scripts/mac-signing.mjs'

test('release packaging refuses ad-hoc and App Store identities instead of silently losing consent', () => {
  for (const identity of [undefined, '-', 'Apple Distribution: Example', 'Apple Development: Example']) {
    assert.throws(() => macSigningConfig({ KITHMOOT_MAC_SIGNING_IDENTITY: identity }), /Developer ID/)
  }
  assert.throws(() => macSigningConfig({ KITHMOOT_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example' }), /NOTARY_PROFILE/)
  assert.equal(macSigningConfig({ KITHMOOT_MAC_LOCAL_PREVIEW: '1' }).localPreview, true)
})
