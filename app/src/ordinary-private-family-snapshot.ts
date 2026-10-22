import { base64 } from '@scure/base'
import { verifyLinkCard } from 'nostr-contact-card'
import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import { readBoxClaim } from '../../src/box-status.js'
import { readLogoImage } from '../../src/logo-image.js'
import { roomLogoOp } from '../../src/room-logo.js'
import { normaliseBlossomServer } from '../../src/attachment.js'
import { readPendingBlobDeleteJournal } from './blob-deletion.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
const families = ['kithmoot.box-discovery', 'kithmoot.uploads', 'kithmoot.blob-deletes', 'kithmoot.storage-grants',
  'kithmoot.history-recovery', 'kithmoot.file-storage', 'kithmoot.blossom-server', 'kithmoot.room-logo']
const DISCOVERY = /^kithmoot\.box-discovery\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
const HISTORY = /^kithmoot\.history-recovery\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
const UPLOAD = /^kithmoot\.uploads\.v1\.([0-9a-f]{64})$/
const LOGO = /^kithmoot\.room-logo\.v1\.([0-9a-f]{64})$/
const GRANTS = /^kithmoot\.storage-grants\.v1\.([0-9a-f]{64})$/
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function hex(value: unknown): value is string { return typeof value === 'string' && HEX.test(value) }
function object(value: unknown, required: readonly string[], optional: readonly string[] = [], extensions = false): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) ||
      !extensions && Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) hold()
}
function canonical(raw: string): unknown {
  const value: unknown = JSON.parse(raw)
  if (JSON.stringify(value) !== raw) hold()
  return value
}
function signed(value: unknown, kind: number, author?: string): Event {
  // Status ingestion retains genuinely signed malformed statements, including
  // extra carrier JSON. Do not apply readBoxStatus or semantic expiry here.
  object(value, ['kind', 'created_at', 'tags', 'content', 'pubkey', 'id', 'sig'], [], true)
  if (value.kind !== kind || !integer(value.created_at) || !hex(value.pubkey) || author && value.pubkey !== author ||
      !verifyEventUncached(value as unknown as Event)) hold()
  return value as unknown as Event
}
function discovery(value: unknown, box: string): { status: boolean; claim: boolean } {
  object(value, ['revision', 'nodeId', 'enabled'], ['card', 'serial', 'claim', 'status', 'statusConflictAt', 'claimConflictAt'])
  if (typeof value.revision !== 'string' || !hex(value.nodeId) || typeof value.enabled !== 'boolean') hold()
  const revision = canonical(value.revision)
  if (!Array.isArray(revision) || revision.length !== 7 || !revision.slice(0, 3).every(integer) ||
      revision.slice(3).some(v => !hex(v)) || revision[4] !== value.nodeId) hold()
  // This is a retained past contact revision, not a requirement that today's
  // contact still endorses it. Replaced cards can leave inert replay floors.
  if (Object.hasOwn(value, 'card') !== Object.hasOwn(value, 'serial')) hold()
  if (Object.hasOwn(value, 'card')) {
    if (typeof value.card !== 'string' || value.card.length > 5464 || !integer(value.serial)) hold()
    const bytes = base64.decode(value.card)
    try {
      if (base64.encode(bytes) !== value.card || bytes.length < 126 || bytes.length > 4096) hold()
      const expires = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(45)
      const historical = Number(expires > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : expires) - 1
      const r = verifyLinkCard(bytes, historical)
      if (!r.ok || r.card.nodeId !== value.nodeId || r.card.serial !== value.serial) hold()
    } finally { bytes.fill(0) }
  }
  for (const k of ['statusConflictAt', 'claimConflictAt']) if (Object.hasOwn(value, k) && !integer(value[k])) hold()
  if (Object.hasOwn(value, 'claim')) {
    const claim = signed(value.claim, 30640), r = readBoxClaim(claim, claim.created_at)
    // Claim shape is checked at its own authored time, never the current clock.
    // Retirement remains terminal replay history; no ownership result escapes.
    if (!r.ok || r.claim.node !== box) hold()
  }
  if (Object.hasOwn(value, 'status')) signed(value.status, 10640, box)
  return { status: Object.hasOwn(value, 'status'), claim: Object.hasOwn(value, 'claim') }
}

/** Offline custody only. Returns counts, never endpoints, signed permissions,
 * images, grants or replay records. No live clock, loader, effects or pruning.
 * Signed replay carriers retain malformed status and retirement; histories
 * retain writer-supported JSON extensions. Cross-family same-image binding,
 * fresh authority and protected production startup remain separate work. */
export function validateOrdinaryPrivateFamilySnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ discoveries: number; statusFloors: number; claimFloors: number;
    uploadJournals: number; uploadCandidates: number; pendingDeletes: number; histories: number; windows: number;
    sharedFileConsent: number; legacyFileSuggestions: number; logos: number; grantJournals: number }> {
  const counts = { discoveries: 0, statusFloors: 0, claimFloors: 0, uploadJournals: 0, uploadCandidates: 0,
    pendingDeletes: 0, histories: 0, windows: 0, sharedFileConsent: 0, legacyFileSuggestions: 0, logos: 0, grantJournals: 0 }
  if (!['browser', 'tab'].includes(options.kind)) hold()
  try {
    for (const [name, raw] of records) {
      if (name.startsWith('kithmoot.account.') && families.some(f => name.includes('.' + f))) hold()
      if (!families.some(f => name === f || name.startsWith(f + '.'))) continue
      if (options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      if (name === 'kithmoot.blossom-server') {
        // Historical display suggestion only. It can be arbitrary text and
        // must never become consent or a deletion endpoint by being retained.
        counts.legacyFileSuggestions++; continue
      }
      if (name === 'kithmoot.blob-deletes.v1') {
        counts.pendingDeletes += readPendingBlobDeleteJournal(raw).length; continue
      }
      const value = canonical(raw), d = DISCOVERY.exec(name), h = HISTORY.exec(name)
      if (d) {
        const r = discovery(value, d[2]!); counts.discoveries++
        if (r.status) counts.statusFloors++; if (r.claim) counts.claimFloors++
      } else if (h) {
        // The actual saver spreads the supplied progress and windows. Extension
        // fields are inert JSON, preserved under the raw byte bound, not dropped.
        object(value, ['version', 'person', 'node', 'windows'], [], true)
        if (value.version !== 1 || value.person !== h[1] || value.node !== h[2] || !Array.isArray(value.windows) || value.windows.length > 64) hold()
        const names = new Set<string>()
        for (const w of value.windows) {
          object(w, ['relay', 'class', 'until'], [], true)
          if (typeof w.relay !== 'string' || !w.relay || !['authored', 'addressed'].includes(w.class as string) || !integer(w.until)) hold()
          const tuple = JSON.stringify([w.relay, w.class])
          if (names.has(tuple)) hold(); names.add(tuple)
        }
        // Do not re-sort: the producer's locale comparator may differ across
        // platforms. Order and relay strings here carry no dialing authority.
        counts.histories++; counts.windows += value.windows.length
      } else if (UPLOAD.test(name)) {
        if (!Array.isArray(value) || !value.length || value.length > 1000) hold()
        const names = new Set<string>()
        for (const b of value) {
          object(b, ['url', 'sha256'], ['key'])
          if (typeof b.url !== 'string' || !hex(b.sha256) || b.key !== undefined && b.key !== 'device' && b.key !== 'file') hold()
          // recordUpload accepts arbitrary URL text. Keeping it cannot make
          // an operator or target authorised; deletion verifies separately.
          const tuple = JSON.stringify([b.url, b.sha256])
          if (names.has(tuple)) hold(); names.add(tuple)
        }
        counts.uploadJournals++; counts.uploadCandidates += value.length
      } else if (name === 'kithmoot.file-storage.v1') {
        // "Nowhere" is written down too (mode off); a shared consent names
        // its server, and from version 3 how it was chosen.
        if (value && typeof value === 'object' && (value as Record<string, unknown>).mode === 'off') {
          object(value, ['mode'], ['disclosure'])
          if (value.disclosure !== undefined && value.disclosure !== 3) hold()
        } else {
          object(value, ['mode', 'disclosure', 'origin'], ['via'])
          if (value.mode !== 'shared' || (value.disclosure !== 1 && value.disclosure !== 2 && value.disclosure !== 3) || typeof value.origin !== 'string' || normaliseBlossomServer(value.origin) !== value.origin) hold()
          if (value.disclosure === 3 ? !['default', 'typed', 'wildbloom'].includes(value.via as string) : value.via !== undefined) hold()
          counts.sharedFileConsent++
        }
      } else if (GRANTS.test(name)) {
        // The grants, revocations and resets the room's keeper handed this
        // device, as the receiver persists them. The keeper's signature on each
        // is checked again when the receiver is rebuilt, against the authority
        // pinned in the room's link, which this row does not carry.
        object(value, ['events', 'acknowledged'])
        if (!Array.isArray(value.events) || value.events.length > 4_608 || !Array.isArray(value.acknowledged) || value.acknowledged.length > 4_608) hold()
        const ids = new Set<string>()
        for (const e of value.events) {
          object(e, ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
          if (!hex(e.id) || !hex(e.pubkey) || !integer(e.created_at) || !integer(e.kind) || typeof e.content !== 'string' || typeof e.sig !== 'string' ||
              !Array.isArray(e.tags) || e.tags.length > 32 || e.tags.some(t => !Array.isArray(t) || t.length > 8 || t.some(v => typeof v !== 'string'))) hold()
          if (ids.has(e.id as string)) hold(); ids.add(e.id as string)
        }
        for (const key of value.acknowledged) if (typeof key !== 'string' || key.length > 300 || !/^[a-z0-9.-]+\/[0-9a-f]{64}$/.test(key)) hold()
        counts.grantJournals++
      } else if (LOGO.test(name)) {
        object(value, ['epoch', 'record']); object(value.record, ['image', 'id', 'at', 'sentAt'])
        const r = value.record, image = r.image === null ? null : readLogoImage(r.image)
        if (!integer(value.epoch) || image === undefined || !integer(r.sentAt)) hold()
        const op = roomLogoOp(image, r.at as number, r.id as string)
        if (r.sentAt < Math.floor(op.at / 1000)) hold()
        // The cache's writer removes `by` and other source fields; this result
        // authenticates no original sender or present epoch membership.
        counts.logos++; if (counts.logos > 64) hold()
      } else hold()
    }
    return Object.freeze(counts)
  } catch { return hold() }
}
