/**
 * This device's archive of the rooms it has been in: the original signed
 * events, as they arrived, so a room's history does not depend on a relay
 * remembering it. See `src/archive.ts` for what goes in and how it is read.
 *
 * Nothing decrypted is stored. Each event, still room-encrypted and signed,
 * is sealed again with AES-GCM under a device key, the pattern of
 * `history-index.ts` with its own schema. Outside the ciphertext a record
 * carries two keyed hashes and nothing else: which conversation it belongs to
 * and which event it is, both HMACs under a second device key.
 *
 * What that protects, honestly: somebody reading the stored records without
 * the keys learns no room id, event id, sender or time. The keys themselves
 * sit in the same IndexedDB on the same disk; "non-extractable" only stops
 * the page's own scripts exporting them, so whoever can copy the whole
 * browser profile can open the archive. Records are not padded, so their
 * sizes show roughly how long each event is, and how many records each
 * conversation holds shows too.
 *
 * `reseedRelays` is the other half: a room relay that returns fewer of a
 * conversation's events than this device holds is handed the originals back,
 * unchanged, a few at a time. Whether a relay keeps chat at all is the
 * relay health's finding, not this module's.
 */
import { getEventHash, type Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { archiveTag, compareArchived, olderThan, reseedCandidates, MAX_RESEED_EVENTS, type ArchiveMeta, type ArchiveQuery, type EventArchive } from '../../src/archive.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { RelayConfig } from '../../src/relay-pool.js'

const DATABASE_VERSION = 1
const RECORD_VERSION = 1
const EVENT_AAD = 'kithmoot.room-archive.event.v1:'
const NONCE_BYTES = 12
/** An event larger than this was never a room event a relay would take. */
const MAX_EVENT_BYTES = 128 * 1024
/** Per conversation. Well past any room today; past it the oldest events
 *  go. What "keep" means on a full device is an open question in the plan. */
export const MAX_ARCHIVED_PER_STREAM = 50_000

export interface ArchivedRecord {
  /** HMAC of the event id: stable, so a second copy replaces the first. */
  key: string
  /** HMAC of the kind and `d` tag: which conversation, opaquely. */
  stream: string
  version: 1
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}

export interface ArchiveKeys {
  /** AES-GCM, seals each event. */
  seal: CryptoKey
  /** HMAC-SHA-256, names streams and records. */
  name: CryptoKey
}

export interface RoomArchiveStorage {
  keys(): Promise<ArchiveKeys | undefined>
  /** Store `candidate` unless keys already exist, and return whichever
   *  pair is stored: two tabs opening a fresh archive agree on one. */
  adoptKeys(candidate: ArchiveKeys): Promise<ArchiveKeys>
  stream(stream: string): Promise<ArchivedRecord[]>
  /** Write `records` and delete the records named by `remove`, together. */
  put(records: readonly ArchivedRecord[], remove?: readonly string[]): Promise<void>
}

/** What a sealed record holds. */
interface Sealed { event: Event; quiet?: true }

export class RoomArchive implements EventArchive {
  #keys?: Promise<ArchiveKeys>
  /** Decrypted per conversation on first read, then kept current by `keep`
   *  until `release`. */
  readonly #streams = new Map<string, Promise<Map<string, Sealed>>>()
  #queue: Sealed[] = []
  #flushing?: Promise<void>
  /** Events queued and not yet written, per conversation, so a reader waits
   *  for its own conversation and never for every room's. */
  readonly #pending = new Map<string, number>()
  readonly #drained = new Map<string, (() => void)[]>()
  readonly #released = new Set<string>()
  #warned = false

  readonly #perStream: number

  constructor(private readonly storage: RoomArchiveStorage, private readonly crypt: Crypto = globalThis.crypto, limits: { perStream?: number } = {}) {
    if (!crypt?.subtle || !crypt.getRandomValues) throw new Error('This device cannot keep an encrypted room archive.')
    this.#perStream = limits.perStream ?? MAX_ARCHIVED_PER_STREAM
  }

  keep(event: Event, meta?: ArchiveMeta): void {
    try {
      if (!wellFormed(event)) return
      const name = streamName(event.kind, archiveTag(event)!)
      this.#pending.set(name, (this.#pending.get(name) ?? 0) + 1)
      this.#queue.push({ event: copyEvent(event), ...(meta?.quiet ? { quiet: true as const } : {}) })
      this.#flushing ??= Promise.resolve().then(() => this.#flush()).finally(() => { this.#flushing = undefined })
    } catch {
      // Keeping is best effort; the room goes on without it.
    }
  }

  /** Resolves once everything kept so far is on disk. */
  async flushed(): Promise<void> {
    while (this.#flushing) await this.#flushing
  }

  async read(query: ArchiveQuery): Promise<Event[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('Use an archive read limit of at least one.')
    const d = query.d.toLowerCase()
    const name = streamName(query.kind, d)
    this.#released.delete(name)
    if (this.#pending.get(name)) await new Promise<void>(resolve => this.#drained.set(name, [...(this.#drained.get(name) ?? []), resolve]))
    const events = await this.#load(query.kind, d)
    return [...events.values()]
      .filter(kept => !(query.reseedable && kept.quiet))
      .map(kept => kept.event)
      .filter(e => (query.since === undefined || e.created_at >= query.since) && (!query.before || olderThan(e, query.before)))
      .sort(compareArchived)
      .slice(0, query.limit)
      .map(copyEvent)
  }

  release(query: Pick<ArchiveQuery, 'kind' | 'd'>): void {
    const name = streamName(query.kind, query.d.toLowerCase())
    // Still being written: let it go once it is on disk.
    if (this.#pending.get(name)) this.#released.add(name)
    else this.#streams.delete(name)
  }

  /** Delete one conversation's records: part of forgetting a room. Waits for
   *  anything still being written, so nothing lands after it. */
  async forget(query: Pick<ArchiveQuery, 'kind' | 'd'>): Promise<void> {
    await this.flushed()
    // No keys yet means nothing was ever kept: never mint a pair to forget nothing.
    if (!await this.storage.keys()) return
    const stream = await this.#streamHandle(query.kind, query.d.toLowerCase())
    const records = await this.storage.stream(stream)
    if (records.length) await this.storage.put([], records.map(record => record.key))
    this.#streams.delete(streamName(query.kind, query.d.toLowerCase()))
  }

  async #flush(): Promise<void> {
    while (this.#queue.length) {
      const batch = this.#queue.splice(0, 200)
      const added: [Map<string, Sealed>, string][] = []
      const touched = new Set<Map<string, Sealed>>()
      try {
        const records: ArchivedRecord[] = []
        for (const kept of batch) {
          const { event } = kept
          const d = archiveTag(event)!
          const events = await this.#load(event.kind, d)
          if (events.has(event.id)) continue
          events.set(event.id, kept)
          added.push([events, event.id])
          touched.add(events)
          records.push(await this.#seal(kept, d))
        }
        // Past the cap, the oldest go: a room that keeps talking keeps its
        // newest history rather than freezing on the day it filled up.
        const remove: string[] = []
        for (const events of touched) {
          if (events.size <= this.#perStream) continue
          const oldest = [...events.values()].map(k => k.event).sort(compareArchived).slice(this.#perStream)
          for (const event of oldest) {
            events.delete(event.id)
            const key = await this.#hash(`event\n${event.id}`)
            const written = records.findIndex(r => r.key === key)
            if (written >= 0) records.splice(written, 1)
            else remove.push(key)
          }
        }
        if (records.length || remove.length) await this.storage.put(records, remove)
      } catch (error) {
        // Not on disk, so not remembered as kept: a later copy tries again.
        for (const [events, id] of added) events.delete(id)
        if (!this.#warned) { this.#warned = true; console.warn('room archive could not keep events', error) }
      } finally {
        for (const { event } of batch) this.#settled(streamName(event.kind, archiveTag(event)!))
      }
    }
  }

  #settled(name: string): void {
    const left = (this.#pending.get(name) ?? 1) - 1
    if (left > 0) { this.#pending.set(name, left); return }
    this.#pending.delete(name)
    for (const resolve of this.#drained.get(name) ?? []) resolve()
    this.#drained.delete(name)
    if (this.#released.delete(name)) this.#streams.delete(name)
  }

  #load(kind: number, d: string): Promise<Map<string, Sealed>> {
    const name = streamName(kind, d)
    let loading = this.#streams.get(name)
    if (!loading) {
      loading = this.#open(kind, d)
      // A failed read is retried next time rather than remembered as empty.
      loading.catch(() => { if (this.#streams.get(name) === loading) this.#streams.delete(name) })
      this.#streams.set(name, loading)
    }
    return loading
  }

  async #open(kind: number, d: string): Promise<Map<string, Sealed>> {
    const stream = await this.#streamHandle(kind, d)
    const { seal } = await this.#deviceKeys()
    const events = new Map<string, Sealed>()
    for (const record of await this.storage.stream(stream)) {
      const kept = await this.#unseal(record, stream, seal)
      // Checked again on the way out: the right conversation, and an id
      // that is the hash of what it names. The signature is the reader's
      // to check, as for any event off a relay.
      if (kept && kept.event.kind === kind && archiveTag(kept.event) === d) events.set(kept.event.id, kept)
    }
    return events
  }

  async #unseal(record: ArchivedRecord, stream: string, seal: CryptoKey): Promise<Sealed | undefined> {
    if (record.version !== RECORD_VERSION || record.stream !== stream || !(record.nonce instanceof ArrayBuffer) ||
        !(record.ciphertext instanceof ArrayBuffer) || record.nonce.byteLength !== NONCE_BYTES) return undefined
    try {
      const plaintext = await this.crypt.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: aad(stream) }, seal, record.ciphertext)
      const sealed = JSON.parse(new TextDecoder().decode(plaintext)) as Sealed
      if (!sealed || typeof sealed !== 'object' || !wellFormed(sealed.event)) return undefined
      return { event: sealed.event, ...(sealed.quiet === true ? { quiet: true as const } : {}) }
    } catch {
      return undefined
    }
  }

  async #seal(kept: Sealed, d: string): Promise<ArchivedRecord> {
    const stream = await this.#streamHandle(kept.event.kind, d)
    const { seal } = await this.#deviceKeys()
    const nonce = new Uint8Array(NONCE_BYTES); this.crypt.getRandomValues(nonce)
    const plaintext = new TextEncoder().encode(JSON.stringify(kept))
    const ciphertext = await this.crypt.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(stream) }, seal, plaintext)
    return { key: await this.#hash(`event\n${kept.event.id}`), stream, version: RECORD_VERSION, nonce: nonce.slice().buffer, ciphertext }
  }

  #streamHandle(kind: number, d: string): Promise<string> { return this.#hash(`stream\n${kind}\n${d}`) }

  async #hash(value: string): Promise<string> {
    const { name } = await this.#deviceKeys()
    const mac = new Uint8Array(await this.crypt.subtle.sign('HMAC', name, new TextEncoder().encode(value)))
    return [...mac].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  #deviceKeys(): Promise<ArchiveKeys> {
    this.#keys ??= (async () => {
      const existing = await this.storage.keys()
      if (existing) return existing
      const seal = await this.crypt.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const name = await this.crypt.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      return this.storage.adoptKeys({ seal, name })
    })()
    this.#keys.catch(() => { this.#keys = undefined })
    return this.#keys
  }
}

function streamName(kind: number, d: string): string { return `${kind}:${d}` }

function aad(stream: string): ArrayBuffer { return new TextEncoder().encode(EVENT_AAD + stream).slice().buffer }

/** A complete event whose id is the hash of what it says. */
function wellFormed(event: Event): boolean {
  if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.kind) || !Number.isSafeInteger(event.created_at) ||
      typeof event.content !== 'string' || !Array.isArray(event.tags) || !/^[0-9a-f]{64}$/.test(event.id) ||
      !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig) || !archiveTag(event)) return false
  if (event.content.length > MAX_EVENT_BYTES) return false
  try { return getEventHash(event) === event.id } catch { return false }
}

