/**
 * The home list's sections: Pinned, Unread, Recent, Older and Ended.
 *
 * docs/2026-10-05-room-list-sections.md is the design, shared with the
 * Android app, which groups its list by the same rules. A short list, or a
 * search, is not worth headings: then this is one list with the pinned rooms
 * first, and a search never hides a match behind a closed fold.
 */

export type RoomSection = 'pinned' | 'unread' | 'recent' | 'older' | 'ended'

export const SECTION_ORDER: readonly RoomSection[] = ['pinned', 'unread', 'recent', 'older', 'ended']

export const SECTION_LABELS: Record<RoomSection, string> = {
  pinned: 'Pinned',
  unread: 'Unread',
  recent: 'Recent',
  older: 'Older',
  ended: 'Ended',
}

/** Sections a person can fold away, and whether they start folded. */
export const FOLDABLE: Partial<Record<RoomSection, true>> = { older: true, ended: true }

/** Up to this many rooms, no headings: the same threshold that shows Find a room. */
export const SECTION_THRESHOLD = 8

/** Activity this recent, in seconds, is Recent rather than Older. */
export const RECENT_SECONDS = 7 * 24 * 60 * 60

export interface SectionFacts {
  pinned: boolean
  ended: boolean
  /** Unread messages from people; agents do not count. */
  unread: number
  /** Unix seconds of the room's latest activity. */
  activity: number
}

export function sectionOf(facts: SectionFacts, now: number): RoomSection {
  if (facts.pinned) return 'pinned'
  if (facts.ended) return 'ended'
  if (facts.unread > 0) return 'unread'
  return facts.activity >= now - RECENT_SECONDS ? 'recent' : 'older'
}

export interface SectionGroup<T> {
  section: RoomSection
  rooms: T[]
}

/**
 * Group rooms already in activity order. Undefined when the list should be
 * flat: a search, or no more than `SECTION_THRESHOLD` rooms. The order
 * within a section is the order given; empty sections are left out.
 */
export function groupRooms<T>(rooms: readonly T[], section: (room: T) => RoomSection, searching: boolean): SectionGroup<T>[] | undefined {
  if (searching || rooms.length <= SECTION_THRESHOLD) return undefined
  const groups = new Map<RoomSection, T[]>()
  for (const room of rooms) {
    const key = section(room)
    const group = groups.get(key)
    if (group) group.push(room)
    else groups.set(key, [room])
  }
  return SECTION_ORDER.filter(key => groups.has(key)).map(key => ({ section: key, rooms: groups.get(key)! }))
}

/** Pinned rooms first, each part keeping the order it was given. */
export function pinnedFirst<T>(rooms: readonly T[], pinned: (room: T) => boolean): T[] {
  return [...rooms.filter(pinned), ...rooms.filter(room => !pinned(room))]
}

/** The heading's text: the label, and the count while folded. */
export function sectionHeading(section: RoomSection, count: number, folded: boolean): string {
  return folded ? `${SECTION_LABELS[section]} · ${count}` : SECTION_LABELS[section]
}

/** The colour slot for a room's initial: one of eight, fixed by its id. */
export function avatarSlot(roomId: string): number {
  const byte = parseInt(roomId.slice(0, 2), 16)
  return Number.isFinite(byte) ? byte % 8 : 0
}

/** The letter or digit a room's avatar shows. */
export function avatarInitial(label: string): string {
  const match = label.match(/[\p{L}\p{N}]/u)
  return match ? match[0].toLocaleUpperCase() : '#'
}
