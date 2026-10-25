import { nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { verifyEventUncached } from '../../src/verify.js'
import { inspectEnvelopeHeader } from '../../packages/context/src/blossom.js'
import { CONTEXT_ENVELOPE_V2_BYTES, CONTEXT_ENVELOPE_LEGACY_BYTES } from '../../packages/context/src/limits.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const FAMILIES = ['kithmoot.shared-projects', 'kithmoot.assignments', 'kithmoot.context']
const PROJECT = /^kithmoot\.shared-projects\.v1\.([0-9a-f]{64})$/
const PROJECT_SIDE = /^kithmoot\.shared-projects\.v1\.([0-9a-f]{64})\.journal\.v2\.([0-9a-f]{64})$/
const ASSIGNMENT = /^kithmoot\.assignments\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
const ASSIGNMENT_SIDE = /^kithmoot\.assignments\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})\.journal\.v2\.([0-9a-f]{64})$/
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

interface AssignmentCounts { events: number; pending: number }
interface JournalRef { key: string; sha256: string }
interface JournalHead { base: JournalRef | null; tip: JournalRef | null }
interface JournalSegment { base: JournalRef; previous: JournalRef | null }
interface AssignmentSegment extends JournalSegment { delta: { add: number; outbox?: number } }
interface AssignmentSide { base?: AssignmentCounts; segment?: AssignmentSegment }
/** A project delta body is one NIP44 ciphertext; only its visible framing is
 *  checkable offline. The seven-collection shape and count limits inside it
 *  are writer- and loader-enforced, exactly like assignment ciphertext. */
interface ProjectSide { base?: true; segment?: JournalSegment }
type JournalSide = { root: string; kind: 'assignment'; side: AssignmentSide } | { root: string; kind: 'project'; side: ProjectSide }
function assignmentBase(value: unknown): AssignmentCounts {
  writerObject(value, ['v', 'events', 'outbox'])
  if (value.v !== 1 || !Array.isArray(value.events) || !Array.isArray(value.outbox) ||
      value.events.length > 20000 || value.outbox.length > 100 || value.events.length + value.outbox.length === 0) hold()
  for (const item of value.events) validateOrdinaryNip44Framing(item)
  for (const item of value.outbox) validateOrdinaryNip44Framing(item)
  return { events: value.events.length, pending: value.outbox.length }
}
function assignmentDelta(raw: string): { add: number; outbox?: number } {
  const value = canonical(raw), hasOutbox = !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'outbox')
  writerObject(value, hasOutbox ? ['v', 'add', 'outbox'] : ['v', 'add'])
  if (value.v !== 2 || !Array.isArray(value.add) || value.add.length > 20000 || (hasOutbox && !Array.isArray(value.outbox))) hold()
  for (const item of value.add) validateOrdinaryNip44Framing(item)
  if (hasOutbox) {
    const outbox = value.outbox
    if (!Array.isArray(outbox) || outbox.length > 100) hold()
    for (const item of outbox) validateOrdinaryNip44Framing(item)
    return { add: value.add.length, outbox: outbox.length }
  }
  return { add: value.add.length }
}
/** The v1 whole-cache project envelope, shared by a project root and the v2
 *  base side record it references. Binds the sealed identity to the account
 *  named by the storage key. */