/** The signed fields only: no cached verdict or other property rides along. */
function copyEvent(event: Event): Event {
  return { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig }
}

/** Browser persistence. The two device keys are structured-cloned
 *  CryptoKeys and stay non-extractable; records carry only keyed hashes
 *  outside their ciphertext. */
export class BrowserRoomArchiveStorage implements RoomArchiveStorage {
  #db: Promise<IDBDatabase> | undefined
  constructor(private readonly dbName = ROOM_ARCHIVE_DATABASE, private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('This browser does not provide storage for a room archive.')
  }
  async keys(): Promise<ArchiveKeys | undefined> {
    return (await request((await this.#transaction('keys', 'readonly')).objectStore('keys').get('device'))) as ArchiveKeys | undefined
  }
  async adoptKeys(candidate: ArchiveKeys): Promise<ArchiveKeys> {
    const transaction = await this.#transaction('keys', 'readwrite')
    const store = transaction.objectStore('keys')
    const existing = await request(store.get('device')) as ArchiveKeys | undefined
    if (!existing) store.put(candidate, 'device')
    await complete(transaction)
    return existing ?? candidate
  }
  async stream(stream: string): Promise<ArchivedRecord[]> {
    return await request((await this.#transaction('events', 'readonly')).objectStore('events').index('stream').getAll(stream))
  }
  async put(records: readonly ArchivedRecord[], remove: readonly string[] = []): Promise<void> {
    const transaction = await this.#transaction('events', 'readwrite')
    const store = transaction.objectStore('events')
    for (const key of remove) store.delete(key)
    for (const record of records) store.put(record)
    await complete(transaction)
  }
  async #transaction(store: 'keys' | 'events', mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.#database()).transaction(store, mode)
  }
  #database(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, DATABASE_VERSION)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys')
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'key' }).createIndex('stream', 'stream')
      }
      open.onsuccess = () => {
        // Another tab deleting the archive (forgetting this browser) must
        // not wait on this one.
        open.result.onversionchange = () => open.result.close()
        resolve(open.result)
      }
      open.onerror = () => reject(open.error)
    })
  }
}

