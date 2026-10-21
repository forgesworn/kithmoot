import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayTransport } from './relay-pool.js'
import { KINDS } from './kinds.js'
import { ownEnvelope2Events, type ChatStream } from './chat.js'
import { scanChatHistory } from './chat-history-scan.js'

/**
 * Take back what a device signed in a room that self-destructs, as far as
 * NIP-09 allows. A deletion request is a request: a relay may decline it or
 * keep a copy, and anything another member already copied stays with them.
 */

/** Deletion requests carry at most this many event ids. */
export const DELETION_IDS_PER_REQUEST = 300
/** A page of what a key signed, asked for in one go. */
const QUERY_LIMIT = 1_000
/** Rounds of ask-then-delete, so a room with more than a page is emptied. */
const MAX_ROUNDS = 5
/** Chat streams named in one filter's `#d`. */
const STREAMS_PER_FILTER = 20

export interface DeletionKey {
  sk: Uint8Array
  /** Only this key's events of these kinds. Absent: everything it signed. */
  kinds?: number[]
}

export interface DeletionReport {
  /** Events found, other than deletion requests. */
  found: number
  /** Events named in a deletion request that a relay took. */
  requested: number
  /** Requests a relay refused or that could not be sent. */
  failed: number
  /** False when history discovery was partial, capped or timed out. */
  complete: boolean
}

/** One NIP-09 request naming these events. */
export function deletionRequest(sk: Uint8Array, events: readonly Event[], now: number): Event {
  const kinds = [...new Set(events.map((e) => e.kind))].sort((a, b) => a - b)
  return finalizeEvent({
    kind: 5,
    created_at: now,
    content: 'This KithMoot room self-destructed.',
    tags: [...events.map((e) => ['e', e.id]), ...kinds.map((k) => ['k', String(k)])],
  }, sk)
}

async function readEvents(transport: RelayTransport, filter: Filter, deadline: number): Promise<{ events: Event[]; complete: boolean }> {
  // Reuse the same configured, route-owned query capability as history
  // recovery. A generic subscribe callback can also mean a local timeout.
  const queryable = transport as RelayTransport & {
    query?: (url: string, filters: Filter[], timeoutMs?: number, maxEvents?: number) => Promise<{ events: Event[]; complete: boolean }>
  }
  if (typeof queryable.query === 'function' && typeof queryable.describe === 'function') {
    const events = new Map<string, Event>()
    let urls: string[]
    try { urls = [...new Set(queryable.describe().filter(r => r.read).map(r => r.url))] }
    catch { return { events: [], complete: false } }
    let complete = urls.length > 0
    for (const url of urls) {
      if (Date.now() >= deadline) return { events: [...events.values()], complete: false }
      try {
        const read = await queryable.query(url, [filter], Math.max(1, deadline - Date.now()), QUERY_LIMIT)
        if (!read.complete) complete = false
        for (const event of read.events.slice(0, QUERY_LIMIT)) {
          if (events.has(event.id)) continue
          if (events.size >= QUERY_LIMIT) return { events: [...events.values()], complete: false }
          events.set(event.id, event)
        }
        if (read.events.length > QUERY_LIMIT) return { events: [...events.values()], complete: false }
      } catch { complete = false }
    }
    return { events: [...events.values()], complete }
  }
  return new Promise((resolve) => {
    const events: Event[] = []
    const seen = new Set<string>()
    let done = false
    let unsub: (() => void) | undefined
    const finish = (complete: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { unsub?.() } catch { /* A closed pool has nothing to unsubscribe. */ }
      resolve({ events, complete })
    }
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
    try {
      unsub = transport.subscribe([filter], event => {
        if (done || seen.has(event.id)) return
        if (events.length >= QUERY_LIMIT) { finish(false); return }
        seen.add(event.id); events.push(event)
      }, () => finish(false))
    } catch { finish(false) }
    if (done) try { unsub?.() } catch { /* As above. */ }
  })
}

