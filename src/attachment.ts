/**
 * Attachments: something shared through Wildbloom, dropped into the chat.
 *
 * Wildbloom seals a file into an encrypted envelope under a fresh random key,
 * uploads only the envelope to a Blossom server, and publishes a NIP-94
 * kind-1063 event naming the envelope's URL and hash. The key never goes
 * anywhere public; the uploader is shown it once and hands it on by some
 * other route. In a room, that other route is the chat: the key rides inside
 * the room-key ciphertext beside the URL and the hash, so everybody in the
 * room can open the file and nobody outside it can, which is exactly the
 * standing the chat text already has.
 *
 * This module is the reading half. It knows the envelope format well enough
 * to refuse anything that is not exactly what Wildbloom wrote, and it fetches
 * nothing on its own: a fetch reaches the Blossom server, and whether that
 * happens is the person's decision, made by clicking, not the page's. The
 * format is Wildbloom's `FSWNENC2` (and the `FSWNENC1` and legacy `WBLMENC1`
 * it still reads), reproduced here from its specification and checked
 * against its published known-answer vectors, so that a room can open a
 * Wildbloom file without depending on Wildbloom's code.
 *
 * Browser-safe on purpose: no DOM, no Node, only the noble primitives the
 * rest of the protocol already uses.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { ChatAttachment } from './chat.js'

const MAGIC_V2 = 'FSWNENC2'
const MAGIC_V1 = 'FSWNENC1'
const MAGIC_LEGACY = 'WBLMENC1'
const HEADER_BYTES_V1 = 24
const HEADER_BYTES_V2 = 56
const SALT_BYTES = 32
const CHUNK_BYTES = 1024 * 1024
const TAG_BYTES = 16
const MAX_METADATA_BYTES = 4096
const MIN_PADDING_BUCKET_BYTES = 64 * 1024
/** The format's own ceiling: a 256 MiB source pads to at most 258 records. */
const MAX_RECORDS = 258
const MAX_SOURCE_BYTES = 256 * 1024 * 1024
const HKDF_INFO_V2 = new TextEncoder().encode('forgesworn-aes-256-gcm-chunked/v2')
const RECOVERY_KEY_PREFIX = 'wbk1_'
/** C0 controls and DEL, which a stored name or media type may not carry. */
const CONTROLS = /[\u0000-\u001f\u007f]/
const CONTROLS_ALL = /[\u0000-\u001f\u007f]/g

/** How much a reader will pull from a Blossom server for one attachment
 *  unless told otherwise. A room is for pictures and documents, not for the
 *  256 MiB the envelope format itself allows. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

export interface DecryptedEnvelope {
  /** The source file name, exactly as the uploader's client recorded it. */
  name: string
  /** The source media type, lower-cased. */
  type: string
  /** The source byte count. */
  size: number
  source: Uint8Array
}

