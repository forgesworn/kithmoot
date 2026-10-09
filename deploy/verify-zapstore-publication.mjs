import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { verifyEvent } from 'nostr-tools'

const publisher = 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd'
// A store publication is a separate gate from a website or GitHub release.
// This read-only check signs nothing and never reads a publisher private key.
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--output', '--manifest'].includes(args[i]) && args[i + 1] && !options.has(args[i]),
    'Usage: node deploy/verify-zapstore-publication.mjs [--manifest manifest.json] [--output receipt.json]')
  options.set(args[i], args[i + 1])
}
const manifest = JSON.parse(readFileSync(options.get('--manifest') ?? new URL('../site/android-release.json', import.meta.url), 'utf8'))
const packageId = manifest.applicationId
const expectedHash = manifest.apkSha256
const expectedCertificate = manifest.currentCertificateSha256
assert.equal(manifest.channel, 'production')
assert.equal(packageId, 'dev.forgesworn.kithmoot')
assert.match(expectedHash, /^[a-f0-9]{64}$/)
assert.match(expectedCertificate, /^[a-f0-9]{64}$/)
const tag = (event, name) => event.tags.find(t => t[0] === name)?.[1]
const requireTag = (event, name) => {
  const matches = event.tags.filter(t => t[0] === name)
  assert.equal(matches.length, 1, `Expected one ${name} tag on event ${event.id}`)
  return matches[0][1]
}
const relay = 'wss://relay.zapstore.dev'
function query(filters) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay), events = []
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Relay did not complete the query')) }, 30_000)
    const fail = error => { clearTimeout(timeout); ws.close(); reject(error) }
    ws.on('error', fail)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'publication-proof', ...filters])))
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString())
      if (message[0] === 'EVENT' && message[1] === 'publication-proof') {
        const event = message[2]
        if (!verifyEvent(event) || event.pubkey !== publisher) return fail(new Error('Invalid publisher signature'))
        events.push(event)
      }
      if (message[0] === 'EOSE' && message[1] === 'publication-proof') {
        clearTimeout(timeout); ws.close(); resolve(events)
      }
    })
  })
}
const listing = await query([
  { kinds: [32267], authors: [publisher], '#d': [packageId], limit: 1 },
  { kinds: [30063], authors: [publisher], '#i': [packageId], limit: 100 },
])
const app = listing.find(e => e.kind === 32267)
assert.ok(app, 'Application metadata missing')
assert.equal(requireTag(app, 'd'), packageId)
const releases = listing.filter(e => e.kind === 30063 && tag(e, 'c') === 'main').sort((a,b) => b.created_at - a.created_at)
const release = releases.find(e => tag(e, 'version') === manifest.versionName && tag(e, 'c') === 'main')
assert.ok(release, `Production ${manifest.versionName} release missing`)
assert.equal(releases[0].id, release.id, `The current Zapstore release differs from ${manifest.versionName}`)
assert.equal(requireTag(release, 'i'), packageId)
assert.equal(requireTag(release, 'd'), `${packageId}@${manifest.versionName}`)
assert.equal(requireTag(release, 'version'), manifest.versionName)
assert.equal(requireTag(release, 'c'), 'main')
const assetIds = release.tags.filter(t => t[0] === 'e').map(t => t[1])
assert.ok(assetIds.length, 'Release contains no asset references')
const assets = await query([{ kinds: [3063], authors: [publisher], ids: assetIds }])
const asset = assets.find(e => tag(e, 'x') === expectedHash)
assert.ok(asset, 'Expected APK asset missing')
assert.equal(requireTag(asset, 'x'), expectedHash)
assert.equal(requireTag(asset, 'i'), packageId)
assert.equal(requireTag(asset, 'version'), manifest.versionName)
assert.equal(requireTag(asset, 'version_code'), String(manifest.versionCode))
assert.equal(requireTag(asset, 'apk_certificate_hash'), expectedCertificate)
assert.equal(requireTag(asset, 'filename'), manifest.downloadFilename)
assert.equal(requireTag(asset, 'size'), String(manifest.apkBytes))
assert.equal(requireTag(asset, 'min_platform_version'), String(manifest.minSdk))
assert.equal(requireTag(asset, 'target_platform_version'), String(manifest.targetSdk))
assert.equal(requireTag(asset, 'f'), 'android-arm64-v8a')
const url = requireTag(asset, 'url')
assert.equal(url, `https://cdn.zapstore.dev/${expectedHash}`)
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
assert.equal(response.status, 200, 'APK not served publicly')
const hash = createHash('sha256'); let bytes = 0
for await (const chunk of response.body) {
  hash.update(chunk); bytes += chunk.length
  assert.ok(bytes <= manifest.apkBytes, 'Served APK exceeds its recorded size')
}
assert.equal(bytes, manifest.apkBytes)
assert.equal(hash.digest('hex'), expectedHash)
const proof = {
  verifiedAt: new Date().toISOString(), relay, eoseReceived: true,
  publisher, packageId, version: manifest.versionName, versionCode: manifest.versionCode, channel: 'main',
  applicationEventId: app.id, releaseEventId: release.id, assetEventId: asset.id,
  releaseCreatedAt: new Date(release.created_at * 1000).toISOString(),
  nostrSignaturesVerified: true, releaseReferencesVerifiedAsset: true,
  apk: { url, bytes, sha256: expectedHash, certificateSha256: expectedCertificate, publicDownloadVerified: true },
  published: true, physicalAndroidAcceptance: false, zapstoreClientAcceptance: false,
}
if (options.has('--output')) writeFileSync(options.get('--output'), JSON.stringify(proof, null, 2) + '\n')
console.log(JSON.stringify(proof))
