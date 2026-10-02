/**
 * The unsigned body of a VMLS/1 `leaf-binding/1`, read the way the MLS device
 * vault must read it before it signs (Vennel MLS contract §6.2, review
 * packet S1). A port of the binding parts of Vennel's independent reader
 * (`vectors/vmls-reader.mjs`), which itself follows `vmls-core`'s
 * `binding.rs` check for check: the same order, the same stable error codes.
 *
 * Only the seven-key unsigned body is accepted here. A signed eight-key
 * binding, an opaque digest without its body, or any body with extra bytes is
 * refused, so the vault can never be asked to sign something it has not read.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { getEventHash, verifyEvent, type Event } from 'nostr-tools/pure'

/** The stable `vmls_core::ErrorCode` names this reader can return. */
export type BindingErrorCode =
  | 'Malformed' | 'NonCanonical' | 'UnsupportedVersion' | 'TooLarge'
  | 'BadLeafIdentity' | 'BadDeviceKey' | 'BindingExpired' | 'BindingOutlivesCredential'
  | 'CredentialMalformed' | 'CredentialSignatureInvalid' | 'CredentialNotPersonScoped'
  | 'CredentialWrongIdentity' | 'CredentialWrongDevice' | 'CredentialExpired'
  | 'CredentialLifetimeTooLong' | 'CredentialRevoked' | 'CredentialNotYetValid'

export class BindingError extends Error {
  constructor(readonly code: BindingErrorCode) { super(code) }
}

const fail = (code: BindingErrorCode): never => { throw new BindingError(code) }

/** A completed binding (body, key 8 and a 64-byte signature) fits in this. */
export const MAX_BINDING_BYTES = 8192
/** Key 8's header and the signature's: `08 58 40` and 64 bytes. */
const SIGNATURE_FIELD_BYTES = 3 + 64
export const MAX_UNSIGNED_BODY_BYTES = MAX_BINDING_BYTES - SIGNATURE_FIELD_BYTES
export const BINDING_SIGNATURE_TAG = 'VMLS/1 leaf-binding'
export const DEVICE_CREDENTIAL_KIND = 20460
export const MAX_PERSON_CREDENTIAL_SECONDS = 30 * 86_400
export const MAX_CREATED_AT_SKEW_SECONDS = 600
const CREDENTIAL_IDENTITY_PREFIX = utf8ToBytes('vmls1')
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

// ---- a streaming reader: the same checks, in the same order, as cbor.rs ----

// ignoreBOM: a leading U+FEFF is text, as it is to cbor.rs; never stripped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const ALLOWED_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])
const WIDTHS: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 }
const MINIMUMS: Record<number, bigint> = { 1: 24n, 2: 0x100n, 4: 0x10000n, 8: 0x100000000n }

class Reader {
  at = 0
  constructor(private readonly input: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.at + n > this.input.length) fail('Malformed')
    const out = this.input.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  head(major: number): bigint {
    const initial = this.take(1)[0]!
    if (initial >> 5 !== major) fail('NonCanonical')
    const info = initial & 0x1f
    if (info < 24) return BigInt(info)
    const width = WIDTHS[info]
    if (width === undefined) return fail('NonCanonical')
    let value = 0n
    for (const byte of this.take(width)) value = (value << 8n) | BigInt(byte)
    if (value < MINIMUMS[width]!) fail('NonCanonical')
    return value
  }
  bounded(major: number, max: number): number {
    const n = this.head(major)
    if (n > BigInt(max)) fail('TooLarge')
    return Number(n)
  }
  map(n: number): void { if (this.head(5) !== BigInt(n)) fail('NonCanonical') }
  key(k: number): void { if (this.head(0) !== BigInt(k)) fail('NonCanonical') }
  timestamp(): number {
    const value = this.head(0)
    if (value > MAX_SAFE) fail('Malformed')
    return Number(value)
  }
  fixed(n: number): Uint8Array {
    if (this.head(2) !== BigInt(n)) fail('Malformed')
    return this.take(n)
  }
  text(max: number): string {
    const raw = this.take(this.bounded(3, max))
    let text = ''
    try { text = utf8.decode(raw) } catch { fail('Malformed') }
    if (raw.some(b => b < 0x20 && !ALLOWED_CONTROLS.has(b))) fail('Malformed')
    return text
  }
  arrayLen(max: number): number { return this.bounded(4, max) }
  finish(): void { if (this.at !== this.input.length) fail('NonCanonical') }
}

/** What the vault signs over, read from the unsigned body. */
export interface UnsignedBinding {
  /** The exact body bytes; the digest is computed over these. */
  body: Uint8Array
  /** `vmls1` followed by the 32-byte leaf id. */
  identity: Uint8Array
  leafId: Uint8Array
  signatureKey: Uint8Array
  /** The embedded kind-20460 person credential. */
  event: Event
  device: Uint8Array
  expiresAt: number
  homeBox: Uint8Array
}

