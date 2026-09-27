import type { Event } from 'nostr-tools/pure'

/**
 * A device's own copy of a room's original signed events.
 *
 * Room history used to be exactly as durable as the one relay that still
 * stored it: every client read chat from relays every time, and a relay that
 * forgot took the room's past with it. An archive keeps each event as it
 * arrived, ciphertext and signature, never anything decrypted, so the copy is
 * as safe to hold as the relay's was, can be checked again when it is read
 * back, and can be handed to a relay unchanged.
 *
 * What goes in is only what the caller has already accepted: a chat event
 * that decoded under the room's rules, a rekey whose signature checked. What
 * comes out is untrusted again and goes through the same decoder as an event
 * off a relay, so an archive can widen what a device remembers and never what
 * it believes. The web implementation is `app/src/room-archive.ts`.
 */
export interface EventArchive {
  /** Keep one accepted event. Idempotent, and never throws: it runs inside a
   *  relay subscription handler. Writing may finish later. */
  keep(event: Event): void
  /** Kept events of one kind under one `d` tag, newest first. */
  read(query: ArchiveQuery): Promise<Event[]>
}

export interface ArchiveQuery {
  kind: number
  d: string
  /** Oldest `created_at` to include. */
  since?: number
  /** Only events strictly older than this position, in newest-first order:
   *  earlier `created_at`, or the same second and a smaller id. The cursor a
   *  reader pages back with. */
  before?: ArchiveCursor
  limit: number
}

export interface ArchiveCursor { at: number; id: string }

/** The `d` tag an event is filed under, or undefined. */
export function archiveTag(event: Pick<Event, 'tags'>): string | undefined {
  const d = event.tags.find(tag => tag[0] === 'd')?.[1]
  return typeof d === 'string' && d.length > 0 && d.length <= 128 ? d.toLowerCase() : undefined
}

/** Newest first; a tie on the second breaks on id, the same order a cursor
 *  pages through. */
export function compareArchived(a: Pick<Event, 'created_at' | 'id'>, b: Pick<Event, 'created_at' | 'id'>): number {
  return b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/** Whether `event` sits strictly after `cursor` in newest-first order. */
export function olderThan(event: Pick<Event, 'created_at' | 'id'>, cursor: ArchiveCursor): boolean {
  return event.created_at < cursor.at || (event.created_at === cursor.at && event.id < cursor.id)
}

/** The most events one device republishes to one relay for one conversation
 *  in one pass: the window a reader renders, and no more. */
export const MAX_RESEED_EVENTS = 500

/**
 * Which of a device's archived events a relay should be handed back.
 *
 * Only when the relay returned fewer of the conversation's events than the
 * archive holds for the same window: a relay that returned as many or more
 * is not forgetful, whatever it is missing, and is left alone. Then the
 * archived events it did not return, newest first, at most `limit`. The
 * events are the archive's originals, unchanged; the caller verifies each
 * signature again before it publishes anything.
 */
export function reseedCandidates(archived: readonly Event[], returned: ReadonlySet<string>, limit = MAX_RESEED_EVENTS): Event[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('reseed limit must be a whole number')
  if (returned.size >= archived.length) return []
  return archived.filter(event => !returned.has(event.id)).sort(compareArchived).slice(0, limit)
}
