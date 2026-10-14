import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { OrdinaryStateHold, ordinaryUtf8Length, validateOrdinaryFrame, validateOrdinaryKey,
  type OrdinaryFrame, type OrdinaryPurpose } from './ordinary-state-codec.js'

/** Local custody only. A journal is neither current signer/membership authority
 * nor independent rollback protection. Only the native controller may advance it. */
export const ORDINARY_OPERATION_BYTES = 4 * 1024 * 1024
export const ORDINARY_OPERATION_DATA_BYTES = 1024 * 1024
export const ORDINARY_OPERATION_PREFIX = 'kithmoot.operation-journal.v1.'
export const ORDINARY_OPERATION_CONTROL_PREFIX = 'journal:tab:'
const HEX = /^[0-9a-f]{64}$/, TAB = /^tab:[0-9a-f]{64}$/
const isTab = (v: unknown): v is `tab:${string}` => typeof v === 'string' && v.length === 68 && TAB.test(v)
export type OrdinaryOperationPhase = 'prepared' | 'provider-started' | 'provider-returned' | 'candidate-committed' | 'settled'
export interface OrdinaryOperationJournal {
  readonly version: 1
  readonly id: string
  readonly tab: `tab:${string}`
  readonly sequence: number
  readonly phase: OrdinaryOperationPhase
  readonly source: readonly [string, string]
  readonly enrolled: readonly [string, string]
  readonly target: readonly [string, string] | null
  readonly sourceRevisions: readonly [number, number]
  readonly enrolledRevisions: readonly [number, number]
  readonly targetRevisions: readonly [number, number] | null
  readonly requestDigest: string
  readonly resultDigest: string | null
  /** Exact native scopes and immutable deadlines, interpreted by the producer. */
  readonly scopes: readonly (readonly [OrdinaryPurpose, string, string, number])[]
  readonly ceilings: readonly number[]
  /** Bounded canonical producer records. The codec does not authenticate their meaning. */
  readonly request: string
  readonly result: string | null
  readonly secrets: readonly Uint8Array<ArrayBuffer>[]
  readonly nonces: readonly [string, string] | null
}
export interface OrdinaryOperationBinding {
  readonly purpose: OrdinaryPurpose
  readonly keyId: string
  readonly generation: string
  readonly expiresAt: number
}
interface Cipher { nonce: ArrayBuffer; ciphertext: ArrayBuffer }
export interface OrdinaryOperationControl { readonly version: 1; readonly browser: Cipher; readonly tab: Cipher }
function hold(): never { throw new OrdinaryStateHold() }
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
function dataObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) hold()
  const descriptors = Object.getOwnPropertyDescriptors(raw)
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string') ||
      Object.keys(descriptors).sort().join(',') !== [...fields].sort().join(',') ||
      Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) hold()
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]))
}
function dataArray(raw: unknown, maximum: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > maximum) hold()
  const descriptors = Object.getOwnPropertyDescriptors(raw)
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) hold()
  const result: unknown[] = []
  for (let i = 0; i < raw.length; i++) {
    const d = descriptors[String(i)]
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) hold()
    result.push(d.value)
  }
  return result
}
function secretBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype) hold()
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 32 || keys.some((key, i) => key !== String(i))) hold()
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    const d = descriptors[String(i)]!
    if (!Object.hasOwn(d, 'value') || !d.enumerable || !integer(d.value) || d.value > 255) hold()
    bytes[i] = d.value
  }
  // Descriptor checks reject shadow accessors before reading native storage.
  if (!(raw.buffer instanceof ArrayBuffer)) { bytes.fill(0); hold() }
  return bytes
}
const hash = (v: unknown): string => { if (typeof v !== 'string' || v.length !== 64 || !HEX.test(v)) hold(); return v }
function digestPair(raw: unknown): [string, string] {
  const values = dataArray(raw, 2); if (values.length !== 2) hold()
  return [hash(values[0]), hash(values[1])]
}
function revisionPair(raw: unknown): [number, number] {
  const v = dataArray(raw, 2)
  if (v.length !== 2 || v.some(x => !integer(x))) hold()
  return v as [number, number]
}
export interface OrdinaryOperationClassification extends Omit<OrdinaryOperationJournal, 'request' | 'result' | 'secrets' | 'nonces'> {
  readonly requestBytes: number
  readonly resultBytes: number | null
  readonly secretCount: number
  readonly hasNonces: boolean
}
const META = ['version', 'id', 'tab', 'sequence', 'phase', 'source', 'enrolled', 'target', 'sourceRevisions', 'enrolledRevisions', 'targetRevisions', 'scopes', 'ceilings', 'requestDigest', 'resultDigest'] as const
function classification(raw: unknown): OrdinaryOperationClassification {
  const v = dataObject(raw, [...META, 'requestBytes', 'resultBytes', 'secretCount', 'hasNonces'])
  if (v.version !== 1 || !isTab(v.tab) || !integer(v.sequence) || v.sequence === 0 ||
      !['prepared', 'provider-started', 'provider-returned', 'candidate-committed', 'settled'].includes(v.phase as string)) hold()
  const scopes = dataArray(v.scopes, 32).map(rawScope => {
    const s = dataArray(rawScope, 4)
    if (s.length !== 4 || s[0] !== 'browser' && s[0] !== v.tab || typeof s[1] !== 'string' ||
        !s[1].length || s[1].length > 512 || !integer(s[3])) hold()
    ordinaryUtf8Length(s[1], 2048)
    return [s[0] as OrdinaryPurpose, s[1], hash(s[2]), s[3]] as const
  })
  if (!scopes.some(s => s[0] === 'browser') || !scopes.some(s => s[0] === v.tab) ||
      new Set(scopes.map(s => s[0] + '\0' + s[1])).size !== scopes.length ||
      scopes.some((s, i) => i > 0 && scopes[i - 1]![0] + '\0' + scopes[i - 1]![1] >= s[0] + '\0' + s[1])) hold()
  const ceilings = dataArray(v.ceilings, 16)
  if (!ceilings.length || ceilings.some(c => !integer(c))) hold()
  if (!integer(v.requestBytes) || v.requestBytes > ORDINARY_OPERATION_DATA_BYTES ||
      v.resultBytes !== null && (!integer(v.resultBytes) || v.resultBytes > ORDINARY_OPERATION_DATA_BYTES) ||
      !integer(v.secretCount) || v.secretCount > 128 || typeof v.hasNonces !== 'boolean') hold()
  const phase = v.phase as OrdinaryOperationPhase, source = digestPair(v.source), enrolled = digestPair(v.enrolled), target = v.target === null ? null : digestPair(v.target)
  const sourceRevisions = revisionPair(v.sourceRevisions), enrolledRevisions = revisionPair(v.enrolledRevisions), targetRevisions = v.targetRevisions === null ? null : revisionPair(v.targetRevisions)
  if ((target === null) !== (targetRevisions === null) || enrolled.some((d, i) => d === source[i]) || target?.some((d, i) => d === enrolled[i] || d === source[i]) ||
      enrolledRevisions.some((r, i) => sourceRevisions[i]! >= Number.MAX_SAFE_INTEGER || r !== sourceRevisions[i]! + 1) ||
      targetRevisions?.some((r, i) => enrolledRevisions[i]! >= Number.MAX_SAFE_INTEGER || r !== enrolledRevisions[i]! + 1)) hold()
  const returned = phase === 'provider-returned' || phase === 'candidate-committed' || phase === 'settled'
  const requestDigest = hash(v.requestDigest), resultDigest = v.resultDigest === null ? null : hash(v.resultDigest)
  if (returned === (resultDigest === null)) hold()
  if (phase === 'settled') {
    if (v.requestBytes || v.resultBytes !== null || v.secretCount || v.hasNonces || target === null) hold()
  } else {
    if (!v.requestBytes) hold()
    if (phase === 'prepared' && (v.secretCount || v.hasNonces)) hold()
    if (phase === 'provider-started' || phase === 'provider-returned') {
      if (!v.secretCount || !v.hasNonces) hold()
    }
    if (phase === 'candidate-committed' && (v.secretCount || v.hasNonces)) hold()
    const returned = phase === 'provider-returned' || phase === 'candidate-committed'
    if (returned ? !v.resultBytes || target === null : v.resultBytes !== null || target !== null) hold()
  }
  return { version: 1, id: hash(v.id), tab: v.tab as `tab:${string}`, sequence: v.sequence, phase,
    source, enrolled, target, sourceRevisions, enrolledRevisions, targetRevisions, requestDigest, resultDigest, scopes, ceilings: ceilings as number[],
    requestBytes: v.requestBytes, resultBytes: v.resultBytes as number | null, secretCount: v.secretCount, hasNonces: v.hasNonces }
}
function headerTuple(v: OrdinaryOperationClassification): unknown[] {
  return [...META.map(k => v[k]), v.requestBytes, v.resultBytes, v.secretCount, v.hasNonces]
}
function packet(bytes: Uint8Array): { header: OrdinaryOperationClassification; offset: number } {
  if (bytes.length < 4 || bytes.length > ORDINARY_OPERATION_BYTES) hold()
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (size > 128 * 1024 || size > bytes.length - 4) hold()
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + size)), v: unknown = JSON.parse(text)
  if (!Array.isArray(v) || v.length !== META.length + 4) hold()
  const header = classification(Object.fromEntries([...META, 'requestBytes', 'resultBytes', 'secretCount', 'hasNonces'].map((k, i) => [k, v[i]])))
  if (JSON.stringify(headerTuple(header)) !== text || bytes.length !== 4 + size + header.requestBytes +
      (header.resultBytes ?? 0) + header.secretCount * 32 + (header.hasNonces ? 24 : 0)) hold()
  const offset = 4 + size
  if (header.phase !== 'settled') {
    if (bytesToHex(sha256(bytes.subarray(offset, offset + header.requestBytes))) !== header.requestDigest) hold()
    if (header.resultBytes !== null && bytesToHex(sha256(bytes.subarray(offset + header.requestBytes,
        offset + header.requestBytes + header.resultBytes))) !== header.resultDigest) hold()
  }
  return { header, offset }
}
/** Classification never decodes or copies private body material. */
export function decodeOrdinaryOperationClassification(bytes: Uint8Array): OrdinaryOperationClassification {
  try { return packet(bytes).header } catch { return hold() }
}
export function encodeOrdinaryOperationJournal(raw: OrdinaryOperationJournal): Uint8Array<ArrayBuffer> {
  let request: Uint8Array | undefined, result: Uint8Array | undefined, output: Uint8Array | undefined
  const nonceBytes: Uint8Array[] = [], ownedSecrets: Uint8Array<ArrayBuffer>[] = []
  let success = false
  try {
    const v = dataObject(raw, [...META, 'request', 'result', 'secrets', 'nonces'])
    if (typeof v.request !== 'string' || v.result !== null && typeof v.result !== 'string') hold()
    const requestBytes = ordinaryUtf8Length(v.request, ORDINARY_OPERATION_DATA_BYTES)
    const resultBytes = v.result === null ? null : ordinaryUtf8Length(v.result as string, ORDINARY_OPERATION_DATA_BYTES)
    for (const value of dataArray(v.secrets, 128)) ownedSecrets.push(secretBytes(value))
    const secrets = ownedSecrets
    const nonces = v.nonces === null ? null : dataArray(v.nonces, 2)
    if (nonces && (nonces.length !== 2 || nonces.some(x => typeof x !== 'string' || !/^[0-9a-f]{24}$/.test(x)))) hold()
    const header = classification({ ...Object.fromEntries(META.map(k => [k, v[k]])), requestBytes, resultBytes,
      secretCount: secrets.length, hasNonces: nonces !== null })
    const encodedHeader = new TextEncoder().encode(JSON.stringify(headerTuple(header)))
    request = new TextEncoder().encode(v.request); result = v.result === null ? undefined : new TextEncoder().encode(v.result as string)
    const bytes = output = new Uint8Array(4 + encodedHeader.length + requestBytes + (resultBytes ?? 0) + secrets.length * 32 + (nonces ? 24 : 0))
    if (bytes.length > ORDINARY_OPERATION_BYTES) hold()
    new DataView(bytes.buffer).setUint32(0, encodedHeader.length); bytes.set(encodedHeader, 4)
    let offset = 4 + encodedHeader.length
    for (const part of [request, result, ...secrets as Uint8Array[], ...(nonces ? nonces.map(x => { const n = hexToBytes(x as string); nonceBytes.push(n); return n }) : [])]) {
      if (part) { bytes.set(part, offset); offset += part.length }
    }
    packet(bytes)
    success = true
    return bytes
  } catch { return hold() } finally { request?.fill(0); result?.fill(0); for (const nonce of [...nonceBytes, ...ownedSecrets]) nonce.fill(0); if (!success) output?.fill(0) }
}
/** Private producer decode: returned key bytes are caller-owned and must be wiped. */
export function decodeOrdinaryOperationJournal(bytes: Uint8Array): OrdinaryOperationJournal {
  const secrets: Uint8Array<ArrayBuffer>[] = []
  try {
    const { header, offset: start } = packet(bytes)
    let offset = start
    const text = (size: number) => { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size)); offset += size; return value }
    const request = text(header.requestBytes), result = header.resultBytes === null ? null : text(header.resultBytes)
    for (let i = 0; i < header.secretCount; i++) { secrets.push(Uint8Array.from(bytes.subarray(offset, offset + 32))); offset += 32 }
    const nonces: [string, string] | null = header.hasNonces ? [bytesToHex(bytes.subarray(offset, offset + 12)), bytesToHex(bytes.subarray(offset + 12, offset + 24))] : null
    const { requestBytes: _r, resultBytes: _s, secretCount: _c, hasNonces: _n, ...meta } = header
    return { ...meta, request, result, secrets, nonces }
  } catch { for (const key of secrets) key.fill(0); return hold() }
}
export function ordinaryOperationNames(tab: OrdinaryPurpose): Readonly<{ control: string; marker: string }> {
  if (!isTab(tab)) hold()
  return Object.freeze({ control: ORDINARY_OPERATION_CONTROL_PREFIX + tab.slice(4), marker: ORDINARY_OPERATION_PREFIX + tab.slice(4) })
}
export function ordinaryOperationCommitment(journal: OrdinaryOperationClassification): string {
  const v = classification(journal)
  if (v.phase !== 'settled') hold()
  const digest = sha256.create()
  const text = (value: string) => { const bytes = new TextEncoder().encode(value); digest.update(length(bytes)).update(bytes) }
  try {
    digest.update(new TextEncoder().encode('kithmoot.ordinary-operation-settlement.v1\0')).update(new Uint8Array([v.version]))
    digest.update(hexToBytes(v.id)); text(v.tab); digest.update(u64(v.sequence))
    for (const pair of [v.source, v.enrolled, v.target!]) for (const value of pair) digest.update(hexToBytes(value))
    for (const pair of [v.sourceRevisions, v.enrolledRevisions, v.targetRevisions!]) for (const value of pair) digest.update(u64(value))
    digest.update(hexToBytes(v.requestDigest)).update(hexToBytes(v.resultDigest!)).update(u64(v.scopes.length))
    for (const [purpose, name, generation, fence] of v.scopes) { text(purpose); text(name); digest.update(hexToBytes(generation)).update(u64(fence)) }
    digest.update(u64(v.ceilings.length)); for (const ceiling of v.ceilings) digest.update(u64(ceiling))
    return bytesToHex(digest.digest())
  } finally { digest.destroy() }
}
export function ordinaryOperationMarker(journal: { id: string; tab: `tab:${string}`; sequence: number; commitment: string | null }): string {
  const v = dataObject(journal, ['id', 'tab', 'sequence', 'commitment'])
  if (!isTab(v.tab) || !integer(v.sequence) || v.sequence === 0) hold()
  return JSON.stringify([1, hash(v.id), v.tab, v.sequence, v.commitment === null ? null : hash(v.commitment)])
}
export function validateOrdinaryOperationMarker(raw: string): Readonly<{ id: string; tab: `tab:${string}`; sequence: number; commitment: string | null }> {
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v) || v.length !== 5 || v[0] !== 1) hold()
    const result = { id: hash(v[1]), tab: v[2] as `tab:${string}`, sequence: v[3] as number, commitment: v[4] as string | null }
    if (ordinaryOperationMarker(result) !== raw) hold()
    return Object.freeze(result)
  } catch { return hold() }
}
function u64(value: number): Uint8Array<ArrayBuffer> {
  if (!integer(value)) hold()
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value)); return bytes
}
function length(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, bytes.length); return result
}
/** Explicit binary fields, including every ciphertext byte; never object JSON. */
export function ordinaryFrameDigest(raw: OrdinaryFrame): string {
  const frame = validateOrdinaryFrame(raw), digest = sha256.create()
  try {
    digest.update(new TextEncoder().encode('kithmoot.ordinary-frame-digest.v1\0')).update(new Uint8Array([frame.version]))
    const purpose = new TextEncoder().encode(frame.purpose)
    digest.update(length(purpose)).update(purpose).update(hexToBytes(frame.keyId)).update(hexToBytes(frame.generation))
      .update(u64(frame.revision)).update(u64(frame.expiresAt)).update(new Uint8Array(frame.nonce))
      .update(length(new Uint8Array(frame.ciphertext))).update(new Uint8Array(frame.ciphertext))
    return bytesToHex(digest.digest())
  } finally { new Uint8Array(frame.nonce).fill(0); new Uint8Array(frame.ciphertext).fill(0); digest.destroy() }
}
function binding(raw: OrdinaryOperationBinding): OrdinaryOperationBinding {
  const v = dataObject(raw, ['purpose', 'keyId', 'generation', 'expiresAt'])
  if (v.purpose !== 'browser' && !isTab(v.purpose) || !integer(v.expiresAt) ||
      (v.purpose === 'browser' ? v.expiresAt !== 0 : v.expiresAt === 0)) hold()
  return { purpose: v.purpose as OrdinaryPurpose, keyId: hash(v.keyId), generation: hash(v.generation), expiresAt: v.expiresAt }
}
function aad(control: string, owner: OrdinaryOperationBinding): Uint8Array<ArrayBuffer> {
  // Revision is bound inside the payload's exact frame digests. Stable key,
  // generation and original lease permit phase updates; settlement also
  // advances both owner frames and binds permanent history in their markers.
  return new TextEncoder().encode(JSON.stringify(['kithmoot.ordinary-operation.v1', control, owner.purpose, owner.keyId, owner.generation, owner.expiresAt]))
}
function cipher(raw: unknown): Cipher {
  const v = dataObject(raw, ['nonce', 'ciphertext'])
  if (!(v.nonce instanceof ArrayBuffer) || v.nonce.byteLength !== 12 || !(v.ciphertext instanceof ArrayBuffer) ||
      v.ciphertext.byteLength < 16 || v.ciphertext.byteLength > ORDINARY_OPERATION_BYTES + 16) hold()
  return { nonce: v.nonce.slice(0), ciphertext: v.ciphertext.slice(0) }
}
export function validateOrdinaryOperationControl(raw: unknown): OrdinaryOperationControl {
  const v = dataObject(raw, ['version', 'browser', 'tab'])
  if (v.version !== 1) hold()
  return { version: 1, browser: cipher(v.browser), tab: cipher(v.tab) }
}
/** Equality witness for a previously authenticated control, never phase
 * authority by itself. Bind every encrypted byte and both role labels. */
