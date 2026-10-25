import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import {
  createJournalStorage,
  shouldCompactJournal,
  type JournalHead,
  type JournalKeyValueStore,
  type JournalRef,
  type JournalSegment,
} from './journal-storage.js'

const encoder = new TextEncoder()
const digest = (value: string): string => bytesToHex(sha256(encoder.encode(value)))
const sideKey = (root: string, value: string): string => `${root}.journal.v2.${digest(value)}`
const ref = (root: string, value: string): JournalRef => ({ key: sideKey(root, value), sha256: digest(value) })

class MemoryStore implements JournalKeyValueStore {
  readonly values = new Map<string, string>()
  readonly operations: string[] = []
  readonly reads: string[] = []
  writes = 0
  fault?: { write: number; phase: 'before' | 'after' }
  removeFault = false

  constructor(root?: string, value?: string) {
    if (root !== undefined && value !== undefined) this.values.set(root, value)
  }

  async get(key: string): Promise<string | undefined> { this.reads.push(key); return this.values.get(key) }

  async set(key: string, value: string): Promise<void> {
    const write = ++this.writes
    this.operations.push(`set:${key}`)
    if (this.fault?.write === write && this.fault.phase === 'before') {
      this.fault = undefined
      throw new Error('injected failure before write')
    }
    this.values.set(key, value)
    if (this.fault?.write === write && this.fault.phase === 'after') {
      this.fault = undefined
      throw new Error('injected failure after write')
    }
  }

  async remove(key: string): Promise<void> {
    this.operations.push(`remove:${key}`)
    if (this.removeFault) throw new Error('injected cleanup failure')
    this.values.delete(key)
  }

  head(root: string): JournalHead { return JSON.parse(this.values.get(root)!) as JournalHead }
}

function segment(root: string, base: JournalRef, previous: JournalRef | null, body: string): { raw: string; ref: JournalRef; value: JournalSegment } {
  const value: JournalSegment = { v: 2, base, previous, body }
  const raw = JSON.stringify(value)
  return { raw, ref: ref(root, raw), value }
}

const migrationFaults = (['before', 'after'] as const).flatMap(phase => [
  { phase, write: 1, record: 'base' },
  { phase, write: 2, record: 'segment' },
  { phase, write: 3, record: 'head' },
])

const compactionFaults = (['before', 'after'] as const).flatMap(phase => [
  { phase, write: 1, record: 'base' },
  { phase, write: 2, record: 'head' },
])

