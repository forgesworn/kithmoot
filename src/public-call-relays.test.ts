import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import {
  PUBLIC_RELAY_MAX_LIFETIME, PUBLIC_RELAY_MAX_NOTE, PUBLIC_RELAY_MAX_URLS, PublicRelayAdvertBook, PublicRelayLoginFailed,
  PublicRelayRefused, fetchPublicRelayLogin, publicRelayHostAllowed, validatePublicRelayOffer, verifyPublicRelayAdvert,
  type PublicRelayAdvert, type PublicRelayOffer,
} from './public-call-relays.js'

interface FixtureCase { name: string; events: unknown[]; expect: string[] }
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/public-advert-v1.json', import.meta.url), 'utf8')) as
  { cases: FixtureCase[]; now: number; profile: string; schema: number }

function verdict(run: () => PublicRelayAdvert): string {
  try { return run().status } catch (error) {
    if (error instanceof PublicRelayRefused) return error.reason
    throw error
  }
}

describe('spry-turn public-advert-v1 fixture', () => {
  it('is the profile this port implements', () => {
    expect(fixture.profile).toBe('spry-public-advert-v1')
    expect(fixture.schema).toBe(1)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(12)
  })
  for (const entry of fixture.cases) {
    it(entry.name, () => {
      const book = new PublicRelayAdvertBook()
      expect(entry.events.map(event => verdict(() => book.accept(event, fixture.now)))).toEqual(entry.expect)
    })
  }
})

const offer = (): PublicRelayOffer => ({
  credentials: 'https://relay.example/v1/public/credentials',
  urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:5349?transport=tcp'],
  note: 'Synthetic operator note',
})
const refused = (value: PublicRelayOffer): boolean => {
  try { validatePublicRelayOffer(value); return false } catch (error) { return error instanceof PublicRelayRefused }
}

// The table from spry-link advert.rs `endpoint_and_turn_rules_refuse_unsafe_destinations`.
describe('destination rules, as spry-link', () => {
  it('accepts the reference offer', () => expect(refused(offer())).toBe(false))
  for (const endpoint of [
    'http://relay.example/v1/public/credentials',
    'https://relay.example:443/v1/public/credentials',
    'https://relay.example:8443/v1/public/credentials',
    'https://user@relay.example/v1/public/credentials',
    'https://relay.example/v1/public/credentials?x=1',
    'https://relay.example/v1/public/credentials#x',
    'https://relay.example/other',
    'https://192.0.2.1/v1/public/credentials',
    'https://[2001:db8::1]/v1/public/credentials',
    'https://localhost/v1/public/credentials',
    'https://relay.local/v1/public/credentials',
    'https://relay.example./v1/public/credentials',
    'https://RELAY.example/v1/public/credentials',
  ]) it(`refuses endpoint ${endpoint}`, () => expect(refused({ ...offer(), credentials: endpoint })).toBe(true))
  for (const uri of [
    'turn:other.example:3478?transport=udp',
    'turns:relay.example:5349?transport=udp',
    'turn:relay.example:0',
    'turn:relay.example:22?transport=tcp',
    'turn:relay.example:8080?transport=udp',
    'turn:relay.example:03478?transport=udp',
    'turn:relay.example:+3478?transport=udp',
    'turn:relay.example:?transport=udp',
    'turn:relay.example:3478?transport=udp&x=1',
    'stun:relay.example:3478',
    'turn:user@relay.example:3478',
  ]) it(`refuses TURN ${uri}`, () => expect(refused({ ...offer(), urls: [uri] })).toBe(true))
  for (const uri of [
    'turn:relay.example?transport=udp',
    'turns:relay.example:443?transport=tcp',
    'turn:relay.example:5349',
  ]) it(`accepts TURN ${uri}`, () => expect(refused({ ...offer(), urls: [uri] })).toBe(false))
  it('folds ASCII case only when matching the TURN host', () => {
    expect(refused({ ...offer(), urls: ['turn:RELAY.example:3478'] })).toBe(false)
    expect(refused({ ...offer(), urls: ['turn:relay.exampl\u0130:3478'] })).toBe(true)
  })
  it('bounds the note and the URL list', () => {
    expect(refused({ ...offer(), note: 'x'.repeat(PUBLIC_RELAY_MAX_NOTE + 1) })).toBe(true)
    expect(refused({ ...offer(), note: 'é'.repeat(71) })).toBe(true)
    expect(refused({ ...offer(), note: 'line\nbreak' })).toBe(true)
    expect(refused({ ...offer(), urls: Array(PUBLIC_RELAY_MAX_URLS + 1).fill(offer().urls[0]) })).toBe(true)
    expect(refused({ ...offer(), urls: [] })).toBe(true)
  })
})

