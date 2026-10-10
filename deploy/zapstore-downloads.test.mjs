import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifiedDownloadUrls, verifyDownload } from './zapstore-downloads.mjs'

const payload = Buffer.from('one immutable production APK')
const manifest = {
  versionName: '0.6.78',
  downloadFilename: 'kithmoot-0.6.78-production.apk',
  apkBytes: payload.length,
  apkSha256: createHash('sha256').update(payload).digest('hex'),
}
const github = `https://github.com/forgesworn/kithmoot-android/releases/download/v0.6.78/${manifest.downloadFilename}`
const mirror = `https://kithmoot.app/apk/${manifest.apkSha256}`
const asset = (...urls) => ({ tags: urls.map(url => ['url', url]) })

describe('signed Zapstore download sources', () => {
  it('keeps the verified upstream first and its immutable owner mirror second', () => {
    expect(verifiedDownloadUrls(asset(github, mirror), manifest)).toEqual([github, mirror])
  })

  it('retains the existing content-addressed Zapstore source', () => {
    const cdn = `https://cdn.zapstore.dev/${manifest.apkSha256}`
    expect(verifiedDownloadUrls(asset(cdn), manifest)).toEqual([cdn])
  })

  it('rejects missing and duplicated sources', () => {
    expect(() => verifiedDownloadUrls(asset(), manifest)).toThrow('no download URLs')
    expect(() => verifiedDownloadUrls(asset(github, github), manifest)).toThrow('duplicate')
  })

  it.each([
    github.replace('v0.6.78', 'v0.6.77'),
    github.replace('forgesworn/kithmoot-android', 'another/publisher'),
    mirror.replace('https:', 'http:'),
    mirror.replace('kithmoot.app', 'kithmoot.app.attacker.example'),
    mirror.replace('kithmoot.app', 'kithmoot.app@attacker.example'),
    `${mirror}?redirect=https://attacker.example`,
    mirror.replace(manifest.apkSha256, 'f'.repeat(64)),
  ])('rejects a source outside this exact production artifact: %s', url => {
    expect(() => verifiedDownloadUrls(asset(url), manifest)).toThrow('Unexpected APK download URL')
  })
})

describe('public APK byte verification', () => {
  const serve = (body, status = 200) => async () => new Response(body, { status })

  it('checks a complete public download against the recorded bytes and hash', async () => {
    await expect(verifyDownload(github, manifest, serve(payload))).resolves.toEqual({
      url: github, bytes: payload.length, sha256: manifest.apkSha256, publicDownloadVerified: true,
    })
  })

  it('rejects a same-size tampered download', async () => {
    await expect(verifyDownload(mirror, manifest, serve(Buffer.alloc(payload.length)))).rejects.toThrow('hash differs')
  })

  it('rejects truncated and oversized downloads', async () => {
    await expect(verifyDownload(mirror, manifest, serve(payload.subarray(1)))).rejects.toThrow('size differs')
    await expect(verifyDownload(mirror, manifest, serve(Buffer.concat([payload, payload])))).rejects.toThrow('exceeds')
  })

  it('rejects a partial HTTP response even if its body matches', async () => {
    await expect(verifyDownload(mirror, manifest, serve(payload, 206))).rejects.toThrow('not served publicly')
  })
})
