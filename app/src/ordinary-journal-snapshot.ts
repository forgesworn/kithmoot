import { nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import { inspectEnvelopeHeader } from '../../packages/context/src/blossom.js'
import { CONTEXT_ENVELOPE_V2_BYTES, CONTEXT_ENVELOPE_LEGACY_BYTES } from '../../packages/context/src/limits.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const FAMILIES = ['kithmoot.shared-projects', 'kithmoot.assignments', 'kithmoot.context']
const PROJECT = /^kithmoot\.shared-projects\.v1\.([0-9a-f]{64})$/
const ASSIGNMENT = /^kithmoot\.assignments\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
const CONTEXT = /^kithmoot\.context\.v1\.([0-9a-f]{64})$/
const HEX = /^[0-9a-f]{64}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CHUNK = 1024 * 1024
function hold(): never { throw new OrdinaryStateHold() }
function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).length !== fields.length) hold()
}
function writerObject(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  object(value, fields)
  if (Object.keys(value).some((key, i) => key !== fields[i])) hold()
}
function canonical(raw: string): unknown {
  const value: unknown = JSON.parse(raw)
  if (JSON.stringify(value) !== raw) hold()
  return value
}
/** Canonical padded base64 without decoding a whole ciphertext copy. */
function base64Length(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) hold()
  const pads = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const end = value.length - pads
  for (let i = 0; i < end; i++) if (BASE64.indexOf(value[i]!) < 0) hold()
  if (pads && (BASE64.indexOf(value[end - 1]!) & (pads === 2 ? 15 : 3)) !== 0) hold()
  return value.length / 4 * 3 - pads
}
/** Only the visible v2 length profile is checked. The encrypted length prefix,
 * MAC, plaintext, recipient and room remain unauthenticated here. nostr-tools
 * 2.25 writes both the two-byte and extended six-byte prefix profiles. */
export function validateOrdinaryNip44Framing(value: unknown): number {
  const length = base64Length(value)
  if (typeof value !== 'string' || length < 99 || BASE64.indexOf(value[0]!) * 4 + (BASE64.indexOf(value[1]!) >> 4) !== 2) hold()
  const short = length - 65 - 2, extended = length - 65 - 6
  const padded = nip44.v2.utils.calcPaddedLen
  if (!(short >= 32 && padded(Math.min(short, 65535)) === short) &&
      !(extended >= 65536 && padded(Math.min(extended, 4294967295)) === extended)) hold()
  return length
}
/** Visible envelope framing only. The source, metadata, tags and nonce/salt
 * provenance cannot be authenticated without opening it. Never do that during
 * custody. Current projects always write v2; current context saves may retain
 * a legacy envelope accepted through an earlier import/restore. */
function envelope(value: unknown, context: boolean): void {
  const length = base64Length(value)
  if (typeof value !== 'string' || length < 24) hold()
  const bytes = Uint8Array.from(atob(value.slice(0, Math.min(value.length, 76))), c => c.charCodeAt(0))
  try {
    const header = inspectEnvelopeHeader(bytes, length), v2 = header.format === 'FSWNENC2'
    if (!v2 && !context) hold()
    // A <=1MiB signed snapshot plus metadata can round up to a 2MiB
    // bucket. V2 custody and recovery share that writer ceiling; legacy
    // Context passthrough retains its stricter 2MiB acceptance bound.
    if (context && length > (v2 ? CONTEXT_ENVELOPE_V2_BYTES : CONTEXT_ENVELOPE_LEGACY_BYTES)) hold()
    const plaintext = length - header.headerBytes - header.recordCount * 16
    if (header.recordCount !== Math.ceil(plaintext / CHUNK) || plaintext < 65536 ||
        (plaintext <= CHUNK ? !Number.isInteger(Math.log2(plaintext)) : plaintext % CHUNK !== 0)) hold()
  } finally { bytes.fill(0) }
}
function cache(value: unknown, account: string): void {
  object(value, ['kind', 'created_at', 'tags', 'content', 'pubkey', 'id', 'sig'])
  if (value.kind !== 30078 || !Number.isSafeInteger(value.created_at) || (value.created_at as number) < 0 ||
      value.pubkey !== account || typeof value.id !== 'string' || !HEX.test(value.id) ||
      typeof value.sig !== 'string' || !SIGNATURE.test(value.sig) ||
      JSON.stringify(value.tags) !== JSON.stringify([['d', 'kithmoot/context/v1/cache']]) || typeof value.content !== 'string') hold()
  if (ordinaryUtf8Length(value.content, CHUNK) >= CHUNK) hold()
  ordinaryUtf8Length(JSON.stringify(value), CHUNK)
  const body = canonical(value.content)
  writerObject(body, ['v', 'recipient', 'ciphertext'])
  if (body.v !== 1 || body.recipient !== account) hold()
  validateOrdinaryNip44Framing(body.ciphertext)
  if (!verifyEventUncached(value as unknown as Event)) hold()
}

/** Offline, count-only custody of encrypted journals in their original browser
 * owner. No decryption, signer, loader, network, clock, pruning or key repair.
 * The cache event signature authenticates its carrier, not current authority or
 * the opaque policy/head. Assignment account/room binding is only physical.
 * A complete composite must classify all other private families. Larger real
 * producer outputs hold intact under the codec profile; recovery is still owed. */
export function validateOrdinaryJournalSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ projects: number; assignments: number; events: number; pending: number; contexts: number; collections: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { projects: 0, assignments: 0, events: 0, pending: 0, contexts: 0, collections: 0 }
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && FAMILIES.some(family => name.includes('.' + family))) hold()
      if (!FAMILIES.some(family => name === family || name.startsWith(family + '.'))) continue
      if (options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      const value = canonical(raw), project = PROJECT.exec(name), assignment = ASSIGNMENT.exec(name), context = CONTEXT.exec(name)
      if (project) {
        writerObject(value, ['v', 'identity', 'key', 'body'])
        if (value.v !== 1 || value.identity !== project[1] || validateOrdinaryNip44Framing(value.key) !== 131) hold()
        envelope(value.body, false); counts.projects++
      } else if (assignment) {
        writerObject(value, ['v', 'events', 'outbox'])
        if (value.v !== 1 || !Array.isArray(value.events) || !Array.isArray(value.outbox) ||
            value.events.length > 20000 || value.outbox.length > 100 || value.events.length + value.outbox.length === 0) hold()
        for (const item of value.events) validateOrdinaryNip44Framing(item)
        for (const item of value.outbox) validateOrdinaryNip44Framing(item)
        counts.assignments++; counts.events += value.events.length; counts.pending += value.outbox.length
      } else if (context) {
        writerObject(value, ['v', 'identity', 'collections'])
        if (value.v !== 1 || value.identity !== context[1] || !Array.isArray(value.collections) || value.collections.length > 32) hold()
        for (const row of value.collections) { writerObject(row, ['access', 'envelope']); cache(row.access, context[1]!); envelope(row.envelope, true) }
        counts.contexts++; counts.collections += value.collections.length
      } else hold()
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
