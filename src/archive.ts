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
  keep(event: Event, meta?: ArchiveMeta): void
  /** Kept events of one kind under one `d` tag, newest first. */
  read(query: ArchiveQuery): Promise<Event[]>
  /** Nobody is reading this conversation now: an archive that holds it in
   *  memory may let it go. */
  release?(query: Pick<ArchiveQuery, 'kind' | 'd'>): void
}

/** What an archive records beside an event, sealed with it. */
export interface ArchiveMeta {
  /** It came through a quiet room, where chat never appears on a relay as
   *  a bare room event. Such an event is never handed back to a relay,
   *  whatever the room is opened as later. See `quiet.ts`. */
  quiet?: boolean
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
  /** Only events that may be handed back to a relay: not a quiet room's. */
  reseedable?: boolean
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
 * archived events it did not return, newest first, at most `limit`.
 *
 * `floor` is for an answer that may be cut short: a relay that caps how many
 * events it returns hands back its newest and stops, so an archived event
 * older than the oldest one it returned says nothing about whether the relay
 * holds it. Such events are left out of the count and out of the result.
 *
 * The events are the archive's originals, unchanged; the caller verifies
 * each signature again before it publishes anything.
 */
export function reseedCandidates(archived: readonly Event[], returned: ReadonlySet<string>, limit = MAX_RESEED_EVENTS, floor?: number): Event[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('reseed limit must be a whole number')
  const judged = floor === undefined ? archived : archived.filter(event => event.created_at >= floor)
  if (returned.size >= judged.length) return []
  return judged.filter(event => !returned.has(event.id)).sort(compareArchived).slice(0, limit)
}
