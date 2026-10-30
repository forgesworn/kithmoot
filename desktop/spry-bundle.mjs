import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The built-in call relay's helper (`spry-node`) as the packagers place it:
 * `resources/spry/` beside the app archive, outside the asar
 * (docs/design/2026-10-28-built-in-relay.md, 1.2). The packager writes
 * `spry-manifest.json` into the app with the helper's SHA-256 for each
 * platform it built, so a helper replaced in a user-writable install is
 * refused rather than run. Nothing starts the helper yet; the supervisor
 * that will (K4) asks this module for its path first.
 */
export const SPRY_MANIFEST = 'spry-manifest.json'

const HEX64 = /^[0-9a-f]{64}$/

/** Where the helper sits under the app's resources directory. */
export function bundledHelperPath(resourcesPath, platform = process.platform) {
  if (typeof resourcesPath !== 'string' || !resourcesPath) throw new Error('No resources directory')
  return join(resourcesPath, 'spry', platform === 'win32' ? 'spry-node.exe' : 'spry-node')
}

/** The manifest's key for a platform and architecture, as the packagers write it. */
export function helperKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/**
 * The SHA-256 this app expects of its helper on `platform`/`arch`. Throws for
 * a manifest of the wrong shape or one without this platform, so a build that
 * did not bundle a helper never starts one.
 */
export function expectedHelperHash(manifest, platform = process.platform, arch = process.arch) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || typeof manifest.version !== 'string' || !manifest.helpers || typeof manifest.helpers !== 'object'
    || Array.isArray(manifest.helpers)) {
    throw new Error('The built-in relay manifest is not valid')
  }
  const key = helperKey(platform, arch)
  const hash = Object.hasOwn(manifest.helpers, key) ? manifest.helpers[key] : undefined
  if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error('This build has no built-in relay for this computer')
  return hash
}

/**
 * The helper's path, once its bytes match the manifest. A supervisor should
 * start it straight after, from the path returned; the check guards against a
 * replaced file in the install, not against a process racing to swap it.
 */
export async function verifiedHelper({ resourcesPath, manifest, platform = process.platform, arch = process.arch, read = readFile }) {
  const expected = expectedHelperHash(manifest, platform, arch)
  const path = bundledHelperPath(resourcesPath, platform)
  let bytes
  try { bytes = await read(path) } catch { throw new Error('The built-in relay is missing from this install') }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error('The built-in relay does not match this app, so it was not started')
  return path
}