/** Reads a seven-key unsigned `leaf-binding/1` body, and nothing else. */
export function readUnsignedBinding(body: Uint8Array): UnsignedBinding {
  if (body.length > MAX_UNSIGNED_BODY_BYTES) fail('TooLarge')
  const r = new Reader(body)
  r.map(7)
  r.key(1); if (r.head(0) !== 1n) fail('UnsupportedVersion')
  r.key(2); const identity = r.fixed(37).slice()
  if (!same(identity.subarray(0, 5), CREDENTIAL_IDENTITY_PREFIX)) fail('BadLeafIdentity')
  r.key(3); const signatureKey = r.fixed(32).slice()
  r.key(4); r.map(5)
  r.key(1); const pubkey = bytesToHex(r.fixed(32))
  r.key(2); const createdAt = r.timestamp()
  r.key(3)
  const tags: string[][] = []
  for (let i = r.arrayLen(16); i > 0; i--) {
    const n = r.arrayLen(8)
    if (n === 0) fail('Malformed')
    const tag: string[] = []
    for (let j = 0; j < n; j++) tag.push(r.text(512))
    tags.push(tag)
  }
  r.key(4); const content = r.text(1024)
  r.key(5); const sig = bytesToHex(r.fixed(64))
  r.key(5); const device = r.fixed(32).slice()
  r.key(6); const expiresAt = r.timestamp()
  r.key(7); const homeBox = r.fixed(32).slice()
  r.finish()
  const event = { kind: DEVICE_CREDENTIAL_KIND, pubkey, created_at: createdAt, tags, content, sig, id: '' }
  return { body: body.slice(), identity, leafId: identity.slice(5), signatureKey, event, device, expiresAt, homeBox }
}

/** `SHA-256(UTF8("VMLS/1 leaf-binding") || body)`: what the device signs. */
export function bindingDigest(body: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(BINDING_SIGNATURE_TAG), body))
}

export interface PersonCredential {
  /** The credential's event id. */
  id: string
  identity: string
  device: string
  expiresAt: number
}

/**
 * The person-credential rules of `DeviceCredential::verify_person`: a valid
 * NIP-01 signature, `d` equal to the signer, `scope=person`, one `device`,
 * one canonical `expiration` in the future, not issued more than ten minutes
 * ahead, at most 30 days long, and not revoked.
 */
export function verifyPersonCredential(
  event: Pick<Event, 'kind' | 'pubkey' | 'created_at' | 'tags' | 'content' | 'sig'>,
  now: number,
  expectedIdentity?: string,
  revoked: ReadonlySet<string> = new Set(),
): PersonCredential {
  if (event.kind !== DEVICE_CREDENTIAL_KIND) fail('CredentialMalformed')
  const id = getEventHash(event)
  if (!verifyEvent({ ...event, id })) fail('CredentialSignatureInvalid')
  const only = (name: string): string | undefined => {
    const found = event.tags.filter(tag => tag[0] === name)
    if (found.length > 1) fail('CredentialMalformed')
    return found.length ? (found[0]![1] ?? '') : undefined
  }
  const d = only('d'), scope = only('scope')
  if (d !== event.pubkey || scope !== 'person') fail('CredentialNotPersonScoped')
  if (expectedIdentity !== undefined && expectedIdentity !== event.pubkey) fail('CredentialWrongIdentity')
  const device = only('device')
  if (device === undefined || !/^[0-9a-f]{64}$/.test(device)) return fail('CredentialMalformed')
  const expiration = only('expiration')
  if (expiration === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(expiration) || Number(expiration) > Number.MAX_SAFE_INTEGER) return fail('CredentialMalformed')
  const expiresAt = Number(expiration)
  if (expiresAt <= now) fail('CredentialExpired')
  if (event.created_at > now + MAX_CREATED_AT_SKEW_SECONDS) fail('CredentialNotYetValid')
  if (expiresAt - event.created_at > MAX_PERSON_CREDENTIAL_SECONDS || expiresAt - now > MAX_PERSON_CREDENTIAL_SECONDS) fail('CredentialLifetimeTooLong')
  if (revoked.has(id)) fail('CredentialRevoked')
  return { id, identity: event.pubkey, device, expiresAt }
}

/**
 * Everything the vault checks of an unsigned body before signing it with
 * `device`: the device key is a curve point, the credential is a valid
 * person credential for `expectedIdentity` naming `device`, and the binding
 * is unexpired and does not outlive the credential.
 */
export function checkUnsignedBinding(
  binding: UnsignedBinding,
  now: number,
  expectedIdentity: string,
  revoked: ReadonlySet<string> = new Set(),
): PersonCredential {
  try { secp256k1.Point.fromHex('02' + bytesToHex(binding.device)) } catch { fail('BadDeviceKey') }
  const credential = verifyPersonCredential(binding.event, now, expectedIdentity, revoked)
  if (credential.device !== bytesToHex(binding.device)) fail('CredentialWrongDevice')
  if (binding.expiresAt <= now) fail('BindingExpired')
  if (binding.expiresAt > credential.expiresAt) fail('BindingOutlivesCredential')
  return credential
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
