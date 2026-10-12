/** The ordinary-state frame is custody, never membership or rollback authority.
 * Names and values exist only inside the authenticated whole image. Mutable
 * encoding buffers are wiped; immutable JavaScript strings cannot be erased. */
// Acceptance profile, not a browser quota or memory guarantee. Older v1
// clients only accepted 2 MiB values / 8 MiB images: production must fence
// that profile too, even when a new frame still fits the old image ceiling.
export const ORDINARY_IMAGE_BYTES = 32 * 1024 * 1024
export const ORDINARY_RECORDS = 16_384
export const ORDINARY_FENCES = 4_096
export const ORDINARY_NAME_UNITS = 512
export const ORDINARY_VALUE_UNITS = 2 * 1024 * 1024
/** Existing family validators retain their independent UTF-16 shape bound
 * above. The codec and encrypted-journal profile measure raw UTF-8 bytes. */
export const ORDINARY_VALUE_BYTES = 8 * 1024 * 1024
const HEX = /^[0-9a-f]{64}$/
export type OrdinaryPurpose = 'browser' | `tab:${string}`
export interface OrdinaryMigration {
  phase: 'sealed' | 'cleaning' | 'complete'
  /** Exact legacy values still awaiting recorded cleanup; empty after completion. */
  sources: ReadonlyMap<string, string>
  /** All snapshotted source names, including those already removed. */
  names: readonly string[]
}
export interface OrdinaryImage {
  purpose: OrdinaryPurpose
  keyId: string
  generation: string
  revision: number
  /** Browser custody has no lease (zero); tab custody has an exact expiry. */
  expiresAt: number
  records: ReadonlyMap<string, string>
  migration?: OrdinaryMigration
  /** A deletion fence is never evicted merely to admit another one. */
  fences: ReadonlyMap<string, number>
}
export interface OrdinaryFrame {
  version: 1
  purpose: OrdinaryPurpose
  keyId: string
  generation: string
  revision: number
  expiresAt: number
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}
export class OrdinaryStateHold extends Error {
  constructor() { super('Protected browser storage could not be verified.'); this.name = 'OrdinaryStateHold' }
}
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
/** Count without allocating an encoded copy. Matches TextEncoder, including
 * its three-byte replacement for an unpaired UTF-16 surrogate. */
export function ordinaryUtf8Length(value: string, limit = ORDINARY_VALUE_BYTES): number {
  if (value.length > limit) hold() // UTF-8 cannot use fewer bytes than UTF-16 units.
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
    if (bytes > limit) hold()
  }
  return bytes
}
/** Exact canonical JSON UTF-8 size for the already validated, array-only
 * tuple. Stop at the ceiling before JSON.stringify can allocate a huge image.
 * Unlike raw UTF-8, JSON preserves lone surrogates as six-byte escapes. */