describe('connect-time host denylist', () => {
  it('refuses names a browser cannot prove public', () => {
    for (const host of ['relay.example', 'box.lan', 'nas.home', 'x.localdomain', 'abc.onion', 'x.alt', '1.in-addr.arpa', 'relay.test', 'relay.local', 'single'])
      expect(publicRelayHostAllowed(host), host).toBe(false)
    expect(publicRelayHostAllowed('turn.example.org')).toBe(true)
  })
})

const secret = new Uint8Array(32).fill(3)
const other = new Uint8Array(32).fill(4)
const NOW = 1_793_000_000
function sign(options: { key?: Uint8Array; at?: number; status?: string; content?: string; tags?: string[][]; region?: string } = {}) {
  const at = options.at ?? NOW
  const tags = options.tags ?? [['d', 'spry-turn'], ['v', '1'], ['status', options.status ?? 'open'], ['auth', 'public'],
    ['expiration', String(at + PUBLIC_RELAY_MAX_LIFETIME)], ...(options.region ? [['g', options.region]] : [])]
  const content = options.content ?? (options.status === 'withdrawn' ? '{}' : JSON.stringify(offer()))
  return finalizeEvent({ kind: 31478, created_at: at, tags, content }, options.key ?? secret)
}
const reason = (run: () => unknown): string | undefined => {
  try { run(); return undefined } catch (error) { return error instanceof PublicRelayRefused ? error.reason : String(error) }
}

describe('verifyPublicRelayAdvert beyond the fixture', () => {
  it('reads the region and the offer, and expires at its expiration', () => {
    const advert = verifyPublicRelayAdvert(sign({ region: 'GB' }), NOW)
    expect(advert).toMatchObject({ status: 'open', region: 'GB', host: 'relay.example', expiresAt: NOW + PUBLIC_RELAY_MAX_LIFETIME })
    expect(advert.offer).toEqual(offer())
    expect(reason(() => verifyPublicRelayAdvert(sign(), NOW + PUBLIC_RELAY_MAX_LIFETIME))).toBe('Expired')
    expect(reason(() => verifyPublicRelayAdvert(sign({ region: 'gb' }), NOW))).toBe('Destination')
  })
  it('wants exactly one two-element tag per name', () => {
    const base = [['d', 'spry-turn'], ['v', '1'], ['status', 'open'], ['auth', 'public'], ['expiration', String(NOW + 60)]]
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: [...base, ['v', '1']] }), NOW))).toBe('Destination')
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: base.map(t => t[0] === 'd' ? ['d', 'spry-turn', 'x'] : t) }), NOW))).toBe('Destination')
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: [...base, ['expiration', String(NOW + 60)]] }), NOW))).toBe('Expired')
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: base.map(t => t[0] === 'expiration' ? ['expiration', ' 1793000060'] : t) }), NOW))).toBe('Expired')
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: base.map(t => t[0] === 'expiration' ? ['expiration', '1'.repeat(17)] : t) }), NOW))).toBe('Expired')
    expect(reason(() => verifyPublicRelayAdvert(sign({ tags: base.map(t => t[0] === 'auth' ? ['auth', 'paired'] : t) }), NOW))).toBe('Destination')
  })
  it('refuses unknown or repeated content fields and a withdrawal that offers something', () => {
    expect(reason(() => verifyPublicRelayAdvert(sign({ content: JSON.stringify({ ...offer(), extra: 1 }) }), NOW))).toBe('Encoding')
    const repeated = JSON.stringify(offer()).replace('{', '{"credentials":"https://other.example/v1/public/credentials",')
    expect(reason(() => verifyPublicRelayAdvert(sign({ content: repeated }), NOW))).toBe('Encoding')
    expect(reason(() => verifyPublicRelayAdvert(sign({ status: 'withdrawn', content: '{"a":1}' }), NOW))).toBe('Encoding')
    expect(reason(() => verifyPublicRelayAdvert(sign({ status: 'paused' }), NOW))).toBe('Destination')
    // A null note is no note, as serde reads an Option.
    expect(verifyPublicRelayAdvert(sign({ content: JSON.stringify({ ...offer(), note: null }) }), NOW).offer?.note).toBeUndefined()
  })
  it('checks size first, then shape, then the signature on a fresh copy', () => {
    const big = sign({ content: JSON.stringify({ ...offer(), note: 'x'.repeat(4000) }) })
    expect(reason(() => verifyPublicRelayAdvert(big, NOW))).toBe('Size')
    const tampered = { ...sign(), content: JSON.stringify({ ...offer(), note: 'changed' }) }
    expect(reason(() => verifyPublicRelayAdvert(tampered, NOW))).toBe('Authentication')
    const forged = { ...tampered, [Symbol.for('verified')]: true }
    expect(reason(() => verifyPublicRelayAdvert(forged, NOW))).toBe('Authentication')
    expect(reason(() => verifyPublicRelayAdvert({ ...sign(), created_at: 1.5 }, NOW))).toBe('Encoding')
    expect(reason(() => verifyPublicRelayAdvert({ ...sign(), id: 'A'.repeat(64) }, NOW))).toBe('Encoding')
    expect(reason(() => verifyPublicRelayAdvert('not an event', NOW))).toBe('Encoding')
  })
})

