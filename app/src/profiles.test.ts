import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { ProfileBook } from './profiles.js'
import { profilePreference } from './relay-settings.js'
import type { NostrRelayPool } from '../../src/index.js'

const books: ProfileBook[] = []
afterEach(() => { books.forEach(book => book.close()); books.length = 0; vi.unstubAllGlobals(); vi.useRealTimers() })

it('recovers a missed profile after the first lookup expires and never retries a profile already found', async () => {
  vi.useFakeTimers()
  const { book, pools } = scoped()
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  book.want([pubkey], 'public')
  await vi.advanceTimersByTimeAsync(16_000)
  expect(pools[0]!.asked).toEqual([[pubkey], [pubkey]])
  pools[0]!.receive(finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '{"name":"Recovered"}' }, secret))
  expect(book.get(pubkey)?.name).toBe('Recovered')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(pools[0]!.asked).toHaveLength(2)
})

it('retries a failed transport but caps attempts, and cancelling lookups cancels pending retries', async () => {
  vi.useFakeTimers()
  const transport = vi.fn(() => { throw new Error('offline') })
  const book = new ProfileBook({ relays: () => [], publicRelays: () => [], onChange: vi.fn(), transport })
  books.push(book)
  book.want(['a'.repeat(64)], 'public')
  await vi.advanceTimersByTimeAsync(6_000)
  expect(transport).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(transport).toHaveBeenCalledTimes(3)
  book.setEnabled(false); book.setEnabled(true)
  book.want(['a'.repeat(64)], 'public')
  book.setEnabled(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(transport).toHaveBeenCalledTimes(4)
})

it('keeps participant keys off profile Nostr relays until the app has an explicit opt-in', () => {
  const subscribe = vi.fn(() => () => {})
  const transport = vi.fn(() => ({ subscribe, close() {} }) as unknown as NostrRelayPool)
  const book = new ProfileBook({ relays: () => ['wss://room.example/'],
    publicRelays: () => ['wss://profiles.example/'], transport, onChange: vi.fn() })
  books.push(book)
  book.setEnabled(profilePreference({ getItem: () => null }))
  const participant = getPublicKey(generateSecretKey())
  book.want([participant], 'room')
  book.want([participant], 'public')
  expect(transport).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
  book.setEnabled(profilePreference({ getItem: () => 'true' }))
  book.want([participant], 'public')
  expect(transport).toHaveBeenCalledWith(['wss://profiles.example/'], 'public')
  expect(subscribe).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ kinds: [0], authors: [participant] }),
  ]), expect.any(Function))
})

function fixture() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  let receive!: (event: Event) => void
  const onChange = vi.fn()
  const book = new ProfileBook({ relays: () => [], publicRelays: () => [], onChange, transport: () => ({
    subscribe: (_filters: unknown, handler: typeof receive) => { receive = handler; return () => {} },
    close() {},
  }) as unknown as NostrRelayPool })
  // These cases exercise verification itself; the default-off gate has its
  // own tests below.
  book.setNip05Automatic(true)
  books.push(book)
  book.want([pubkey], 'room')
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
  const book = new ProfileBook({ relays: () => [], publicRelays: () => [], onChange: vi.fn(), transport: () => ({
    subscribe: (_filters: unknown, handler: typeof receive) => { receive = handler; return () => {} },
    close() {},
  }) as unknown as NostrRelayPool })
  books.push(book)
  book.want([pubkey], 'room')
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
  const book = new ProfileBook({ relays: () => ['wss://nos.lol/', 'wss://relay.primal.net/', 'wss://purplepag.es', 'wss://nos.lol', 'wss://relay.primal.net'], publicRelays: () => [], onChange: vi.fn(), transport })
  books.push(book)
  book.want(['a'.repeat(64)], 'room')
  expect(transport).toHaveBeenCalledWith(['wss://nos.lol/', 'wss://relay.primal.net/', 'wss://purplepag.es'], 'room')
})

/** A book over a room's relays and the public ones, with a fake transport
 *  that remembers, per scope, where it was pointed and what was asked. */
function scoped() {
  const room = ['wss://room.example/', 'wss://purplepag.es', 'wss://relay.damus.io']
  const publicOnly = ['wss://purplepag.es', 'wss://relay.damus.io']
  const pools: { scope: string; urls: string[]; closed: boolean; asked: string[][]; receive: (event: Event) => void }[] = []
  const book = new ProfileBook({
    relays: () => room, publicRelays: () => publicOnly, onChange: vi.fn(),
    transport: (urls, scope) => {
      const pool = { scope, urls, closed: false, asked: [] as string[][], receive: (_event: Event) => {} }
      pools.push(pool)
      return {
        subscribe: (filters: { authors: string[] }[], handler: (event: Event) => void) => { pool.asked.push(filters[0]!.authors); pool.receive = handler; return () => {} },
        close() { pool.closed = true },
      } as unknown as NostrRelayPool
    },
  })
  books.push(book)
  return { book, pools, room, publicOnly }
}
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)

