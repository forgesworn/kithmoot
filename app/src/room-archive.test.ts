import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { RoomArchive, reseedRelays, resetReseedHistory, type ArchiveKeys, type ArchivedRecord, type ReseedPool, type RoomArchiveStorage } from './room-archive.js'
import type { RelayConfig } from '../../src/relay-pool.js'

const crypt = webcrypto as unknown as Crypto
const ROOM = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const sk = generateSecretKey()

class MemoryStorage implements RoomArchiveStorage {
  stored?: ArchiveKeys
  records = new Map<string, ArchivedRecord>()
  async keys(): Promise<ArchiveKeys | undefined> { return this.stored }
  async adoptKeys(candidate: ArchiveKeys): Promise<ArchiveKeys> { return this.stored ??= candidate }
  async stream(stream: string): Promise<ArchivedRecord[]> { return [...this.records.values()].filter(r => r.stream === stream) }
  async put(records: readonly ArchivedRecord[], remove: readonly string[] = []): Promise<void> { for (const k of remove) this.records.delete(k); for (const r of records) this.records.set(r.key, r) }
}

const chat = (text: string, at: number, d = ROOM, kind = 1460): Event =>
  finalizeEvent({ kind, created_at: at, tags: [['d', d]], content: `ciphertext:${text}` }, sk)

describe('room archive at rest', () => {
  it('round-trips original events, newest first, by kind and conversation, with a strict cursor', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt)
    const events = [chat('a', 100), chat('b', 200), chat('c', 300), chat('elsewhere', 250, OTHER), chat('rekey', 150, ROOM, 1462)]
    for (const event of events) archive.keep(event)
    archive.keep(events[0]!)
    await archive.flushed()
    expect(storage.records.size).toBe(5)
    expect((await archive.read({ kind: 1460, d: ROOM, limit: 10 })).map(e => e.content)).toEqual(['ciphertext:c', 'ciphertext:b', 'ciphertext:a'])
    expect(await archive.read({ kind: 1460, d: ROOM, limit: 10 })).toEqual([events[2], events[1], events[0]].map(e => JSON.parse(JSON.stringify(e))))
    expect((await archive.read({ kind: 1460, d: ROOM, since: 150, limit: 10 })).map(e => e.created_at)).toEqual([300, 200])
    expect((await archive.read({ kind: 1460, d: ROOM, before: { at: 200, id: events[1]!.id }, limit: 10 })).map(e => e.created_at)).toEqual([100])
    expect((await archive.read({ kind: 1462, d: ROOM, limit: 10 })).map(e => e.content)).toEqual(['ciphertext:rekey'])

    // A second tab, or the next visit, opens the same records.
    const reopened = new RoomArchive(storage, crypt)
    expect(await reopened.read({ kind: 1460, d: OTHER, limit: 10 })).toHaveLength(1)
  })

  it('shows neither room ids, event ids, contents nor times outside the ciphertext, under non-extractable keys', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt)
    const event = chat('secret', 1_799_999_999)
    archive.keep(event)
    await archive.flushed()
    expect(storage.stored!.seal.extractable).toBe(false)
    expect(storage.stored!.name.extractable).toBe(false)
    const record = [...storage.records.values()][0]!
    const visible = JSON.stringify({ key: record.key, stream: record.stream, version: record.version }) + Buffer.from(record.ciphertext).toString('latin1')
    for (const leak of [ROOM, event.id, event.pubkey, event.sig, 'ciphertext:secret', String(event.created_at)]) expect(visible).not.toContain(leak)
    expect(Object.keys(record).sort()).toEqual(['ciphertext', 'key', 'nonce', 'stream', 'version'])
  })

  it('checks events on the way in and records on the way out', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt)
    const good = chat('good', 100)
    archive.keep({ ...good, content: 'changed after signing' })
    archive.keep({ ...chat('no tag', 100), tags: [] })
    archive.keep(good)
    await archive.flushed()
    expect(storage.records.size).toBe(1)

    // Tampered ciphertext, and a record moved to another conversation, are
    // not handed to anybody.
    archive.keep(chat('other', 100, OTHER))
    await archive.flushed()
    const [first, second] = [...storage.records.values()]
    storage.records.set(first!.key, { ...first!, ciphertext: first!.ciphertext.slice(1) })
    storage.records.set(second!.key, { ...second!, stream: first!.stream })
    const fresh = new RoomArchive(storage, crypt)
    expect(await fresh.read({ kind: 1460, d: ROOM, limit: 10 })).toEqual([])
    expect(await fresh.read({ kind: 1460, d: OTHER, limit: 10 })).toEqual([])
  })

  it('agrees on one pair of device keys when two tabs start at once', async () => {
    const storage = new MemoryStorage()
    const [a, b] = [new RoomArchive(storage, crypt), new RoomArchive(storage, crypt)]
    a.keep(chat('from a', 1)); b.keep(chat('from b', 2))
    await Promise.all([a.flushed(), b.flushed()])
    expect(await new RoomArchive(storage, crypt).read({ kind: 1460, d: ROOM, limit: 10 })).toHaveLength(2)
  })

  it('past the cap drops the oldest, on disk too, and keeps the newest', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt, { perStream: 3 })
    for (let i = 1; i <= 5; i++) archive.keep(chat(`m${i}`, i))
    await archive.flushed()
    archive.keep(chat('m6', 6))
    await archive.flushed()
    expect((await archive.read({ kind: 1460, d: ROOM, limit: 10 })).map(e => e.created_at)).toEqual([6, 5, 4])
    expect(storage.records.size).toBe(3)
    expect((await new RoomArchive(storage, crypt).read({ kind: 1460, d: ROOM, limit: 10 })).map(e => e.created_at)).toEqual([6, 5, 4])
  })

  it('lets a conversation go from memory when released, and reads it back from disk', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt)
    archive.keep(chat('a', 1))
    expect(await archive.read({ kind: 1460, d: ROOM, limit: 10 })).toHaveLength(1)
    let loads = 0
    const stream = storage.stream.bind(storage)
    storage.stream = async (s: string) => { loads++; return stream(s) }
    await archive.read({ kind: 1460, d: ROOM, limit: 10 })
    expect(loads).toBe(0)
    archive.release({ kind: 1460, d: ROOM })
    expect(await archive.read({ kind: 1460, d: ROOM, limit: 10 })).toHaveLength(1)
    expect(loads).toBe(1)
  })

  it('a reader waits for its own conversation to be written, not for every room', async () => {
    const storage = new MemoryStorage()
    const archive = new RoomArchive(storage, crypt)
    archive.keep(chat('here', 1))
    // Another room's write that never finishes must not hold this read up.
    const put = storage.put.bind(storage)
    let stall: () => void = () => {}
    const stalled = new Promise<void>(resolve => { stall = resolve })
    let reached = false
    await archive.read({ kind: 1460, d: ROOM, limit: 10 })
    storage.put = async (records, remove) => { reached = true; await stalled; return put(records, remove) }
    archive.keep(chat('elsewhere', 2, OTHER))
    await expect.poll(() => reached).toBe(true)
    expect(await archive.read({ kind: 1460, d: ROOM, limit: 10 })).toHaveLength(1)
    stall()
    await archive.flushed()
  })
})