function projectBase(value: unknown, account: string): void {
  writerObject(value, ['v', 'identity', 'key', 'body'])
  if (value.v !== 1 || value.identity !== account || validateOrdinaryNip44Framing(value.key) !== 131) hold()
  envelope(value.body, false)
}
function journalRef(value: unknown, root: string): JournalRef {
  writerObject(value, ['key', 'sha256'])
  if (typeof value.key !== 'string' || typeof value.sha256 !== 'string' || !HEX.test(value.sha256) ||
      value.key !== `${root}.journal.v2.${value.sha256}`) hold()
  return { key: value.key, sha256: value.sha256 }
}
function journalHead(value: unknown, root: string): JournalHead {
  writerObject(value, ['v', 'base', 'tip'])
  if (value.v !== 2) hold()
  const base = value.base === null ? null : journalRef(value.base, root)
  const tip = value.tip === null ? null : journalRef(value.tip, root)
  if (tip && !base) hold()
  return { base, tip }
}
function assignmentSegment(value: unknown, root: string): AssignmentSegment {
  writerObject(value, ['v', 'base', 'previous', 'body'])
  if (value.v !== 2 || typeof value.body !== 'string') hold()
  return { base: journalRef(value.base, root), previous: value.previous === null ? null : journalRef(value.previous, root), delta: assignmentDelta(value.body) }
}
function assignmentSide(name: string, raw: string): JournalSide {
  const match = ASSIGNMENT_SIDE.exec(name)!
  const root = `kithmoot.assignments.v1.${match[1]}.${match[2]}`
  if (bytesToHex(sha256(new TextEncoder().encode(raw))) !== match[3]) hold()
  const value = canonical(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) hold()
  const version = (value as Record<string, unknown>).v
  if (version === 1) return { root, kind: 'assignment', side: { base: assignmentBase(value) } }
  if (version === 2) return { root, kind: 'assignment', side: { segment: assignmentSegment(value, root) } }
  return hold()
}
function projectSegment(value: unknown, root: string): JournalSegment {
  writerObject(value, ['v', 'base', 'previous', 'body'])
  if (value.v !== 2 || typeof value.body !== 'string') hold()
  validateOrdinaryNip44Framing(value.body)
  return { base: journalRef(value.base, root), previous: value.previous === null ? null : journalRef(value.previous, root) }
}
function projectSide(name: string, raw: string): JournalSide {
  const match = PROJECT_SIDE.exec(name)!
  const root = `kithmoot.shared-projects.v1.${match[1]}`
  if (bytesToHex(sha256(new TextEncoder().encode(raw))) !== match[2]) hold()
  const value = canonical(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) hold()
  const version = (value as Record<string, unknown>).v
  if (version === 1) { projectBase(value, match[1]); return { root, kind: 'project', side: { base: true } } }
  if (version === 2) return { root, kind: 'project', side: { segment: projectSegment(value, root) } }
  return hold()
}
const sameRef = (a: JournalRef | null, b: JournalRef | null): boolean => a === b || !!a && !!b && a.key === b.key && a.sha256 === b.sha256

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
  const sides = new Map<string, JournalSide>(), heads = new Map<string, { kind: 'assignment' | 'project'; head: JournalHead }>()
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && FAMILIES.some(family => name.includes('.' + family))) hold()
      if (!FAMILIES.some(family => name === family || name.startsWith(family + '.'))) continue
      if (options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      if (ASSIGNMENT_SIDE.test(name)) { sides.set(name, assignmentSide(name, raw)); continue }
      if (PROJECT_SIDE.test(name)) { sides.set(name, projectSide(name, raw)); continue }
      const value = canonical(raw), project = PROJECT.exec(name), assignment = ASSIGNMENT.exec(name), context = CONTEXT.exec(name)
      if (project) {
        counts.projects++
        if (!value || typeof value !== 'object' || Array.isArray(value)) hold()
        if ((value as Record<string, unknown>).v === 2) heads.set(name, { kind: 'project', head: journalHead(value, name) })
        else projectBase(value, project[1])
      } else if (assignment) {
        counts.assignments++
        if (!value || typeof value !== 'object' || Array.isArray(value)) hold()
        if ((value as Record<string, unknown>).v === 2) heads.set(name, { kind: 'assignment', head: journalHead(value, name) })
        else {
          const base = assignmentBase(value)
          counts.events += base.events; counts.pending += base.pending
        }
      } else if (context) {
        writerObject(value, ['v', 'identity', 'collections'])
        if (value.v !== 1 || value.identity !== context[1] || !Array.isArray(value.collections) || value.collections.length > 32) hold()
        for (const row of value.collections) { writerObject(row, ['access', 'envelope']); cache(row.access, context[1]!); envelope(row.envelope, true) }
        counts.contexts++; counts.collections += value.collections.length
      } else hold()
    }
    for (const [root, entry] of heads) {
      let logical: AssignmentCounts = { events: 0, pending: 0 }
      if (entry.head.base) {
        const base = sides.get(entry.head.base.key)
        if (!base || base.root !== root || base.kind !== entry.kind) hold()
        if (entry.kind === 'assignment') {
          if (base.kind !== 'assignment' || !base.side.base) hold()
          logical = { ...base.side.base }
        } else if (base.kind !== 'project' || !base.side.base) hold()
      }
      const chain: JournalSegment[] = [], seen = new Set<string>()
      let next = entry.head.tip
      while (next) {
        if (chain.length >= 4096 || seen.has(next.key)) hold()
        seen.add(next.key)
        const record = sides.get(next.key)
        if (!record || record.root !== root || record.kind !== entry.kind || !record.side.segment || !sameRef(record.side.segment.base, entry.head.base)) hold()
        chain.push(record.side.segment); next = record.side.segment.previous
      }
      if (entry.kind === 'assignment') {
        for (const segment of chain.reverse() as AssignmentSegment[]) {
          logical.events += segment.delta.add
          if (logical.events > 20000) hold()
          if (segment.delta.outbox !== undefined) logical.pending = segment.delta.outbox
        }
        counts.events += logical.events; counts.pending += logical.pending
      }
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
