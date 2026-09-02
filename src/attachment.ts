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
 * The reading half knows the envelope format well enough to refuse anything
 * that is not exactly what Wildbloom wrote, and it fetches nothing on its
 * own: a fetch reaches the Blossom server, and whether that happens is the
 * person's decision, made by clicking, not the page's. The format is
 * Wildbloom's `FSWNENC2` (and the `FSWNENC1` and legacy `WBLMENC1` it still
 * reads), reproduced here from its specification and checked against its
 * published known-answer vectors, so that a room can open a Wildbloom file
 * without depending on Wildbloom's code.
 *
 * The writing half is the same format from the other side, so a file
 * dropped into a room goes out exactly as Wildbloom would have sent it:
 * sealed under a fresh key, put on a Blossom server as an opaque blob, and
 * announced by a kind-1063 event any Wildbloom client can read. The upload
 * is authorised the way Wildbloom authorises it (a signed kind-24242 event
 * naming the hash and the host), by whatever key the caller signs with.
 *
 * Browser-safe on purpose: no DOM, no Node, only the noble primitives the
 * rest of the protocol already uses.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import type { ChatAttachment } from './chat.js'
import { verifyEventUncached } from './verify.js'

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

// ---------------------------------------------------------------------------
// Writing an envelope
// ---------------------------------------------------------------------------

/** The media type Wildbloom uploads an envelope under. Its bytes say
 *  nothing about what is inside, and neither does this. */
export const ENVELOPE_MEDIA_TYPE = 'application/vnd.forgesworn.encrypted'
/** The one file name Wildbloom gives every envelope, so a Blossom server
 *  and a kind-1063 event learn nothing from it. */
export const ENVELOPE_FILE_NAME = 'wildbloom.wbenc'
/** The scheme name the kind-1063 event carries in its `encryption` tag. */
export const ENVELOPE_SCHEME = 'forgesworn-aes-256-gcm-chunked-v2'
/** The biggest file a room will seal and upload. Well under the format's
 *  own 256 MiB: a room is for pictures and documents, and everything here
 *  is held in memory while it is sealed. */
export const MAX_UPLOAD_SOURCE_BYTES = 64 * 1024 * 1024

export interface EnvelopeSource {
  /** The file name as the person's device knows it. Normalised the way
   *  Wildbloom normalises it before it is stored. */
  name: string
  /** The media type as the person's device knows it. Lower-cased; empty
   *  becomes `application/octet-stream`. */
  type: string
}

export interface EncryptEnvelopeOptions {
  /** The 32-byte input key, which is also the recovery key the chat will
   *  carry. Fresh random when not given, which is what every real envelope
   *  gets; given only to reproduce a published vector. */
  key?: Uint8Array
  /** The 32-byte header salt. Fresh random when not given. Test-only. */
  salt?: Uint8Array
  /** The 8-byte nonce prefix. Fresh random when not given. Test-only. */
  noncePrefix?: Uint8Array
  /** The padding byte at each absolute plaintext offset. Fresh random when
   *  not given. Test-only: the published vectors fill their padding with a
   *  formula so their bytes can be reproduced. */
  padding?: (offset: number) => number
  /** Refuse a source larger than this. Defaults to
   *  `MAX_UPLOAD_SOURCE_BYTES`, and can never exceed the format's own. */
  maxSourceBytes?: number
}

export interface EncryptedEnvelope {
  /** The envelope bytes, ready to upload. */
  envelope: Uint8Array
  /** SHA-256 of `envelope`, hex: the `x` tag and the Blossom address. */
  sha256: string
  /** The recovery key, as the 64 hex characters the chat carries. This is
   *  the only copy; it exists here and in whatever the caller puts it in. */
  key: string
  /** The source name exactly as the envelope stores it. */
  name: string
  /** The source media type exactly as the envelope stores it. */
  type: string
  /** The source byte count. */
  size: number
}

/** `crypto.getRandomValues` refuses more than 64 KiB at a time. */
function fillRandom(target: Uint8Array): void {
  for (let offset = 0; offset < target.length; offset += 65536) {
    const n = Math.min(65536, target.length - offset)
    target.set(randomBytes(n), offset)
  }
}