// spry-link advert.rs `signed_adverts_verify_and_a_newer_withdrawal_wins`, and the restore rule.
describe('PublicRelayAdvertBook', () => {
  it('keeps the newest per key and lets a newer withdrawal win', () => {
    const book = new PublicRelayAdvertBook(4)
    const event = sign({ region: 'GB' })
    book.accept(event, NOW)
    expect(book.open(NOW)).toHaveLength(1)
    expect(reason(() => book.accept(event, NOW))).toBe('Replay')
    const gone = sign({ at: NOW + 1, status: 'withdrawn' })
    expect(book.accept(gone, NOW + 1).status).toBe('withdrawn')
    expect(book.open(NOW + 1)).toHaveLength(0)
    expect(reason(() => book.accept(event, NOW + 1))).toBe('Replay')
    expect(book.watermark(getPublicKey(secret))).toBe(NOW + 1)
  })
  it('is bounded', () => {
    const full = new PublicRelayAdvertBook(1)
    full.accept(sign(), NOW)
    expect(reason(() => full.accept(sign({ key: other }), NOW))).toBe('Overload')
    expect(new PublicRelayAdvertBook(5000).capacity).toBe(1024)
  })
  it('does not advance the watermark for an event that fails verification', () => {
    const book = new PublicRelayAdvertBook()
    expect(reason(() => book.accept({ ...sign({ at: NOW + 5 }), sig: '0'.repeat(128) }, NOW))).toBe('Authentication')
    expect(book.watermark(getPublicKey(secret))).toBeUndefined()
    book.accept(sign(), NOW)
  })
  it('forgets a watermark two hours after its created_at', () => {
    const book = new PublicRelayAdvertBook()
    book.accept(sign(), NOW)
    expect(book.watermarks(NOW + PUBLIC_RELAY_MAX_LIFETIME - 1)).toHaveLength(1)
    expect(book.watermarks(NOW + PUBLIC_RELAY_MAX_LIFETIME)).toHaveLength(0)
  })
  it('admits the one event behind a restored watermark once, and nothing older', () => {
    const event = sign()
    const first = new PublicRelayAdvertBook()
    first.accept(event, NOW)
    const marks = first.watermarks(NOW + 10)
    const book = new PublicRelayAdvertBook(1024, marks)
    expect(book.open(NOW + 10)).toHaveLength(0)
    expect(book.accept(event, NOW + 10).status).toBe('open')
    expect(reason(() => book.accept(event, NOW + 10))).toBe('Replay')
    const older = sign({ at: NOW - 5 })
    expect(reason(() => new PublicRelayAdvertBook(1024, marks).accept(older, NOW + 10))).toBe('Replay')
    // A withdrawal behind a restored watermark stays withdrawn: an open advert at the same second differs in id.
    const gone = sign({ at: NOW + 20, status: 'withdrawn' })
    const withdrawnBook = new PublicRelayAdvertBook()
    withdrawnBook.accept(gone, NOW + 20)
    const reopened = new PublicRelayAdvertBook(1024, withdrawnBook.watermarks(NOW + 30))
    expect(reason(() => reopened.accept(sign({ at: NOW + 20 }), NOW + 30))).toBe('Replay')
  })
})

