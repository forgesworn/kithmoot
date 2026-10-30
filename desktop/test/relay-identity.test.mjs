import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const scratch = () => mkdtemp(join(tmpdir(), 'kithmoot-relay-identity-'))

test('the pairing key is the x-only public key of a secp256k1 secret', () => {
  // The generator point: secret 1.
  assert.equal(pairingPublicKey('0'.repeat(63) + '1'), '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  for (const bad of ['0'.repeat(64), 'f'.repeat(64), 'xyz', 'A'.repeat(64)]) assert.throws(() => pairingPublicKey(bad), { code: 'ERR_CONFIG' })
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
