// Desktop metadata publication only. Importing this module performs no I/O.
// The SSH/archive transport remains an explicit operator step. No site build,
// signing-key loading, archive upload, installation or service change is here.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, stat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const DESKTOP_PATHS = Object.freeze([
  'downloads/release.json', 'downloads/release.json.sig',
  'downloads/updates/darwin/arm64/RELEASES.json',
  'downloads/versions.json', 'downloads/SHA256SUMS.txt',
])
const LANDING_PATHS = Object.freeze(['index.html', 'downloads/index.html'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value)
const rows = list => [...list].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const normalManifest = manifest => {
  const seen = new Set()
  return rows(manifest.map(row => {
    if (typeof row.path !== 'string' || seen.has(row.path) || !Number.isSafeInteger(row.mode) || row.mode < 0 || row.mode > 0o7777) throw Error('Invalid protected manifest row')
    seen.add(row.path)
    const base = { path: row.path, mode: row.mode, kind: row.kind === 'symlink' ? 'link' : row.kind }
    if (base.kind === 'directory') return base
    if (base.kind === 'link' && typeof row.target === 'string') return { ...base, target: row.target }
    if (base.kind === 'file' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256)) return { ...base, bytes: row.bytes, sha256: row.sha256 }
    throw Error('Invalid protected manifest row')
  }))
}
const metadataEntries = metadata => Object.entries(metadata).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
const protectedRows = (manifest, paths = DESKTOP_PATHS) => normalManifest(manifest).filter(row => !paths.includes(row.path))
const json = value => `${JSON.stringify(value, null, 2)}\n`
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
const versionParts = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) throw Error('Invalid desktop version')
  return value.split('.').map(Number)
}
const newer = (next, previous) => {
  const a = versionParts(next), b = versionParts(previous)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
const macFile = archive => {
  versionParts(archive.version)
  if (archive.filename !== `KithMoot-${archive.version}-mac-arm64.zip` || !Number.isSafeInteger(archive.bytes) || archive.bytes <= 0 ||
      archive.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw Error('Invalid Mac archive identity')
  return { filename: archive.filename, version: archive.version, bytes: archive.bytes, sha256: archive.sha256 }
}
function verifyDesktopSignature(bytes, text, trustedKeys) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{86}==\s*$/.test(text) || !Array.isArray(trustedKeys)) return false
  const signature = Buffer.from(text.trim(), 'base64')
  const message = Buffer.concat([Buffer.from('kithmoot/v1/update-manifest\ndownloads/release.json\n'), Buffer.from(bytes)])
  return signature.length === 64 && trustedKeys.some(hex => {
    if (!/^[a-f0-9]{64}$/.test(hex)) return false
    try { return verify(null, message, createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') } }), signature) } catch { return false }
  })
}
function landingOverlay(baseline, reviewedLanding) {
  if (reviewedLanding === undefined) return {}
  if (!reviewedLanding || canonical(Object.keys(reviewedLanding).sort()) !== canonical([...LANDING_PATHS].sort())) throw Error('Only the two reviewed landing paths are allowed')
  const result = {}
  for (const path of LANDING_PATHS) {
    const row = reviewedLanding[path], original = baseline.manifest.find(item => item.path === path)
    if (!row || original?.kind !== 'file' || original.sha256 !== row.baseSha256) throw Error('Reviewed landing base is stale')
    if (typeof row.content !== 'string' || !/^[a-f0-9]{64}$/.test(row.candidateSha256) || sha(row.content) !== row.candidateSha256 ||
        Buffer.byteLength(row.content) !== row.candidateBytes) throw Error('Reviewed landing candidate differs')
    result[path] = row.content
  }
  return result
}

/** Compose from the current live metadata, preserving all old platform history.
 * signManifest is supplied explicitly; this module never reads a private key. */
export function composeDesktopMetadata(baseline, archive, { publishedAt, notes, origin, signManifest, trustedKeys, reviewedLanding }) {
  const file = macFile(archive), current = baseline.publicMetadata
  if (!verifyDesktopSignature(current['downloads/release.json'], current['downloads/release.json.sig'], trustedKeys)) throw Error('Untrusted baseline desktop manifest signature')
  const landing = landingOverlay(baseline, reviewedLanding)
  const manifest = JSON.parse(current['downloads/release.json'])
  const feed = JSON.parse(current['downloads/updates/darwin/arm64/RELEASES.json'])
  const catalogue = JSON.parse(current['downloads/versions.json'])
  if (!newer(file.version, manifest.version) || !newer(file.version, feed.currentRelease)) throw Error('Desktop version must increase')
  if (!Array.isArray(manifest.files) || !Array.isArray(feed.releases) || !Array.isArray(catalogue.desktop) || !Array.isArray(catalogue.android)) throw Error('Invalid live desktop metadata')
  if (feed.releases.some(row => row.version === file.version) || catalogue.desktop.some(row => row.version === file.version)) throw Error('Version already exists')
  const urlOrigin = new URL(origin)
  if (urlOrigin.protocol !== 'https:' || urlOrigin.username || urlOrigin.password || urlOrigin.pathname !== '/' || urlOrigin.search || urlOrigin.hash) throw Error('Invalid public origin')
  const oldOrigin = new URL(feed.releases.find(row => row.version === feed.currentRelease)?.updateTo?.url).origin
  if (urlOrigin.origin !== oldOrigin) throw Error('Public update origin must remain unchanged')
  if (typeof notes !== 'string' || !Number.isFinite(Date.parse(publishedAt)) || typeof signManifest !== 'function') throw Error('Release date, notes and signer are required')
  const path = `/apk/desktop/${file.version}/${file.filename}`, published = new Date(publishedAt).toISOString()
  const releaseBytes = json({ ...manifest, version: file.version, published: published.slice(0, 10), files: [file, ...manifest.files] })
  const signature = signManifest(Buffer.from(releaseBytes))
  if (!verifyDesktopSignature(releaseBytes, signature, trustedKeys)) throw Error('Signer returned an untrusted detached signature')
  const checksums = current['downloads/SHA256SUMS.txt']
  if (checksums.split('\n').some(line => line.trim().endsWith(file.filename))) throw Error('Archive checksum already exists')
  return {
    'downloads/release.json': releaseBytes,
    'downloads/release.json.sig': signature.trim() + '\n',
    'downloads/updates/darwin/arm64/RELEASES.json': json({ ...feed, currentRelease: file.version, releases: [
      { version: file.version, updateTo: { version: file.version, pub_date: published, notes, name: file.version,
        url: new URL(path, urlOrigin).href, sha256: file.sha256, size: file.bytes } }, ...feed.releases,
    ] }),
    'downloads/versions.json': json({ ...catalogue, desktop: [{ version: file.version, published: published.slice(0, 10), files: [
      { os: 'mac', arch: 'arm64', kind: 'app', filename: file.filename, url: path, bytes: file.bytes, sha256: file.sha256 },
    ] }, ...catalogue.desktop] }),
    'downloads/SHA256SUMS.txt': checksums + (checksums.endsWith('\n') ? '' : '\n') + `${file.sha256}  ${file.filename}\n`,
    ...landing,
  }
}

/** Reject unrelated metadata or invented cross-platform releases. */
export function validateDesktopMetadata(baseline, overlay, archive, trustedKeys, reviewedLanding) {
  const landing = landingOverlay(baseline, reviewedLanding), paths = [...DESKTOP_PATHS, ...Object.keys(landing)]
  if (canonical(Object.keys(overlay).sort()) !== canonical(paths.sort()) || Object.values(overlay).some(value => typeof value !== 'string')) throw Error('Only explicit desktop publication paths are allowed')
  for (const [path, content] of Object.entries(landing)) if (overlay[path] !== content) throw Error('Reviewed landing overlay differs')
  const file = macFile(archive), current = baseline.publicMetadata
  if (!verifyDesktopSignature(current['downloads/release.json'], current['downloads/release.json.sig'], trustedKeys)) throw Error('Untrusted baseline desktop manifest signature')
  if (!verifyDesktopSignature(overlay['downloads/release.json'], overlay['downloads/release.json.sig'], trustedKeys)) throw Error('Untrusted desktop manifest signature')
  const nextManifest = JSON.parse(overlay['downloads/release.json']), oldManifest = JSON.parse(current['downloads/release.json'])
  const nextFeed = JSON.parse(overlay['downloads/updates/darwin/arm64/RELEASES.json']), oldFeed = JSON.parse(current['downloads/updates/darwin/arm64/RELEASES.json'])
  const nextCatalogue = JSON.parse(overlay['downloads/versions.json']), oldCatalogue = JSON.parse(current['downloads/versions.json'])
  if (!newer(file.version, oldManifest.version) || !newer(file.version, oldFeed.currentRelease) || nextManifest.version !== file.version || nextFeed.currentRelease !== file.version ||
      canonical(nextManifest.files) !== canonical([file, ...oldManifest.files]) || canonical(nextFeed.releases.slice(1)) !== canonical(oldFeed.releases) ||
      canonical(nextCatalogue.desktop.slice(1)) !== canonical(oldCatalogue.desktop) || canonical(nextCatalogue.android) !== canonical(oldCatalogue.android) ||
      canonical(omit(nextManifest, ['version', 'published', 'files'])) !== canonical(omit(oldManifest, ['version', 'published', 'files'])) ||
      canonical(omit(nextFeed, ['currentRelease', 'releases'])) !== canonical(omit(oldFeed, ['currentRelease', 'releases'])) ||
      canonical(omit(nextCatalogue, ['desktop'])) !== canonical(omit(oldCatalogue, ['desktop']))) throw Error('Existing platform history changed')
  const entry = nextFeed.releases[0], listed = nextCatalogue.desktop[0]
  const oldOrigin = new URL(oldFeed.releases.find(row => row.version === oldFeed.currentRelease)?.updateTo?.url).origin
  if (entry.version !== file.version || entry.updateTo.version !== file.version || entry.updateTo.sha256 !== file.sha256 || entry.updateTo.size !== file.bytes ||
      oldOrigin.startsWith('https:') !== true || entry.updateTo.url !== `${oldOrigin}/apk/desktop/${file.version}/${file.filename}` || listed.version !== file.version || listed.files.length !== 1 ||
      canonical(listed.files[0]) !== canonical({ os: 'mac', arch: 'arm64', kind: 'app', filename: file.filename,
        url: `/apk/desktop/${file.version}/${file.filename}`, bytes: file.bytes, sha256: file.sha256 })) throw Error('Mac archive/feed/catalogue mismatch')
  const oldSums = current['downloads/SHA256SUMS.txt'], expectedSums = oldSums + (oldSums.endsWith('\n') ? '' : '\n') + `${file.sha256}  ${file.filename}\n`
  if (overlay['downloads/SHA256SUMS.txt'] !== expectedSums) throw Error('Existing checksums changed')
  return true
}

async function digestFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
export async function treeManifest(root) {
  const result = []
  async function visit(relative = '') {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name, absolute = join(root, path), stat = await lstat(absolute)
      const row = { path, mode: stat.mode & 0o7777 }
      if (stat.isDirectory()) { result.push({ ...row, kind: 'directory' }); await visit(path) }
      else if (stat.isSymbolicLink()) result.push({ ...row, kind: 'link', target: await readlink(absolute) })
      else if (stat.isFile()) result.push({ ...row, kind: 'file', bytes: stat.size, sha256: await digestFile(absolute) })
      else throw Error(`Unsupported protected path: ${path}`)
    }
  }
  await visit(); return rows(result)
}

export async function snapshotCurrent(root) {
  root = resolve(root)
  const releasesResolved = await realpath(join(root, 'releases')), currentTarget = await readlink(join(root, 'current'))
  const currentResolved = await realpath(join(root, 'current'))
  if (dirname(currentResolved) !== releasesResolved) throw Error('Current release is outside resolved releases directory')
  const manifest = await treeManifest(currentResolved), publicMetadata = {}
  for (const path of DESKTOP_PATHS) {
    if (manifest.find(row => row.path === path)?.kind !== 'file') throw Error('Desktop metadata must be ordinary files')
    publicMetadata[path] = await readFile(join(currentResolved, path), 'utf8')
  }
  return { root, releasesResolved, currentTarget, currentResolved, manifest, publicMetadata }
}

export function assertCurrent(expected, actual) {
  for (const key of ['root', 'releasesResolved', 'currentTarget', 'currentResolved']) if (expected[key] !== actual[key]) throw Error(`Publication CAS changed: ${key}`)
  if (canonical(normalManifest(expected.manifest)) !== canonical(normalManifest(actual.manifest)) || canonical(metadataEntries(expected.publicMetadata)) !== canonical(metadataEntries(actual.publicMetadata))) throw Error('Publication CAS changed: live bytes/modes/links')
}

/** Only call after explicit publication authority. Tests use temporary roots.
 * The directory lock serialises cooperating publishers; no lock is stolen.
 * An unrelated legacy writer can still race after activation, so operators
 * inspect observable writers and independently read back public state. */
export async function activateDesktopMetadata({ root, expected, overlay, archive, trustedKeys, releaseName, reviewedLanding }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(releaseName ?? '')) throw Error('Invalid release name')
  root = resolve(root)
  if (root !== expected.root) throw Error('Publication root differs')
  const lock = join(root, '.desktop-publication.lock')
  await mkdir(lock, { mode: 0o700 })
  let stage, link, stageCreated = false, activated = false
  try {
    assertCurrent(expected, await snapshotCurrent(root))
    validateDesktopMetadata(expected, overlay, archive, trustedKeys, reviewedLanding)
    const paths = [...DESKTOP_PATHS, ...Object.keys(landingOverlay(expected, reviewedLanding))]
    const archivePath = join(root, 'apk/desktop', archive.version, archive.filename), archiveStat = await lstat(archivePath)
    if (!archiveStat.isFile() || archiveStat.size !== archive.bytes || await digestFile(archivePath) !== archive.sha256) throw Error('Immutable archive is absent or differs')
    if (!(archiveStat.mode & 0o004)) throw Error('Archive is not publicly readable')
    for (let parent = dirname(archivePath); ; parent = dirname(parent)) {
      const directory = await stat(parent)
      if (!directory.isDirectory() || !(directory.mode & 0o001)) throw Error('Archive directory is not publicly traversable')
      if (parent === root) break
    }
    stage = join(expected.releasesResolved, releaseName)
    await mkdir(stage, { mode: 0o755 })
    stageCreated = true
    await cp(expected.currentResolved, stage, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, force: false })
    for (const path of paths) {
      for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) if (!(await lstat(join(stage, parent))).isDirectory()) throw Error('Metadata parent is not a directory')
      const dest = join(stage, path)
      if (!(await lstat(dest)).isFile()) throw Error('Metadata destination is not an ordinary file')
      await writeFile(dest, overlay[path])
    }
    const stagedManifest = await treeManifest(stage)
    if (canonical(protectedRows(stagedManifest, paths)) !== canonical(protectedRows(expected.manifest, paths))) throw Error('Protected release paths changed')
    const stagedMetadata = {}
    for (const path of paths) {
      stagedMetadata[path] = await readFile(join(stage, path), 'utf8')
      if (stagedMetadata[path] !== overlay[path]) throw Error('Staged desktop metadata differs')
    }
    validateDesktopMetadata(expected, stagedMetadata, archive, trustedKeys, reviewedLanding)
    assertCurrent(expected, await snapshotCurrent(root))
    link = join(root, `.current-desktop-${randomUUID()}.tmp`)
    await symlink(stage, link)
    // Fresh full-tree CAS under the same lock; rename is the single activation.
    await rename(link, join(root, 'current')); link = null; activated = true
    return { previous: expected.currentTarget, current: stage, version: archive.version, archiveMode: archiveStat.mode & 0o7777,
      protectedRows: protectedRows(stagedManifest, paths).length, manifest: stagedManifest }
  } finally {
    if (link) await rm(link, { force: true })
    if (stageCreated && !activated) await rm(stage, { recursive: true, force: true })
    await rmdir(lock)
  }
}