it('asks the open room’s relays about people in the room, and the public relays alone about anybody else', () => {
  const { book, pools, room, publicOnly } = scoped()
  book.want([A], 'room')
  book.want([B], 'public')
  expect(pools.map(pool => [pool.scope, pool.urls])).toEqual([['room', room], ['public', publicOnly]])
  expect(pools[0]!.asked).toEqual([[A]])
  expect(pools[1]!.asked).toEqual([[B]])
  // The public pool never saw the room's relay, and the person asked about
  // there never reached the room's pool.
  expect(pools[1]!.urls).not.toContain('wss://room.example/')
  expect(pools[0]!.asked.flat()).not.toContain(B)
})

it('asks a key again in the room when it was only asked about publicly before, and never twice for the same scope', () => {
  const { book, pools } = scoped()
  book.want([A], 'public')
  book.want([A], 'public')
  expect(pools).toHaveLength(1)
  expect(pools[0]!.asked).toEqual([[A]])
  book.want([A, B], 'room')
  expect(pools.map(pool => pool.scope)).toEqual(['public', 'room'])
  expect(pools[1]!.asked).toEqual([[A, B]])
  // The room pool already covers the public relays, so a public question
  // about a key it has asked is not asked again.
  book.want([A, B, C], 'public')
  expect(pools[0]!.asked).toEqual([[A], [C]])
  book.want([A], 'room')
  expect(pools[1]!.asked).toEqual([[A, B]])
})

it('takes a profile from either scope and shows it to every caller', () => {
  const { book, pools } = scoped()
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  book.want([pubkey], 'public')
  pools[0]!.receive(finalizeEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Ada' }) }, secret))
  expect(book.get(pubkey)?.name).toBe('Ada')
  // A key nobody asked about is not accepted from either pool.
  const stranger = generateSecretKey()
  pools[0]!.receive(finalizeEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Stranger' }) }, stranger))
  expect(book.get(getPublicKey(stranger))).toBeUndefined()
})

it('switching lookups off closes both pools and forgets, and on again builds both afresh', () => {
  const { book, pools } = scoped()
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  book.want([pubkey], 'room')
  book.want([B], 'public')
  pools[0]!.receive(finalizeEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Ada' }) }, secret))
  book.setEnabled(false)
  expect(pools.map(pool => pool.closed)).toEqual([true, true])
  expect(book.get(pubkey)).toBeUndefined()
  // Off means nothing is asked of anyone.
  book.want([pubkey], 'room')
  book.want([B], 'public')
  expect(pools).toHaveLength(2)
  book.setEnabled(true)
  book.want([pubkey], 'room')
  book.want([B], 'public')
  expect(pools.map(pool => pool.scope)).toEqual(['room', 'public', 'room', 'public'])
  expect(pools.slice(2).map(pool => pool.closed)).toEqual([false, false])
  expect(pools[2]!.asked).toEqual([[pubkey]])
  expect(pools[3]!.asked).toEqual([[B]])
})

it('restarting the room closes the sockets opened for the room just left, asks its people afresh, and keeps what it learned', () => {
  const { book, pools } = scoped()
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  book.want([pubkey], 'room')
  book.want([B], 'public')
  pools[0]!.receive(finalizeEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Ada' }) }, secret))
  book.restartRoom()
  expect(pools.map(pool => pool.closed)).toEqual([true, false])
  expect(book.get(pubkey)?.name).toBe('Ada')
  // The next room's people are asked on a new pool, not the old room's.
  book.want([pubkey], 'room')
  expect(pools.map(pool => pool.scope)).toEqual(['room', 'public', 'room'])
  expect(pools[2]!.asked).toEqual([[pubkey]])
})

it('leaves the public pool, and who it has asked about, alone across room switches', () => {
  const { book, pools } = scoped()
  // Signed in at home: the account is asked about publicly.
  book.want([A], 'public')
  // A switch restarts the room twice, leaving one and opening the next, and
  // the screen asks about the account again in between and after.
  book.restartRoom()
  book.want([A], 'public')
  book.restartRoom()
  book.want([A, B], 'public')
  // One public pool, never closed, and the account asked about once.
  expect(pools.map(pool => [pool.scope, pool.closed])).toEqual([['public', false]])
  expect(pools[0]!.asked).toEqual([[A], [B]])
})

it('asks the next room about somebody asked about in the room before, even after asking publicly', () => {
  const { book, pools } = scoped()
  book.want([A], 'room')
  book.restartRoom()
  // Out of a room, A is somebody else: the public relays may be asked.
  book.want([A], 'public')
  book.want([A], 'room')
  expect(pools.map(pool => [pool.scope, pool.closed])).toEqual([['room', true], ['public', false], ['room', false]])
  expect(pools[1]!.asked).toEqual([[A]])
  expect(pools[2]!.asked).toEqual([[A]])
})

it('a room restart with lookups switched off asks nobody', () => {
  const { book, pools } = scoped()
  book.setEnabled(false)
  book.restartRoom()
  book.want([A], 'room')
  book.want([B], 'public')
  expect(pools).toHaveLength(0)
})
