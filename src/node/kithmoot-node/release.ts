import { constants, openSync, fstatSync, closeSync, readSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { NODE_VERSION } from './version.js'

export interface ReleaseFile { path: string; bytes: number; sha256: string; executable: boolean }
export interface NodeRelease {
  v: 1; name: 'kithmoot-node'; version: string; platform: 'linux-arm64' | 'linux-x64'
  distribution: 'private-candidate' | 'public-release'
  dependencies: { name: 'node' | 'spry' | 'shelter'; revision: string; visibility: 'private' | 'public'; provenance: string }[]
  files: ReleaseFile[]
}
export const REQUIRED_RELEASE_FILES = ['kithmoot-node', 'runtime/bin/node', 'lib/kithmoot-node.mjs', 'bin/spry-node', 'bin/bothyd',
  'deploy/kithmoot-node.service', 'deploy/kithmoot-node-front.service', 'licenses/NOTICE.txt', 'licenses/Node-LICENSE.txt', 'licenses/Spry-LICENSE.txt', 'licenses/Shelter-LICENSE.txt'] as const
const allowedPath = (path: string): boolean => path === 'kithmoot-node' || /^(?:runtime\/bin|lib|bin|deploy|licenses|provenance)\/[A-Za-z0-9_.-]+$/.test(path)
export function fileDigest(path: string): { bytes: number; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const file = fstatSync(fd)
    if (!file.isFile() || file.mode & 0o022 || file.size > 536870912) throw Error('Release files must be bounded protected regular files')
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let bytes = 0, size: number
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) { bytes += size; if (bytes > 536870912) throw Error('Release file grew while being checked'); hash.update(buffer.subarray(0, size)) }
    if (bytes !== file.size) throw Error('Release file changed while being checked')
    return { bytes, sha256: hash.digest('hex') }
  } finally { closeSync(fd) }
}
/** Integrity of an already provenance-verified release, not proof of who
 * published it. Verify the archive's external signature/attestation before
 * executing its launcher. The copied root-owned stage is checked again
 * against this parsed manifest before any service or symlink changes. */
export function verifyRelease(directory: string, expected?: NodeRelease): { root: string; release: NodeRelease; digest: string } {
  const root = realpathSync(directory), manifestPath = join(root, 'release.json')
  if (lstatSync(root).mode & 0o022) throw Error('Release directory must not be writable by other users')
  const fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const file = fstatSync(fd)
    if (!file.isFile() || file.mode & 0o022 || file.size > 131072) throw Error('Release manifest must be a bounded protected regular file')
    bytes = readFileSync(fd); if (bytes.length !== file.size) throw Error('Release manifest changed')
  } finally { closeSync(fd) }
  const manifest = { sha256: createHash('sha256').update(bytes).digest('hex') }
  const parsed = JSON.parse(bytes.toString('utf8')) as NodeRelease
  const release = expected ?? parsed
  if (expected && JSON.stringify(parsed) !== JSON.stringify(expected)) throw Error('Staged release manifest changed')
  if (!release || Object.keys(release).some(key => !['v', 'name', 'version', 'platform', 'distribution', 'dependencies', 'files'].includes(key)) || release.v !== 1 || release.name !== 'kithmoot-node' || release.version !== (expected?.version ?? NODE_VERSION) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(release.version)
    || !['linux-arm64', 'linux-x64'].includes(release.platform) || !['private-candidate', 'public-release'].includes(release.distribution)
    || !Array.isArray(release.dependencies) || release.dependencies.length !== 3 || new Set(release.dependencies.map(value => value.name)).size !== 3
    || release.dependencies.some(value => !value || Object.keys(value).some(key => !['name', 'revision', 'visibility', 'provenance'].includes(key)) || !['node', 'spry', 'shelter'].includes(value.name) || !['private', 'public'].includes(value.visibility)
      || typeof value.revision !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.revision) || typeof value.provenance !== 'string' || value.provenance.length < 1 || value.provenance.length > 1024)
    || release.distribution === 'public-release' && release.dependencies.some(value => value.visibility !== 'public')
    || !Array.isArray(release.files) || release.files.length < REQUIRED_RELEASE_FILES.length || release.files.length > 128) throw Error('Invalid node release manifest')
  const entries = new Map<string, ReleaseFile>(); let total = 0
  for (const file of release.files) {
    if (!file || Object.keys(file).some(key => !['path', 'bytes', 'sha256', 'executable'].includes(key)) || typeof file.path !== 'string' || !allowedPath(file.path) || posix.normalize(file.path) !== file.path || entries.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 536870912 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean') throw Error('Invalid node release file')
    entries.set(file.path, file); total += file.bytes
  }
  if (total > 1073741824 || REQUIRED_RELEASE_FILES.some(path => !entries.has(path))) throw Error('Incomplete or oversized node release')
  const actual = new Set<string>()
  const walk = (relative: string): void => {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name
      if (path === 'release.json') continue
      const info = lstatSync(join(root, path))
      if (info.mode & 0o022 || item.isSymbolicLink()) throw Error('Release tree contains writable paths or links')
      if (item.isDirectory()) { if (![...entries.keys()].some(file => file.startsWith(path + '/')) || path.split('/').length > 3) throw Error('Release tree is too deep'); walk(path) }
      else if (item.isFile()) actual.add(path)
      else throw Error('Release tree contains special files')
    }
  }
  walk('')
  if (actual.size !== entries.size || [...actual].some(path => !entries.has(path))) throw Error('Release contains unexpected files')
  for (const [path, file] of entries) {
    const value = fileDigest(join(root, path)), info = lstatSync(join(root, path))
    if (value.bytes !== file.bytes || value.sha256 !== file.sha256 || !!(info.mode & 0o111) !== file.executable) throw Error('Node release integrity check failed')
  }
  return { root, release: structuredClone(release), digest: manifest.sha256 }
}