// ---------------------------------------------------------------------------
// The recovery key
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecodeKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('The recovery key is not a Wildbloom key.')
  let binary: string
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=')
  } catch {
    throw new Error('The recovery key is not valid base64url.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  if (bytes.length !== 32) throw new Error('The recovery key must contain 256 bits.')
  // Re-encode and compare: base64url has alternate final characters that
  // decode to the same bits, and the format admits exactly one spelling.
  if (base64UrlEncode(bytes) !== value) throw new Error('The recovery key is not canonical base64url.')
  return bytes
}

/**
 * Read a recovery key as Wildbloom shows it (`wbk1_` and 43 characters of
 * base64url) or as the 64 hex characters the chat carries, and return the
 * hex form. Throws on anything else, so a mistyped key is refused before it
 * is sent rather than after somebody has clicked on it.
 */
export function parseRecoveryKey(text: string): string {
  const value = text.trim()
  if (value.startsWith(RECOVERY_KEY_PREFIX)) {
    return bytesToHex(base64UrlDecodeKey(value.slice(RECOVERY_KEY_PREFIX.length)))
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase()
  throw new Error('The recovery key is not a Wildbloom key.')
}

/** The hex key in the form Wildbloom itself shows and accepts. */
export function formatRecoveryKey(keyHex: string): string {
  return RECOVERY_KEY_PREFIX + base64UrlEncode(hexToBytes(keyHex))
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * Wildbloom's file-name normalisation, which the stored name must be a fixed
 * point of. Reproduced exactly: a decoder that accepted a name this function
 * would change is accepting a metadata record Wildbloom would refuse.
 */
export function canonicalEnvelopeName(value: string): string {
  const leaf = value.split(/[\\/]/).at(-1) ?? ''
  const cleaned = leaf
    .normalize('NFC')
    .replace(CONTROLS_ALL, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const fallback = cleaned || 'blob.bin'
  return fallback.length <= 180 ? fallback : fallback.slice(0, 180)
}

function canonicalEnvelopeType(value: string): string {
  const type = (value || 'application/octet-stream').toLowerCase()
  if (type.length > 255 || CONTROLS.test(type)) throw new Error('The encrypted file has an invalid media type.')
  return type
}

/** The padding bucket `P(L)` the specification defines. */
export function paddedPlaintextLength(length: number): number {
  if (length <= MIN_PADDING_BUCKET_BYTES) return MIN_PADDING_BUCKET_BYTES
  if (length <= CHUNK_BYTES) return 2 ** Math.ceil(Math.log2(length))
  return Math.ceil(length / CHUNK_BYTES) * CHUNK_BYTES
}

function nonceFor(prefix: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(12)
  nonce.set(prefix)
  new DataView(nonce.buffer).setUint32(8, counter, false)
  return nonce
}

function aadFor(header: Uint8Array, counter: number): Uint8Array {
  const aad = new Uint8Array(header.length + 4)
  aad.set(header)
  new DataView(aad.buffer).setUint32(header.length, counter, false)
  return aad
}

/**
 * The AES key an `FSWNENC2` envelope was sealed under: derived from the
 * recovery key and the header's salt, so no two envelopes share one even
 * when the recovery key is reused. `FSWNENC1` uses the recovery key as is.
 */
export function deriveEnvelopeKey(inputKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, inputKey, salt, HKDF_INFO_V2, 32)
}

interface Header {
  bytes: Uint8Array
  recordCount: number
  noncePrefix: Uint8Array
  salt: Uint8Array | null
}

function readHeader(envelope: Uint8Array): Header {
  const magic = new TextDecoder().decode(envelope.subarray(0, 8))
  const v2 = magic === MAGIC_V2
  if (envelope.length < 8 || (!v2 && magic !== MAGIC_V1 && magic !== MAGIC_LEGACY)) {
    throw new Error('This is not a Wildbloom encrypted envelope.')
  }
  const headerBytes = v2 ? HEADER_BYTES_V2 : HEADER_BYTES_V1
  if (envelope.length < headerBytes) throw new Error('This is not a Wildbloom encrypted envelope.')
  const bytes = envelope.slice(0, headerBytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunkSize = view.getUint32(8, false)
  const recordCount = view.getUint32(12, false)
  if (chunkSize !== CHUNK_BYTES || recordCount < 1 || recordCount > MAX_RECORDS) {
    throw new Error('The Wildbloom envelope header is invalid.')
  }
  const minimum = headerBytes + (recordCount - 1) * (chunkSize + TAG_BYTES) + 1 + TAG_BYTES
  const maximum = headerBytes + recordCount * (chunkSize + TAG_BYTES)
  if (envelope.length < minimum || envelope.length > maximum) {
    throw new Error('The Wildbloom envelope length is invalid.')
  }
  return {
    bytes,
    recordCount,
    noncePrefix: bytes.slice(16, 24),
    salt: v2 ? bytes.slice(24, 24 + SALT_BYTES) : null,
  }
}

interface Metadata {
  name: string
  size: number
  type: string
}

function readMetadata(plaintext: Uint8Array): { metadata: Metadata; prefixLength: number } {
  if (plaintext.length < 4) throw new Error('The encrypted metadata record is truncated.')
  const length = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false)
  if (length < 2 || length > MAX_METADATA_BYTES || 4 + length > plaintext.length) {
    throw new Error('The encrypted metadata length is invalid.')
  }
  let text: string
  let value: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(4, 4 + length))
    value = JSON.parse(text)
  } catch {
    throw new Error('The encrypted metadata is invalid.')
  }
  if (!value || typeof value !== 'object') throw new Error('The encrypted metadata is invalid.')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.name !== 'string' || typeof candidate.size !== 'number' || typeof candidate.type !== 'string') {
    throw new Error('The encrypted metadata types are invalid.')
  }
  const name = canonicalEnvelopeName(candidate.name)
  if (name !== candidate.name) throw new Error('The encrypted file name is invalid.')
  const size = candidate.size
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SOURCE_BYTES) {
    throw new Error('The encrypted file size is invalid.')
  }
  const type = canonicalEnvelopeType(candidate.type)
  if (Object.keys(candidate).sort().join(',') !== 'name,size,type') {
    throw new Error('The encrypted metadata shape is invalid.')
  }
  // JSON.stringify writes the minimal escaping profile the specification
  // requires, so byte equality against it is the canonical-form check.
  if (text !== JSON.stringify({ name, size, type })) throw new Error('The encrypted metadata is not canonical.')
  return { metadata: { name, size, type }, prefixLength: 4 + length }
}

