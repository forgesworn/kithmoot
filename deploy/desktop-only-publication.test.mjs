// Local simulated publication roots and disposable signing keys only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_PATHS, composeDesktopMetadata, validateDesktopMetadata, snapshotCurrent, assertCurrent, activateDesktopMetadata } from './desktop-only-publication.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const stringify = value => JSON.stringify(value, null, 2) + '\n'
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-publication-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'site'), releases = join(base, 'bulk/releases'), live = join(releases, 'old')
  await mkdir(root, { recursive: true }); await mkdir(live, { recursive: true }); await symlink(releases, join(root, 'releases')); await symlink(join(root, 'releases/old'), join(root, 'current'))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trustedKeys = [Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')]
  const signer = bytes => sign(null, Buffer.concat([Buffer.from('kithmoot/v1/update-manifest\ndownloads/release.json\n'), bytes]), privateKey).toString('base64')
  const oldFiles = ['mac-arm64.zip', 'linux-x64.tar.gz', 'windows-x64.zip'].map(ending => ({ filename: `KithMoot-0.1.104-${ending}`, version: '0.1.104', bytes: 3, sha256: 'a'.repeat(64) }))
  const manifest = stringify({ version: '0.1.104', channel: 'preview', published: '2026-10-24', files: oldFiles })
  const feed = stringify({ currentRelease: '0.1.104', releases: [{ version: '0.1.104', updateTo: { version: '0.1.104', url: 'https://example.test/apk/desktop/0.1.104/KithMoot-0.1.104-mac-arm64.zip' } }] })
  const catalogue = stringify({ desktop: [{ version: '0.1.104', files: oldFiles }], android: [{ version: '0.6.112', files: [{ filename: 'phone.apk', sha256: 'b'.repeat(64) }] }] })
  const metadata = { 'downloads/release.json': manifest, 'downloads/release.json.sig': signer(Buffer.from(manifest)) + '\n',
    'downloads/updates/darwin/arm64/RELEASES.json': feed, 'downloads/versions.json': catalogue, 'downloads/SHA256SUMS.txt': 'old-checksum  phone.apk\n' }
  for (const [path, bytes] of Object.entries({ ...metadata, 'j/assets/current.js': 'newer-live-PWA', 'android-release.json': 'newer-android',
    'android-release.json.sig': 'protected-signature', '.well-known/assetlinks.json': 'protected-links', 'index.html': 'current-marketing', 'downloads/index.html': 'current-downloads' })) {
    await mkdir(join(live, path, '..'), { recursive: true }); await writeFile(join(live, path), bytes, { mode: 0o644 })
  }
  await symlink('assets/current.js', join(live, 'j/alias.js'))
  const body = Buffer.from('only a simulated Mac archive')
  const archive = { version: '0.1.106', filename: 'KithMoot-0.1.106-mac-arm64.zip', bytes: body.length, sha256: sha(body) }
  await mkdir(join(root, 'apk/desktop', archive.version), { recursive: true }); await writeFile(join(root, 'apk/desktop', archive.version, archive.filename), body)
  const expected = await snapshotCurrent(root)
  const overlay = composeDesktopMetadata(expected, archive, { publishedAt: '2026-10-25T21:00:00Z', notes: 'Monitor fix', origin: 'https://example.test', signManifest: signer, trustedKeys })
  return { base, root, releases, live, archive, expected, overlay, trustedKeys, signer,
    activate: extra => activateDesktopMetadata({ root, expected, overlay, archive, trustedKeys, releaseName: 'desktop-106', ...extra }) }
}

