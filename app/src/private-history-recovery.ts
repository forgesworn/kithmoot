import type { Event } from 'nostr-tools/pure'
import {
  HISTORY_IMPORT_MAX_EVENTS,
  MAX_PRIVATE_MIGRATION_EVENTS,
  historyImportRequest,
  importBoundedHistory,
  submitPrivateMigrationRequest,
  type HistoryImportResult,
  type HistoryRelayReader,
  type PrivateMigrationIdentity,
  type PrivateMigrationReply,
  type RelayTransport,
} from '../../src/index.js'

/** A deliberately visible first recovery window. Further windows must be
 * selected/resumed by the person; this is not a background crawler. */
export const HISTORY_RECOVERY_WINDOW_SECONDS = 30 * 24 * 60 * 60
/** Public kinds whose original signed records this version can retain. The
 * local index is stricter and currently admits only decryptable NIP-17 DMs. */
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

export async function recoverRecentHistory(input: {
  person: string
  relays: readonly string[]
  until: number
  read: HistoryRelayReader
}): Promise<HistoryImportResult> {
  return await importBoundedHistory({ relays: input.relays, requests: recentHistoryRecoveryRequests(input.person, input.until), read: input.read })
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
