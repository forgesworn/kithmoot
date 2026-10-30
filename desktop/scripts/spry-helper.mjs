// Fetches the built-in call relay's helper (`spry-node`) from the pinned
// spry-turn release, checks the archive and the binary against
// scripts/spry-release.json, and stages it for the packagers at
// artifacts/spry/<platform>-<arch>/spry/. No runtime download: the app ships
// the helper it was built with (docs/design/2026-10-28-built-in-relay.md, 1.2).
//
//   node scripts/spry-helper.mjs [darwin-arm64 linux-x64 linux-arm64 win32-x64]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPRY_MANIFEST } from '../spry-bundle.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const HEX64 = /^[0-9a-f]{64}$/

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** The pinned release, checked for shape so a bad edit fails the build. */
export async function readPin(path = resolve(root, 'scripts/spry-release.json')) {
  const pin = JSON.parse(await readFile(path, 'utf8'))
  if (typeof pin.version !== 'string' || typeof pin.release !== 'string' || !pin.release.startsWith('https://github.com/forgesworn/spry-turn/releases/download/')
    || !pin.helpers || typeof pin.helpers !== 'object') throw new Error('spry-release.json is not valid')
  for (const [key, helper] of Object.entries(pin.helpers)) {
    if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(key) || typeof helper.archive !== 'string' || !/^[\w.-]+\.(tar\.gz|zip)$/.test(helper.archive)
      || typeof helper.binary !== 'string' || !/^[\w.-]+\/bin\/spry-node(\.exe)?$/.test(helper.binary)
      || !HEX64.test(helper.archiveSha256) || !HEX64.test(helper.binarySha256)) throw new Error(`spry-release.json: bad entry ${key}`)
  }
  return pin
}

/** The archive for `key`, downloaded once into artifacts/spry/downloads and checked every time. */
async function archiveFor(pin, key, { artifacts, fetchArchive }) {
  const helper = pin.helpers[key]
  if (!helper) throw new Error(`No pinned spry-turn helper for ${key}`)
  const path = join(artifacts, 'downloads', helper.archive)
  let bytes = await readFile(path).catch(() => undefined)
  if (!bytes || sha256(bytes) !== helper.archiveSha256) {
    bytes = await fetchArchive(pin.release + helper.archive)
    if (sha256(bytes) !== helper.archiveSha256) throw new Error(`${helper.archive} does not match its pinned SHA-256; not using it`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  return { path, helper }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Stage the pinned helper for `key` (for example `darwin-arm64`). Extracts
 * only the one binary, freshly every time, so a helper signed by an earlier
 * run is never reused. Returns the staged directory (copied to
 * `resources/spry`), the binary's path and its SHA-256 as staged.
 */
export async function stageHelper(key, { pin, artifacts = resolve(root, 'artifacts/spry'), fetchArchive = download } = {}) {
  pin ??= await readPin()
  const { path: archive, helper } = await archiveFor(pin, key, { artifacts, fetchArchive })
  const scratch = await mkdtemp(join(tmpdir(), 'kithmoot-spry-'))
  try {
    const extracted = helper.archive.endsWith('.zip')
      ? spawnSync('unzip', ['-q', '-o', archive, helper.binary, '-d', scratch], { stdio: 'inherit' })
      : spawnSync('tar', ['-xzf', archive, '-C', scratch, helper.binary], { stdio: 'inherit' })
    if (extracted.status !== 0) throw new Error(`Could not extract ${helper.binary} from ${helper.archive}`)
    const bytes = await readFile(join(scratch, helper.binary))
    if (sha256(bytes) !== helper.binarySha256) throw new Error(`${helper.binary} does not match its pinned SHA-256; not using it`)
    const dir = join(artifacts, key, 'spry')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const file = join(dir, key.startsWith('win32-') ? 'spry-node.exe' : 'spry-node')
    await copyFile(join(scratch, helper.binary), file)
    await chmod(file, 0o755)
    return { dir, file, sha256: helper.binarySha256, version: pin.version }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Write the manifest the app reads before starting its helper (spry-bundle.mjs). */
export async function writeManifest(helpers, { version, appRoot = root } = {}) {
  for (const [key, hash] of Object.entries(helpers)) {
    if (!HEX64.test(hash)) throw new Error(`Bad helper hash for ${key}`)
  }
  const path = resolve(appRoot, SPRY_MANIFEST)
  await writeFile(path, `${JSON.stringify({ version, helpers }, null, 2)}\n`)
  return path
}

/** Hash a staged or packaged helper as it is now (after signing, on macOS). */
export async function hashFile(path) {
  return sha256(await readFile(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pin = await readPin()
  for (const key of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(pin.helpers)) {
    const staged = await stageHelper(key, { pin })
    console.log(`${staged.sha256}  ${key} spry-node ${staged.version}`)
  }
}
