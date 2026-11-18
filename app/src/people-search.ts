import { sanitiseDisplayName } from '../../src/display-name.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { NostrRelayPool } from '../../src/relay-pool.js'
import type { Event } from 'nostr-tools/pure'
import { nostrMessageRecipient } from './nostr-message.js'
import { newerProfile } from './people-profile-cache.js'

export const PEOPLE_SEARCH_RELAY = 'wss://relay.ditto.pub/'
const SEARCH_LIMIT = 16
const SEARCH_TIMEOUT_MS = 5_000

export function peopleSearchQuery(value: string): string | undefined {
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length < 2 || query.length > 120 || /(?:nsec1|ncryptsec1|bunker:|nostrconnect:|:\/\/)/iu.test(query)) return undefined
  return query
}

export function peopleSearchKey(query: string): string | undefined {
  if (/^[0-9a-f]{64}$/i.test(query)) return query.toLowerCase()
  if (!/^(?:nostr:)?n(?:pub|profile)1/i.test(query)) return undefined
  try { return nostrMessageRecipient(query.toLowerCase()) } catch { return undefined }
}

export interface PeopleSearchResult {
  pubkey: string
  name?: string
}

/** One explicit, read-only NIP-50 request. Search results are temporary
 * and only name a public key. In particular they never load profile media. */
export async function searchNostrPeople(query: string, borrow: () => Pick<NostrRelayPool, 'query' | 'close'>, signal: AbortSignal): Promise<PeopleSearchResult[]> {
  signal.throwIfAborted()
  const peer = peopleSearchKey(query)
  if (peer) return [{ pubkey: peer }]
  const hold = borrow()
  const cancel = () => hold.close()
  signal.addEventListener('abort', cancel, { once: true })
  let events: Event[]
  try {
    const result = await hold.query(PEOPLE_SEARCH_RELAY, [{ kinds: [0], search: query, limit: SEARCH_LIMIT }], SEARCH_TIMEOUT_MS, SEARCH_LIMIT)
    signal.throwIfAborted()
    if (!result.complete && !result.events.length) throw Error('The search relay did not answer. Try again.')
    events = result.events
  } finally {
    signal.removeEventListener('abort', cancel)
    hold.close()
  }

  const now = Math.floor(Date.now() / 1000)
  const newest = new Map<string, Event>()
  for (const event of events) {
    try {
      if (event.kind !== 0 || event.content.length > 16_384 || event.created_at < 0 || event.created_at > now + 60 || !verifyEventUncached(event)) continue
      const previous = newest.get(event.pubkey)
      if (!previous || newerProfile(event, previous)) newest.set(event.pubkey, event)
    } catch { /* Untrusted relay event. */ }
  }
  const match = query.toLowerCase()
  const matches: (PeopleSearchResult & { exact: boolean })[] = []
  for (const event of newest.values()) {
    try {
      const content = JSON.parse(event.content)
      const display = sanitiseDisplayName(content.display_name)
      const handle = sanitiseDisplayName(content.name)
      const names = [display, handle].flatMap(name => name ? [name.toLowerCase()] : [])
      if (names.some(name => name.includes(match))) {
        matches.push({ pubkey: event.pubkey, name: display ?? handle, exact: names.includes(match) })
      }
    } catch { /* Malformed profile metadata. */ }
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact)).map(({ pubkey, name }) => ({ pubkey, name }))
}