function fixedBytes(value: Uint8Array | undefined, length: number, what: string): Uint8Array {
  if (value === undefined) return randomBytes(length)
  if (value.length !== length) throw new Error(`The ${what} must be ${length} bytes.`)
  return value
}

/**
 * Seal a file into an `FSWNENC2` envelope exactly as Wildbloom's writer
 * does: canonical metadata, the padding bucket, 1 MiB records under a key
 * derived from a fresh input key and a fresh salt, every record bound to
 * the header by its tag. Given a vector's key, salt, nonce prefix and
 * padding rule it reproduces the vector's bytes; given nothing it produces
 * an envelope nobody has seen before, with the key that opens it.
 */
export function encryptEnvelope(
  source: Uint8Array,
  meta: EnvelopeSource,
  opts: EncryptEnvelopeOptions = {},
): EncryptedEnvelope {
  const maxSource = Math.min(opts.maxSourceBytes ?? MAX_UPLOAD_SOURCE_BYTES, MAX_SOURCE_BYTES)
  if (source.length === 0) throw new Error('The file is empty.')
  if (source.length > maxSource) {
    throw new Error(`The file is larger than ${Math.floor(maxSource / (1024 * 1024))} MiB, which is as much as a room will send.`)
  }
  const name = canonicalEnvelopeName(meta.name)
  const type = canonicalEnvelopeType(meta.type)
  // JSON.stringify writes the minimal escaping profile the specification
  // requires, and key order is the order given here.
  const metadata = new TextEncoder().encode(JSON.stringify({ name, size: source.length, type }))
  if (metadata.length > MAX_METADATA_BYTES) throw new Error('The file name is too long to store.')
  const prefix = new Uint8Array(4 + metadata.length)
  new DataView(prefix.buffer).setUint32(0, metadata.length, false)
  prefix.set(metadata, 4)

  const plaintextLength = paddedPlaintextLength(prefix.length + source.length)
  const recordCount = Math.ceil(plaintextLength / CHUNK_BYTES)
  const inputKey = fixedBytes(opts.key, 32, 'key')
  const salt = fixedBytes(opts.salt, SALT_BYTES, 'salt')
  const noncePrefix = fixedBytes(opts.noncePrefix, 8, 'nonce prefix')

  const header = new Uint8Array(HEADER_BYTES_V2)
  header.set(new TextEncoder().encode(MAGIC_V2))
  const view = new DataView(header.buffer)
  view.setUint32(8, CHUNK_BYTES, false)
  view.setUint32(12, recordCount, false)
  header.set(noncePrefix, 16)
  header.set(salt, 24)

  const key = deriveEnvelopeKey(inputKey, salt)
  const envelope = new Uint8Array(HEADER_BYTES_V2 + plaintextLength + recordCount * TAG_BYTES)
  envelope.set(header)
  let written = HEADER_BYTES_V2
  const paddingStart = prefix.length + source.length
  for (let counter = 0; counter < recordCount; counter += 1) {
    const offset = counter * CHUNK_BYTES
    const length = Math.min(CHUNK_BYTES, plaintextLength - offset)
    const plaintext = new Uint8Array(length)
    // Three regions of the logical plaintext may land in this record: the
    // metadata prefix, the source, the padding. Each is copied for the part
    // of it that overlaps this record, which may be none.
    const prefixEnd = Math.min(offset + length, prefix.length)
    if (prefixEnd > offset) plaintext.set(prefix.subarray(offset, prefixEnd), 0)
    const sourceStart = Math.max(offset, prefix.length)
    const sourceEnd = Math.min(offset + length, paddingStart)
    if (sourceEnd > sourceStart) {
      plaintext.set(source.subarray(sourceStart - prefix.length, sourceEnd - prefix.length), sourceStart - offset)
    }
    const padStart = Math.max(offset, paddingStart)
    if (offset + length > padStart) {
      const pad = plaintext.subarray(padStart - offset)
      if (opts.padding) {
        for (let i = 0; i < pad.length; i += 1) pad[i] = opts.padding(padStart + i) & 0xff
      } else {
        fillRandom(pad)
      }
    }
    const sealed = gcm(key, nonceFor(noncePrefix, counter), aadFor(header, counter)).encrypt(plaintext)
    plaintext.fill(0)
    envelope.set(sealed, written)
    written += sealed.length
  }
  key.fill(0)
  return { envelope, sha256: sha256Hex(envelope), key: bytesToHex(inputKey), name, type, size: source.length }
}

