import type { Event } from 'nostr-tools/pure'
import {
  HISTORY_IMPORT_MAX_EVENTS,
  MAX_PRIVATE_MIGRATION_EVENTS,
  historyImportRequest,
  importBoundedHistory,
  submitPrivateMigrationRequest,
  type HistoryImportResult,
  type HistoryRequestClass,
  type HistoryRelayReader,
  type PrivateMigrationIdentity,
  type PrivateMigrationReply,
  type RelayTransport,
} from '../../src/index.js'

/** A deliberately visible first recovery window. Further windows must be
 * selected/resumed by the person; this is not a background crawler. */
export const HISTORY_RECOVERY_WINDOW_SECONDS = 30 * 24 * 60 * 60
/** Public kinds whose original signed records this version can retain. The
 * local index is stricter and currently admits only decryptable NIP-17 DMs
 * plus verified account-authored kind-1 notes. */
export const RECOVERABLE_AUTHORED_KINDS = [0, 1, 3, 4, 5, 6, 7, 10002, 30023] as const
export const RECOVERABLE_ADDRESSED_KINDS = [4, 1059] as const

export function recentHistoryRecoveryRequests(person: string, until: number): ReturnType<typeof historyImportRequest>[] {
  if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid recovery end time.')
  const since = Math.max(0, until - HISTORY_RECOVERY_WINDOW_SECONDS)
  return [
    historyImportRequest({ class: 'authored', person, kinds: RECOVERABLE_AUTHORED_KINDS, since, until, limit: HISTORY_IMPORT_MAX_EVENTS }),
    historyImportRequest({ class: 'addressed', person, kinds: RECOVERABLE_ADDRESSED_KINDS, since, until, limit: HISTORY_IMPORT_MAX_EVENTS }),
  ]
}

export interface HistoryRecoveryReadWindow {
  relay: string
  class: HistoryRequestClass
  until: number
}

/** One narrow filter for one persisted relay/class cursor. Keeping the relay
 * outside the filter is deliberate: callers must not let a complete relay
 * advance a different relay that timed out or applied a smaller limit. */
export function historyRecoveryRequest(person: string, window: HistoryRecoveryReadWindow): ReturnType<typeof historyImportRequest> {
  if (window.class !== 'authored' && window.class !== 'addressed' || !Number.isSafeInteger(window.until) || window.until < 0 || !window.relay) throw new Error('Invalid history recovery window.')
  const since = Math.max(0, window.until - HISTORY_RECOVERY_WINDOW_SECONDS)
  return historyImportRequest({
    class: window.class,
    person,
    kinds: window.class === 'authored' ? RECOVERABLE_AUTHORED_KINDS : RECOVERABLE_ADDRESSED_KINDS,
    since,
    until: window.until,
    limit: HISTORY_IMPORT_MAX_EVENTS,
  })
}

export async function recoverRecentHistory(input: {
  person: string
  relays: readonly string[]
  until: number
  read: HistoryRelayReader
}): Promise<HistoryImportResult> {
  return await importBoundedHistory({ relays: input.relays, requests: recentHistoryRecoveryRequests(input.person, input.until), read: input.read })
}

/** Runs independently per persisted relay/class cursor and re-applies global
 * deduplication across the combined result. `importBoundedHistory` owns the
 * hostile-relay validation for each request; this layer owns only the cursor
 * isolation that makes a later recovery action truthful. */
export async function recoverHistoryWindows(input: {
  person: string
  windows: readonly HistoryRecoveryReadWindow[]
  read: HistoryRelayReader
}): Promise<HistoryImportResult> {
  if (input.windows.length === 0 || input.windows.length > 64) throw new Error('Use 1-64 recovery windows.')
  const responses = await Promise.all(input.windows.map(async window => await importBoundedHistory({
    relays: [window.relay], requests: [historyRecoveryRequest(input.person, window)], read: input.read,
  })))
  const ids = new Set<string>(), events: Event[] = []
  for (const response of responses) for (const event of response.events) if (!ids.has(event.id)) {
    ids.add(event.id); events.push(event)
  }
  return { events, receipts: responses.flatMap(response => response.receipts) }
}

/** Retain a bounded import in the selected verified box. Every batch receives
 * its own authenticated receipt; an error receipt is returned rather than
 * converted into a claim that the box stored anything. */
export async function retainRecoveredHistory(input: {
  events: readonly Event[]
  identity: PrivateMigrationIdentity
  node: string
  transport: Pick<RelayTransport, 'publish' | 'subscribe'>
  nonce: () => string
}): Promise<{ batches: { ids: string[]; reply: PrivateMigrationReply }[] }> {
  const batches: { ids: string[]; reply: PrivateMigrationReply }[] = []
  for (let offset = 0; offset < input.events.length; offset += MAX_PRIVATE_MIGRATION_EVENTS) {
    const events = input.events.slice(offset, offset + MAX_PRIVATE_MIGRATION_EVENTS)
    const reply = await submitPrivateMigrationRequest({ identity: input.identity, node: input.node, operation: { op: 'retain', events }, nonce: input.nonce(), transport: input.transport })
    batches.push({ ids: events.map(event => event.id), reply })
  }
  return { batches }
}