test('Mac-only publication preserves live platform history and every protected file/mode/link with resolved bulk releases', async t => {
  const f = await fixture(t)
  assert.equal(validateDesktopMetadata(f.expected, f.overlay, f.archive, f.trustedKeys), true)
  const oldCatalogue = JSON.parse(f.expected.publicMetadata['downloads/versions.json']), next = JSON.parse(f.overlay['downloads/versions.json'])
  assert.deepEqual(next.android, oldCatalogue.android); assert.deepEqual(next.desktop.slice(1), oldCatalogue.desktop)
  assert.equal(next.desktop[0].files.length, 1); assert.equal(next.desktop[0].files[0].os, 'mac')
  const result = await f.activate(), actual = await snapshotCurrent(f.root)
  assert.equal(actual.currentResolved, join(f.expected.releasesResolved, 'desktop-106')); assert.equal(result.version, '0.1.106')
  assert.deepEqual(actual.manifest.filter(row => !DESKTOP_PATHS.includes(row.path)), f.expected.manifest.filter(row => !DESKTOP_PATHS.includes(row.path)))
  assert.equal(await readFile(join(actual.currentResolved, 'j/assets/current.js'), 'utf8'), 'newer-live-PWA')
  assert.equal(await readlink(join(actual.currentResolved, 'j/alias.js')), 'assets/current.js')
  for (const path of DESKTOP_PATHS) assert.equal(await readFile(join(actual.currentResolved, path), 'utf8'), f.overlay[path])
  assert.equal(await readFile(join(f.live, 'downloads/release.json'), 'utf8'), f.expected.publicMetadata['downloads/release.json'])
  await assert.rejects(lstat(join(f.root, '.desktop-publication.lock')), /ENOENT/)
})

for (const change of ['bytes', 'mode', 'target']) test(`CAS refuses changed live ${change} without activation`, async t => {
  const f = await fixture(t)
  if (change === 'bytes') await writeFile(join(f.live, 'j/assets/current.js'), 'newer-still')
  if (change === 'mode') await chmod(join(f.live, 'j/assets/current.js'), 0o600)
  if (change === 'target') { await rm(join(f.root, 'current')); await symlink('releases/other', join(f.root, 'current')); await mkdir(join(f.releases, 'other')) }
  await assert.rejects(f.activate(), /CAS|metadata/)
  await assert.rejects(lstat(join(f.releases, 'desktop-106')), /ENOENT/)
  await assert.rejects(lstat(join(f.root, '.desktop-publication.lock')), /ENOENT/)
})

test('publication lock contention never removes another publisher lock', async t => {
  const f = await fixture(t), lock = join(f.root, '.desktop-publication.lock')
  await mkdir(lock); await writeFile(join(lock, 'owner'), 'other publisher')
  await assert.rejects(f.activate(), /EEXIST/)
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'other publisher')
})

test('pre-existing release directory survives a refused publication', async t => {
  const f = await fixture(t), existing = join(f.releases, 'desktop-106')
  await mkdir(existing); await writeFile(join(existing, 'preserve'), 'pre-existing release')
  await assert.rejects(f.activate(), /EEXIST/)
  assert.equal(await readFile(join(existing, 'preserve'), 'utf8'), 'pre-existing release')
  assert.equal(await readlink(join(f.root, 'current')), f.expected.currentTarget)
})

for (const change of ['archive', 'private-archive', 'signature', 'signature-format', 'old-signature', 'android-history', 'platform', 'outside-allowlist', 'downgrade', 'origin']) test(`publication refuses ${change}`, async t => {
  const f = await fixture(t)
  if (change === 'archive') await writeFile(join(f.root, 'apk/desktop', f.archive.version, f.archive.filename), 'different immutable archive')
  if (change === 'private-archive') await chmod(join(f.root, 'apk/desktop', f.archive.version, f.archive.filename), 0o600)
  if (change === 'signature') f.overlay['downloads/release.json.sig'] = Buffer.alloc(64).toString('base64')
  if (change === 'signature-format') f.overlay['downloads/release.json.sig'] += '!'
  if (change === 'old-signature') f.expected.publicMetadata['downloads/release.json.sig'] = Buffer.alloc(64).toString('base64')
  if (change === 'android-history') { const c = JSON.parse(f.overlay['downloads/versions.json']); c.android = []; f.overlay['downloads/versions.json'] = stringify(c) }
  if (change === 'platform') { const c = JSON.parse(f.overlay['downloads/versions.json']); c.desktop[0].files[0].os = 'windows'; f.overlay['downloads/versions.json'] = stringify(c) }
  if (change === 'outside-allowlist') f.overlay['j/index.html'] = 'stale105'
  if (change === 'downgrade') { const c = JSON.parse(f.overlay['downloads/updates/darwin/arm64/RELEASES.json']); c.currentRelease = '0.1.103'; f.overlay['downloads/updates/darwin/arm64/RELEASES.json'] = stringify(c) }
  if (change === 'origin') { const c = JSON.parse(f.overlay['downloads/updates/darwin/arm64/RELEASES.json']); c.releases[0].updateTo.url = c.releases[0].updateTo.url.replace('example.test', 'different.test'); f.overlay['downloads/updates/darwin/arm64/RELEASES.json'] = stringify(c) }
  await assert.rejects(f.activate())
  assert.equal(await readlink(join(f.root, 'current')), f.expected.currentTarget)
  await assert.rejects(lstat(join(f.releases, 'desktop-106')), /ENOENT/)
})

