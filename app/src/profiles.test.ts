import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { ProfileBook } from './profiles.js'
import type { NostrRelayPool } from '../../src/index.js'

const books: ProfileBook[] = []
afterEach(() => { books.forEach(book => book.close()); books.length = 0; vi.unstubAllGlobals() })

function fixture() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  let receive!: (event: Event) => void
  const onChange = vi.fn()
  const book = new ProfileBook({ relays: () => [], onChange, transport: () => ({
    subscribe: (_filters: unknown, handler: typeof receive) => { receive = handler; return () => {} },
    close() {},
  }) as unknown as NostrRelayPool })
  // These cases exercise verification itself; the default-off gate has its
  // own tests below.
  book.setNip05Automatic(true)
  books.push(book)
  book.want([pubkey])
  const publish = (content: unknown, created_at = 1) => receive(finalizeEvent({ kind: 0, tags: [], created_at, content: JSON.stringify(content) }, secret))
  return { book, pubkey, publish, onChange, receive }
}

it('loads signed kind-0 names and pictures and only displays an address mapped to that key', async () => {
  const { book, pubkey, publish } = fixture()
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  vi.stubGlobal('fetch', fetcher)
  publish({ display_name: 'Alice', picture: 'https://example.com/alice.png', nip05: 'alice@example.com' })
  expect(book.get(pubkey)).toMatchObject({ name: 'Alice', picture: 'https://example.com/alice.png' })
  await vi.waitFor(() => expect(book.get(pubkey)?.nip05).toBe('alice@example.com'))
  expect(fetcher).toHaveBeenCalledWith('https://example.com/.well-known/nostr.json?name=alice', expect.objectContaining({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }))
})

it('keeps profiles usable when an address maps to another key or its endpoint fails', async () => {
  const { book, pubkey, publish } = fixture()
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: 'f'.repeat(64) } }) })
  vi.stubGlobal('fetch', fetcher)
  publish({ name: 'Alice', picture: 'javascript:bad', nip05: 'alice@example.com' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(book.get(pubkey)).toEqual({ name: 'Alice', picture: undefined })
  fetcher.mockRejectedValue(new Error('offline'))
  publish({ name: 'Alice new', nip05: 'alice@example.com' }, 2)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  expect(book.get(pubkey)?.nip05).toBeUndefined()
})

it('does not let a late address response restore a replaced or disabled profile', async () => {
  const { book, pubkey, publish, onChange } = fixture()
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done })))
  publish({ name: 'Old', nip05: 'alice@example.com' })
  publish({ name: 'New' }, 2)
  resolve({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  await new Promise(done => setTimeout(done, 0))
  expect(book.get(pubkey)).toEqual({ name: 'New', picture: undefined })
  publish({ name: 'Latest', nip05: 'alice@example.com' }, 3)
  book.setEnabled(false)
  const changes = onChange.mock.calls.length
  resolve({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  await new Promise(done => setTimeout(done, 0))
  expect(book.get(pubkey)).toBeUndefined()
  expect(onChange).toHaveBeenCalledTimes(changes)
})

it('does not contact an address’s domain until verification is switched on', async () => {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  let receive!: (event: Event) => void
  const book = new ProfileBook({ relays: () => [], onChange: vi.fn(), transport: () => ({
    subscribe: (_filters: unknown, handler: typeof receive) => { receive = handler; return () => {} },
    close() {},
  }) as unknown as NostrRelayPool })
  books.push(book)
  book.want([pubkey])
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  vi.stubGlobal('fetch', fetcher)
  receive(finalizeEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Alice', nip05: 'alice@example.com' }) }, secret))
  await new Promise(done => setTimeout(done, 10))
  expect(fetcher).not.toHaveBeenCalled()
  expect(book.get(pubkey)?.nip05).toBeUndefined()
  // Switching it on verifies every claim already held, with no new lookup.
  book.setNip05Automatic(true)
  await vi.waitFor(() => expect(book.get(pubkey)?.nip05).toBe('alice@example.com'))
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledWith('https://example.com/.well-known/nostr.json?name=alice', expect.objectContaining({ credentials: 'omit' }))
})

it('a check in flight when verification is switched off can never publish its answer', async () => {
  const { book, pubkey, publish, onChange } = fixture()
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done })))
  publish({ name: 'Alice', nip05: 'alice@example.com' })
  book.setNip05Automatic(false)
  resolve({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  await new Promise(done => setTimeout(done, 10))
  expect(book.get(pubkey)?.nip05).toBeUndefined()
  // And switching it back on asks again, cleanly.
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: pubkey } }) })
  vi.stubGlobal('fetch', fetcher)
  book.setNip05Automatic(true)
  await vi.waitFor(() => expect(book.get(pubkey)?.nip05).toBe('alice@example.com'))
  expect(onChange).toHaveBeenCalled()
})

it('ignores forged profiles and invalid address URLs without contacting their hosts', () => {
  const { book, pubkey, publish, receive } = fixture()
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  publish({ name: 'Alice', nip05: 'alice@example.com/secret' })
  receive({ kind: 0, pubkey, tags: [], content: '{"name":"Forged"}', created_at: 100, id: '0'.repeat(64), sig: '0'.repeat(128) })
  expect(book.get(pubkey)?.name).toBe('Alice')
  expect(fetcher).not.toHaveBeenCalled()
})

it('hands the pool each relay once when the room and the public list spell it differently', () => {
  const transport = vi.fn(() => ({ subscribe: () => () => {}, close() {} }) as unknown as NostrRelayPool)
  const book = new ProfileBook({ relays: () => ['wss://nos.lol/', 'wss://relay.primal.net/', 'wss://purplepag.es', 'wss://nos.lol', 'wss://relay.primal.net'], onChange: vi.fn(), transport })
  books.push(book)
  book.want(['a'.repeat(64)])
  expect(transport).toHaveBeenCalledWith(['wss://nos.lol/', 'wss://relay.primal.net/', 'wss://purplepag.es'])
})
