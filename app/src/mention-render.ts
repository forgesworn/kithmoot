/**
 * The pure parts of highlighting a mention in a rendered message - pulled
 * out of `main.ts` so they can be tested without a DOM. `appendMentions`
 * in `main.ts` turns `segmentMentions`'s output into `span` elements.
 */
import { EVERYONE, ROOM_MENTION_PATTERN, mentionsOf, type ChatMessage, type Named } from '../../src/index.js'

/**
 * One pattern for a set of names, longest first so "The moot" wins over a
 * shorter name inside it. Word boundaries by letter-or-digit rather than
 * `\b`, exactly as the agent side does them, so a name that is not ASCII
 * still gets the boundary it needs and a name with a space in it still
 * works. Always matches the room mention (`@all`/`@everyone`) too, whether
 * or not any name is given.
 */
export function mentionPattern(names: string[]): RegExp | undefined {
  const wanted = [...new Set(names)].sort((a, b) => b.length - a.length)
  const alternatives = wanted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  try {
    const named = alternatives ? `|(?<![\\p{L}\\p{N}_])@?(?:${alternatives})(?![\\p{L}\\p{N}_])` : ''
    return new RegExp(`${ROOM_MENTION_PATTERN.source}${named}`, 'giu')
  } catch {
    // A name that will not compile is a name nobody gets highlighted for,
    // which is better than a log that fails to draw.
    return undefined
  }
}

/**
 * The names one message's own mentions justify highlighting: the shown
 * name of every participant `mentionsOf` says it addresses. A message
 * that carries the wire `mentions` field highlights exactly those people
 * and nobody else, so a bare word that only happens to match somebody's
 * name stays plain unless the sender actually mentioned them. A message
 * from before the field existed still matches any current roster name
 * found in its text, as it always has - see `mentionsOf`.
 */
export function mentionedNames(
  message: Pick<ChatMessage, 'text' | 'mentions'>,
  roster: readonly Named[],
  displayName: (pubkey: string) => string | undefined,
): string[] {
  const named: string[] = []
  for (const p of mentionsOf(message, roster)) {
    if (p === EVERYONE) continue
    const name = displayName(p)
    if (name) named.push(name)
  }
  return named
}

export interface MentionSegment {
  text: string
  /** True for a run of text a `mentionPattern` matched. */
  mention: boolean
  /** True when the matched run is the room mention or one of the reader's
   *  own names. Only meaningful when `mention` is true. */
  me: boolean
}

/**
 * A message's text cut into plain and matched runs, in order, so a caller
 * can build whatever markup it likes from them without re-running the
 * matching logic. Never drops or reorders any character of `text`.
 */
export function segmentMentions(text: string, pattern: RegExp | undefined, mine: ReadonlySet<string>): MentionSegment[] {
  if (!pattern) return text ? [{ text, mention: false, me: false }] : []
  const segments: MentionSegment[] = []
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > at) segments.push({ text: text.slice(at, start), mention: false, me: false })
    const me = ROOM_MENTION_PATTERN.test(token) || mine.has(token.replace(/^@/, '').toLowerCase())
    segments.push({ text: token, mention: true, me })
    at = start + token.length
  }
  if (at < text.length) segments.push({ text: text.slice(at), mention: false, me: false })
  return segments
}
