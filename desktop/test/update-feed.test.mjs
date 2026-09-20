import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'))

test('the static Mac update feed exactly identifies the published signed archive', async () => {
  const [pkg, release, feed] = await Promise.all([
    readJson('../package.json'),
    readJson('../../site/downloads/release.json'),
    readJson('../../site/downloads/updates/darwin/arm64/RELEASES.json'),
  ])
  assert.equal(feed.currentRelease, pkg.version)
  assert.equal(feed.releases.length, 1)
  const entry = feed.releases[0]
  assert.equal(entry.version, feed.currentRelease)
  assert.equal(entry.updateTo.version, feed.currentRelease)
  assert.equal(entry.updateTo.name, feed.currentRelease)
  assert.match(entry.updateTo.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  const published = release.files.find(file => file.filename.endsWith('-mac-arm64.zip'))
  assert.ok(published)
  assert.equal(entry.updateTo.sha256, published.sha256)
  assert.equal(entry.updateTo.size, published.bytes)
  assert.equal(entry.updateTo.url, `https://kithmoot.forgesworn.dev/apk/desktop/${release.version}/${published.filename}`)
  assert.equal(desktop.endsWith('/desktop/'), true)
})
