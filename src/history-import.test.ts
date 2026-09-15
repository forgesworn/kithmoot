import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { HISTORY_IMPORT_MAX_EVENTS, historyImportRequest, importBoundedHistory, oldestHistoryCursor } from './history-import.js'

const personKey = generateSecretKey()
const person = getPublicKey(personKey)
const other = getPublicKey(generateSecretKey())
const signed = (key = personKey, tags: string[][] = [], created_at = 1_700_000_000): Event => finalizeEvent({ kind: 4, created_at, tags, content: 'ciphertext' }, key)

describe('bounded history import', () => {
  it('retains only verified matching events and reports each relay/request separately', async () => {
    const authored = historyImportRequest({ class: 'authored', person, kinds: [4], since: 1_600_000_000, until: 1_800_000_000, limit: 20, cursor: { createdAt: 1_700_000_100, id: 'a'.repeat(64) } })
    const addressed = historyImportRequest({ class: 'addressed', person, kinds: [4], since: 1_600_000_000, until: 1_800_000_000, limit: 20 })
    const mine = signed(), toMe = signed(generateSecretKey(), [['p', person]])
    const forged = { ...mine, content: 'edited' }
    const wrongAuthor = signed(generateSecretKey())
    const wrongRecipient = signed(generateSecretKey(), [['p', other]])
    const result = await importBoundedHistory({
      relays: ['wss://one.test', 'wss://two.test'], requests: [authored, addressed],
      read: async (relay, filter) => ({ terminal: relay.includes('one.test') ? 'complete' : 'closed', events: filter.authors ? [mine, forged, wrongAuthor] : [toMe, wrongRecipient, mine] }),
      now: () => 100,
    })
    expect(result.events.map(event => event.id).sort()).toEqual([mine.id, toMe.id].sort())
    expect(result.receipts).toHaveLength(4)
    expect(result.receipts.find(receipt => receipt.relay === 'wss://one.test/' && receipt.request.class === 'authored')).toMatchObject({ terminal: 'complete', accepted: 1, invalid: 1, rejected: 1, cursor: authored.cursor })
    expect(result.receipts.find(receipt => receipt.relay === 'wss://one.test/' && receipt.request.class === 'addressed')).toMatchObject({ terminal: 'complete', accepted: 1, duplicate: 0, rejected: 2 })
    expect(result.receipts.find(receipt => receipt.relay === 'wss://two.test/' && receipt.request.class === 'authored')).toMatchObject({ terminal: 'closed', accepted: 0, duplicate: 1, invalid: 1, rejected: 1 })
    expect(result.receipts.filter(receipt => receipt.relay === 'wss://two.test/').map(receipt => receipt.terminal)).toEqual(['closed', 'closed'])
  })

  it('keeps timeout, unavailable and limited outcomes visible for resumption', async () => {
    const request = historyImportRequest({ class: 'authored', person, kinds: [4], since: 1, until: 2, limit: 1 })
    const result = await importBoundedHistory({
      relays: ['wss://timeout.test', 'wss://offline.test', 'wss://full.test'], requests: [request],
      read: async relay => {
        if (relay.includes('timeout')) return { terminal: 'timeout', events: [] }
        if (relay.includes('offline')) throw new Error('dial failed')
        return { terminal: 'complete', events: [signed(personKey, [], 2)] }
      },
      now: () => 50,
    })
    expect(result.receipts.map(receipt => receipt.terminal)).toEqual(['timeout', 'unavailable', 'limited'])
    expect(result.receipts[1]!.detail).toBe('dial failed')
  })

  it('refuses broad or relay-search filters and finds the stable oldest cursor', () => {
    expect(() => historyImportRequest({ class: 'authored', person, kinds: [], since: 1, until: 2, limit: 1 })).toThrow(/explicit supported/)
    expect(() => historyImportRequest({ class: 'addressed', person, kinds: [4], since: 2, until: 1, limit: 1 })).toThrow(/bounded time/)
    expect(() => historyImportRequest({ class: 'authored', person, kinds: [4], since: 1, until: 2, limit: HISTORY_IMPORT_MAX_EVENTS + 1 })).toThrow(/limit/)
    const later = signed(personKey, [], 9)
    const first = signed(personKey, [], 3)
    expect(oldestHistoryCursor([later, first])).toEqual({ createdAt: 3, id: first.id })
  })
})
