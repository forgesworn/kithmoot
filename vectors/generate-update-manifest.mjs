// Regenerate vectors/update-manifest.json: node vectors/generate-update-manifest.mjs
// Test keys from fixed seeds; Ed25519 is deterministic, so the output is stable.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { signedMessage } from '../desktop/update-manifest.mjs'
const key = seedHex => createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex'), format: 'der', type: 'pkcs8' })
const pub = k => Buffer.from(createPublicKey(k).export({ format: 'jwk' }).x, 'base64url').toString('hex')
const signer = key('01'.repeat(32)), other = key('02'.repeat(32))
const sig = (k, label, text) => sign(null, signedMessage(label, Buffer.from(text, 'utf8')), k).toString('base64')
const desktop = '{\n  "version": "0.2.0",\n  "files": [\n    {"filename": "KithMoot-0.2.0-windows-x64.zip", "version": "0.2.0", "sha256": "' + 'ab'.repeat(32) + '", "bytes": 1000}\n  ]\n}\n'
const android = '{\n  "schemaVersion": 1,\n  "applicationId": "dev.forgesworn.kithmoot",\n  "versionName": "0.7.0",\n  "versionCode": 80,\n  "apkSha256": "' + 'cd'.repeat(32) + '",\n  "apkBytes": 2000,\n  "downloadFilename": "kithmoot-0.7.0-production.apk"\n}\n'
const flip = (b64, i) => { const b = Buffer.from(b64, 'base64'); b[i] ^= 1; return b.toString('base64') }
const cases = []
for (const [label, text] of [['downloads/release.json', desktop], ['android-release.json', android]]) {
  const good = sig(signer, label, text)
  const other_label = label === 'android-release.json' ? 'downloads/release.json' : 'android-release.json'
  cases.push(
    { description: `${label}: signed by the trusted key`, label, manifest: text, signature: good, valid: true },
    { description: `${label}: one byte of the manifest changed`, label, manifest: text.replace('"version', '"versioN'), signature: good, valid: false },
    { description: `${label}: trailing newline removed`, label, manifest: text.slice(0, -1), signature: good, valid: false },
    { description: `${label}: one bit of the signature flipped`, label, manifest: text, signature: flip(good, 10), valid: false },
    { description: `${label}: signed by a key the app does not trust`, label, manifest: text, signature: sig(other, label, text), valid: false },
    { description: `${label}: signature made for the other manifest`, label, manifest: text, signature: sig(signer, other_label, text), valid: false },
    { description: `${label}: signature truncated`, label, manifest: text, signature: good.slice(0, 80), valid: false },
    { description: `${label}: signature not base64`, label, manifest: text, signature: '!'.repeat(86) + '==', valid: false },
  )
}
writeFileSync(new URL('./update-manifest.json', import.meta.url), JSON.stringify({
  description: 'Signed update manifests: Ed25519 over "kithmoot/v1/update-manifest\\n" + label + "\\n" + the manifest bytes, signature base64 in the .sig file. See docs/updates.md.',
  trustedKeys: [pub(signer)],
  untrustedKeyForReference: pub(other),
  cases,
}, null, 2) + '\n')
console.log(cases.length, pub(signer))