describe('incremental journal storage', () => {
  it('loads exact legacy bytes without migrating on read', async () => {
    const root = 'assignments'
    const legacy = '{"v":1,"events":["encrypted"],"outbox":[]}'
    const store = new MemoryStore(root, legacy)
    const journal = createJournalStorage(root, store)

    await expect(journal.load()).resolves.toBe(legacy)
    await expect(journal.loadIncremental()).resolves.toEqual({ base: legacy, deltas: [] })
    expect([...store.values.keys()]).toEqual([root])
  })

  it('migrates the exact v1 base and replays deltas in chronological order', async () => {
    const root = 'assignments'
    const legacy = '{"v":1,"events":[],"outbox":["exact raw bytes"]}'
    const store = new MemoryStore(root, legacy)
    const journal = createJournalStorage(root, store)

    await journal.appendIncremental('first')
    const firstHead = store.head(root)
    await journal.appendIncremental('second')
    const secondHead = store.head(root)

    await expect(journal.loadIncremental()).resolves.toEqual({ base: legacy, deltas: ['first', 'second'] })
    await expect(journal.load()).rejects.toThrow('use loadIncremental')
    expect(store.values.get(firstHead.base!.key)).toBe(legacy)
    const first = JSON.parse(store.values.get(firstHead.tip!.key)!) as JournalSegment
    const second = JSON.parse(store.values.get(secondHead.tip!.key)!) as JournalSegment
    expect(first.previous).toBeNull()
    expect(second.previous).toEqual(firstHead.tip)
    expect(first.base).toEqual(firstHead.base)
    expect(second.base).toEqual(firstHead.base)
    expect(secondHead.base).toEqual(firstHead.base)
    await expect(createJournalStorage(root, store).loadIncremental()).resolves.toEqual({ base: legacy, deltas: ['first', 'second'] })
  })

  it('supports a first delta when no legacy snapshot exists', async () => {
    const store = new MemoryStore()
    const journal = createJournalStorage('new', store)
    await journal.appendIncremental('first')
    await expect(journal.loadIncremental()).resolves.toEqual({ base: '', deltas: ['first'] })
  })

  it('keeps the head constant-sized as delta bodies and the chain grow', async () => {
    const root = 'head'
    const store = new MemoryStore(root, 'base')
    const journal = createJournalStorage(root, store)
    await journal.appendIncremental('x')
    const lengths = [store.values.get(root)!.length]
    await journal.appendIncremental('a much larger opaque delta'.repeat(100))
    lengths.push(store.values.get(root)!.length)
    await journal.appendIncremental('third')
    lengths.push(store.values.get(root)!.length)

    expect(lengths[1]).toBe(lengths[0])
    expect(lengths[2]).toBe(lengths[0])
    expect(store.values.get(root)).not.toContain('opaque delta')
    expect(store.values.get(root)).not.toContain('third')
  })

  it('save replaces the base and cleans the old generation only after head commit', async () => {
    const root = 'compact'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('old base')
    await journal.appendIncremental('one')
    await journal.appendIncremental('two')
    const old = store.head(root)
    const oldRecords = [old.base!.key, old.tip!.key, (JSON.parse(store.values.get(old.tip!.key)!) as JournalSegment).previous!.key]
    store.operations.length = 0

    await journal.save('new base')
    const current = store.head(root)
    expect(current.tip).toBeNull()
    await expect(journal.load()).resolves.toBe('new base')
    await expect(journal.loadIncremental()).resolves.toEqual({ base: 'new base', deltas: [] })
    expect(store.values.get(current.base!.key)).toBe('new base')
    for (const key of oldRecords) expect(store.values.has(key)).toBe(false)
    const commit = store.operations.lastIndexOf(`set:${root}`)
    expect(commit).toBeGreaterThanOrEqual(0)
    for (const [index, operation] of store.operations.entries()) {
      if (operation.startsWith('remove:')) expect(index).toBeGreaterThan(commit)
    }
  })

  it('does not delete a reused base during compaction and supports tombstone cleanup', async () => {
    const root = 'tombstones'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('same base')
    await journal.appendIncremental('old delta')
    const old = store.head(root)
    const oldTip = old.tip!.key

    await journal.save('same base')
    expect(store.values.get(old.base!.key)).toBe('same base')
    expect(store.values.has(oldTip)).toBe(false)

    await journal.appendIncremental('another old delta')
    const beforeTombstones = store.head(root)
    const withoutRemove: JournalKeyValueStore = { get: key => store.get(key), set: (key, value) => store.set(key, value) }
    const tombstoning = createJournalStorage(root, withoutRemove)
    await tombstoning.save('replacement')
    expect(store.values.get(beforeTombstones.base!.key)).toBe('')
    expect(store.values.get(beforeTombstones.tip!.key)).toBe('')
    await expect(tombstoning.loadIncremental()).resolves.toEqual({ base: 'replacement', deltas: [] })
  })

  it('treats old-generation deletion as best effort after the new head is durable', async () => {
    const root = 'cleanup-failure'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('old')
    await journal.appendIncremental('delta')
    store.removeFault = true

    await expect(journal.save('new')).resolves.toBeUndefined()
    await expect(journal.loadIncremental()).resolves.toEqual({ base: 'new', deltas: [] })
  })

  it('never exposes valid or corrupt crash orphans', async () => {
    const root = 'orphans'
    const store = new MemoryStore(root, 'legacy')
    const journal = createJournalStorage(root, store)
    await journal.appendIncremental('reachable')
    const head = store.head(root)
    const orphan = segment(root, head.base!, null, 'orphan')
    store.values.set(orphan.ref.key, orphan.raw)
    store.values.set(`${root}.journal.v2.${'0'.repeat(64)}`, 'corrupt unreachable bytes')

    await expect(journal.loadIncremental()).resolves.toEqual({ base: 'legacy', deltas: ['reachable'] })
  })

  it('makes missing or corrupt referenced bases fatal', async () => {
    const root = 'base-faults'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('base')
    await journal.appendIncremental('delta')
    const base = store.head(root).base!

    store.values.delete(base.key)
    await expect(journal.loadIncremental()).rejects.toThrow('missing')
    store.values.set(base.key, 'changed')
    await expect(journal.loadIncremental()).rejects.toThrow('SHA-256')
  })

  it('makes a missing or corrupt later segment fatal without returning a partial prefix', async () => {
    const root = 'segment-faults'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('base')
    await journal.appendIncremental('first')
    await journal.appendIncremental('second')
    const tip = store.head(root).tip!
    const middle = (JSON.parse(store.values.get(tip.key)!) as JournalSegment).previous!

    store.values.delete(middle.key)
    await expect(journal.loadIncremental()).rejects.toThrow('missing')
    store.values.set(middle.key, store.values.get(middle.key) ?? 'corrupt')
    await expect(journal.loadIncremental()).rejects.toThrow()
    store.values.set(tip.key, 'corrupt tip')
    await expect(journal.loadIncremental()).rejects.toThrow('SHA-256')
  })

  it('rejects a segment bound to another base', async () => {
    const root = 'wrong-base'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('base one')
    await journal.appendIncremental('one')
    const original = store.head(root)
    const other = segment(root, ref(root, 'base two'), null, 'two')
    store.values.set(other.ref.key, other.raw)
    store.values.set(root, JSON.stringify({ ...original, tip: other.ref }))

    await expect(journal.loadIncremental()).rejects.toThrow('another base')
  })

  it('fails closed on malformed, unsupported, and cyclic roots or chains', async () => {
    const root = 'invalid'
    const store = new MemoryStore(root, JSON.stringify({ v: 3, base: null, tip: null }))
    const journal = createJournalStorage(root, store)
    await expect(journal.loadIncremental()).rejects.toThrow('Unsupported')

    store.values.set(root, JSON.stringify({ v: 2, base: null, tip: null, extra: true }))
    await expect(journal.loadIncremental()).rejects.toThrow('Invalid journal v2 head')

    const baseValue = 'base'
    const base = ref(root, baseValue)
    store.values.set(base.key, baseValue)
    const placeholder = segment(root, base, null, 'cycle')
    const cyclicRef = { key: `${root}.journal.v2.${'a'.repeat(64)}`, sha256: 'a'.repeat(64) }
    const cyclic = JSON.stringify({ ...placeholder.value, previous: cyclicRef })
    store.values.set(cyclicRef.key, cyclic)
    store.values.set(root, JSON.stringify({ v: 2, base, tip: cyclicRef }))
    await expect(journal.loadIncremental()).rejects.toThrow()
  })

  it('enforces depth and byte limits on writes and reload', async () => {
    const root = 'limits'
    const store = new MemoryStore()
    const shallow = createJournalStorage(root, store, { maxDepth: 2, maxBytes: 4096 })
    await shallow.save('base')
    await shallow.appendIncremental('one')
    await shallow.appendIncremental('two')
    await expect(shallow.appendIncremental('three')).rejects.toThrow('depth limit')
    await expect(createJournalStorage(root, store, { maxDepth: 1, maxBytes: 4096 }).loadIncremental()).rejects.toThrow('depth limit')

    const bytesStore = new MemoryStore()
    const bounded = createJournalStorage('bytes', bytesStore, { maxBytes: 256 })
    await bounded.save('base')
    await expect(bounded.appendIncremental('x'.repeat(300))).rejects.toThrow('byte limit')
    await expect(bounded.loadIncremental()).resolves.toEqual({ base: 'base', deltas: [] })
    await expect(createJournalStorage('bytes', bytesStore, { maxBytes: 2 }).loadIncremental()).rejects.toThrow('byte limit')
  })

  it('serialises concurrent appends so neither tip overwrites the other', async () => {
    const root = 'serial'
    const store = new MemoryStore(root, 'base')
    const journal = createJournalStorage(root, store)
    await Promise.all([journal.appendIncremental('one'), journal.appendIncremental('two'), journal.appendIncremental('three')])
    await expect(journal.loadIncremental()).resolves.toEqual({ base: 'base', deltas: ['one', 'two', 'three'] })
  })

  it('appends from verified metadata without replaying the existing chain', async () => {
    const root = 'append-metadata'
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('base')
    await journal.appendIncremental('one')
    await journal.loadIncremental()
    store.reads.length = 0

    await journal.appendIncremental('two')
    expect(store.reads).toEqual([store.head(root).tip!.key])
    await expect(journal.loadIncremental()).resolves.toEqual({ base: 'base', deltas: ['one', 'two'] })
  })

  it('does not overwrite a different immutable record at a content-addressed key', async () => {
    const root = 'immutable'
    const store = new MemoryStore(root, 'base')
    const journal = createJournalStorage(root, store)
    const base = ref(root, 'base')
    const next = segment(root, base, null, 'delta')
    store.values.set(next.ref.key, 'different orphan bytes')

    await expect(journal.appendIncremental('delta')).rejects.toThrow('immutable')
    expect(store.values.get(root)).toBe('base')
  })

  it.each(migrationFaults)('keeps migration safe on $phase failure of the $record write', async ({ phase, write }) => {
    const root = `migration-${phase}-${write}`
    const legacy = '{"v":1,"exact":"legacy bytes"}'
    const store = new MemoryStore(root, legacy)
    store.fault = { phase, write }
    const journal = createJournalStorage(root, store)

    await expect(journal.appendIncremental('delta')).rejects.toThrow('injected failure')
    if (phase === 'after' && write === 3) {
      await expect(journal.loadIncremental()).resolves.toEqual({ base: legacy, deltas: ['delta'] })
    } else {
      expect(store.values.get(root)).toBe(legacy)
      await expect(journal.loadIncremental()).resolves.toEqual({ base: legacy, deltas: [] })
    }
  })

  it.each(compactionFaults)('keeps compaction safe on $phase failure of the $record write', async ({ phase, write }) => {
    const root = `compaction-${phase}-${write}`
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    await journal.save('old base')
    await journal.appendIncremental('old delta')
    const oldRoot = store.values.get(root)
    store.writes = 0
    store.fault = { phase, write }

    await expect(journal.save('new base')).rejects.toThrow('injected failure')
    if (phase === 'after' && write === 2) {
      await expect(journal.loadIncremental()).resolves.toEqual({ base: 'new base', deltas: [] })
    } else {
      expect(store.values.get(root)).toBe(oldRoot)
      await expect(journal.loadIncremental()).resolves.toEqual({ base: 'old base', deltas: ['old delta'] })
    }
  })
})