/** A pool of named relays, each holding what it holds. A relay in `forgets`
 *  accepts and stores nothing; one in `caps` returns at most that many
 *  events per request, newest first; one in `silent` never finishes. */
class FakePool implements ReseedPool {
  published: { url: string; id: string }[] = []
  asked: Filter[] = []
  constructor(public relays: Map<string, Event[]>, public config: RelayConfig[], public forgets = new Set<string>(),
    public caps = new Map<string, number>(), public silent = new Set<string>()) {}
  describe(): RelayConfig[] { return this.config }
  async query(url: string, filters: Filter[]): Promise<{ events: Event[]; complete: boolean }> {
    const f = filters[0]!
    this.asked.push(f)
    if (this.silent.has(url)) return { events: [], complete: false }
    const matching = (this.relays.get(url) ?? []).filter(e => (!f.ids || f.ids.includes(e.id)) &&
      (!f.kinds || f.kinds.includes(e.kind)) && (!f['#d'] || e.tags.some(t => t[0] === 'd' && f['#d']!.includes(t[1]!))) &&
      (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until) &&
      (!f.authors || f.authors.includes(e.pubkey)))
    const limit = Math.min(f.limit ?? Infinity, this.caps.get(url) ?? Infinity)
    return { events: matching.sort((a, b) => b.created_at - a.created_at).slice(0, limit), complete: true }
  }
  async publishQuietly(url: string, event: Event): Promise<void> {
    if (!this.config.some(r => r.url === url && r.write)) throw new Error('not a room relay')
    this.published.push({ url, id: event.id })
    if (!this.forgets.has(url)) this.relays.get(url)!.push(event)
  }
}

