import type { Event, EventTemplate } from 'nostr-tools/pure'
import { verifyEvent } from 'nostr-tools/pure'
import { isSafeRelayUrl } from './network-hints.js'
import { normaliseRelayConfig } from './relay-pool.js'

/**
 * Where a person wants their private conversations to live.
 *
 * NIP-17's DM relay list: a replaceable kind 10050 event, one `relay` tag per
 * relay, signed by the person. It is public by design - anyone can read which
 * relays somebody uses for private messages - and that is the price of a
 * standard every client can read: a sender looks it up before writing.
 *
 * KithMoot reads it to choose the relays a private conversation is started
 * on. The default relays are public ones a person does not run, and public
 * relays keep a room's events for days, not months, and turn away accounts
 * that send a lot; a conversation that is meant to replace Signal needs to
 * live somewhere its two people chose. See `docs/messages.md`, "Direct
 * messages", for the rule, and `docs/decisions.md` for why this does not
 * reverse the project relay leaving the defaults.
 */
export const KIND_DM_RELAYS = 10050

/** The most relays one list is read for, and the most a conversation gets. */
export const MAX_DM_RELAYS = 6

/** A conversation is never started on fewer than this many relays while the
 *  fallback has more to offer: one relay down must not mean no conversation. */
export const MIN_DM_RELAYS = 2

/** A relay URL in canonical form, or undefined if it is not one a link may carry. */
function canonical(url: string): string | undefined {
  if (typeof url !== 'string' || !isSafeRelayUrl(url.trim())) return undefined
  try {
    return normaliseRelayConfig([url.trim()])[0]?.url
  } catch {
    return undefined
  }
}

function canonicalList(urls: readonly string[]): string[] {
  const out: string[] = []
  for (const url of urls) {
    const normal = canonical(url)
    if (normal && !out.includes(normal)) out.push(normal)
  }
  return out
}

/**
 * The relays a kind 10050 event names, in its order, canonical and
 * deduplicated, at most `MAX_DM_RELAYS`. An event of another kind, by
 * another author when one is given, or with a bad signature names none.
 */
export function parseDmRelayList(event: Event, author?: string): string[] {
  if (event.kind !== KIND_DM_RELAYS) return []
  if (author !== undefined && event.pubkey.toLowerCase() !== author.toLowerCase()) return []
  if (!verifyEvent(event)) return []
  return relaysNamed(event)
}

function relaysNamed(event: Event): string[] {
  const urls = event.tags.filter(tag => tag[0] === 'relay' && typeof tag[1] === 'string').map(tag => tag[1]!)
  return canonicalList(urls).slice(0, MAX_DM_RELAYS)
}

/** Of several kind 10050 events for one author, the one that counts: the
 *  latest, then the lowest id, as for any replaceable event. */
export function latestDmRelayList(events: readonly Event[], author: string): string[] {
  const own = events.filter(event => event.kind === KIND_DM_RELAYS && event.pubkey.toLowerCase() === author.toLowerCase())
  own.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // The latest one with a good signature counts even when it names nothing
  // usable: a person who emptied their list meant it.
  const latest = own.find(event => verifyEvent(event))
  return latest ? relaysNamed(latest) : []
}

/** The unsigned event that publishes a DM relay list. Throws on a list with
 *  no usable relay, or more than `MAX_DM_RELAYS`. */
export function dmRelayListTemplate(relays: readonly string[], now: number): EventTemplate {
  const urls = canonicalList(relays)
  if (urls.length !== relays.length) throw new Error('every relay must be a wss:// address')
  if (urls.length === 0) throw new Error('a DM relay list needs at least one relay')
  if (urls.length > MAX_DM_RELAYS) throw new Error(`a DM relay list can name at most ${MAX_DM_RELAYS} relays`)
  return { kind: KIND_DM_RELAYS, created_at: now, tags: urls.map(url => ['relay', url]), content: '' }
}

/**
 * The relays a new private conversation is started on.
 *
 * The other person's list first, then the starter's, alternating, so each
 * of them has their first choice in even when both lists are long; then
 * deduplicated and capped at `MAX_DM_RELAYS`. When neither has a list, the
 * fallback - the relays of the room it is started from, which is what every
 * conversation used before this. When the two lists between them name fewer
 * than `MIN_DM_RELAYS`, the fallback tops them up, so one relay going down
 * never takes the conversation with it.
 */
export function relaysForPrivateConversation(opts: {
  mine: readonly string[]
  theirs: readonly string[]
  fallback: readonly string[]
}): string[] {
  const mine = canonicalList(opts.mine)
  const theirs = canonicalList(opts.theirs)
  const fallback = canonicalList(opts.fallback)
  const chosen: string[] = []
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    for (const url of [theirs[i], mine[i]]) if (url && !chosen.includes(url)) chosen.push(url)
  }
  if (chosen.length === 0) return fallback.slice(0, MAX_DM_RELAYS)
  for (const url of fallback) {
    if (chosen.length >= MIN_DM_RELAYS) break
    if (!chosen.includes(url)) chosen.push(url)
  }
  return chosen.slice(0, MAX_DM_RELAYS)
}

/** NIP-65's relay list: where a person reads and writes, kind 10002. */
export const KIND_RELAY_LIST = 10002

/**
 * Where to send something private for `author` so they find it: their NIP-17
 * DM relays when they publish a list, else the relays their NIP-65 list
 * says they read from (an `r` tag marked `read`, or unmarked). The latest
 * correctly signed list of each kind counts; at most `MAX_DM_RELAYS`. Empty
 * when they publish neither, and the sender's own relays are all there is.
 */
export function inboxRelays(events: readonly Event[], author: string): string[] {
  const dm = latestDmRelayList(events, author)
  if (dm.length) return dm
  const own = events.filter(event => event.kind === KIND_RELAY_LIST && event.pubkey.toLowerCase() === author.toLowerCase())
  own.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const latest = own.find(event => verifyEvent(event))
  if (!latest) return []
  const urls = latest.tags
    .filter(tag => tag[0] === 'r' && typeof tag[1] === 'string' && (tag[2] === undefined || tag[2] === 'read'))
    .map(tag => tag[1]!)
  return canonicalList(urls).slice(0, MAX_DM_RELAYS)
}
