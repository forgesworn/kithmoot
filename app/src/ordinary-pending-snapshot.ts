import { verifyEvent } from 'nostr-tools/pure'
import { normaliseArtwork, MAX_CHAT_ARTWORK } from '../../src/artwork.js'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { MAX_KEPT, type KeptPendingSend } from './pending-sends.js'

const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
export interface OrdinaryPendingPair { durable: string | null; transient: string | null }
function records(raw: string | null, accepts: (record: KeptPendingSend) => boolean): KeptPendingSend[] {
  if (raw !== null && typeof raw !== 'string') hold()
  if (raw === null) return []
  if (raw.length > ORDINARY_VALUE_UNITS) hold()
  let values: unknown
  try { values = JSON.parse(raw) } catch { hold() }
  if (!Array.isArray(values) || values.length > MAX_KEPT) hold()
  for (const row of values) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype ||
        Object.keys(row).some(name => !['id','channel','text','files','artwork','event','state','editable'].includes(name)) ||
        typeof row.id !== 'string' || !row.id.length || row.id.length > 128 || typeof row.channel !== 'string' ||
        !row.channel.length || row.channel.length > 512 || typeof row.text !== 'string' || !Array.isArray(row.files) ||
        row.files.some((file: unknown) => typeof file !== 'string') ||
        !['waiting','refused','unknown','moved'].includes(row.state) ||
        (row.editable !== undefined && row.editable !== true)) hold()
    const event = row.event
    if (!event || Object.getPrototypeOf(event) !== Object.prototype || Object.keys(event).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' ||
        !HEX.test(event.id) || !HEX.test(event.pubkey) || typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig) ||
        !Number.isSafeInteger(event.kind) || event.kind < 0 || !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
        typeof event.content !== 'string' || !Array.isArray(event.tags) ||
        event.tags.some((tag: unknown) => !Array.isArray(tag) || tag.some(value => typeof value !== 'string'))) hold()
    try { if (!verifyEvent(event)) hold() } catch { hold() }
    if (row.artwork !== undefined && (!Array.isArray(row.artwork) || row.artwork.length > MAX_CHAT_ARTWORK || row.artwork.some((art: unknown) => !normaliseArtwork(art)))) hold()
    // JSON decoding removes verifier cache symbols and escaped object aliases.
    if (accepts(structuredClone(row)) !== true) hold()
  }
  return values
}
/** Shared strict signed-record parser and two-owner queue constraints. The
 * binding callback is mandatory; signed outer integrity alone is insufficient.
 * Binding exceptions propagate to the adapter's existing revocation path;
 * raw snapshot validation below normalises them to HOLD. Returns counts only
 * and never releases a send or permits replay. */
export function validateOrdinaryPendingPair(pair: OrdinaryPendingPair, accepts: (record: KeptPendingSend) => boolean):
  Readonly<{ durableRecords: number; transientRecords: number }> {
  if (typeof accepts !== 'function') hold()
  const durable = pair.durable, transient = pair.transient
  const a = records(durable, accepts), b = records(transient, accepts), all = [...a, ...b]
  if (all.length > MAX_KEPT || new Set(all.map(record => record.id)).size !== all.length) hold()
  return Object.freeze({ durableRecords: a.length, transientRecords: b.length })
}
/** Complete pending partition from both captured physical owners. Every row
 * has an explicit account and room, and each queue is checked as one pair.
 * No inferred legacy account, loader, owner allocation, pruning or effect.
 * The caller must bind inner messages to the same validated complete image;
 * this function cannot supply that authority on its own. */
export function validateOrdinaryPendingSnapshot(browser: ReadonlyMap<string, string>, tab: ReadonlyMap<string, string>,
  options: { accepts(account: string, roomId: string, record: KeptPendingSend): boolean }):
  Readonly<{ queues: number; records: number; durableRecords: number; transientRecords: number }> {
  try {
    const accepts = options.accepts
    if (typeof accepts !== 'function') hold()
    const pairs = new Map<string, OrdinaryPendingPair & { account: string; roomId: string }>()
    for (const [part, image] of [['durable', browser], ['transient', tab]] as const) for (const [name, raw] of image) {
      if (name === 'kithmoot.pending' || name.startsWith('kithmoot.pending.')) hold()
      if (!name.startsWith('kithmoot.account.') || !name.includes('.kithmoot.pending')) continue
      const m = /^kithmoot\.account\.([0-9a-f]{64})\.kithmoot\.pending\.([0-9a-f]{64})$/.exec(name)
      if (!m || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
      ordinaryUtf8Length(raw)
      const pair = pairs.get(name) ?? { account: m[1]!, roomId: m[2]!, durable: null, transient: null }
      pair[part] = raw; pairs.set(name, pair)
    }
    const counts = { queues: pairs.size, records: 0, durableRecords: 0, transientRecords: 0 }
    for (const pair of pairs.values()) {
      const c = validateOrdinaryPendingPair(pair, row => accepts(pair.account, pair.roomId, row))
      counts.durableRecords += c.durableRecords; counts.transientRecords += c.transientRecords
    }
    counts.records = counts.durableRecords + counts.transientRecords
    return Object.freeze(counts)
  } catch { return hold() }
}