test('snapshot comparison ignores capture time but requires the complete protected manifest', async t => {
  const f = await fixture(t)
  assert.doesNotThrow(() => assertCurrent({ ...f.expected, readAt: 'earlier' }, { ...f.expected, readAt: 'later' }))
  assert.throws(() => assertCurrent({ ...f.expected, manifest: [] }, f.expected), /CAS/)
  const reordered = { ...f.expected, publicMetadata: Object.fromEntries(Object.entries(f.expected.publicMetadata).reverse()),
    manifest: f.expected.manifest.map(row => Object.fromEntries(Object.entries(row).reverse())).reverse() }
  assert.doesNotThrow(() => assertCurrent(f.expected, reordered))
  const alias = { ...f.expected, manifest: f.expected.manifest.map(row => row.kind === 'link' ? { ...row, kind: 'symlink' } : row) }
  assert.doesNotThrow(() => assertCurrent(f.expected, alias))
})

test('tampered baseline is refused before the supplied signer is called', async t => {
  const f = await fixture(t); let signed = false
  f.expected.publicMetadata['downloads/release.json.sig'] = Buffer.alloc(64).toString('base64')
  assert.throws(() => composeDesktopMetadata(f.expected, f.archive, { publishedAt: '2026-10-25T21:00:00Z', notes: 'Monitor fix', origin: 'https://example.test',
    trustedKeys: f.trustedKeys, signManifest: bytes => { signed = true; return f.signer(bytes) } }), /baseline.*signature/)
  assert.equal(signed, false)
})

function landing(f) {
  return Object.fromEntries(['index.html', 'downloads/index.html'].map(path => {
    const content = `${path}: reviewed Mac106 link only`
    return [path, { baseSha256: f.expected.manifest.find(row => row.path === path).sha256,
      candidateSha256: sha(content), candidateBytes: Buffer.byteLength(content), content }]
  }))
}

test('an explicit reviewed seven-path publication preserves everything outside its pinned HTML and metadata', async t => {
  const f = await fixture(t), reviewedLanding = landing(f)
  const overlay = { ...f.overlay, ...Object.fromEntries(Object.entries(reviewedLanding).map(([path, row]) => [path, row.content])) }
  await f.activate({ overlay, reviewedLanding })
  const actual = await snapshotCurrent(f.root)
  for (const [path, row] of Object.entries(reviewedLanding)) assert.equal(await readFile(join(actual.currentResolved, path), 'utf8'), row.content)
  const paths = [...DESKTOP_PATHS, 'index.html', 'downloads/index.html']
  assert.deepEqual(actual.manifest.filter(row => !paths.includes(row.path)), f.expected.manifest.filter(row => !paths.includes(row.path)))
})

for (const change of ['stale-base', 'candidate-bytes', 'candidate-hash', 'other-path', 'unreviewed-overlay']) test(`reviewed landing refuses ${change}`, async t => {
  const f = await fixture(t), reviewedLanding = landing(f)
  const overlay = { ...f.overlay, ...Object.fromEntries(Object.entries(reviewedLanding).map(([path, row]) => [path, row.content])) }
  if (change === 'stale-base') reviewedLanding['index.html'].baseSha256 = '0'.repeat(64)
  if (change === 'candidate-bytes') reviewedLanding['index.html'].candidateBytes++
  if (change === 'candidate-hash') reviewedLanding['index.html'].candidateSha256 = '0'.repeat(64)
  if (change === 'other-path') reviewedLanding['j/index.html'] = reviewedLanding['index.html']
  if (change === 'unreviewed-overlay') overlay['index.html'] += 'unexpected copy change'
  await assert.rejects(f.activate({ overlay, reviewedLanding }))
  assert.equal(await readlink(join(f.root, 'current')), f.expected.currentTarget)
  await assert.rejects(lstat(join(f.releases, 'desktop-106')), /ENOENT/)
})
