import { base64 } from '@scure/base'
import type { Event } from 'nostr-tools/pure'
import { MAX_PER_EPOCH_ROOM, QuietTransport } from 'nostr-deaddrop'
import { MAX_EPOCH } from '../../src/epoch.js'
import { QUIET_BUCKET_BYTES, QUIET_KINDS } from '../../src/quiet.js'
import { verifyEventUncached } from '../../src/verify.js'
import { QUIET_PREFIX } from './quiet-store.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS, ORDINARY_RECORDS } from './ordinary-state-codec.js'

const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(name => !Object.hasOwn(value, name)) ||
      Reflect.ownKeys(value).some(name => typeof name !== 'string' || !required.includes(name) && !optional.includes(name))) hold()
}
function hex(value: unknown): asserts value is string { if (typeof value !== 'string' || !HEX.test(value)) hold() }
export interface OrdinaryQuietScope {
  readonly roomId: string
  readonly account?: string
  /** Protocol room epoch, distinct from the hourly counter epoch. Absent in
   * older writers; its interpretation must come from retained room evidence. */
  readonly epoch?: number
}
export interface OrdinaryQuietChecks {
  readonly kind: 'browser' | 'tab'
  /** Pure, check-only owner binding from the same validated whole image. A public
   * key's shape cannot establish which participant owns these counters. */
  acceptsCounters(participant: string, scope: OrdinaryQuietScope): boolean
  /** Pure, check-only authenticated room/channel/epoch/credential and outgoing
   * device/participant binding, using retained evidence from this image.
   * Historical integrity is not current authority or permission to resend. */
  acceptsQueued(event: Event, scope: OrdinaryQuietScope): boolean
}
export interface OrdinaryQuietSnapshot {
  readonly rooms: readonly (OrdinaryQuietScope & { readonly counterSources: number; readonly queued: number })[]
}
/** Strict offline custody validation. Never invokes the permissive loader,
 * prunes expired queues, resets counters or changes source bytes. The caller
 * must supply actual same-image binding checks; no default accepts callback.
 * Before-emission retention, restoration and current authority are separate
 * production gates. This validator performs no encryption/signing/network. */