/**
 * Ask the relays what each key signed and ask them to delete it, in requests
 * of at most 300 ids, within `timeoutMs` overall. Best effort: it never
 * throws, and says what it could and could not do.
 */
export async function deleteSignedEvents(opts: {
  transport: RelayTransport
  keys: readonly DeletionKey[]
  /** Unix seconds. */
  now: () => number
  timeoutMs?: number
  /** This device's chat streams, to find what it wrote in chat envelope 2:
   *  each such message is signed by its own outer key, which no `authors`
   *  query names, so the streams are read and each message the device wrote
   *  is asked for under its own key (see `ownEnvelope2Events`). Omitted,
   *  only what the keys above signed is asked for. */
  chat?: { deviceSk: Uint8Array; streams: readonly ChatStream[] }
}): Promise<DeletionReport> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  const report: DeletionReport = { found: 0, requested: 0, failed: 0, complete: true }
  for (const key of opts.keys) {
    const author = getPublicKey(key.sk)
    const asked = new Set<string>()
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const filter: Filter = { authors: [author], ...(key.kinds ? { kinds: key.kinds } : {}), limit: QUERY_LIMIT }
      const read = await readEvents(opts.transport, filter, deadline)
      if (!read.complete) report.complete = false
      // A deletion is not deleted: the request is the record that it was asked.
      const fresh = [...new Map(read.events.filter((e) => e.kind !== 5 && !asked.has(e.id)).map((e) => [e.id, e])).values()]
      report.found += fresh.length
      if (fresh.length === 0) break
      for (let i = 0; i < fresh.length; i += DELETION_IDS_PER_REQUEST) {
        const group = fresh.slice(i, i + DELETION_IDS_PER_REQUEST)
        for (const e of group) asked.add(e.id)
        if (Date.now() >= deadline) { report.complete = false; report.failed += group.length; continue }
        try {
          await Promise.race([
            opts.transport.publish(deletionRequest(key.sk, group, opts.now())),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), Math.max(1, deadline - Date.now())).unref?.()),
          ])
          report.requested += group.length
        } catch {
          report.failed += group.length
        }
      }
      if (fresh.length < QUERY_LIMIT) break
      if (round === MAX_ROUNDS - 1) report.complete = false
    }
  }
  if (opts.chat && opts.chat.streams.length > 0) await deleteOwnEnvelope2(opts.transport, opts.chat, opts.now, deadline, report)
  return report
}

/** The envelope-2 pass of `deleteSignedEvents`: one request per message,
 *  each signed by that message's outer key. */
async function deleteOwnEnvelope2(
  transport: RelayTransport,
  chat: { deviceSk: Uint8Array; streams: readonly ChatStream[] },
  now: () => number,
  deadline: number,
  report: DeletionReport,
): Promise<void> {
  const asked = new Set<string>()
  for (let i = 0; i < chat.streams.length; i += STREAMS_PER_FILTER) {
    const streams = chat.streams.slice(i, i + STREAMS_PER_FILTER)
    const complete = await scanChatHistory({ kinds: [KINDS.CHAT], '#d': streams.map(s => s.d) }, filter => {
      if (Date.now() >= deadline) return Promise.resolve({ events: [], complete: false })
      return readEvents(transport, filter, deadline)
    }, async events => {
      const fresh = new Map<string, { event: Event; sk: Uint8Array }>()
      for (const own of ownEnvelope2Events(events.filter(e => !asked.has(e.id)), streams, chat.deviceSk)) {
        if (fresh.has(own.event.id)) own.sk.fill(0)
        else fresh.set(own.event.id, own)
      }
      report.found += fresh.size
      for (const { event, sk } of fresh.values()) {
        asked.add(event.id)
        try {
          if (Date.now() >= deadline) { report.complete = false; report.failed += 1; continue }
          await Promise.race([
            transport.publish(deletionRequest(sk, [event], now())),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), Math.max(1, deadline - Date.now())).unref?.()),
          ])
          report.requested += 1
        } catch {
          report.failed += 1
        } finally {
          sk.fill(0)
        }
      }
    })
    if (!complete) report.complete = false
  }
}
