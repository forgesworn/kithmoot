import { sanitiseDisplayName } from '../../src/display-name.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { RelayPoolClient } from '../../src/relay-pool.js'
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
export async function searchNostrPeople(query: string, borrow: () => RelayPoolClient, signal: AbortSignal): Promise<PeopleSearchResult[]> {
  signal.throwIfAborted()
  const peer = peopleSearchKey(query)
  if (peer) return [{ pubkey: peer }]
  const match = query.toLowerCase()
  const hold = borrow()
  const newest = new Map<string, Event>()
  let stop: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let count = 0
      const finish = (error?: unknown): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve()
      }
      const cancel = () => finish(signal.reason)
      const timer = setTimeout(() => finish(newest.size ? undefined : Error('The search relay did not answer. Try again.')), SEARCH_TIMEOUT_MS)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const now = Math.floor(Date.now() / 1000)
        stop = hold.subscribe([{ kinds: [0], search: query, limit: SEARCH_LIMIT }], event => {
          if (count >= SEARCH_LIMIT) return
          count++
          try {
            if (event.kind !== 0 || event.content.length > 16_384 || event.created_at > now + 60 || !verifyEventUncached(event)) return
            const previous = newest.get(event.pubkey)
            if (!previous || newerProfile(event, previous)) newest.set(event.pubkey, event)
          } catch { /* Untrusted relay event. */ }
          finally {
            if (count === SEARCH_LIMIT) finish()
          }
        }, () => finish())
      } catch (error) { finish(error) }
    })
    signal.throwIfAborted()
  } finally {
    stop?.()
    hold.close()
  }
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
