import { matchFilters, type Filter } from 'nostr-tools/filter'
import type { Event } from 'nostr-tools/pure'
import { normaliseHex } from './hex.js'
import { normaliseRelayConfig } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'

/** The maximum number of events a single recovery request may ask a relay for.
 * A full recovery walks explicit time windows; it never uses an unbounded
 * "everything" request. */
export const HISTORY_IMPORT_MAX_EVENTS = 500
/** A relay frame larger than this is not admitted to migration custody. */
export const HISTORY_IMPORT_MAX_EVENT_BYTES = 96_000

export type HistoryRequestClass = 'authored' | 'addressed'
export type HistoryTerminal = 'complete' | 'unavailable' | 'closed' | 'timeout' | 'limited'

/** A stable event position. Callers persist one per relay and request class
 * while walking a bounded window backwards. The ID breaks same-second ties. */
export interface HistoryCursor { createdAt: number; id: string }

export interface HistoryImportRequest {
  /** Bump only for an intentionally incompatible filter meaning. */
  version: 1
  class: HistoryRequestClass
  /** The selected person's public key, not an inferred contact. */
  person: string
  /** Exact, visible relay filter. `search` is deliberately not supported. */
  filter: Filter
  /** Optional persisted position which is copied into every receipt. */
  cursor?: HistoryCursor
}

export interface HistoryReadResult {
  /** The reader only returns `complete` after a real EOSE for this request. */
  terminal: Exclude<HistoryTerminal, 'limited'>
  events: readonly Event[]
  detail?: string
}

/** The transport adapter owns sockets and must distinguish EOSE, timeout and
 * CLOSED. The importer deliberately has no fallback to the live chat pool. */
export type HistoryRelayReader = (relay: string, filter: Filter) => Promise<HistoryReadResult>

export interface HistoryImportReceipt {
  relay: string
  request: HistoryImportRequest
  startedAt: number
  finishedAt: number
  terminal: HistoryTerminal
  accepted: number
  duplicate: number
  invalid: number
  rejected: number
  cursor?: HistoryCursor
  detail?: string
}

export interface HistoryImportResult {
  /** New, verified signed events only. The caller chooses private custody. */
  events: Event[]
  receipts: HistoryImportReceipt[]
}

export interface BoundedHistoryImport {
  relays: readonly string[]
  requests: readonly HistoryImportRequest[]
  read: HistoryRelayReader
  now?: () => number
}

const HEX = /^[0-9a-f]{64}$/
const terminal = new Set<HistoryTerminal>(['complete', 'unavailable', 'closed', 'timeout', 'limited'])

/** Creates one of the only two recovery request classes. The event kinds are
 * supplied by the owning application so it cannot accidentally crawl kinds it
 * has no decoder or custody rule for. */
export function historyImportRequest(input: {
  class: HistoryRequestClass
  person: string
  kinds: readonly number[]
  since: number
  until: number
  limit: number
  cursor?: HistoryCursor
}): HistoryImportRequest {
  const person = normalisePerson(input.person)
  const kinds = [...new Set(input.kinds)]
  const filter: Filter = { kinds, since: input.since, until: input.until, limit: input.limit }
  if (input.class === 'authored') filter.authors = [person]
  else filter['#p'] = [person]
  const request: HistoryImportRequest = { version: 1, class: input.class, person, filter, ...(input.cursor ? { cursor: input.cursor } : {}) }
  assertHistoryImportRequest(request)
  return request
}

/** Reject requests which look broad even if they were constructed without the
 * helper. This makes the boundary enforceable at the custody call site. */
export function assertHistoryImportRequest(request: HistoryImportRequest): void {
  if (!request || request.version !== 1 || (request.class !== 'authored' && request.class !== 'addressed')) throw new Error('unsupported history import request')
  const person = normalisePerson(request.person)
  const filter = request.filter
  if (!filter || typeof filter !== 'object' || 'search' in filter) throw new Error('history import does not support relay search')
  if (!Array.isArray(filter.kinds) || filter.kinds.length === 0 || filter.kinds.length > 16 || filter.kinds.some(kind => !Number.isSafeInteger(kind) || kind < 0 || kind > 65_535)) throw new Error('history import needs explicit supported event kinds')
  const since = filter.since, until = filter.until, limit = filter.limit
  if (typeof since !== 'number' || typeof until !== 'number' || !Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until < since) throw new Error('history import needs a bounded time range')
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_IMPORT_MAX_EVENTS) throw new Error(`history import limit must be 1-${HISTORY_IMPORT_MAX_EVENTS}`)
  if (request.class === 'authored') {
    if (!sameOnly(filter.authors, person) || filter['#p'] !== undefined) throw new Error('authored history must name exactly the selected author')
  } else if (!sameOnly(filter['#p'], person) || filter.authors !== undefined) {
    throw new Error('addressed history must name exactly the selected recipient')
  }
  if (request.cursor && (!Number.isSafeInteger(request.cursor.createdAt) || request.cursor.createdAt < 0 || !HEX.test(request.cursor.id))) throw new Error('invalid history cursor')
}

