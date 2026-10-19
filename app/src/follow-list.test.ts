import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { FollowBook, followedKeys } from './follow-list.js'
import type { RelayPoolClient } from '../../src/relay-pool.js'

const books: FollowBook[] = []
afterEach(() => { books.forEach(book => book.close()); books.length = 0; vi.useRealTimers() })

const key = () => getPublicKey(generateSecretKey())

function fixture() {
  const secret = generateSecretKey()
  const account = getPublicKey(secret)
  let receive: ((event: Event) => void) | undefined
  const filters: unknown[] = []
  const unsub = vi.fn()
  const onChange = vi.fn()
  const book = new FollowBook({ relays: () => ['wss://purplepag.es'], onChange, transport: () => ({
    subscribe: (f: unknown, handler: (event: Event) => void) => { filters.push(f); receive = handler; return unsub },
    close() {},
  }) as unknown as RelayPoolClient })
  books.push(book)
  const list = (follows: string[], created_at = 1, signer = secret) =>
    finalizeEvent({ kind: 3, created_at, tags: follows.map(p => ['p', p]), content: '' }, signer)
  return { book, account, list, receive: (event: Event) => receive?.(event), filters, unsub, onChange }
}

it('reads followed keys from p tags, once each, never the author and never a malformed key', () => {
  const a = key(), b = key(), author = key()
  expect(followedKeys({ pubkey: author, tags: [['p', a], ['p', b], ['p', a], ['p', author], ['p', 'not-a-key'], ['e', key()], ['p', b.toUpperCase()]] })).toEqual([a, b])
})

it('asks only for the account\'s own list and shows the newest signed one', () => {
  const { book, account, list, receive, filters } = fixture()
  const a = key(), b = key()
  book.setAccount(account)
  book.refresh()
  expect(filters).toEqual([[{ kinds: [3], authors: [account], limit: 1 }]])
  expect(book.snapshot().status).toBe('loading')
  receive(list([a, b], 10))
  receive(list([a], 5))
  expect(book.snapshot()).toEqual({ status: 'ready', pubkeys: [a, b], createdAt: 10 })
  expect(book.follows(b)).toBe(true)
})

it('ignores a list signed by anyone else or with a broken signature', () => {
  const { book, account, list, receive } = fixture()
  book.setAccount(account)
  book.refresh()
  receive(list([key()], 1, generateSecretKey()))
  const forged = list([key()], 2)
  receive({ ...forged, tags: [['p', key()]] })
  expect(book.snapshot().pubkeys).toEqual([])
})

it('stops and forgets the list when lookups are switched off or the account changes', () => {
  const { book, account, list, receive, unsub } = fixture()
  const a = key()
  book.setAccount(account)
  book.refresh()
  receive(list([a]))
  book.setEnabled(false)
  expect(unsub).toHaveBeenCalled()
  expect(book.snapshot()).toEqual({ status: 'off', pubkeys: [] })
  expect(book.follows(a)).toBe(false)
  book.setEnabled(true)
  book.refresh()
  receive(list([a]))
  book.setAccount(key())
  expect(book.snapshot()).toEqual({ status: 'ready', pubkeys: [] })
  // A late event for the previous account is dropped.
  receive(list([a], 9))
  expect(book.snapshot().pubkeys).toEqual([])
})

it('gives up waiting after a while and closes the request', () => {
  vi.useFakeTimers()
  const { book, account, unsub } = fixture()
  book.setAccount(account)
  book.refresh()
  vi.advanceTimersByTime(5_000)
  expect(unsub).toHaveBeenCalled()
  expect(book.snapshot()).toEqual({ status: 'ready', pubkeys: [] })
})
