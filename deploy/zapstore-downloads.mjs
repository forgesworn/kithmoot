import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Release downloads must name the same immutable APK that the manifest records.
// Accept our upstream and mirror URLs alongside Zapstore's content-addressed CDN.
export function verifiedDownloadUrls(asset, manifest) {
  const { apkSha256: hash, versionName: version, downloadFilename: filename } = manifest
  const allowed = new Set([
    `https://cdn.zapstore.dev/${hash}`,
    `https://github.com/forgesworn/kithmoot-android/releases/download/v${version}/${filename}`,
    ...['kithmoot.app', 'kithmoot.forgesworn.dev'].flatMap(host => [
      `https://${host}/apk/${filename}`,
      `https://${host}/apk/${hash}`,
    ]),
  ])
  const urls = asset.tags.filter(tag => tag[0] === 'url').map(tag => tag[1])
  assert.ok(urls.length > 0, 'APK asset has no download URLs')
  assert.equal(new Set(urls).size, urls.length, 'APK asset has duplicate download URLs')
  for (const url of urls) assert.ok(allowed.has(url), `Unexpected APK download URL: ${url}`)
  return urls
}

export async function verifyDownload(url, manifest, fetchDownload = fetch) {
  const response = await fetchDownload(url, { signal: AbortSignal.timeout(120_000) })
  assert.equal(response.status, 200, `APK not served publicly: ${url}`)
  assert.ok(response.body, 'APK download has no body')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    bytes += chunk.length
    assert.ok(bytes <= manifest.apkBytes, 'Served APK exceeds its recorded size')
  }
  assert.equal(bytes, manifest.apkBytes, 'Served APK size differs from the manifest')
  const sha256 = hash.digest('hex')
  assert.equal(sha256, manifest.apkSha256, 'Served APK hash differs from the manifest')
  return { url, bytes, sha256, publicDownloadVerified: true }
}