describe('journal compaction policy', () => {
  it('uses delta bytes relative to the base with a 1 MiB floor', () => {
    expect(shouldCompactJournal({ baseBytes: 100, deltaBytes: 1024 * 1024 - 1, baseRecordCount: 10_000, deltaMutations: 1 })).toBe(false)
    expect(shouldCompactJournal({ baseBytes: 100, deltaBytes: 1024 * 1024, baseRecordCount: 10_000, deltaMutations: 1 })).toBe(true)
    expect(shouldCompactJournal({ baseBytes: 2 * 1024 * 1024, deltaBytes: 1024 * 1024, baseRecordCount: 10_000, deltaMutations: 1 })).toBe(false)
    expect(shouldCompactJournal({ baseBytes: 2 * 1024 * 1024, deltaBytes: 2 * 1024 * 1024, baseRecordCount: 10_000, deltaMutations: 1 })).toBe(true)
  })

  it('uses mutations relative to base records rather than a fixed commit count', () => {
    expect(shouldCompactJournal({ baseBytes: 1024 * 1024, deltaBytes: 100, baseRecordCount: 1000, deltaMutations: 300 })).toBe(false)
    expect(shouldCompactJournal({ baseBytes: 1024 * 1024, deltaBytes: 100, baseRecordCount: 1000, deltaMutations: 1000 })).toBe(true)
    expect(shouldCompactJournal({ baseBytes: 1024 * 1024, deltaBytes: 100, baseRecordCount: 10, deltaMutations: 255 })).toBe(false)
    expect(shouldCompactJournal({ baseBytes: 1024 * 1024, deltaBytes: 100, baseRecordCount: 10, deltaMutations: 256 })).toBe(true)
    expect(shouldCompactJournal({ baseBytes: 0, deltaBytes: 0, baseRecordCount: 0, deltaMutations: 0 })).toBe(false)
  })
})