export const ROOM_ARCHIVE_DATABASE = 'kithmoot-room-archive-v1'

/** Remove this browser's whole archive: part of forgetting the browser. */
export function deleteRoomArchive(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!factory) return Promise.resolve()
  return new Promise(resolve => {
    const deleting = factory.deleteDatabase(ROOM_ARCHIVE_DATABASE)
    deleting.onsuccess = deleting.onerror = deleting.onblocked = () => resolve()
  })
}

function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Room archive transaction was aborted.'))
  })
}

// ---------------------------------------------------------------------------
// Reseeding forgetful relays
// ---------------------------------------------------------------------------

/** One conversation to compare: the filter a reader subscribes with. */
export interface ReseedTarget {
  kind: number
  d: string
  since?: number
  limit: number
  /** Only these signers: the authority, for rekeys. */
  authors?: string[]
}

/** What reseeding needs of a relay pool. `NostrRelayPool` has all of it. */
export interface ReseedPool {
  describe(): RelayConfig[]
  query(url: string, filters: Filter[], timeoutMs?: number): Promise<{ events: Event[]; complete: boolean }>
  publishQuietly(url: string, event: Event): Promise<void>
}

export interface ReseedOptions {
  /** False once the room this is for has closed or been left. */
  alive: () => boolean
  /** Pause between two republished events, so a relay sees a trickle. */
  gapMs?: number
  /** The most events one call republishes, over every relay. */
  budget?: number
  /** How long one relay has to answer one request. */
  timeoutMs?: number
  now?: () => number
}

