import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MANIFESTS, UPDATE_KEYS, boundedDigest, compareVersions, desktopUpdate, verifyManifest } from '../update-manifest.mjs'

const site = relative => readFile(new URL(`../../site/${relative}`, import.meta.url))
const vectors = JSON.parse(await readFile(new URL('../../vectors/update-manifest.json', import.meta.url), 'utf8'))

test('every update-manifest vector verifies, or fails, as recorded', () => {
  assert.ok(vectors.cases.length >= 16)
  for (const v of vectors.cases) {
    assert.equal(verifyManifest(v.label, Buffer.from(v.manifest, 'utf8'), v.signature, vectors.trustedKeys), v.valid, v.description)
  }
})

test('the test key is not one the apps trust', () => {
  const good = vectors.cases.find(v => v.valid)
  assert.equal(verifyManifest(good.label, Buffer.from(good.manifest), good.signature), false)
})

test('the published manifests carry a signature by a key the apps trust', async () => {
  assert.equal(UPDATE_KEYS.length, 2)
  for (const key of UPDATE_KEYS) assert.match(key, /^[0-9a-f]{64}$/)
  for (const label of Object.values(MANIFESTS)) {
    const [bytes, sig] = await Promise.all([site(label), site(`${label}.sig`)])
    assert.equal(verifyManifest(label, bytes, sig), true, `${label}.sig: run node scripts/update-signing.mjs sign`)
  }
})

test('versions compare numerically and refuse anything else', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.47', '0.1.47'), 0)
  assert.equal(compareVersions('0.1.47', '1.0.0'), -1)
  for (const bad of ['0.1', '0.1.47-beta', 'v0.1.47', '01.1.1', '']) assert.throws(() => compareVersions(bad, '0.1.0'))
})

const manifest = (version, files) => Buffer.from(JSON.stringify({ version, files }))
const windows = version => ({ filename: `KithMoot-${version}-windows-x64.zip`, version, sha256: 'a'.repeat(64), bytes: 100 })

test('a newer release offers this platform\'s archive', () => {
  assert.deepEqual(desktopUpdate(manifest('0.2.0', [windows('0.2.0')]), { currentVersion: '0.1.47', platform: 'win32', arch: 'x64' }),
    { version: '0.2.0', filename: 'KithMoot-0.2.0-windows-x64.zip', sha256: 'a'.repeat(64), bytes: 100 })
})

test('the same or an older release offers nothing, so a replayed manifest cannot downgrade', () => {
  for (const version of ['0.1.47', '0.1.46', '0.0.1']) {
    assert.equal(desktopUpdate(manifest(version, [windows(version)]), { currentVersion: '0.1.47', platform: 'win32', arch: 'x64' }), undefined)
  }
})

test('platforms with their own updater, or no archive in the release, are offered nothing', () => {
  const m = manifest('0.2.0', [windows('0.2.0')])
  assert.equal(desktopUpdate(m, { currentVersion: '0.1.0', platform: 'darwin', arch: 'arm64' }), undefined)
  assert.equal(desktopUpdate(m, { currentVersion: '0.1.0', platform: 'linux', arch: 'x64' }), undefined)
})

test('a malformed entry is refused, not half-trusted', () => {
  const opts = { currentVersion: '0.1.0', platform: 'win32', arch: 'x64' }
  for (const change of [{ sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) }, { bytes: 0 }, { bytes: 1.5 }, { bytes: 2 ** 40 }, { version: '0.1.9' }]) {
    assert.throws(() => desktopUpdate(manifest('0.2.0', [{ ...windows('0.2.0'), ...change }]), opts), JSON.stringify(change))
  }
  assert.throws(() => desktopUpdate(Buffer.from('not json'), opts))
  assert.throws(() => desktopUpdate(manifest('latest', []), opts))
})

test('a bounded digest stops at the declared size', () => {
  const digest = boundedDigest(4)
  digest.update(Buffer.from('abcd'))
  assert.throws(() => digest.update(Buffer.from('e')), /larger/)
  const ok = boundedDigest(3)
  ok.update(Buffer.from('abc'))
  assert.deepEqual(ok.finish(), { bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
})
