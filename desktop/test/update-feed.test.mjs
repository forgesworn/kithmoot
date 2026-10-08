import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../update-manifest.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'))

test('the static Mac update feed exactly identifies the published signed archive', async () => {
  const [release, feed, versions] = await Promise.all([
    readJson('../../site/downloads/release.json'),
    readJson('../../site/downloads/updates/darwin/arm64/RELEASES.json'),
    readJson('../../site/downloads/versions.json'),
  ])
  assert.equal(feed.releases.length, 1)
  const entry = feed.releases[0]
  assert.equal(entry.version, feed.currentRelease)
  assert.equal(entry.updateTo.version, feed.currentRelease)
  assert.equal(entry.updateTo.name, feed.currentRelease)
  assert.match(entry.updateTo.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  // A platform can stay on its last accepted archive while other platforms
  // advance. Its feed must identify the newest published archive for that Mac.
  const macReleases = versions.desktop.filter(item => item.files.some(file => file.os === 'mac' && file.arch === 'arm64'))
    .sort((a, b) => compareVersions(b.version, a.version))
  assert.ok(macReleases.length)
  const latestMac = macReleases[0]
  assert.equal(feed.currentRelease, latestMac.version)
  assert.ok(compareVersions(latestMac.version, release.version) <= 0)
  const published = latestMac.files.find(file => file.os === 'mac' && file.arch === 'arm64')
  assert.ok(published)
  if (latestMac.version === release.version) {
    const signed = release.files.find(file => file.filename === published.filename)
    assert.ok(signed)
    assert.equal(signed.version, latestMac.version)
    assert.equal(signed.sha256, published.sha256)
    assert.equal(signed.bytes, published.bytes)
  }
  assert.equal(entry.updateTo.sha256, published.sha256)
  assert.equal(entry.updateTo.size, published.bytes)
  assert.equal(published.url, `/apk/desktop/${latestMac.version}/${published.filename}`)
  assert.equal(entry.updateTo.url, `https://kithmoot.forgesworn.dev${published.url}`)
  assert.equal(desktop.endsWith('/desktop/'), true)
})
