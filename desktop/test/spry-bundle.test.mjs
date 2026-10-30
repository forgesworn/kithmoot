import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledHelperPath, expectedHelperHash, helperKey, verifiedHelper } from '../spry-bundle.mjs'
import { readPin, stageHelper, writeManifest } from '../scripts/spry-helper.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const scratch = () => mkdtemp(join(tmpdir(), 'kithmoot-spry-test-'))

test('the helper sits in resources/spry, with .exe only on Windows', () => {
  assert.equal(bundledHelperPath('/app/Resources', 'darwin'), join('/app/Resources', 'spry', 'spry-node'))
  assert.equal(bundledHelperPath('/opt/KithMoot/resources', 'linux'), join('/opt/KithMoot/resources', 'spry', 'spry-node'))
  assert.equal(bundledHelperPath('C:\\KithMoot\\resources', 'win32').endsWith('spry-node.exe'), true)
  assert.throws(() => bundledHelperPath(''), /No resources directory/)
  assert.equal(helperKey('linux', 'arm64'), 'linux-arm64')
})

test('a manifest without this platform, or of the wrong shape, starts nothing', () => {
  const hash = 'a'.repeat(64)
  assert.equal(expectedHelperHash({ version: '0.4.0', helpers: { 'darwin-arm64': hash } }, 'darwin', 'arm64'), hash)
  for (const manifest of [undefined, null, [], {}, { version: '0.4.0' }, { version: 1, helpers: {} }, { version: '0.4.0', helpers: [] }]) {
    assert.throws(() => expectedHelperHash(manifest, 'darwin', 'arm64'), /manifest is not valid/)
  }
  assert.throws(() => expectedHelperHash({ version: '0.4.0', helpers: { 'linux-x64': hash } }, 'darwin', 'arm64'), /no built-in relay for this computer/)
  assert.throws(() => expectedHelperHash({ version: '0.4.0', helpers: { 'darwin-arm64': 'A'.repeat(64) } }, 'darwin', 'arm64'), /no built-in relay/)
  assert.throws(() => expectedHelperHash({ version: '0.4.0', helpers: Object.create({ 'darwin-arm64': hash }) }, 'darwin', 'arm64'), /no built-in relay/)
})

test('the helper is handed out only while its bytes match the manifest', async () => {
  const dir = await scratch()
  try {
    await mkdir(join(dir, 'spry'))
    const helper = join(dir, 'spry', 'spry-node')
    await writeFile(helper, 'reviewed helper')
    const manifest = { version: '0.4.0', helpers: { 'linux-x64': sha('reviewed helper') } }
    assert.equal(await verifiedHelper({ resourcesPath: dir, manifest, platform: 'linux', arch: 'x64' }), helper)
    await writeFile(helper, 'replaced helper')
    await assert.rejects(verifiedHelper({ resourcesPath: dir, manifest, platform: 'linux', arch: 'x64' }), /does not match this app/)
    await rm(helper)
    await assert.rejects(verifiedHelper({ resourcesPath: dir, manifest, platform: 'linux', arch: 'x64' }), /missing from this install/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/** A release archive shaped like spry-turn's: <name>/bin/spry-node plus a decoy. */
async function fixtureRelease(dir, binary = 'spry-node bytes') {
  const name = 'spry-turn-v0.4.0-x86_64-unknown-linux-gnu'
  await mkdir(join(dir, 'src', name, 'bin'), { recursive: true })
  await writeFile(join(dir, 'src', name, 'bin', 'spry-node'), binary)
  await writeFile(join(dir, 'src', name, 'bin', 'spry-turn'), 'not wanted')
  const archive = join(dir, `${name}.tar.gz`)
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(dir, 'src'), name], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0)
  const bytes = await readFile(archive)
  const pin = { version: '0.4.0', release: 'https://github.com/forgesworn/spry-turn/releases/download/v0.4.0/',
    helpers: { 'linux-x64': { archive: `${name}.tar.gz`, archiveSha256: sha(bytes), binary: `${name}/bin/spry-node`, binarySha256: sha(binary) } } }
  return { bytes, pin }
}

test('staging fetches the pinned archive once, checks both hashes and extracts only spry-node', async () => {
  const dir = await scratch()
  try {
    const { bytes, pin } = await fixtureRelease(dir)
    const fetched = []
    const fetchArchive = async url => { fetched.push(url); return bytes }
    const artifacts = join(dir, 'artifacts')
    const staged = await stageHelper('linux-x64', { pin, artifacts, fetchArchive })
    assert.deepEqual(fetched, [`${pin.release}${pin.helpers['linux-x64'].archive}`])
    assert.equal(staged.file, join(artifacts, 'linux-x64', 'spry', 'spry-node'))
    assert.equal(await readFile(staged.file, 'utf8'), 'spry-node bytes')
    assert.equal((await stat(staged.file)).mode & 0o777, 0o755)
    await assert.rejects(stat(join(artifacts, 'linux-x64', 'spry', 'spry-turn')))
    await stageHelper('linux-x64', { pin, artifacts, fetchArchive })
    assert.equal(fetched.length, 1, 'a cached archive that still matches is not fetched again')
    await writeFile(staged.file, 'signed by an earlier run')
    await stageHelper('linux-x64', { pin, artifacts, fetchArchive })
    assert.equal(await readFile(staged.file, 'utf8'), 'spry-node bytes', 'extracted afresh every time')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an archive or binary that does not match the pin is refused', async () => {
  const dir = await scratch()
  try {
    const { bytes, pin } = await fixtureRelease(dir)
    const artifacts = join(dir, 'artifacts')
    await assert.rejects(stageHelper('linux-x64', { pin, artifacts, fetchArchive: async () => Buffer.from('tampered') }), /does not match its pinned SHA-256/)
    const wrongBinary = structuredClone(pin)
    wrongBinary.helpers['linux-x64'].binarySha256 = 'b'.repeat(64)
    await assert.rejects(stageHelper('linux-x64', { pin: wrongBinary, artifacts, fetchArchive: async () => bytes }), /spry-node does not match its pinned SHA-256/)
    await assert.rejects(stageHelper('darwin-arm64', { pin, artifacts, fetchArchive: async () => bytes }), /No pinned spry-turn helper/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the manifest names a hash per platform and refuses anything else', async () => {
  const dir = await scratch()
  try {
    const path = await writeManifest({ 'linux-x64': 'c'.repeat(64) }, { version: '0.4.0', appRoot: dir })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: '0.4.0', helpers: { 'linux-x64': 'c'.repeat(64) } })
    await assert.rejects(writeManifest({ 'linux-x64': 'nope' }, { version: '0.4.0', appRoot: dir }), /Bad helper hash/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the checked-in pin is well formed and covers every desktop platform', async () => {
  const pin = await readPin()
  assert.deepEqual(Object.keys(pin.helpers).sort(), ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  assert.equal(pin.release, `https://github.com/forgesworn/spry-turn/releases/download/v${pin.version}/`)
})