export function validateOrdinaryQuietSnapshot(records: ReadonlyMap<string, string>, migrated: boolean,
  input: OrdinaryQuietChecks): OrdinaryQuietSnapshot {
  const options = { ...input }
  if (!['browser', 'tab'].includes(options.kind) || typeof options.acceptsCounters !== 'function' || typeof options.acceptsQueued !== 'function') hold()
  const rooms: (OrdinaryQuietScope & { counterSources: number; queued: number })[] = []
  const seenRooms = new Map<string, Set<string>>()
  const ids = new Set<string>()
  // Finish structural checks for the entire family before invoking evidence
  // callbacks, so a later malformed row cannot enter restoration code.
  const checks: { scope: OrdinaryQuietScope; participants: string[]; events: Event[] }[] = []
  try {
    for (const [physical, raw] of records) {
      let name = physical, account: string | undefined
      if (name.startsWith('kithmoot.account.')) {
        const match = /^kithmoot\.account\.([0-9a-f]{64})\.(.+)$/.exec(name)
        if (!match) hold()
        account = match[1]!; name = match[2]!
        if (name.startsWith('kithmoot.account.')) hold()
      }
      if (!name.startsWith('kithmoot.quiet.')) continue
      if (!name.startsWith(QUIET_PREFIX) || options.kind !== 'browser' || account !== undefined && !migrated || raw.length > ORDINARY_VALUE_UNITS) hold()
      const roomId = name.slice(QUIET_PREFIX.length); hex(roomId)
      let owners = seenRooms.get(roomId)
      if (!owners) { owners = new Set(); seenRooms.set(roomId, owners) }
      if (owners.has(account ?? 'legacy') || account === undefined && owners.size > 0 || account !== undefined && owners.has('legacy')) hold()
      owners.add(account ?? 'legacy')
      let value: unknown
      try { value = JSON.parse(raw) } catch { hold() }
      // The existing writer uses JSON.stringify. Require that exact encoding
      // so duplicate object names, lossy numbers and ambiguous escape forms
      // cannot be silently collapsed by JSON.parse during custody migration.
      if (JSON.stringify(value) !== raw) hold()
      object(value, ['queued', 'at'], ['used', 'epoch'])
      if (!integer(value.at) || Object.hasOwn(value, 'epoch') && (!integer(value.epoch) || value.epoch > MAX_EPOCH) ||
          !Array.isArray(value.queued) || value.queued.length > QuietTransport.MAX_PENDING) hold()
      // The writer removes a row with no used state and no queue. Its
      // impossible persisted form cannot bless loss of counter history.
      if (!Object.hasOwn(value, 'used') && value.queued.length === 0) hold()
      const scope = Object.freeze({ roomId, ...(account ? { account } : {}),
        ...(Object.hasOwn(value, 'epoch') ? { epoch: value.epoch as number } : {}) })
      const participants: string[] = []
      if (Object.hasOwn(value, 'used')) {
        if (!value.used || typeof value.used !== 'object' || Array.isArray(value.used) || Object.getPrototypeOf(value.used) !== Object.prototype) hold()
        const entries = Object.entries(value.used)
        if (entries.length > ORDINARY_RECORDS) hold()
        for (const [participant, used] of entries) {
          hex(participant); object(used, ['epoch', 'counters'])
          if (!integer(used.epoch) || used.epoch > Math.floor(Number.MAX_SAFE_INTEGER / 3600) ||
              !Array.isArray(used.counters) || used.counters.length > MAX_PER_EPOCH_ROOM ||
              used.counters.some(counter => !integer(counter) || counter >= MAX_PER_EPOCH_ROOM) ||
              new Set(used.counters).size !== used.counters.length) hold()
          participants.push(participant)
        }
      }
      const events: Event[] = []
      for (const event of value.queued) {
        object(event, ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig'])
        hex(event.id); hex(event.pubkey)
        if (!integer(event.created_at) || !QUIET_KINDS.includes(event.kind as number) || typeof event.sig !== 'string' ||
            !/^[0-9a-f]{128}$/.test(event.sig) || typeof event.content !== 'string' || event.content.length < 132 || event.content.length > QUIET_BUCKET_BYTES ||
            !Array.isArray(event.tags) || event.tags.length < 1 || event.tags.length > 2) hold()
        let d = false, expiry = false
        for (const tag of event.tags) {
          if (!Array.isArray(tag) || tag.length !== 2) hold()
          if (tag[0] === 'd') { if (d) hold(); hex(tag[1]); d = true }
          else if (tag[0] === 'expiration') {
            const seconds = Number(tag[1])
            if (expiry || typeof tag[1] !== 'string' || !integer(seconds) || String(seconds) !== tag[1]) hold()
            expiry = true
          } else hold()
        }
        if (!d || ids.has(event.id) || !verifyEventUncached(event as unknown as Event)) hold()
        // Exact v0.3.0 roomPlaintext probe, without generating a drop/nonce.
        const bytes = new TextEncoder().encode(JSON.stringify({ e: event, pad: '' }))
        try { if (bytes.length > QUIET_BUCKET_BYTES) hold() } finally { bytes.fill(0) }
        let cipher: Uint8Array | undefined
        try { cipher = base64.decode(event.content); if (cipher.length < 99 || cipher[0] !== 2 || base64.encode(cipher) !== event.content) hold() }
        catch { hold() } finally { cipher?.fill(0) }
        ids.add(event.id); events.push(event as unknown as Event)
      }
      checks.push({ scope, participants, events })
      rooms.push(Object.freeze({ ...scope, counterSources: participants.length, queued: events.length }))
    }
    for (const { scope, participants, events } of checks) {
      for (const participant of participants) if (options.acceptsCounters(participant, scope) !== true) hold()
      for (const event of events) if (options.acceptsQueued(structuredClone(event), scope) !== true) hold()
    }
    rooms.sort((a, b) => a.roomId.localeCompare(b.roomId) || (a.account ?? '').localeCompare(b.account ?? ''))
    return Object.freeze({ rooms: Object.freeze(rooms) })
  } catch { return hold() }
  finally { for (const check of checks) { check.events.length = 0; check.participants.length = 0 }; checks.length = 0 }
}
