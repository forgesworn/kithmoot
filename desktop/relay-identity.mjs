import { createECDH, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The built-in call relay's lasting identity (docs/design/2026-10-28-built-in-relay.md,
 * 1.3). `SPRY_TURN_SECRET` derives the node's key, its pairing id, its grant
 * tokens and so the `spry:` endpoint rooms carry; the endpoint also names the
 * control relays, and clients compare endpoints whole. So the secret, the app's
 * pairing key, the control relays and the listener port are made once, kept
 * together, and only thrown away when the person removes the relay.
 *
 * The file holds them encrypted by the operating system's keychain
 * (Electron `safeStorage`). Where no keychain is available, or Linux would fall
 * back to its fixed-password `basic_text` store, nothing is written and the
 * relay cannot be turned on: these secrets are never kept in clear.
 */

const HEX64 = /^[0-9a-f]{64}$/
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const MAX_FILE = 16384
/** Listener ports are picked from here: clear of the usual service ports and
 *  of 49152 to 65535, where the node picks its allocation ports. */
export const LISTEN_PORTS = Object.freeze([20000, 39999])

const messages = {
  ERR_NO_KEYCHAIN: "This computer's keychain is not available, so the call relay's keys cannot be kept safely.",
  ERR_IDENTITY: "The call relay's saved keys could not be read.",
  ERR_CONFIG: 'Invalid call relay settings.',
}
export function identityError(code) { return Object.assign(new Error(messages[code]), { code }) }

/** The x-only public key (64 hex) of a secp256k1 secret, or a throw for a
 *  secret that is not one (zero, or not below the curve order). */
export function pairingPublicKey(secret) {
  if (typeof secret !== 'string' || !HEX64.test(secret)) throw identityError('ERR_CONFIG')
  const ecdh = createECDH('secp256k1')
  try { ecdh.setPrivateKey(Buffer.from(secret, 'hex')) } catch { throw identityError('ERR_CONFIG') }
  return ecdh.getPublicKey('hex', 'compressed').slice(2)
}

/** 1 to 4 distinct `wss://` URLs on DNS names, as spry-node's
 *  `--control-relay` takes them. Returns them normalised, in order. */
export function controlRelayList(urls) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4) throw identityError('ERR_CONFIG')
  const out = []
  for (const value of urls) {
    let url
    try { url = new URL(value) } catch { throw identityError('ERR_CONFIG') }
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash
      || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !DNS_NAME.test(url.hostname) || url.href.length > 512) throw identityError('ERR_CONFIG')
    if (out.includes(url.href)) throw identityError('ERR_CONFIG')
    out.push(url.href)
  }
  return out
}

function validIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'controlRelays,listenPort,pairingSecret,participant,turnSecret,v'
    || value.v !== 1 || !HEX64.test(value.turnSecret) || !HEX64.test(value.participant)
    || !Number.isInteger(value.listenPort) || value.listenPort < LISTEN_PORTS[0] || value.listenPort > LISTEN_PORTS[1]) return undefined
  try {
    pairingPublicKey(value.pairingSecret)
    return { v: 1, turnSecret: value.turnSecret, pairingSecret: value.pairingSecret, participant: value.participant,
      controlRelays: controlRelayList(value.controlRelays), listenPort: value.listenPort }
  } catch { return undefined }
}

export function createRelayIdentity({ dir, safeStorage, platform = process.platform, random = randomBytes }) {
  if (typeof dir !== 'string' || !dir || !safeStorage) throw identityError('ERR_CONFIG')
  const file = join(dir, 'identity.bin')
  function requireKeychain() {
    let available = false
    try {
      available = safeStorage.isEncryptionAvailable() === true
        && !(platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    } catch { available = false }
    if (!available) throw identityError('ERR_NO_KEYCHAIN')
  }
  function newSecret() {
    for (;;) {
      const secret = random(32).toString('hex')
      try { pairingPublicKey(secret); return secret } catch { /* Out of range: draw again. */ }
    }
  }
  /** The saved identity, undefined if none was made, or a throw if one
   *  exists but cannot be read (another build's keychain entry, a damaged file). */
  async function load() {
    let bytes
    try { bytes = await readFile(file) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw identityError('ERR_IDENTITY')
    }
    requireKeychain()
    if (bytes.length > MAX_FILE) throw identityError('ERR_IDENTITY')
    let value
    try { value = validIdentity(JSON.parse(safeStorage.decryptString(bytes))) } catch { value = undefined }
    if (!value) throw identityError('ERR_IDENTITY')
    return value
  }
  async function create({ participant, controlRelays }) {
    if (typeof participant !== 'string' || !HEX64.test(participant)) throw identityError('ERR_CONFIG')
    const relays = controlRelayList(controlRelays)
    requireKeychain()
    const span = LISTEN_PORTS[1] - LISTEN_PORTS[0] + 1
    const identity = { v: 1, turnSecret: random(32).toString('hex'), pairingSecret: newSecret(), participant,
      controlRelays: relays, listenPort: LISTEN_PORTS[0] + random(4).readUInt32BE(0) % span }
    const sealed = safeStorage.encryptString(JSON.stringify(identity))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${random(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(sealed)
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, file) } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    return identity
  }
  /** Forget the identity and the node's own state (its grants and pairing).
   *  The router-mapping record beside the state is kept, so the next run can
   *  still clean up after a crash. */
  async function remove() {
    await rm(file, { force: true })
    await rm(join(dir, 'node-state.json'), { force: true })
  }
  return { load, create, remove, file, stateFile: join(dir, 'node-state.json') }
}