describe('reseeding forgetful relays', () => {
  beforeEach(() => resetReseedHistory())
  const both = (url: string): RelayConfig => ({ url, read: true, write: true })

  async function kept(...events: (Event | [Event, { quiet: true }])[]): Promise<RoomArchive> {
    const archive = new RoomArchive(new MemoryStorage(), crypt)
    for (const event of events) Array.isArray(event) ? archive.keep(...event) : archive.keep(event)
    await archive.flushed()
    return archive
  }

  it('hands a relay that returned fewer the originals it lacks, unchanged, and only to that relay', async () => {
    const events = [chat('1', 100), chat('2', 200), chat('3', 300)]
    const archive = await kept(...events)
    const pool = new FakePool(new Map([['wss://full', [...events]], ['wss://forgot', [events[0]!]]]), [both('wss://full'), both('wss://forgot'), { url: 'wss://read-only', read: true, write: false }])
    const report = await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, since: 0, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(pool.published).toEqual([{ url: 'wss://forgot', id: events[2]!.id }, { url: 'wss://forgot', id: events[1]!.id }])
    expect(pool.relays.get('wss://forgot')!.map(e => e.id).sort()).toEqual(events.map(e => e.id).sort())
    expect(pool.relays.get('wss://forgot')![1]).toEqual(JSON.parse(JSON.stringify(events[2])))
    expect(report.reseeded).toEqual(new Map([['wss://forgot', 2]]))

    // Asked again at once, nobody is compared twice.
    await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, since: 0, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(pool.published).toHaveLength(2)
  })

  it('reads a relay that caps its answers to the end, and republishes nothing it holds', async () => {
    const events = Array.from({ length: 12 }, (_, i) => chat(`m${i}`, 100 + i))
    const archive = await kept(...events)
    const pool = new FakePool(new Map([['wss://capped', [...events]]]), [both('wss://capped')], new Set(), new Map([['wss://capped', 5]]))
    await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, since: 0, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(pool.published).toEqual([])
    expect(pool.asked.some(f => f.until !== undefined)).toBe(true)

    // Missing one in the middle, it is found through the pages and only it goes back.
    resetReseedHistory()
    const gappy = new FakePool(new Map([['wss://capped', events.filter((_, i) => i !== 3)]]), [both('wss://capped')], new Set(), new Map([['wss://capped', 5]]))
    await reseedRelays(gappy, archive, [{ kind: 1460, d: ROOM, since: 0, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(gappy.published.map(p => p.id)).toEqual([events[3]!.id])
  })

  it('treats a relay that does not finish answering as unknown: nothing republished', async () => {
    const archive = await kept(chat('a', 100), chat('b', 200))
    const pool = new FakePool(new Map([['wss://slow', []]]), [both('wss://slow')], new Set(), new Map(), new Set(['wss://slow']))
    await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(pool.published).toEqual([])
  })

  it('stays inside the window and the budget, and skips anything whose signature fails', async () => {
    const events = [chat('old', 10), chat('a', 100), chat('b', 200), chat('c', 300)]
    const archive = await kept(...events)
    const pool = new FakePool(new Map([['wss://empty', []]]), [both('wss://empty')])
    await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, since: 50, limit: 500 }], { alive: () => true, gapMs: 0, budget: 2 })
    expect(pool.published.map(p => p.id)).toEqual([events[3]!.id, events[2]!.id])

    resetReseedHistory()
    const forged = await kept({ ...chat('x', 100), sig: 'f'.repeat(128) })
    const clean = new FakePool(new Map([['wss://empty', []]]), [both('wss://empty')])
    await reseedRelays(clean, forged, [{ kind: 1460, d: ROOM, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(clean.published).toEqual([])
  })

  it('never hands back what came through a quiet room', async () => {
    const open = chat('open', 100)
    const archive = await kept(open, [chat('quiet', 200), { quiet: true }])
    const pool = new FakePool(new Map([['wss://r', []]]), [both('wss://r')])
    await reseedRelays(pool, archive, [{ kind: 1460, d: ROOM, limit: 500 }], { alive: () => true, gapMs: 0 })
    expect(pool.published.map(p => p.id)).toEqual([open.id])
    // Still read back for the room itself.
    expect(await archive.read({ kind: 1460, d: ROOM, limit: 10 })).toHaveLength(2)
  })

  it('republishes a rekey only when the room authority signed it, and stops when the room closes', async () => {
    const authority = finalizeEvent({ kind: 1462, created_at: 1, tags: [['d', ROOM]], content: '' }, sk).pubkey
    const stranger = finalizeEvent({ kind: 1462, created_at: 2, tags: [['d', ROOM]], content: '' }, generateSecretKey())
    const genuine = chat('rekey', 3, ROOM, 1462)
    const archive = await kept(genuine, stranger)
    const pool = new FakePool(new Map([['wss://r', []]]), [both('wss://r')])
    await reseedRelays(pool, archive, [{ kind: 1462, d: ROOM, limit: 1000, authors: [authority] }], { alive: () => true, gapMs: 0 })
    expect(pool.published.map(p => p.id)).toEqual([genuine.id])

    resetReseedHistory()
    const closed = new FakePool(new Map([['wss://r', []]]), [both('wss://r')])
    await reseedRelays(closed, archive, [{ kind: 1462, d: ROOM, limit: 1000, authors: [authority] }], { alive: () => false, gapMs: 0 })
    expect(closed.published).toEqual([])
  })
})