function canonicalBytes(value: unknown, budget: { left: number }): void {
  const take = (n: number) => { budget.left -= n; if (budget.left < 0) hold() }
  if (typeof value === 'string') {
    take(2)
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i)
      if (c === 0x22 || c === 0x5c || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) take(2)
      else if (c < 0x20) take(6)
      else if (c < 0x80) take(1)
      else if (c < 0x800) take(2)
      else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { take(4); i++ }
      else take(c >= 0xd800 && c <= 0xdfff ? 6 : 3)
    }
  } else if (Array.isArray(value)) {
    take(2 + Math.max(0, value.length - 1))
    for (const item of value) canonicalBytes(item, budget)
  } else if (value === null) take(4)
  else if (typeof value === 'number' && integer(value)) take(String(value).length)
  else hold()
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function purpose(value: unknown): value is OrdinaryPurpose {
  return value === 'browser' || typeof value === 'string' && value.startsWith('tab:') && value.length === 68 && HEX.test(value.slice(4))
}
function header(value: Pick<OrdinaryImage, 'purpose' | 'keyId' | 'generation' | 'revision' | 'expiresAt'>): void {
  if (!purpose(value.purpose) || typeof value.keyId !== 'string' || value.keyId.length !== 64 || !HEX.test(value.keyId) ||
      typeof value.generation !== 'string' || value.generation.length !== 64 || !HEX.test(value.generation) ||
      !integer(value.revision) || !integer(value.expiresAt) ||
      (value.purpose === 'browser' ? value.expiresAt !== 0 : value.expiresAt === 0)) hold()
}
function pairs(input: unknown, max: number, numbers: boolean, revision: number): [string, string | number][] {
  if (!Array.isArray(input) || input.length > max) hold()
  let previous: string | undefined
  let units = 0
  for (const row of input) {
    if (!Array.isArray(row) || row.length !== 2 || !text(row[0], ORDINARY_NAME_UNITS) ||
        (previous !== undefined && row[0] <= previous) ||
        (numbers ? !integer(row[1]) || row[1] > revision : typeof row[1] !== 'string' || row[1].length > ORDINARY_VALUE_BYTES)) hold()
    // A cheap necessary aggregate bound caps subsequent UTF-8 scanning too,
    // even if thousands of entries share the same large string object.
    units += row[0].length + (numbers ? 0 : row[1].length)
    if (units > ORDINARY_IMAGE_BYTES) hold()
    if (!numbers) ordinaryUtf8Length(row[1])
    previous = row[0]
  }
  return input as [string, string | number][]
}
function names(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > ORDINARY_RECORDS) hold()
  let previous: string | undefined
  for (const name of input) {
    if (!text(name, ORDINARY_NAME_UNITS) || previous !== undefined && name <= previous) hold()
    previous = name
  }
  return input as string[]
}
const sorted = <T>(entries: ReadonlyMap<string, T>) => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
function tuple(image: OrdinaryImage): unknown[] {
  header(image)
  const records = sorted(image.records)
  const fences = sorted(image.fences)
  pairs(records, ORDINARY_RECORDS, false, image.revision)
  pairs(fences, ORDINARY_FENCES, true, image.revision)
  const migration = image.migration
  let manifest: unknown = null
  if (migration) {
    const sources = sorted(migration.sources)
    pairs(sources, ORDINARY_RECORDS, false, image.revision)
    const declared = [...migration.names].sort()
    names(declared)
    const declaredNames = new Set(declared)
    if (!['sealed', 'cleaning', 'complete'].includes(migration.phase) ||
        (migration.phase === 'complete' ? sources.length !== 0 : migration.phase === 'sealed' ? sources.length !== declared.length || sources.some(([name], i) => name !== declared[i]) : sources.some(([name]) => !declaredNames.has(name)))) hold()
    manifest = [migration.phase, sources, declared]
  }
  return [1, image.purpose, image.keyId, image.generation, image.revision, image.expiresAt, records, manifest, fences]
}
function checkedTuple(image: OrdinaryImage): { value: unknown[]; bytes: number } {
  const value = tuple(image)
  const budget = { left: ORDINARY_IMAGE_BYTES }
  canonicalBytes(value, budget)
  return { value, bytes: ORDINARY_IMAGE_BYTES - budget.left }
}
/** Validate and size without allocating the whole canonical string or bytes. */
export function ordinaryImageByteLength(image: OrdinaryImage): number { return checkedTuple(image).bytes }
export function encodeOrdinaryImage(image: OrdinaryImage): Uint8Array<ArrayBuffer> {
  const checked = checkedTuple(image), value = checked.value
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.length !== checked.bytes || bytes.length > ORDINARY_IMAGE_BYTES) { bytes.fill(0); hold() }
  return bytes
}
export function decodeOrdinaryImage(bytes: Uint8Array): OrdinaryImage {
  if (bytes.length > ORDINARY_IMAGE_BYTES) hold()
  let value: unknown
  let encoded: string
  try { encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(encoded) }
  catch { hold() }
  if (!Array.isArray(value) || value.length !== 9 || value[0] !== 1) hold()
  const image: OrdinaryImage = {
    purpose: value[1], keyId: value[2], generation: value[3], revision: value[4], expiresAt: value[5],
    records: new Map(pairs(value[6], ORDINARY_RECORDS, false, value[4]) as [string, string][]),
    fences: new Map(pairs(value[8], ORDINARY_FENCES, true, value[4]) as [string, number][]),
  }
  if (value[7] !== null) {
    const manifest = value[7]
    if (!Array.isArray(manifest) || manifest.length !== 3) hold()
    image.migration = { phase: manifest[0], sources: new Map(pairs(manifest[1], ORDINARY_RECORDS, false, image.revision) as [string, string][]), names: names(manifest[2]) }
  }
  // Re-encoding also validates the header/manifest and rejects noncanonical
  // numbers, whitespace, duplicate entries and alternate JSON spellings.
  if (JSON.stringify(tuple(image)) !== encoded) hold()
  return image
}
function aad(frame: OrdinaryFrame): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['kithmoot.ordinary-state', frame.version,
    frame.purpose, frame.keyId, frame.generation, frame.revision, frame.expiresAt, 'active']))
}
function frameFields(value: OrdinaryFrame): void {
  if (value.version !== 1 || !(value.nonce instanceof ArrayBuffer) || value.nonce.byteLength !== 12 ||
      !(value.ciphertext instanceof ArrayBuffer) || value.ciphertext.byteLength < 16 || value.ciphertext.byteLength > ORDINARY_IMAGE_BYTES + 16) hold()
  header(value)
}
/** Reject accessor-backed input, then validate an owned, bounded clone. */
export function validateOrdinaryFrame(raw: unknown): OrdinaryFrame {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) hold()
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    if (Reflect.ownKeys(descriptors).some(name => typeof name !== 'string') ||
        Object.keys(descriptors).sort().join(',') !== 'ciphertext,expiresAt,generation,keyId,nonce,purpose,revision,version' ||
        Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) hold()
    // Read descriptor values once. Never re-read the caller while cloning.
    const snapshot = Object.fromEntries(Object.entries(descriptors).map(([name, d]) => [name, d.value])) as unknown as OrdinaryFrame
    frameFields(snapshot)
    const owned = structuredClone(snapshot)
    frameFields(owned)
    return owned
  } catch { return hold() }
}
export function validateOrdinaryKey(key: unknown): CryptoKey {
  if (!(key instanceof CryptoKey) || key.type !== 'secret' || key.extractable || key.algorithm.name !== 'AES-GCM' ||
      (key.algorithm as AesKeyAlgorithm).length !== 256 || [...key.usages].sort().join(',') !== 'decrypt,encrypt') hold()
  return key
}
export function sameOrdinaryFrame(a?: OrdinaryFrame, b?: OrdinaryFrame): boolean {
  if (!a || !b) return a === b
  const equal = (x: ArrayBuffer, y: ArrayBuffer) => {
    if (x.byteLength !== y.byteLength) return false
    const left = new Uint8Array(x), right = new Uint8Array(y)
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
    return true
  }
  return a.version === b.version && a.purpose === b.purpose && a.keyId === b.keyId && a.generation === b.generation &&
    a.revision === b.revision && a.expiresAt === b.expiresAt && equal(a.nonce, b.nonce) && equal(a.ciphertext, b.ciphertext)
}
/** One candidate frame. The owner keeps it byte-exact through unknown outcomes. */
export async function sealOrdinaryImage(image: OrdinaryImage, key: CryptoKey, crypto: Crypto = globalThis.crypto): Promise<OrdinaryFrame> {
  validateOrdinaryKey(key)
  const plaintext = encodeOrdinaryImage(image)
  const frame: OrdinaryFrame = { version: 1, purpose: image.purpose, keyId: image.keyId,
    generation: image.generation, revision: image.revision, expiresAt: image.expiresAt,
    nonce: new ArrayBuffer(12), ciphertext: new ArrayBuffer(0) }
  try {
    crypto.getRandomValues(new Uint8Array(frame.nonce))
    frame.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: frame.nonce, additionalData: aad(frame), tagLength: 128 }, key, plaintext as Uint8Array<ArrayBuffer>)
    return frame
  } finally { plaintext.fill(0) }
}
export async function openOrdinaryFrame(raw: unknown, key: CryptoKey, crypto: Crypto = globalThis.crypto): Promise<OrdinaryImage> {
  validateOrdinaryKey(key)
  // Clone before crypto awaits: callers cannot retarget metadata or ciphertext.
  let plaintext: Uint8Array | undefined
  try {
    const frame = validateOrdinaryFrame(raw)
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frame.nonce, additionalData: aad(frame), tagLength: 128 }, key, frame.ciphertext))
    const image = decodeOrdinaryImage(plaintext)
    if (image.purpose !== frame.purpose || image.keyId !== frame.keyId || image.generation !== frame.generation ||
        image.revision !== frame.revision || image.expiresAt !== frame.expiresAt) hold()
    return image
  } catch { return hold() }
  finally { plaintext?.fill(0) }
}
