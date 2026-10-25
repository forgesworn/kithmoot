import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

export interface JournalImage {
  base?: string
  deltas: string[]
}

export interface JournalStorage {
  load(): Promise<string | undefined>
  save(snapshot: string): Promise<void>
  loadIncremental?(): Promise<JournalImage>
  appendIncremental?(delta: string): Promise<void>
}

export interface IncrementalJournalStorage extends JournalStorage {
  loadIncremental(): Promise<JournalImage>
  appendIncremental(delta: string): Promise<void>
}

export interface JournalRef {
  key: string
  sha256: string
}

export interface JournalHead {
  v: 2
  base: JournalRef | null
  tip: JournalRef | null
}

export interface JournalSegment {
  v: 2
  base: JournalRef
  previous: JournalRef | null
  body: string
}

/** set() must atomically and durably replace one key before it resolves. */
export interface JournalKeyValueStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  remove?(key: string): Promise<void>
}

export interface JournalStorageOptions {
  /** Maximum UTF-8 bytes in the reachable base and segments. */
  maxBytes?: number
  /** Maximum reachable delta segments. */
  maxDepth?: number
}

export interface JournalCompactionStats {
  baseBytes: number
  deltaBytes: number
  baseRecordCount: number
  deltaMutations: number
}

const encoder = new TextEncoder()
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 4096
const suffix = '.journal.v2.'

const utf8Bytes = (value: string): number => encoder.encode(value).byteLength
const digest = (value: string): string => bytesToHex(sha256(encoder.encode(value)))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
const sameRef = (a: JournalRef, b: JournalRef): boolean => a.key === b.key && a.sha256 === b.sha256

function readRef(value: unknown, root: string): JournalRef {
  if (!object(value) || !exactKeys(value, ['key', 'sha256']) || typeof value.key !== 'string' || typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256) || value.key !== `${root}${suffix}${value.sha256}`) throw new Error('Invalid journal record reference')
  return { key: value.key, sha256: value.sha256 }
}

function readHead(value: unknown, root: string): JournalHead {
  if (!object(value) || !exactKeys(value, ['v', 'base', 'tip']) || value.v !== 2) throw new Error('Invalid journal v2 head')
  const base = value.base === null ? null : readRef(value.base, root)
  const tip = value.tip === null ? null : readRef(value.tip, root)
  if (tip && !base) throw new Error('A journal tip requires a base')
  return { v: 2, base, tip }
}

function readSegment(value: unknown, root: string): JournalSegment {
  if (!object(value) || !exactKeys(value, ['v', 'base', 'previous', 'body']) || value.v !== 2 || typeof value.body !== 'string') throw new Error('Invalid journal v2 segment')
  return { v: 2, base: readRef(value.base, root), previous: value.previous === null ? null : readRef(value.previous, root), body: value.body }
}

interface JournalState {
  image: JournalImage
  head: JournalHead | null
  references: JournalRef[]
  bytes: number
}

