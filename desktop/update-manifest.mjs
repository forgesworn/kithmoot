import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * Signed update manifests. The download server is not trusted: a checksum
 * served beside the file it describes proves nothing to somebody who can
 * change both. What an app trusts instead is an Ed25519 signature, made at
 * release time on a machine that never holds the server's keys, over the
 * exact bytes of the manifest it fetched, checked against a key compiled
 * into the app. The manifest then pins each download's SHA-256 and size.
 *
 * See docs/updates.md. The Android app carries the same keys and the same
 * message construction; test/vectors in both repos keep them in step.
 */

/**
 * Raw Ed25519 public keys, hex. The first signs releases. The second is a
 * recovery key kept offline, so a lost or leaked release key can be replaced
 * by a release the recovery key signs, without stranding anybody.
 */
export const UPDATE_KEYS = Object.freeze([
  'eada5891ff88e81b80a1ea7ffca7bfa31ac66b33aa03c862d6e62d397ca0216a',
  'be13e8bf3e634b044bbd11575ebe488e33240ecb4c6fdfd8ca08dd9e7cfa424e',
])

/** What each signed file is for. A signature over one never verifies as the other. */
export const MANIFESTS = Object.freeze({
  desktop: 'downloads/release.json',
  android: 'android-release.json',
})

const DOMAIN = 'kithmoot/v1/update-manifest'

/** The bytes a manifest's signature covers: a domain tag, the manifest's
 *  path on the site, then the file exactly as served. */
export function signedMessage(label, bytes) {
  if (!Object.values(MANIFESTS).includes(label)) throw new Error(`unknown manifest ${label}`)
  return Buffer.concat([Buffer.from(`${DOMAIN}\n${label}\n`, 'utf8'), Buffer.from(bytes)])
}

const publicKey = hex => createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
  format: 'jwk',
})

/** Whether `signature` (the `.sig` file's text: base64 of 64 bytes) is a
 *  signature by one of `keys` over `bytes` as manifest `label`. Never throws. */
export function verifyManifest(label, bytes, signature, keys = UPDATE_KEYS) {
  try {
    const text = Buffer.isBuffer(signature) ? signature.toString('utf8') : String(signature)
    if (!/^[A-Za-z0-9+/]{86}==\s*$/.test(text)) return false
    const sig = Buffer.from(text.trim(), 'base64')
    if (sig.length !== 64) return false
    const message = signedMessage(label, bytes)
    return keys.some(hex => /^[0-9a-f]{64}$/.test(hex) && verify(null, message, publicKey(hex), sig))
  } catch {
    return false
  }
}

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

/** -1, 0 or 1. Throws on anything that is not a plain x.y.z version. */
export function compareVersions(a, b) {
  const pa = VERSION.exec(a)
  const pb = VERSION.exec(b)
  if (!pa || !pb) throw new Error('not a version')
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/** The archive this platform updates from, by file name. Only platforms the
 *  app can replace itself on are listed: the Mac has Squirrel and the
 *  Debian package has apt. */
export const archiveFor = (platform, arch, version) => ({
  'win32:x64': `KithMoot-${version}-windows-x64.zip`,
  'linux:x64': `KithMoot-${version}-linux-x64.tar.gz`,
  'linux:arm64': `KithMoot-${version}-linux-arm64.tar.gz`,
})[`${platform}:${arch}`]

/** Where a desktop archive is served from. */
export const archiveUrl = (origin, version, filename) => `${origin}/apk/desktop/${version}/${filename}`

/** At most this many bytes, whatever a manifest says. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/**
 * Reads a verified desktop manifest and returns the update this copy should
 * take, or undefined when there is none. Throws when the manifest is
 * malformed. Only call it on bytes `verifyManifest` accepted.
 */
export function desktopUpdate(bytes, { currentVersion, platform, arch }) {
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'))
  const { version, files } = manifest ?? {}
  if (typeof version !== 'string' || !VERSION.test(version) || !Array.isArray(files)) throw new Error('malformed manifest')
  // Never sideways or backwards: an old signed manifest replayed by the
  // server can at worst keep this copy where it is.
  if (compareVersions(version, currentVersion) <= 0) return undefined
  const filename = archiveFor(platform, arch, version)
  if (!filename) return undefined
  const file = files.find(entry => entry?.filename === filename)
  if (!file) return undefined
  if (file.version !== version) throw new Error('malformed manifest')
  if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('malformed manifest')
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_ARCHIVE_BYTES) throw new Error('malformed manifest')
  return { version, filename, sha256: file.sha256, bytes: file.bytes }
}

/** A running SHA-256 and byte count that refuses to go past `limit`. */
export function boundedDigest(limit) {
  const hash = createHash('sha256')
  let total = 0
  return {
    update(chunk) {
      total += chunk.length
      if (total > limit) throw new Error('download is larger than the manifest says')
      hash.update(chunk)
    },
    finish() { return { bytes: total, sha256: hash.digest('hex') } },
  }
}