/**
 * Open a Wildbloom envelope with its recovery key (hex). Every record is
 * authenticated and every rule the format states is checked before a single
 * byte of the file is returned; any failure is one plain error and nothing
 * else. The caller is expected to have verified the envelope's hash against
 * the published one first, so a wrong download is refused without the key
 * ever being applied to it.
 */
export function decryptEnvelope(envelope: Uint8Array, keyHex: string): DecryptedEnvelope {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('The recovery key is not a Wildbloom key.')
  const header = readHeader(envelope)
  const inputKey = hexToBytes(keyHex)
  const key = header.salt ? deriveEnvelopeKey(inputKey, header.salt) : inputKey
  const headerBytes = header.bytes.length
  const plaintextLength = envelope.length - headerBytes - header.recordCount * TAG_BYTES

  let metadata: Metadata | null = null
  let prefixLength = 0
  const parts: Uint8Array[] = []
  let copied = 0
  for (let counter = 0; counter < header.recordCount; counter += 1) {
    const start = headerBytes + counter * (CHUNK_BYTES + TAG_BYTES)
    const end = counter === header.recordCount - 1 ? envelope.length : start + CHUNK_BYTES + TAG_BYTES
    let plaintext: Uint8Array
    try {
      plaintext = gcm(key, nonceFor(header.noncePrefix, counter), aadFor(header.bytes, counter)).decrypt(
        envelope.subarray(start, end),
      )
    } catch {
      throw new Error('The recovery key is wrong or the encrypted envelope was modified.')
    }
    if (!metadata) {
      const read = readMetadata(plaintext)
      metadata = read.metadata
      prefixLength = read.prefixLength
      if (paddedPlaintextLength(prefixLength + metadata.size) !== plaintextLength) {
        throw new Error('The encrypted envelope padding is invalid.')
      }
    }
    const globalStart = counter * CHUNK_BYTES
    const wantedEnd = prefixLength + metadata.size
    const overlapStart = Math.max(globalStart, prefixLength)
    const overlapEnd = Math.min(globalStart + plaintext.length, wantedEnd)
    if (overlapEnd > overlapStart) {
      const part = plaintext.slice(overlapStart - globalStart, overlapEnd - globalStart)
      copied += part.length
      parts.push(part)
    }
  }
  if (!metadata || copied !== metadata.size) {
    throw new Error('The encrypted envelope did not contain the declared file.')
  }
  const source = new Uint8Array(metadata.size)
  let offset = 0
  for (const part of parts) {
    source.set(part, offset)
    offset += part.length
  }
  return { name: metadata.name, type: metadata.type, size: metadata.size, source }
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

/** Whether these bytes are the envelope the kind-1063 event's `x` tag named. */
export function verifyEnvelopeHash(envelope: Uint8Array, expectedHex: string): boolean {
  return sha256Hex(envelope) === expectedHex.toLowerCase()
}

export interface FetchAttachmentOptions {
  /** Injectable, for tests and for a runtime with its own fetch. */
  fetch?: typeof fetch
  /** Refuse a body larger than this, before reading all of it. */
  maxBytes?: number
  signal?: AbortSignal
}

/**
 * Fetch an attachment's envelope, refuse it if it is too big or is not the
 * bytes the event named, and only then open it with the key. The order is
 * the point: the hash check costs nothing and settles whether this is the
 * file at all, so the key is never tried against something else.
 */
export async function fetchAttachment(
  att: ChatAttachment,
  opts: FetchAttachmentOptions = {},
): Promise<DecryptedEnvelope> {
  const doFetch = opts.fetch ?? globalThis.fetch
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
  if (!/^https:\/\//i.test(att.url)) throw new Error('An attachment can only be fetched over https.')
  const response = await doFetch(att.url, { signal: opts.signal, redirect: 'follow', credentials: 'omit' })
  if (!response.ok) throw new Error(`The server answered ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('The attachment is larger than this room will fetch.')
  }
  const envelope = await readBounded(response, maxBytes)
  if (!verifyEnvelopeHash(envelope, att.sha256)) throw new Error('The download is not the file the message named.')
  return decryptEnvelope(envelope, att.key)
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer())
    if (whole.length > maxBytes) throw new Error('The attachment is larger than this room will fetch.')
    return whole
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) throw new Error('The attachment is larger than this room will fetch.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
