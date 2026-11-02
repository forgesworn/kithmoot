import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { NODE_VERSION } from './version.js'
import { REQUIRED_RELEASE_FILES, fileDigest, verifyRelease, type NodeRelease } from './release.js'
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kithmoot-release-')); paths.push(root)
  const release: NodeRelease = { v: 1, name: 'kithmoot-node', version: NODE_VERSION, platform: 'linux-arm64', distribution: 'private-candidate',
    dependencies: [ { name: 'node', revision: '24-test', visibility: 'public', provenance: 'test-official-checksum' },
      { name: 'spry', revision: 'test-revision', visibility: 'public', provenance: 'test-source-build' },
      { name: 'shelter', revision: 'test-private-revision', visibility: 'private', provenance: 'test-private-source-build' } ], files: [] }
  for (const path of REQUIRED_RELEASE_FILES) {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true })
    const executable = path === 'kithmoot-node' || path.startsWith('bin/') || path === 'runtime/bin/node'
    writeFileSync(file, `public test fixture: ${path}\n`, { mode: executable ? 0o755 : 0o644 })
    release.files.push({ path, ...fileDigest(file), executable })
  }
  const save = () => writeFileSync(join(root, 'release.json'), JSON.stringify(release), { mode: 0o644 }); save()
  return { root, release, save }
}
it('checks every bundled byte and executable flag before a copied release can activate', () => {
  const { root, release } = fixture()
  expect(verifyRelease(root).release).toEqual(release)
  const expected = structuredClone(release)
  writeFileSync(join(root, 'bin/bothyd'), 'substituted binary')
  expect(() => verifyRelease(root, expected)).toThrow('integrity')
})
it('rejects private dependencies labelled as a public release and keeps provenance decisions explicit', () => {
  const { root, release, save } = fixture()
  release.distribution = 'public-release'; save(); expect(() => verifyRelease(root)).toThrow('manifest')
  release.distribution = 'private-candidate'; release.dependencies[2].provenance = ''; save(); expect(() => verifyRelease(root)).toThrow('manifest')
})
it('refuses unexpected data, traversal, symlinks and writable release contents', () => {
  const { root, release, save } = fixture()
  writeFileSync(join(root, 'unexpected-state'), 'must never ship room state'); expect(() => verifyRelease(root)).toThrow('unexpected')
  unlinkSync(join(root, 'unexpected-state'))
  const last = release.files.at(-1)!.path; release.files.at(-1)!.path = '../outside'; save(); expect(() => verifyRelease(root)).toThrow('file')
  release.files.at(-1)!.path = last; save()
  unlinkSync(join(root, 'bin/bothyd')); symlinkSync(join(root, 'bin/spry-node'), join(root, 'bin/bothyd'))
  expect(() => verifyRelease(root)).toThrow('links')
  unlinkSync(join(root, 'bin/bothyd')); writeFileSync(join(root, 'bin/bothyd'), 'writable', { mode: 0o777 }); chmodSync(join(root, 'bin/bothyd'), 0o777)
  expect(() => verifyRelease(root)).toThrow('writable')
  chmodSync(root, 0o777); expect(() => verifyRelease(root)).toThrow('directory')
})
it('detects manifest replacement after verification even when the substituted files match it', () => {
  const { root, release, save } = fixture()
  const checked = verifyRelease(root)
  writeFileSync(join(root, 'lib/kithmoot-node.mjs'), 'substituted code')
  const file = release.files.find(file => file.path === 'lib/kithmoot-node.mjs')!; Object.assign(file, fileDigest(join(root, file.path))); save()
  expect(() => verifyRelease(root, checked.release)).toThrow('manifest changed')
})
