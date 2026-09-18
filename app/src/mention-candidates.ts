/**
 * The pure parts of the `@` picker and of turning a typed draft into wire
 * mentions - pulled out of `main.ts` so they can be tested without a DOM.
 *
 * Everything on screen shows the DISPLAYED name (`shownAs` in `main.ts`:
 * fresh profile name, else remembered profile name, else announced joining
 * name - see `profile-name.ts`). The picker lists and inserts that same
 * displayed name, never the announced one underneath it, so what a person
 * sees offered is what lands in the box.
 *
 * Two people can share a displayed name. The picker tells them apart by
 * `participant` internally and shows the short npub beside each entry that
 * collides; `chooseMention` in `main.ts` records which participant was
 * actually picked for that name, per draft, so `resolveDraftMentions`
 * below can prefer that participant over its name-mates when the same text
 * is later turned into the wire `mentions` field. A name nobody picked -
 * typed by hand - still resolves the old way, by matching every
 * participant who currently answers to it.
 */
import { mentionsOf, type Named } from '../../src/index.js'

export interface MentionRosterEntry {
  participant: string
  /** The displayed name - see module doc. Absent participants (nobody
   *  ever typed one) are not candidates. */
  name: string
  agent: boolean
}

export interface MentionChoice {
  name: string
  /** Absent for `@all`/`@everyone` and for a model completion, both of
   *  which do not name one participant. */
  participant?: string
  agent: boolean
  room?: boolean
  /** Shown only when another candidate in this list shares the same name,
   *  so a duplicate can be told apart before it is picked. */
  npub?: string
}

const RESERVED = new Set(['all', 'everyone'])

/**
 * Everybody in the room bar yourself, people and agents alike, ordered so
 * that what has been typed so far leads the list. A displayed name shared
 * by more than one participant appears once per participant, each carrying
 * `npub` so the picker can tell them apart.
 */
export function buildMentionCandidates(
  query: string,
  roster: readonly MentionRosterEntry[],
  npubFor: (participant: string) => string,
): MentionChoice[] {
  const wanted = query.toLowerCase()
  const counts = new Map<string, number>()
  for (const entry of roster) {
    const name = entry.name.trim()
    if (!name || RESERVED.has(name.toLowerCase())) continue
    const key = name.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const seenParticipants = new Set<string>()
  const all: MentionChoice[] = []
  for (const entry of roster) {
    const name = entry.name.trim()
    if (!name || RESERVED.has(name.toLowerCase())) continue
    if (seenParticipants.has(entry.participant)) continue
    seenParticipants.add(entry.participant)
    const dup = (counts.get(name.toLowerCase()) ?? 0) > 1
    all.push({ name, participant: entry.participant, agent: entry.agent, npub: dup ? npubFor(entry.participant) : undefined })
  }
  // The whole room, last, so a name still leads when one matches.
  all.push({ name: 'all', agent: false, room: true })
  if (wanted && 'everyone'.startsWith(wanted)) all.push({ name: 'everyone', agent: false, room: true })
  if (!wanted) return all
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(wanted))
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(wanted) && c.name.toLowerCase().includes(wanted))
  return [...starts, ...contains]
}

/**
 * The wire `mentions` a typed draft justifies: `mentionsOf`'s usual
 * reading of `roster` (displayed names, so it agrees with what is
 * highlighted once sent - see `mention-render.ts`), refined by `picked`:
 * a lowercased-name -> participant map of what the `@` picker actually
 * inserted for names still in `text`. When a name is shared by more than
 * one participant and one of them was picked, only that participant is
 * kept; a name nobody picked still matches every participant who answers
 * to it, as it always has.
 */
export function resolveDraftMentions(
  text: string,
  roster: readonly Named[],
  picked: ReadonlyMap<string, string>,
  max: number,
): string[] {
  const raw = mentionsOf({ text }, roster)
  const byName = new Map<string, Set<string>>()
  for (const entry of roster) {
    const name = entry.name?.trim().toLowerCase()
    if (!name) continue
    let set = byName.get(name)
    if (!set) byName.set(name, set = new Set())
    set.add(entry.participant)
  }
  const drop = new Set<string>()
  for (const [name, participants] of byName) {
    if (participants.size < 2) continue
    const pick = picked.get(name)
    if (pick === undefined || !participants.has(pick)) continue
    for (const participant of participants) if (participant !== pick) drop.add(participant)
  }
  return raw.filter((p) => !drop.has(p)).slice(0, max)
}