/** Runs independently per relay and request class. It retains neither plaintext
 * nor a network connection: its output is deliberately just verified original
 * events plus truthful receipts for the private migration layer. */
export async function importBoundedHistory(input: BoundedHistoryImport): Promise<HistoryImportResult> {
  const relays = normaliseRelayConfig(input.relays.map(url => ({ url, read: true, write: false }))).map(relay => relay.url)
  if (input.requests.length === 0 || input.requests.length > 32) throw new Error('provide 1-32 history import requests')
  for (const request of input.requests) assertHistoryImportRequest(request)
  const now = input.now ?? (() => Date.now())
  const seen = new Set<string>()
  const events: Event[] = []
  const receipts = await Promise.all(relays.flatMap(relay => input.requests.map(async request => {
    const startedAt = now()
    let result: HistoryReadResult
    try {
      result = await input.read(relay, { ...request.filter })
    } catch (error) {
      result = { terminal: 'unavailable', events: [], detail: error instanceof Error ? error.message : String(error) }
    }
    const receipt: HistoryImportReceipt = { relay, request, startedAt, finishedAt: now(), terminal: validTerminal(result.terminal) ? result.terminal : 'unavailable', accepted: 0, duplicate: 0, invalid: 0, rejected: 0, ...(request.cursor ? { cursor: request.cursor } : {}), ...(result.detail ? { detail: result.detail } : {}) }
    for (const event of result.events) {
      if (!isPlausibleEvent(event) || eventBytes(event) > HISTORY_IMPORT_MAX_EVENT_BYTES || !verifyEventUncached(event)) { receipt.invalid++; continue }
      if (!matchFilters([request.filter], event) || !matchesClass(request, event)) { receipt.rejected++; continue }
      if (seen.has(event.id)) { receipt.duplicate++; continue }
      seen.add(event.id)
      receipt.accepted++
      events.push(event)
    }
    // An EOSE after exactly the requested cap is a truthful completion of this
    // request, but not evidence that the window is exhausted. Require a resume.
    if (receipt.terminal === 'complete' && result.events.length >= request.filter.limit!) receipt.terminal = 'limited'
    return receipt
  })))
  return { events, receipts }
}

/** Deterministic position useful to the caller's persisted backwards walk. */
export function oldestHistoryCursor(events: readonly Event[]): HistoryCursor | undefined {
  let oldest: HistoryCursor | undefined
  for (const event of events) {
    if (!isPlausibleEvent(event)) continue
    const cursor = { createdAt: event.created_at, id: event.id }
    if (!oldest || cursor.createdAt < oldest.createdAt || (cursor.createdAt === oldest.createdAt && cursor.id < oldest.id)) oldest = cursor
  }
  return oldest
}

function normalisePerson(value: string): string {
  const person = normaliseHex(value)
  if (!HEX.test(person)) throw new Error('history import needs a 32-byte public key')
  return person
}

function sameOnly(values: unknown, person: string): boolean {
  return Array.isArray(values) && values.length === 1 && values[0] === person
}

function validTerminal(value: unknown): value is Exclude<HistoryTerminal, 'limited'> {
  return typeof value === 'string' && terminal.has(value as HistoryTerminal) && value !== 'limited'
}

function isPlausibleEvent(event: Event): boolean {
  return !!event && HEX.test(event.id) && HEX.test(event.pubkey) && Number.isSafeInteger(event.created_at) && event.created_at >= 0 &&
    Number.isSafeInteger(event.kind) && event.kind >= 0 && Array.isArray(event.tags) && typeof event.content === 'string'
}

function eventBytes(event: Event): number {
  try { return new TextEncoder().encode(JSON.stringify(event)).byteLength } catch { return Infinity }
}

function matchesClass(request: HistoryImportRequest, event: Event): boolean {
  return request.class === 'authored' ? event.pubkey === request.person : event.tags.some(tag => tag.length >= 2 && tag[0] === 'p' && tag[1] === request.person)
}