// ---------------------------------------------------------------------------
// The Blossom upload
// ---------------------------------------------------------------------------

/** BUD-01's authorisation event kind. */
export const BLOSSOM_AUTH_KIND = 24242
/** NIP-94's file metadata kind. */
export const FILE_EVENT_KIND = 1063
/** How long an upload authorisation is good for. Wildbloom's own figure;
 *  BUD-01 servers refuse one that is not short-lived. */
export const UPLOAD_AUTHORISATION_LIFETIME_SECONDS = 90
const MAX_DESCRIPTOR_BYTES = 64 * 1024

/**
 * A Blossom server as an https origin and nothing else: no path, query,
 * fragment or credentials, because the authorisation names a host and the
 * upload goes to `/upload` under it. Throws on anything else, so a
 * mistyped setting is refused before a byte is sealed.
 */
export function normaliseBlossomServer(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('The Blossom server must be an https URL.')
  }
  if (url.protocol !== 'https:') throw new Error('The Blossom server must be an https URL.')
  if (url.username || url.password) throw new Error('The Blossom server must not carry credentials.')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The Blossom server must be an origin only, without a path, query or fragment.')
  }
  return url.origin
}

/**
 * The unsigned kind-24242 event that authorises one upload of one blob to
 * one host, built the way Wildbloom builds it, so a server that takes
 * Wildbloom's uploads takes these. `created_at` sits a second in the past
 * because BUD-01 requires it to be, and a strict clock would refuse "now".
 */
export function buildUploadAuthorisation(
  sha256: string,
  server: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): EventTemplate {
  const hash = sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('The blob hash must be 64 hex characters.')
  const hostname = new URL(normaliseBlossomServer(server)).hostname.toLowerCase()
  const createdAt = Math.max(0, nowSeconds - 1)
  return {
    kind: BLOSSOM_AUTH_KIND,
    created_at: createdAt,
    tags: [
      ['t', 'upload'],
      ['expiration', String(createdAt + UPLOAD_AUTHORISATION_LIFETIME_SECONDS)],
      ['server', hostname],
      ['x', hash],
    ],
    content: `Upload blob ${hash} to ${hostname}`,
  }
}

/** The `Authorization` header value for a signed authorisation: `Nostr`
 *  and the event JSON in standard base64 with padding, which is what
 *  BUD-01 asks for and what strict servers check. */
