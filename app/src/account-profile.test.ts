import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import type { RelayPoolClient } from '../../src/relay-pool.js'
import { AccountProfileBook } from './account-profile.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('keeps own Nostr address verification off until chosen, and cancels it in private mode', async () => {
  const secret = generateSecretKey(), account = getPublicKey(secret)
  let receive!: (event: Event) => void
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: account } }) })
  vi.stubGlobal('fetch', fetcher)
  const book = new AccountProfileBook({ relays: () => [], publicRelays: () => [], onChange: vi.fn(), transport: () => ({
    subscribe(_filters: unknown, handler: typeof receive) { receive = handler; return () => {} }, close() {},
  }) as unknown as RelayPoolClient })
  try {
    book.select(account, true)
    receive(finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '{"name":"Alice","nip05":"alice@example.com"}' }, secret))
    expect(fetcher).not.toHaveBeenCalled()
    book.setNip05Automatic(true)
    await vi.waitFor(() => expect(book.get(account)?.nip05).toBe('alice@example.com'))
    book.select(account, false)
    expect(book.get(account)).toBeUndefined()
  } finally { book.select(undefined, false) }
})

it('loads the selected account without directory lookups, and drops old accounts and private-mode work', async () => {
  vi.useFakeTimers()
  const secret = generateSecretKey(), account = getPublicKey(secret), next = getPublicKey(generateSecretKey())
  const requests: { authors: string[]; receive(event: Event): void; stop: ReturnType<typeof vi.fn> }[] = []
  const close = vi.fn(), changed = vi.fn()
  const transport = vi.fn(() => ({
    subscribe(filters: { authors: string[] }[], receive: (event: Event) => void) {
      const stop = vi.fn(); requests.push({ authors: filters[0]!.authors, receive, stop }); return stop
    }, close,
  }) as unknown as RelayPoolClient)
  const book = new AccountProfileBook({ relays: () => [], publicRelays: () => ['wss://profile.example/'], transport, onChange: changed })
  book.select(account, false)
  expect(transport).not.toHaveBeenCalled()
  book.select(account, true)
  book.select(account, true)
  expect(requests.map(request => request.authors)).toEqual([[account]])
  const profile = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: 'TheCryptoDonkey' }) }, secret)
  requests[0]!.receive(profile)
  expect(book.get(account)?.name).toBe('TheCryptoDonkey')
  expect(book.get(next)).toBeUndefined()
  book.select(next, true)
  expect(book.get(account)).toBeUndefined()
  const before = changed.mock.calls.length
  requests[0]!.receive(profile)
  expect(changed).toHaveBeenCalledTimes(before)
  book.select(next, false)
  await vi.advanceTimersByTimeAsync(90_000)
  expect(requests.map(request => request.authors)).toEqual([[account], [next]])
  expect(requests.every(request => request.stop.mock.calls.length === 1)).toBe(true)
  expect(close).toHaveBeenCalledTimes(2)
})