export interface ReseedReport {
  /** Per relay URL: how many originals it accepted back. */
  reseeded: Map<string, number>
}

/** When a conversation was last compared with a relay, by `url d`, so
 *  reopening a room over and over does not ask the same relay again. */
const lastCompared = new Map<string, number>()
export const RESEED_INTERVAL_MS = 10 * 60_000
const DEFAULT_RESEED_BUDGET = 1_000
/** How many times one comparison pages back with `until` before it settles
 *  for what it has. */
const MAX_COMPARE_PAGES = 10

/**
 * What one relay holds of a conversation, paged back with `until` so a relay
 * that caps how many events it returns is still read to the end. Undefined
 * when the relay did not answer in full: a slow or closed request says
 * nothing about what it holds. `floor` is set when paging stopped before the
 * relay ran out, and nothing older than it can be judged.
 */
async function relayHolds(pool: ReseedPool, url: string, filter: Filter, timeoutMs: number | undefined): Promise<{ ids: Set<string>; floor?: number } | undefined> {
  const ids = new Set<string>()
  let until: number | undefined
  for (let page = 0; page < MAX_COMPARE_PAGES; page++) {
    const answer = await pool.query(url, [{ ...filter, ...(until !== undefined ? { until } : {}) }], timeoutMs)
    if (!answer.complete) return undefined
    let fresh = 0
    for (const event of answer.events) if (!ids.has(event.id)) { ids.add(event.id); fresh++ }
    if (fresh === 0) return { ids }
    // Inclusive, because several events can share the oldest second.
    until = Math.min(...answer.events.map(e => e.created_at))
  }
  return { ids, floor: until }
}

