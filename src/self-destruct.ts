import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayTransport } from './relay-pool.js'

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
  /** False when the time ran out before every question was answered. */
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

function readEvents(transport: RelayTransport, filter: Filter, deadline: number): Promise<{ events: Event[]; complete: boolean }> {
  return new Promise((resolve) => {
    const events: Event[] = []
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
    unsub = transport.subscribe([filter], (event) => { events.push(event) }, () => finish(true))
    if (done) try { unsub() } catch { /* As above. */ }
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
    }
  }
  return report
}
