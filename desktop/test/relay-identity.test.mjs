import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createRelayIdentity, controlRelayList, pairingPublicKey, LISTEN_PORTS } from '../relay-identity.mjs'

/** A stand-in keychain: reversible, and visibly not plain text. */
function keychain({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: text => Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
    decryptString: bytes => Buffer.from(bytes.toString().split('').reverse().join(''), 'base64').toString(),
  }
}
const participant = 'd'.repeat(64)
const run = promisify(execFile)
const scratch = () => mkdtemp(join(tmpdir(), 'kithmoot-relay-identity-'))

const ORDER = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

test('the pairing key is the x-only public key of a secp256k1 secret', () => {
  // The generator point: secret 1.
  assert.equal(pairingPublicKey('0'.repeat(63) + '1'), '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  // BIP-340 test vectors 0 to 3 (bip-0340/test-vectors.csv).
  for (const [secret, key] of [
    ['0000000000000000000000000000000000000000000000000000000000000003', 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'],
    ['b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef', 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659'],
    ['c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9', 'dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8'],
    ['0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710', '25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517'],
  ]) assert.equal(pairingPublicKey(secret), key)
  // n - 1 is the last valid secret: the generator's negation, same x.
  assert.equal(pairingPublicKey(ORDER.slice(0, -1) + '0'), '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  for (const bad of ['0'.repeat(64), ORDER, 'f'.repeat(64), 'xyz', 'A'.repeat(64)]) assert.throws(() => pairingPublicKey(bad), { code: 'ERR_CONFIG' })
})

test('the pairing key agrees with OpenSSL where Node has the curve', t => {
  let ecdh
  try { ecdh = createECDH('secp256k1') } catch { return t.skip('no secp256k1 in this runtime') }
  for (let i = 0; i < 200; i++) {
    const secret = randomBytes(32).toString('hex')
    if (BigInt(`0x${secret}`) === 0n || secret >= ORDER) continue
    ecdh.setPrivateKey(Buffer.from(secret, 'hex'))
    assert.equal(pairingPublicKey(secret), ecdh.getPublicKey('hex', 'compressed').slice(2), secret)
  }
})

// Electron's BoringSSL has no secp256k1, so asking node:crypto for it threw in
// the shipped app and the redraw loop hung the window (desktop 0.1.120-0.1.121).
test('no desktop main-process module asks node:crypto for a named curve', async () => {
  const desktop = fileURLToPath(new URL('..', import.meta.url))
  for (const name of (await readdir(desktop)).filter(file => file.endsWith('.mjs'))) {
    const text = (await readFile(join(desktop, name), 'utf8')).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    assert.doesNotMatch(text, /createECDH\s*\(|getCurves\s*\(|namedCurve/, name)
  }
})

test('under the Electron runtime an identity can be made', async t => {
  const desktop = fileURLToPath(new URL('..', import.meta.url))
  const executable = process.env.ELECTRON_EXECUTABLE ?? [
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'node_modules/electron/dist/electron', 'node_modules/electron/dist/electron.exe',
  ].map(path => join(desktop, path)).find(path => existsSync(path))
  if (!executable) return t.skip('no Electron binary (set ELECTRON_EXECUTABLE or run npm run setup in desktop/)')
  const dir = await scratch()
  try {
    const script = `
      import { createRelayIdentity, pairingPublicKey } from ${JSON.stringify(pathToFileURL(join(desktop, 'relay-identity.mjs')).href)}
      const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() }
      const identity = createRelayIdentity({ dir: ${JSON.stringify(join(dir, 'call-relay'))}, safeStorage })
      const made = await identity.create({ participant: '${participant}', controlRelays: ['wss://relay.example'] })
      const again = await identity.load()
      process.stdout.write(JSON.stringify({ same: JSON.stringify(again) === JSON.stringify(made), key: pairingPublicKey(made.pairingSecret) }))`
    const { stdout } = await run(executable, ['--input-type=module', '-e', script],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 })
    const result = JSON.parse(stdout)
    assert.equal(result.same, true)
    assert.match(result.key, /^[0-9a-f]{64}$/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('control relays are 1 to 4 distinct wss URLs on DNS names', () => {
  assert.deepEqual(controlRelayList(['wss://relay.example', 'wss://nos.lol/path']), ['wss://relay.example/', 'wss://nos.lol/path'])
  for (const bad of [[], ['ws://relay.example'], ['wss://203.0.113.7/'], ['wss://[2001:db8::1]/'], ['wss://localhost/'],
    ['wss://user@relay.example/'], ['wss://relay.example/?x=1'], ['wss://a.example', 'wss://a.example/'],
    ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example', 'wss://e.example']]) {
    assert.throws(() => controlRelayList(bad), { code: 'ERR_CONFIG' }, JSON.stringify(bad))
  }
})

test('an identity is made once, kept encrypted and private, and read back the same', async () => {
  const dir = await scratch()
  try {
    const identity = createRelayIdentity({ dir: join(dir, 'call-relay'), safeStorage: keychain() })
    assert.equal(await identity.load(), undefined)
    const made = await identity.create({ participant, controlRelays: ['wss://relay.example'] })
    assert.equal(made.listenPort >= LISTEN_PORTS[0] && made.listenPort <= LISTEN_PORTS[1], true)
    assert.notEqual(made.turnSecret, made.pairingSecret)
    const bytes = await readFile(identity.file)
    assert.equal(bytes.includes(made.turnSecret), false, 'the secret is not in clear')
    if (process.platform !== 'win32') assert.equal((await stat(identity.file)).mode & 0o777, 0o600)
    assert.deepEqual(await identity.load(), made)
    await writeFile(identity.stateFile, '{}')
    await identity.remove()
    assert.equal(await identity.load(), undefined)
    await assert.rejects(stat(identity.stateFile))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('without a real keychain nothing is written and the relay cannot be made', async () => {
  const dir = await scratch()
  try {
    for (const [store, platform] of [[keychain({ available: false }), 'darwin'], [keychain({ backend: 'basic_text' }), 'linux']]) {
      const identity = createRelayIdentity({ dir, safeStorage: store, platform })
      await assert.rejects(identity.create({ participant, controlRelays: ['wss://relay.example'] }), { code: 'ERR_NO_KEYCHAIN' })
      await assert.rejects(stat(identity.file))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a file another build or keychain cannot read is refused, never replaced', async () => {
  const dir = await scratch()
  try {
    const identity = createRelayIdentity({ dir, safeStorage: keychain() })
    await identity.create({ participant, controlRelays: ['wss://relay.example'] })
    const other = createRelayIdentity({ dir, safeStorage: { ...keychain(), decryptString: () => { throw new Error('wrong key') } } })
    await assert.rejects(other.load(), { code: 'ERR_IDENTITY' })
    await writeFile(identity.file, keychain().encryptString(JSON.stringify({ v: 1, turnSecret: 'short' })))
    await assert.rejects(identity.load(), { code: 'ERR_IDENTITY' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