describe('fetchPublicRelayLogin', () => {
  const advert = (): PublicRelayAdvert => ({ ...verifyPublicRelayAdvert(sign({
    content: JSON.stringify({ credentials: 'https://relay.example.org/v1/public/credentials',
      urls: ['turn:relay.example.org:3478?transport=udp', 'turns:relay.example.org:5349?transport=tcp'] }),
  }), NOW) })
  const login = (overrides: Record<string, unknown> = {}) => ({
    urls: ['turn:relay.example.org:3478?transport=udp', 'turns:relay.example.org:5349?transport=tcp'],
    username: `${NOW + 3600}:pub-0123456789abcdef01234567`, credential: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtMTI=', expiresAt: NOW + 3600, ...overrides,
  })
  const reply = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init })
  const run = (response: Response | (() => Promise<Response>), options: { timeoutMs?: number } = {}) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const promise = fetchPublicRelayLogin(advert(), {
      now: () => NOW, timeoutMs: options.timeoutMs,
      fetch: async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response() : response },
    })
    return { promise, calls }
  }

  it('posts exactly {"v":1} with no cookies, referrer, cache or redirect', async () => {
    const { promise, calls } = run(reply(login()))
    await expect(promise).resolves.toMatchObject({ host: 'relay.example.org', expiresAt: NOW + 3600 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://relay.example.org/v1/public/credentials')
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"v":1}', headers: { 'Content-Type': 'application/json' },
      mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
  })
  it('drops every URL the advert did not name, and fails with none left', async () => {
    const narrowed = await run(reply(login({ urls: ['turn:relay.example.org:3478?transport=udp', 'turn:evil.example.org:3478', 'turn:relay.example.org:3478?transport=tcp'] }))).promise
    expect(narrowed.urls).toEqual(['turn:relay.example.org:3478?transport=udp'])
    await expect(run(reply(login({ urls: ['turn:evil.example.org:3478'] }))).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply(login({ urls: 'turn:relay.example.org:3478?transport=udp' }))).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
  })
  it('validates the username, credential and an hour-long expiry', async () => {
    for (const bad of [
      { username: `${NOW + 3599}:pub-0123456789abcdef01234567` },
      { username: `${NOW + 3600}:pub-0123456789ABCDEF01234567` },
      { username: `${NOW + 3600}:pub-0123` },
      { credential: 'not base64!' },
      { credential: 'QUFB'.repeat(17) },
      { credential: '' },
      { expiresAt: NOW, username: `${NOW}:pub-0123456789abcdef01234567` },
      { expiresAt: NOW + 3661, username: `${NOW + 3661}:pub-0123456789abcdef01234567` },
      { expiresAt: NOW + 10.5 },
    ]) await expect(run(reply(login(bad))).promise, JSON.stringify(bad)).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply(login({ expiresAt: NOW + 3660, username: `${NOW + 3660}:pub-0123456789abcdef01234567` }))).promise).resolves.toBeDefined()
  })
  it('needs a 200 with application/json, within 4 KiB', async () => {
    await expect(run(reply(login(), { status: 201 })).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply(login(), { headers: { 'content-type': 'text/plain' } })).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply(login(), { headers: { 'content-length': '5000' } })).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply(JSON.stringify({ ...login(), pad: 'x'.repeat(5000) }))).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(reply('not json')).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
  })
  it('says a 429 is busy, so a renewal can retry', async () => {
    const error = await run(reply('{}', { status: 429 })).promise.catch(e => e)
    expect(error).toBeInstanceOf(PublicRelayLoginFailed)
    expect(error.busy).toBe(true)
    expect((await run(reply('{}', { status: 503 })).promise.catch(e => e)).busy).toBe(false)
  })
  it('refuses a redirected response and a fetch that throws for one', async () => {
    const redirected = reply(login())
    Object.defineProperty(redirected, 'redirected', { value: true })
    await expect(run(redirected).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    await expect(run(() => Promise.reject(new TypeError('redirect mode is error'))).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
  })
  it('gives up after its timeout even if the fetch never answers', async () => {
    const started = Date.now()
    await expect(run(() => new Promise<Response>(() => {}), { timeoutMs: 50 }).promise).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('never contacts a host on the connect-time denylist or a withdrawn advert', async () => {
    let called = false
    const local = verifyPublicRelayAdvert(sign(), NOW) // relay.example
    await expect(fetchPublicRelayLogin(local, { now: () => NOW, fetch: async () => { called = true; return reply(login()) } })).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    const withdrawn = verifyPublicRelayAdvert(sign({ status: 'withdrawn' }), NOW)
    await expect(fetchPublicRelayLogin(withdrawn, { now: () => NOW, fetch: async () => { called = true; return reply(login()) } })).rejects.toBeInstanceOf(PublicRelayLoginFailed)
    expect(called).toBe(false)
  })
})