export function ordinaryOperationControlDigest(raw: unknown): string {
  const control = validateOrdinaryOperationControl(raw), digest = sha256.create()
  try {
    digest.update(new TextEncoder().encode('kithmoot.ordinary-operation-control.v1\0')).update(new Uint8Array([control.version]))
    for (const [role, value] of [[0, control.browser], [1, control.tab]] as const) {
      digest.update(new Uint8Array([role])).update(new Uint8Array(value.nonce))
        .update(length(new Uint8Array(value.ciphertext))).update(new Uint8Array(value.ciphertext))
    }
    return bytesToHex(digest.digest())
  } finally {
    digest.destroy()
    for (const value of [control.browser, control.tab]) { new Uint8Array(value.nonce).fill(0); new Uint8Array(value.ciphertext).fill(0) }
  }
}
export async function sealOrdinaryOperationControl(journal: OrdinaryOperationJournal,
  owners: { browser: { binding: OrdinaryOperationBinding; key: CryptoKey }; tab: { binding: OrdinaryOperationBinding; key: CryptoKey } }): Promise<OrdinaryOperationControl> {
  const bytes = encodeOrdinaryOperationJournal(journal)
  try {
    const parsed = decodeOrdinaryOperationClassification(bytes), names = ordinaryOperationNames(parsed.tab)
    const b = binding(owners.browser.binding), t = binding(owners.tab.binding)
    if (b.purpose !== 'browser' || t.purpose !== parsed.tab || parsed.ceilings[0] !== t.expiresAt) hold()
    const keys = [validateOrdinaryKey(owners.browser.key), validateOrdinaryKey(owners.tab.key)]
    const encrypt = async (owner: OrdinaryOperationBinding, key: CryptoKey): Promise<Cipher> => {
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      return { nonce: nonce.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
        additionalData: aad(names.control, owner), tagLength: 128 }, key, bytes) }
    }
    const browser = await encrypt(b, keys[0]!), tab = await encrypt(t, keys[1]!)
    return { version: 1, browser, tab }
  } catch { return hold() }
  finally { bytes.fill(0) }
}
async function openControl<T>(raw: unknown,
  owners: { browser: { binding: OrdinaryOperationBinding; key: CryptoKey }; tab: { binding: OrdinaryOperationBinding; key: CryptoKey } }, decode: (bytes: Uint8Array) => T): Promise<T> {
  const control = validateOrdinaryOperationControl(raw), b = binding(owners.browser.binding), t = binding(owners.tab.binding)
  const names = ordinaryOperationNames(t.purpose), keys = [validateOrdinaryKey(owners.browser.key), validateOrdinaryKey(owners.tab.key)]
  let browser: Uint8Array | undefined, tab: Uint8Array | undefined
  try {
    if (b.purpose !== 'browser') hold()
    browser = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: control.browser.nonce,
      additionalData: aad(names.control, b), tagLength: 128 }, keys[0]!, control.browser.ciphertext))
    tab = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: control.tab.nonce,
      additionalData: aad(names.control, t), tagLength: 128 }, keys[1]!, control.tab.ciphertext))
    if (browser.length !== tab.length || browser.some((byte, i) => byte !== tab![i])) hold()
    const header = decodeOrdinaryOperationClassification(browser)
    if (header.tab !== t.purpose || header.ceilings[0] !== t.expiresAt) hold()
    const result = decode(browser)
    return result
  } catch { return hold() }
  finally {
    browser?.fill(0); tab?.fill(0)
    for (const value of [control.browser, control.tab]) { new Uint8Array(value.nonce).fill(0); new Uint8Array(value.ciphertext).fill(0) }
  }
}

export const openOrdinaryOperationClassification = (raw: unknown, owners: Parameters<typeof openControl>[1]): Promise<OrdinaryOperationClassification> =>
  openControl(raw, owners, decodeOrdinaryOperationClassification)
export const openOrdinaryOperationControl = (raw: unknown, owners: Parameters<typeof openControl>[1]): Promise<OrdinaryOperationJournal> =>
  openControl(raw, owners, decodeOrdinaryOperationJournal)
