import { sanitiseDisplayName } from '../../src/display-name.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { NostrRelayPool } from '../../src/relay-pool.js'
import type { Filter } from 'nostr-tools/filter'
import type { Event } from 'nostr-tools/pure'
import { nostrMessageRecipient } from './nostr-message.js'
import { newerProfile } from './people-profile-cache.js'

export const PEOPLE_SEARCH_RELAY = 'wss://relay.ditto.pub/'
export const PEOPLE_PROFILE_RELAY = 'wss://purplepag.es/'
const SEARCH_LIMIT = 16
const SEARCH_TIMEOUT_MS = 5_000
const PROFILE_LIMIT = 4
const PROFILE_TIMEOUT_MS = 3_000

const publicAddress = /^(?:-\s*)?(?:nostr:)?n(?:pub|profile)1/i

export function peopleSearchQuery(value: string): string | undefined {
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length < 2 || query.length > 120 || /(?:nsec1|ncryptsec1|bunker:|nostrconnect:|:\/\/)/iu.test(query)) return undefined
  // A mistyped public key is never sent to the text search index.
  if (publicAddress.test(query) && !peopleSearchKey(query)) return undefined
  return query
}

export function peopleSearchKey(query: string): string | undefined {
  const address = query.replace(/^-\s*/, '').replace(/^nostr:/i, '')
  if (/^[0-9a-f]{64}$/i.test(address)) return address.toLowerCase()
  if (!publicAddress.test(query)) return undefined
  try { return nostrMessageRecipient(address) } catch { return undefined }
}

export interface PeopleSearchResult {
  pubkey: string
  name?: string
  event?: Event
}

/** A pasted key uses a kind-0 author filter. Only a name search uses NIP-50. */
export async function searchNostrPeople(query: string, relays: readonly string[],
  borrow: () => Pick<NostrRelayPool, 'query' | 'close'>, signal: AbortSignal): Promise<PeopleSearchResult[]> {
  signal.throwIfAborted()
  const peer = peopleSearchKey(query)
  const filter: Filter = peer
    ? { kinds: [0], authors: [peer], limit: PROFILE_LIMIT }
    : { kinds: [0], search: query, limit: SEARCH_LIMIT }
  if (!relays.length) {
    if (peer) return [{ pubkey: peer }]
    throw Error('No public search relay is available.')
  }
  const hold = borrow()
  const cancel = () => hold.close()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (const relay of relays) {
      const result = await hold.query(relay, [filter], peer ? PROFILE_TIMEOUT_MS : SEARCH_TIMEOUT_MS, filter.limit)
        .catch(() => ({ complete: false, events: [] }))
      signal.throwIfAborted()
      const profiles = matchingProfiles(result.events, query, peer)
      if (profiles.length || !peer && result.complete) return profiles
    }
    if (peer) return [{ pubkey: peer }]
    throw Error('The search relay did not answer. Try again.')
  } finally {
    signal.removeEventListener('abort', cancel)
    hold.close()
  }
}

function matchingProfiles(events: Event[], query: string, peer: string | undefined): PeopleSearchResult[] {
  const now = Math.floor(Date.now() / 1000)
  const newest = new Map<string, Event>()
  for (const event of events) {
    try {
      if (event.kind !== 0 || peer && event.pubkey !== peer || event.content.length > 16_384 ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > now + 60 || !verifyEventUncached(event)) continue
      const previous = newest.get(event.pubkey)
      if (!previous || newerProfile(event, previous)) newest.set(event.pubkey, event)
    } catch { /* Untrusted relay event. */ }
  }
  const match = query.toLowerCase()
  const matches: (PeopleSearchResult & { exact: boolean })[] = []
  for (const event of newest.values()) {
    try {
      const content = JSON.parse(event.content)
      if (!content || typeof content !== 'object' || Array.isArray(content)) continue
      const display = sanitiseDisplayName(content.display_name)
      const handle = sanitiseDisplayName(content.name)
      const names = [display, handle].flatMap(name => name ? [name.toLowerCase()] : [])
      if (peer || names.some(name => name.includes(match))) {
        matches.push({ pubkey: event.pubkey, name: display ?? handle, event, exact: names.includes(match) })
      }
    } catch { /* Malformed profile metadata. */ }
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact)).map(({ pubkey, name, event }) => ({ pubkey, name, event }))
}