export function encodeBlossomAuthorisation(event: Event): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Nostr ${btoa(binary)}`
}

/** What a Blossom server says about a blob it has taken. */
export interface BlossomDescriptor {
  /** Where the blob is served, on the server it was sent to. */
  url: string
  sha256: string
  size: number
  type?: string
}

export interface UploadEnvelopeOptions {
  /** Signs the authorisation. Whatever key signs it is the key the server
   *  sees, and the only thing it learns about who uploaded. */
  sign: (template: EventTemplate) => Promise<Event> | Event
  /** Injectable, for tests and for a runtime with its own fetch. */
  fetch?: typeof fetch
  /** Unix seconds. Injectable for tests. */
  now?: () => number
  signal?: AbortSignal
}

function sameTemplate(template: EventTemplate, event: Event): boolean {
  return (
    event.kind === template.kind &&
    event.created_at === template.created_at &&
    event.content === template.content &&
    JSON.stringify(event.tags) === JSON.stringify(template.tags)
  )
}

function safeReason(value: string | null): string {
  if (!value) return ''
  return value.replace(CONTROLS_ALL, ' ').trim().slice(0, 200)
}

/**
 * Put an envelope on a Blossom server (BUD-01: `PUT /upload`, the signed
 * authorisation in the `Authorization` header, the hash in `X-SHA-256`)
 * and return where it landed. The descriptor the server answers with is
 * held to the bytes that were sent: the same hash, the same size, a URL on
 * the same origin naming that hash. Anything else is a server that stored
 * something other than what it was given, and is refused.
 *
 * Errors are one plain line each and never carry the key, which this
 * function is never given.
 */
export async function uploadEnvelope(
  server: string,
  envelope: Uint8Array,
  opts: UploadEnvelopeOptions,
): Promise<BlossomDescriptor> {
  const origin = normaliseBlossomServer(server)
  const doFetch = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const hash = sha256Hex(envelope)
  const template = buildUploadAuthorisation(hash, origin, now())
  const signed = await opts.sign(template)
  if (!sameTemplate(template, signed) || !verifyEventUncached(signed)) {
    throw new Error('The signer did not sign the upload authorisation as written.')
  }
  let response: Response
  try {
    response = await doFetch(`${origin}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: encodeBlossomAuthorisation(signed),
        'Content-Type': ENVELOPE_MEDIA_TYPE,
        'X-SHA-256': hash,
      },
      body: envelope.slice().buffer as ArrayBuffer,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('The upload was cancelled.')
    throw new Error(`Could not reach ${new URL(origin).hostname}.`)
  }
  if (response.status !== 200 && response.status !== 201) {
    const reason = safeReason(response.headers.get('X-Reason'))
    if (response.status === 401 || response.status === 403) {
      throw new Error(`The server refused the upload authorisation (${response.status}${reason ? `: ${reason}` : ''}).`)
    }
    if (response.status === 413) throw new Error('The server will not take a file this big (413).')
    throw new Error(`The server answered ${response.status}${reason ? `: ${reason}` : ''}.`)
  }
  const text = await response.text()
  if (text.length > MAX_DESCRIPTOR_BYTES) throw new Error('The server answered with more than a blob descriptor.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The server did not answer with a blob descriptor.')
  }
  return checkDescriptor(parsed, origin, hash, envelope.length)
}

function checkDescriptor(value: unknown, origin: string, hash: string, size: number): BlossomDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The server did not answer with a blob descriptor.')
  }
  const d = value as Record<string, unknown>
  if (typeof d.sha256 !== 'string' || d.sha256.toLowerCase() !== hash) {
    throw new Error('The server stored different bytes from the ones it was sent.')
  }
  if (typeof d.size !== 'number' || d.size !== size) throw new Error('The server stored a different size from the one it was sent.')
  if (typeof d.url !== 'string') throw new Error('The server did not say where the blob is.')
  let url: URL
  try {
    url = new URL(d.url)
  } catch {
    throw new Error('The server did not say where the blob is.')
  }
  if (url.origin !== origin || url.search || url.hash) throw new Error('The server put the blob somewhere other than itself.')
  const leaf = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (!new RegExp(`^${hash}(?:\\.[a-z0-9]{1,10})?$`).test(leaf)) {
    throw new Error('The server did not address the blob by its hash.')
  }
  const out: BlossomDescriptor = { url: url.toString(), sha256: hash, size }
  if (typeof d.type === 'string' && d.type.length <= 255 && !CONTROLS.test(d.type)) out.type = d.type.toLowerCase()
  return out
}

/**
 * The unsigned kind-1063 (NIP-94) event that announces an uploaded
 * envelope, with every tag Wildbloom writes, so a Wildbloom client
 * resolves it as one of its own: `url`, `m`, `x` and `ox` (the same hash,
 * since the envelope is what was uploaded and nothing transformed it),
 * `size`, `encryption` and `alt`. The content is Wildbloom's fixed
 * envelope name. Nothing here says what the file is.
 */
export function buildFileEvent(
  descriptor: { url: string; sha256: string; size: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): EventTemplate {
  const hash = descriptor.sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('The blob hash must be 64 hex characters.')
  if (!/^https:\/\//i.test(descriptor.url)) throw new Error('The blob URL must be https.')
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) throw new Error('The blob size must be a positive integer.')
  return {
    kind: FILE_EVENT_KIND,
    created_at: nowSeconds,
    tags: [
      ['url', descriptor.url],
      ['m', ENVELOPE_MEDIA_TYPE],
      ['x', hash],
      ['ox', hash],
      ['size', String(descriptor.size)],
      ['encryption', ENVELOPE_SCHEME],
      ['alt', 'Encrypted Wildbloom file'],
    ],
    content: ENVELOPE_FILE_NAME,
  }
}