/**
 * Compare each target with each of the room's read-and-write relays, alone,
 * and hand a relay that returned fewer events than this device holds the
 * ones it lacks. Only the pool's own relays are ever written to: the room's
 * relays as this device uses them, never a person's own or anybody else's.
 * A quiet room's chat is never handed back, whatever the targets say.
 * Bounded by window, by `budget` and by `RESEED_INTERVAL_MS` per relay and
 * conversation, paced by `gapMs`, and written through the pool's quiet path,
 * which never marks the room's relay health or reopens its sockets.
 */
export async function reseedRelays(pool: ReseedPool, archive: EventArchive, targets: readonly ReseedTarget[], opts: ReseedOptions): Promise<ReseedReport> {
  const report: ReseedReport = { reseeded: new Map() }
  const gap = opts.gapMs ?? 100
  let budget = opts.budget ?? DEFAULT_RESEED_BUDGET
  const now = opts.now ?? Date.now
  const relays = pool.describe().filter(relay => relay.read && relay.write).map(relay => relay.url)
  for (const target of targets) {
    for (const url of relays) {
      if (!opts.alive() || budget <= 0) return report
      const key = `${url} ${target.kind}:${target.d}`
      if (now() - (lastCompared.get(key) ?? -Infinity) < RESEED_INTERVAL_MS) continue
      lastCompared.set(key, now())
      const filter: Filter = { kinds: [target.kind], '#d': [target.d], limit: target.limit, ...(target.since !== undefined ? { since: target.since } : {}), ...(target.authors ? { authors: target.authors } : {}) }
      let held: Awaited<ReturnType<typeof relayHolds>>
      let archived: Event[]
      try {
        ;[held, archived] = await Promise.all([
          relayHolds(pool, url, filter, opts.timeoutMs),
          archive.read({ kind: target.kind, d: target.d, since: target.since, limit: target.limit, reseedable: true }),
        ])
      } catch {
        continue
      }
      // Unknown is not empty: no reseed and no verdict until it answers.
      if (!held || !opts.alive()) continue
      const candidates = reseedCandidates(
        archived.filter(e => !target.authors || target.authors.includes(e.pubkey)),
        held.ids,
        Math.min(budget, MAX_RESEED_EVENTS),
        held.floor,
      ).filter(verifyEventUncached)
      const sent: string[] = []
      for (const event of candidates) {
        if (!opts.alive()) return report
        budget--
        try {
          await pool.publishQuietly(url, event)
          sent.push(event.id)
        } catch {
          // Refused or unreachable: the next comparison will try again.
        }
        if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap))
      }
      if (sent.length) report.reseeded.set(url, (report.reseeded.get(url) ?? 0) + sent.length)
    }
  }
  return report
}

/** For tests: forget when conversations were last compared. */
export function resetReseedHistory(): void { lastCompared.clear() }
