import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'

const PAGE_LIMIT = 1000
const MAX_PAGES = 5

/** Read bounded chat history with inclusive NIP-01 time cursors. EOSE ends
 * one page, not necessarily the history. False means the caller must retain
 * recovery state and must not claim that an unseen message does not exist. */
export async function scanChatHistory(
  filter: Filter,
  read: (filter: Filter) => Promise<{ events: readonly Event[]; complete: boolean }>,
  visit: (events: readonly Event[]) => void | Promise<void>,
): Promise<boolean> {
  let until = filter.until
  for (let page = 0; page < MAX_PAGES; page++) {
    let result: { events: readonly Event[]; complete: boolean }
    try { result = await read({ ...filter, limit: PAGE_LIMIT, ...(until === undefined ? {} : { until }) }) }
    catch { return false }
    // A bad cursor must not become an exhausted-history claim, even when
    // the relay returns fewer than the requested number of events.
    if (result.events.some(e => !Number.isSafeInteger(e.created_at) || e.created_at < 0 || (until !== undefined && e.created_at > until))) return false
    await visit(result.events)
    if (!result.complete) return false
    if (result.events.length < PAGE_LIMIT) return true
    const oldest = Math.min(...result.events.map(e => e.created_at))
    // Do not subtract a second: a saturated same-second page may hide more
    // events at that timestamp. There is no portable event-id cursor.
    if (until !== undefined && oldest >= until) return false
    until = oldest
  }
  return false
}
