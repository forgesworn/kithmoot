import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { scanChatHistory } from './chat-history-scan.js'

// This scanner consumes already-validated history. These headers exercise
// pagination; the calling cleanup regressions use signed encrypted messages.
const pageAt = (at: number) => Array.from({ length: 1000 }, (_, i) => ({ id: String(i), created_at: at - i } as Event))

describe('bounded chat history scan', () => {
  it('visits only the bounded prefix of an oversized result and reports it incomplete', async () => {
    let reads = 0
    const seen: Event[] = [], oversized = [...pageAt(3000), { created_at: 1000 } as Event]
    expect(await scanChatHistory({}, async () => { reads++; return { events: oversized, complete: true } }, events => { seen.push(...events) })).toBe(false)
    expect(reads).toBe(1)
    expect(seen).toEqual(oversized.slice(0, 1000))
  })

  it('keeps inclusive boundary events and reaches the short last page', async () => {
    const cursors: Array<number | undefined> = [], seen: number[] = []
    const complete = await scanChatHistory({ kinds: [1460] }, async filter => {
      cursors.push(filter.until)
      return { events: filter.until === undefined ? pageAt(2000) : [{ created_at: 1001 }, { created_at: 1000 }] as Event[], complete: true }
    }, events => { seen.push(...events.map(e => e.created_at)) })
    expect(complete).toBe(true)
    expect(cursors).toEqual([undefined, 1001])
    expect(seen.at(-1)).toBe(1000)
  })

  it('reports the page budget as incomplete even when every page reached EOSE', async () => {
    let pages = 0
    const complete = await scanChatHistory({}, async filter => {
      pages++
      return { events: pageAt(filter.until ?? 10000), complete: true }
    }, () => {})
    expect(pages).toBe(5)
    expect(complete).toBe(false)
  })

  it.each([NaN, Infinity, -1, 1.5])('refuses invalid timestamp %s even on a short page', async created_at => {
    let visited = false
    expect(await scanChatHistory({}, async () => ({ events: [{ created_at }] as Event[], complete: true }), () => { visited = true })).toBe(false)
    expect(visited).toBe(false)
  })

  it('refuses a full page whose cursor does not advance', async () => {
    let pages = 0
    expect(await scanChatHistory({}, async () => { pages++; return { events: Array(1000).fill({ created_at: 1000 }), complete: true } }, () => {})).toBe(false)
    expect(pages).toBe(2)
  })

  it('refuses results outside the requested time window', async () => {
    expect(await scanChatHistory({ until: 100 }, async () => ({ events: [{ created_at: 101 }] as Event[], complete: true }), () => {})).toBe(false)
  })

  it('visits known partial results while retaining an incomplete outcome', async () => {
    const seen: Event[] = [], event = { created_at: 100 } as Event
    expect(await scanChatHistory({}, async () => ({ events: [event], complete: false }), events => { seen.push(...events) })).toBe(false)
    expect(seen).toEqual([event])
  })

  it('reports a failed read as incomplete', async () => {
    expect(await scanChatHistory({}, async () => { throw new Error('disconnected') }, () => {})).toBe(false)
  })
})