/** The amortised policy uses work relative to the base, never a fixed commit count. */
export function shouldCompactJournal(stats: JournalCompactionStats): boolean {
  if (Object.values(stats).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid journal compaction statistics')
  return stats.deltaBytes >= Math.max(stats.baseBytes, 1024 * 1024) ||
    stats.deltaMutations >= Math.max(256, stats.baseRecordCount)
}

export function createJournalStorage(root: string, store: JournalKeyValueStore, options: JournalStorageOptions = {}): IncrementalJournalStorage {
  if (!root) throw new Error('A journal root key is required')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error('Invalid journal storage limits')
  let tail: Promise<unknown> = Promise.resolve()
  let cached: JournalState | undefined

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const task = tail.then(work)
    tail = task.catch(() => {})
    return task
  }

  async function refresh(): Promise<JournalState> {
    try {
      const state = await read()
      cached = state
      return state
    } catch (error) {
      cached = undefined
      throw error
    }
  }

  async function current(): Promise<JournalState> { return cached ?? refresh() }
  const copy = (image: JournalImage): JournalImage => ({ ...image, deltas: [...image.deltas] })

  function reference(value: string): JournalRef {
    const sha256 = digest(value)
    return { key: `${root}${suffix}${sha256}`, sha256 }
  }

  async function record(ref: JournalRef): Promise<string> {
    const raw = await store.get(ref.key)
    if (raw === undefined) throw new Error('A referenced journal record is missing')
    if (digest(raw) !== ref.sha256) throw new Error('A referenced journal record failed SHA-256 verification')
    return raw
  }

  async function read(): Promise<JournalState> {
    const raw = await store.get(root)
    if (raw === undefined) return { image: { deltas: [] }, head: null, references: [], bytes: 0 }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return { image: { base: raw, deltas: [] }, head: null, references: [], bytes: 0 } }
    if (!object(parsed) || !Object.hasOwn(parsed, 'v')) return { image: { base: raw, deltas: [] }, head: null, references: [], bytes: 0 }
    if (parsed.v === 1) return { image: { base: raw, deltas: [] }, head: null, references: [], bytes: 0 }
    if (parsed.v !== 2) throw new Error('Unsupported journal root version')
    const head = readHead(parsed, root)
    const image: JournalImage = { deltas: [] }
    const references: JournalRef[] = []
    let bytes = 0
    if (head.base) {
      const base = await record(head.base)
      bytes = utf8Bytes(base)
      if (bytes > maxBytes) throw new Error('Journal exceeds its byte limit')
      image.base = base
      references.push(head.base)
    }
    const deltas: string[] = []
    const seen = new Set<string>()
    let next = head.tip
    while (next) {
      if (deltas.length >= maxDepth) throw new Error('Journal exceeds its depth limit')
      if (seen.has(next.key)) throw new Error('Journal chain contains a cycle')
      seen.add(next.key)
      const rawSegment = await record(next)
      bytes += utf8Bytes(rawSegment)
      if (bytes > maxBytes) throw new Error('Journal exceeds its byte limit')
      let parsedSegment: unknown
      try { parsedSegment = JSON.parse(rawSegment) } catch { throw new Error('A referenced journal segment is corrupt') }
      const segment = readSegment(parsedSegment, root)
      if (!head.base || !sameRef(segment.base, head.base)) throw new Error('Journal segment belongs to another base')
      deltas.push(segment.body)
      references.push(next)
      next = segment.previous
    }
    image.deltas = deltas.reverse()
    return { image, head, references, bytes }
  }

  async function writeRecord(ref: JournalRef, value: string): Promise<void> {
    const existing = await store.get(ref.key)
    if (existing === value || existing === '' && value === '') return
    if (existing !== undefined && existing !== '') throw new Error('An immutable journal record was changed')
    await store.set(ref.key, value)
  }

  async function cleanup(references: JournalRef[], keep: JournalRef): Promise<void> {
    const removed = new Set<string>()
    for (const ref of [...references].reverse()) {
      if (ref.key === keep.key || removed.has(ref.key)) continue
      removed.add(ref.key)
      try { if (store.remove) await store.remove(ref.key); else await store.set(ref.key, '') } catch { }
    }
  }

  async function save(snapshot: string): Promise<void> {
    if (typeof snapshot !== 'string') throw new Error('A journal base must be a string')
    const previous = await current()
    const bytes = utf8Bytes(snapshot)
    if (bytes > maxBytes) throw new Error('Journal exceeds its byte limit')
    const base = reference(snapshot)
    const head: JournalHead = { v: 2, base, tip: null }
    await writeRecord(base, snapshot)
    await store.set(root, JSON.stringify(head))
    await cleanup(previous.references, base)
    cached = { image: { base: snapshot, deltas: [] }, head, references: [base], bytes }
  }

  async function append(delta: string): Promise<void> {
    if (typeof delta !== 'string') throw new Error('A journal delta must be a string')
    const previous = await current()
    if (previous.image.deltas.length >= maxDepth) throw new Error('Journal exceeds its depth limit')
    const migratingBase = !previous.head?.base
    const baseValue = migratingBase ? previous.image.base ?? '' : undefined
    const base = migratingBase ? reference(baseValue!) : previous.head!.base!
    const segment: JournalSegment = { v: 2, base, previous: previous.head?.tip ?? null, body: delta }
    const rawSegment = JSON.stringify(segment)
    const tip = reference(rawSegment)
    const nextBytes = (migratingBase ? utf8Bytes(baseValue!) : previous.bytes) + utf8Bytes(rawSegment)
    if (nextBytes > maxBytes) throw new Error('Journal exceeds its byte limit')
    if (migratingBase) await writeRecord(base, baseValue!)
    await writeRecord(tip, rawSegment)
    const head: JournalHead = { v: 2, base, tip }
    await store.set(root, JSON.stringify(head))
    if (migratingBase) { previous.image.base = baseValue!; previous.references.push(base) }
    previous.image.deltas.push(delta)
    previous.references.push(tip)
    previous.head = head
    previous.bytes = nextBytes
    cached = previous
  }

  return {
    load: () => serial(async () => {
      const state = await refresh()
      if (state.image.deltas.length) throw new Error('Legacy load cannot return a journal with deltas; use loadIncremental()')
      return state.image.base
    }),
    save: snapshot => serial(async () => {
      try { await save(snapshot) } catch (error) { cached = undefined; throw error }
    }),
    loadIncremental: () => serial(async () => copy((await refresh()).image)),
    appendIncremental: delta => serial(async () => {
      try { await append(delta) } catch (error) { cached = undefined; throw error }
    }),
  }
}
