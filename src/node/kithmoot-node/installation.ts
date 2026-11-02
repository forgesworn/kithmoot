import { constants, mkdirSync, chmodSync, fchmodSync, fstatSync, lstatSync, openSync, closeSync, readSync, writeSync, fsyncSync, renameSync, rmSync, symlinkSync, readlinkSync, realpathSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifyRelease, type NodeRelease } from './release.js'

function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) } }
export function protectedDirectory(path: string, mode = 0o755): void {
  try { lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    protectedDirectory(dirname(path))
    mkdirSync(path, { mode }); chmodSync(path, mode)
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.mode & 0o022 || process.getuid && info.uid !== process.getuid()) throw Error('Installation directories must be protected and owned by the installing user')
}
function copyRegular(source: string, destination: string, mode: number): void {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output: number | undefined
  try {
    const info = fstatSync(input)
    if (!info.isFile() || info.mode & 0o022) throw Error('Release source changed')
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    const buffer = Buffer.alloc(65536); let length: number, total = 0
    while ((length = readSync(input, buffer, 0, buffer.length, null)) > 0) {
      total += length; if (total > 536870912) throw Error('Release source grew during copy')
      let written = 0
      while (written < length) written += writeSync(output, buffer, written, length - written)
    }
    fchmodSync(output, mode); fsyncSync(output)
  } finally { closeSync(input); if (output !== undefined) closeSync(output) }
}
function installedRelease(directory: string, expected?: NodeRelease) {
  const root = lstatSync(directory)
  if (!root.isDirectory()) throw Error('Installed release path is not a protected directory')
  const checked = verifyRelease(directory, expected)
  const directories = new Set([directory])
  for (const file of [...checked.release.files, { path: 'release.json', executable: false }]) {
    const path = join(directory, file.path), info = lstatSync(path)
    if (process.getuid && info.uid !== process.getuid() || (info.mode & 0o444) !== 0o444
      || file.executable && (info.mode & 0o111) !== 0o111) throw Error('Installed release files must be owned by the installer and readable by its services')
    let parent = dirname(path)
    while (parent !== directory) { directories.add(parent); parent = dirname(parent) }
  }
  for (const path of directories) {
    const info = lstatSync(path)
    if (!info.isDirectory() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o555) !== 0o555) throw Error('Installed release directories must be owned by the installer and accessible to its services')
  }
  return checked
}
/** Copy into a new protected stage and recheck bytes against the original
 * manifest. A failed copy removes only this invocation's new stage. */
export function stageRelease(source: string, releases: string): { directory: string; release: NodeRelease; digest: string } {
  const checked = verifyRelease(source)
  protectedDirectory(releases)
  const base = realpathSync(releases)
  const directory = join(base, `${checked.release.version}-${checked.digest.slice(0, 16)}`)
  let exists = false
  try { lstatSync(directory); exists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (exists) {
    const existing = installedRelease(directory, checked.release)
    if (existing.digest !== checked.digest) throw Error('Installed release manifest differs')
    return { directory, release: checked.release, digest: checked.digest }
  }
  const scratch = join(base, `.stage-${randomBytes(12).toString('hex')}`)
  mkdirSync(scratch, { mode: 0o700 })
  try {
    for (const file of checked.release.files) {
      const destination = join(scratch, file.path)
      protectedDirectory(dirname(destination))
      copyRegular(join(checked.root, file.path), destination, file.executable ? 0o755 : 0o644)
    }
    copyRegular(join(checked.root, 'release.json'), join(scratch, 'release.json'), 0o644)
    if (verifyRelease(scratch, checked.release).digest !== checked.digest) throw Error('Release manifest changed during copy')
    chmodSync(scratch, 0o755); installedRelease(scratch, checked.release); syncDirectory(scratch)
    renameSync(scratch, directory); syncDirectory(base)
    return { directory, release: checked.release, digest: checked.digest }
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error }
}
/** Switch only the installation's managed symlink. Ordinary files and links
 * outside its releases directory belong to somebody else and are preserved. */
export function activateRelease(installation: string, directory: string, expected?: NodeRelease): string | undefined {
  protectedDirectory(installation)
  const releases = join(installation, 'releases'); protectedDirectory(releases)
  const target = realpathSync(directory), child = relative(realpathSync(releases), target)
  if (isAbsolute(child) || child.startsWith('.') || child.includes('/') || child.includes('\\') || !child) throw Error('Release target is outside this installation')
  installedRelease(target, expected)
  const current = join(installation, 'current')
  let previous: string | undefined
  let currentExists = false
  try { lstatSync(current); currentExists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (currentExists) {
    if (!lstatSync(current).isSymbolicLink()) throw Error('Current installation path is not a managed symlink')
    const value = readlinkSync(current)
    previous = realpathSync(isAbsolute(value) ? value : join(installation, value))
    const old = relative(realpathSync(releases), previous)
    if (isAbsolute(old) || old.startsWith('.') || old.includes('/') || old.includes('\\') || !old) throw Error('Existing current link belongs to another installation')
  }
  const next = join(installation, `.current-${randomBytes(12).toString('hex')}`)
  symlinkSync(target, next)
  try { renameSync(next, current); syncDirectory(installation) }
  catch (error) { rmSync(next, { force: true }); throw error }
  return previous
}
