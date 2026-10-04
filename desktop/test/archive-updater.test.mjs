import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createArchiveUpdater, sidePaths } from '../archive-updater.mjs'
import { signedMessage } from '../update-manifest.mjs'

// A key for these tests only, from a fixed seed.
const key = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${'07'.repeat(32)}`, 'hex'), format: 'der', type: 'pkcs8' })
const trusted = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex')
const other = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${'08'.repeat(32)}`, 'hex'), format: 'der', type: 'pkcs8' })
const signWith = (k, bytes) => `${sign(null, signedMessage('downloads/release.json', bytes), k).toString('base64')}\n`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** A Linux tarball built the way package-linux.mjs builds it. */
function tarball(work, version, arch = 'x64') {
  const src = join(work, `src-${version}`)
  const app = join(src, `KithMoot-linux-${arch}`)
  mkdirSync(join(app, 'resources'), { recursive: true })
  writeFileSync(join(app, 'kithmoot'), `#!/bin/sh\necho ${version}\n`)
  writeFileSync(join(app, 'resources', 'app.asar'), version)
  const out = join(work, `KithMoot-${version}-linux-${arch}.tar.gz`)
  assert.equal(spawnSync('tar', ['-czf', out, '-C', src, `KithMoot-linux-${arch}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0)
  return readFileSync(out)
}

function installed(work, version) {
  const dir = join(work, 'apps', 'kithmoot-desktop')
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'kithmoot'), version)
  writeFileSync(join(dir, 'resources', 'app.asar'), version)
  return dir
}

const response = (bytes, status = 200) => new Response(bytes, { status })

/** A server that answers from `routes`, recording what was asked. */
const server = routes => {
  const asked = []
  const fetch = async url => {
    asked.push(url)
    const body = routes[url]
    if (body === undefined) return response('missing', 404)
    return response(typeof body === 'function' ? body() : body)
  }
  return { fetch, asked }
}

function setup({ version = '0.2.0', archive, manifestFiles, signer = key, sig } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'kithmoot-updater-'))
  const installDir = installed(work, '0.1.47')
  const bytes = archive ?? tarball(work, version)
  const filename = `KithMoot-${version}-linux-x64.tar.gz`
  const files = manifestFiles ?? [{ filename, version, sha256: sha(bytes), bytes: bytes.length }]
  const manifest = Buffer.from(JSON.stringify({ version, files }, null, 2))
  const origin = 'https://updates.test'
  const routes = {
    [`${origin}/downloads/release.json`]: manifest,
    [`${origin}/downloads/release.json.sig`]: sig ?? signWith(signer, manifest),
    [`${origin}/apk/desktop/${version}/${filename}`]: bytes,
  }
  const srv = server(routes)
  const states = []
  const errors = []
  const relaunched = []
  const updater = createArchiveUpdater({
    platform: 'linux', arch: 'x64', packaged: true, currentVersion: '0.1.47', installDir,
    updatesDir: join(work, 'config', 'updates'), fetch: srv.fetch, origin, keys: [trusted],
    relaunch: path => relaunched.push(path), notify: s => states.push(s), log: e => errors.push(e),
    setTimeoutFn: () => 1, setIntervalFn: () => 2, clearTimeoutFn: () => {}, clearIntervalFn: () => {},
  })
  return { work, installDir, updater, states, errors, relaunched, srv, routes, origin, cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

test('a signed, matching update is downloaded, unpacked beside the app and swapped in on restart', async () => {
  const t = setup()
  try {
    t.updater.start()
    assert.equal(await t.updater.check(), true)
    assert.deepEqual(t.updater.state(), { phase: 'ready', version: '0.2.0' })
    assert.deepEqual(t.states.map(s => s.phase), ['idle', 'checking', 'downloading', 'ready'])
    // Not touched until the person restarts.
    assert.equal(readFileSync(join(t.installDir, 'kithmoot'), 'utf8'), '0.1.47')
    assert.equal(t.updater.install(), true)
    assert.match(readFileSync(join(t.installDir, 'kithmoot'), 'utf8'), /echo 0\.2\.0/)
    assert.equal(readFileSync(join(sidePaths(t.installDir).backup, 'kithmoot'), 'utf8'), '0.1.47')
    assert.deepEqual(t.relaunched, [join(t.installDir, 'kithmoot')])
    assert.equal(t.updater.install(), false, 'only once')
  } finally { t.cleanup() }
})

test('the next start clears the previous copy and any unpacked update not taken', () => {
  const t = setup()
  try {
    const { backup } = sidePaths(t.installDir)
    mkdirSync(backup)
    mkdirSync(sidePaths(t.installDir, '0.1.48').unpack)
    mkdirSync(`${t.installDir}.update-mine`)
    t.updater.start()
    const left = readdirSync(join(t.work, 'apps')).sort()
    assert.deepEqual(left, ['kithmoot-desktop', 'kithmoot-desktop.update-mine'])
  } finally { t.cleanup() }
})

for (const [name, change] of [
  ['signed by a key the app does not trust', { signer: other }],
  ['with no signature', { sig: '' }],
  ['with a garbage signature', { sig: 'x'.repeat(88) }],
]) {
  test(`a manifest ${name} is refused before anything is downloaded`, async () => {
    const t = setup(change)
    try {
      t.updater.start()
      assert.equal(await t.updater.check(), false)
      assert.equal(t.updater.state().phase, 'error')
      assert.equal(t.srv.asked.some(url => url.includes('/apk/')), false)
    } finally { t.cleanup() }
  })
}

test('an endless manifest is cut off as it streams, not buffered whole', async () => {
  const t = setup()
  try {
    let pulled = 0
    t.routes[`${t.origin}/downloads/release.json`] = () => new ReadableStream({
      pull(controller) { pulled += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)) },
    })
    t.updater.start()
    assert.equal(await t.updater.check(), false)
    assert.equal(t.updater.state().phase, 'error')
    assert.ok(pulled <= 512 * 1024, `read ${pulled} bytes of an endless manifest`)
  } finally { t.cleanup() }
})

test('a manifest changed after signing is refused', async () => {
  const t = setup()
  try {
    const url = `${t.origin}/downloads/release.json`
    t.routes[url] = Buffer.from(t.routes[url].toString().replace('0.2.0', '0.2.1'))
    t.updater.start()
    assert.equal(await t.updater.check(), false)
    assert.equal(t.updater.state().phase, 'error')
  } finally { t.cleanup() }
})

test('an archive that does not match the signed hash is deleted, not unpacked', async () => {
  const t = setup()
  try {
    const url = Object.keys(t.routes).find(u => u.includes('/apk/'))
    const real = t.routes[url]
    const evil = Buffer.from(real)
    evil[evil.length - 1] ^= 1
    t.routes[url] = evil
    t.updater.start()
    assert.equal(await t.updater.check(), false)
    assert.match(t.updater.state().message, /could not verify/)
    assert.deepEqual(readdirSync(join(t.work, 'config', 'updates')), [])
    assert.equal(existsSync(sidePaths(t.installDir, '0.2.0').unpack), false)
    assert.equal(readFileSync(join(t.installDir, 'kithmoot'), 'utf8'), '0.1.47')
  } finally { t.cleanup() }
})

test('an archive longer than the signed size is cut off', async () => {
  const t = setup()
  try {
    const url = Object.keys(t.routes).find(u => u.includes('/apk/'))
    t.routes[url] = Buffer.concat([t.routes[url], Buffer.alloc(1024 * 1024)])
    t.updater.start()
    assert.equal(await t.updater.check(), false)
    assert.match(t.updater.state().message, /could not verify/)
    assert.deepEqual(readdirSync(join(t.work, 'config', 'updates')), [])
  } finally { t.cleanup() }
})

test('a signed archive that does not hold a KithMoot folder is not staged', async () => {
  const work = mkdtempSync(join(tmpdir(), 'kithmoot-archive-'))
  try {
    mkdirSync(join(work, 'src', 'Something-else'), { recursive: true })
    writeFileSync(join(work, 'src', 'Something-else', 'kithmoot'), 'x')
    const out = join(work, 'a.tar.gz')
    spawnSync('tar', ['-czf', out, '-C', join(work, 'src'), 'Something-else'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const t = setup({ archive: readFileSync(out) })
    try {
      t.updater.start()
      assert.equal(await t.updater.check(), false)
      assert.equal(t.updater.state().phase, 'error')
      assert.equal(existsSync(sidePaths(t.installDir, '0.2.0').unpack), false)
      assert.equal(t.updater.install(), false)
    } finally { t.cleanup() }
  } finally { rmSync(work, { recursive: true, force: true }) }
})

test('the same version, or an older one, is not downloaded', async () => {
  for (const version of ['0.1.47', '0.1.40']) {
    const t = setup({ version })
    try {
      t.updater.start()
      assert.equal(await t.updater.check(), false)
      assert.equal(t.updater.state().phase, 'idle')
      assert.equal(t.srv.asked.some(url => url.includes('/apk/')), false)
    } finally { t.cleanup() }
  }
})

test('a copy the person cannot write to, or a development run, has no updater', () => {
  const work = mkdtempSync(join(tmpdir(), 'kithmoot-updater-'))
  try {
    const installDir = installed(work, '0.1.47')
    const base = { platform: 'linux', arch: 'x64', packaged: true, currentVersion: '0.1.47', installDir, updatesDir: join(work, 'u'), fetch: async () => { throw new Error('no') } }
    assert.equal(createArchiveUpdater({ ...base, isWritable: () => false }).state().phase, 'disabled')
    assert.equal(createArchiveUpdater({ ...base, packaged: false }).state().phase, 'disabled')
    assert.equal(createArchiveUpdater({ ...base, platform: 'darwin', arch: 'arm64' }).state().phase, 'disabled')
    assert.equal(createArchiveUpdater(base).state().phase, 'idle')
  } finally { rmSync(work, { recursive: true, force: true }) }
})

test('on Windows the swap is handed to a helper that waits for this process to exit', async () => {
  const work = mkdtempSync(join(tmpdir(), 'kithmoot-updater-'))
  try {
    const installDir = join(work, 'KithMoot-win32-x64')
    mkdirSync(join(installDir, 'resources'), { recursive: true })
    writeFileSync(join(installDir, 'KithMoot.exe'), 'old')
    const zip = Buffer.from('a signed zip')
    const filename = 'KithMoot-0.2.0-windows-x64.zip'
    const manifest = Buffer.from(JSON.stringify({ version: '0.2.0', files: [{ filename, version: '0.2.0', sha256: sha(zip), bytes: zip.length }] }))
    const origin = 'https://updates.test'
    const srv = server({
      [`${origin}/downloads/release.json`]: manifest,
      [`${origin}/downloads/release.json.sig`]: signWith(key, manifest),
      [`${origin}/apk/desktop/0.2.0/${filename}`]: zip,
    })
    const spawned = []
    let quit = 0
    const updater = createArchiveUpdater({
      platform: 'win32', arch: 'x64', packaged: true, currentVersion: '0.1.47', installDir, pid: 4242,
      updatesDir: join(work, 'updates'), fetch: srv.fetch, origin, keys: [trusted],
      extract: (archive, destination) => {
        assert.deepEqual(readFileSync(archive), zip, 'only the verified archive is unpacked')
        mkdirSync(join(destination, 'KithMoot-win32-x64', 'resources'), { recursive: true })
        writeFileSync(join(destination, 'KithMoot-win32-x64', 'KithMoot.exe'), 'new')
        writeFileSync(join(destination, 'KithMoot-win32-x64', 'resources', 'app.asar'), 'new')
      },
      spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} } },
      quit: () => quit++,
      setTimeoutFn: () => 1, setIntervalFn: () => 2, clearTimeoutFn: () => {}, clearIntervalFn: () => {},
    })
    updater.start()
    assert.equal(await updater.check(), true)
    assert.equal(updater.install(), true)
    assert.equal(quit, 1)
    assert.equal(spawned.length, 1)
    const { cmd, args, opts } = spawned[0]
    assert.match(cmd, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
    const arg = name => args[args.indexOf(name) + 1]
    assert.equal(arg('-WaitPid'), '4242')
    assert.equal(arg('-Target'), installDir)
    assert.equal(arg('-Staged'), join(sidePaths(installDir, '0.2.0').unpack, 'KithMoot-win32-x64'))
    assert.equal(arg('-Backup'), `${installDir}.previous`)
    assert.equal(opts.detached, true)
    assert.match(readFileSync(arg('-File'), 'utf8'), /Wait-Process -Id \$WaitPid/)
    // The running copy is left alone: the helper moves it once this process has gone.
    assert.equal(readFileSync(join(installDir, 'KithMoot.exe'), 'utf8'), 'old')
  } finally { rmSync(work, { recursive: true, force: true }) }
})
