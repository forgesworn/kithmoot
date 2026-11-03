import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync, unlinkSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageRelease, activateRelease } from './installation.js'
import { fileDigest, REQUIRED_RELEASE_FILES, type NodeRelease } from './release.js'
import { NODE_VERSION } from './version.js'
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kithmoot-install-stage-')); paths.push(root)
  const source = join(root, 'source'); mkdirSync(source)
  const release: NodeRelease = { v: 1, name: 'kithmoot-node', version: NODE_VERSION, platform: 'linux-arm64', distribution: 'private-candidate',
    dependencies: [{ name: 'node', revision: 'test', visibility: 'public', provenance: 'test' }, { name: 'spry', revision: 'test', visibility: 'public', provenance: 'test' },
      { name: 'shelter', revision: 'test', visibility: 'private', provenance: 'test' }], files: [] }
  for (const path of REQUIRED_RELEASE_FILES) {
    const file = join(source, path); mkdirSync(dirname(file), { recursive: true })
    const executable = path === 'kithmoot-node' || path.startsWith('bin/') || path === 'runtime/bin/node'
    writeFileSync(file, `public fixture ${path}`, { mode: executable ? 0o755 : 0o644 })
    release.files.push({ path, ...fileDigest(file), executable })
  }
  const save = () => writeFileSync(join(source, 'release.json'), JSON.stringify(release)); save()
  return { root, source, release, save, installation: join(root, 'installation') }
}
it('stages checked bytes independently of umask, reuses an intact release and switches only a managed current link', () => {
  const f = fixture(), prior = process.umask(0o077)
  try {
    const first = stageRelease(f.source, join(f.installation, 'releases'))
    expect(lstatSync(first.directory).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(first.directory, 'runtime')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(first.directory, 'runtime/bin/node')).mode & 0o777).toBe(0o755)
    expect(stageRelease(f.source, join(f.installation, 'releases')).directory).toBe(first.directory)
    expect(activateRelease(f.installation, first.directory)).toBeUndefined()
    expect(readlinkSync(join(f.installation, 'current'))).toBe(first.directory)
    writeFileSync(join(f.source, 'lib/kithmoot-node.mjs'), 'new public fixture')
    Object.assign(f.release.files.find(file => file.path === 'lib/kithmoot-node.mjs')!, fileDigest(join(f.source, 'lib/kithmoot-node.mjs'))); f.save()
    const next = stageRelease(f.source, join(f.installation, 'releases'))
    expect(next.directory).not.toBe(first.directory)
    expect(activateRelease(f.installation, next.directory)).toBe(first.directory)
    expect(activateRelease(f.installation, first.directory, first.release)).toBe(next.directory)
    expect(readFileSync(join(first.directory, 'lib/kithmoot-node.mjs'), 'utf8')).not.toBe('new public fixture')
  } finally { process.umask(prior) }
})
it('preserves unrelated files, outside targets and dangling links instead of treating them as a missing installation', () => {
  const f = fixture(), release = stageRelease(f.source, join(f.installation, 'releases')), current = join(f.installation, 'current')
  writeFileSync(current, 'unrelated operator data')
  expect(() => activateRelease(f.installation, release.directory)).toThrow('managed symlink')
  expect(readFileSync(current, 'utf8')).toBe('unrelated operator data'); unlinkSync(current)
  symlinkSync(f.source, current); expect(() => activateRelease(f.installation, release.directory)).toThrow('another installation')
  expect(readlinkSync(current)).toBe(f.source); unlinkSync(current)
  symlinkSync(join(f.root, 'not-present'), current); expect(() => activateRelease(f.installation, release.directory)).toThrow()
  expect(readlinkSync(current)).toBe(join(f.root, 'not-present'))
  expect(() => activateRelease(f.installation, f.source)).toThrow('outside')
})
it('refuses an existing incomplete stage target and leaves an installed release unchanged when source bytes are tampered', () => {
  const f = fixture(), first = stageRelease(f.source, join(f.installation, 'releases'))
  activateRelease(f.installation, first.directory)
  unlinkSync(join(first.directory, 'bin/bothyd'))
  expect(() => stageRelease(f.source, join(f.installation, 'releases'))).toThrow()
  expect(readlinkSync(join(f.installation, 'current'))).toBe(first.directory)
  writeFileSync(join(f.source, 'bin/spry-node'), 'tampered')
  expect(() => stageRelease(f.source, join(f.installation, 'releases'))).toThrow('integrity')
  expect(readlinkSync(join(f.installation, 'current'))).toBe(first.directory)
})
