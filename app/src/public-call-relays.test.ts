import { AccountNetwork } from './account-network.js'
import { findPublicCallRelays, PUBLIC_RELAY_DISCOVERY_PAUSED } from './public-call-relay-discovery.js'
import { describe, expect, it, vi } from 'vitest'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { FakeWebSocket } from '../../test/fake-socket.js'
import { RelayConnections } from './relay-settings.js'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { CALL_RELAY_KEY } from './call-relay.js'
import {
  PUBLIC_CALL_RELAYS_KEY, PUBLIC_CALL_RELAY_SCOPE, PUBLIC_RELAY_LOST, PUBLIC_RELAY_LOST_RELAY_ONLY, PUBLIC_RELAY_RENEW_FAILED, PUBLIC_RELAY_START_FAILED,
  PublicCallRelays, PublicRelayCall, callRelaySource, cleanOperatorNote, publicRelayFilter, publicRelayIceServer, publicRelayPoolHints,
  publicRelayQueryRelays, publicRelaysMayRun, queryPublicRelayAdverts, shortTransportKey, type PublicRelayCallHooks,
} from './public-call-relays.js'
import type { PublicRelayLogin } from '../../src/public-call-relays.js'

const NOW = 1_793_000_000
const keyA = new Uint8Array(32).fill(7), keyB = new Uint8Array(32).fill(8), keyC = new Uint8Array(32).fill(9), keyD = new Uint8Array(32).fill(10)
const pub = (key: Uint8Array) => getPublicKey(key)

function advert(key: Uint8Array, host: string, options: { at?: number; status?: string; note?: string; region?: string } = {}) {
  const at = options.at ?? NOW
  const tags = [['d', 'spry-turn'], ['v', '1'], ['status', options.status ?? 'open'], ['auth', 'public'], ['expiration', String(at + 7200)],
    ...(options.region ? [['g', options.region]] : [])]
  const content = options.status === 'withdrawn' ? '{}' : JSON.stringify({ credentials: `https://${host}/v1/public/credentials`,
    urls: [`turn:${host}:3478?transport=udp`, `turns:${host}:5349?transport=tcp`], ...(options.note ? { note: options.note } : {}) })
  return finalizeEvent({ kind: 31478, created_at: at, tags, content }, key)
}

class MemoryStore {
  map = new Map<string, string>()
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
}

function loginReply(host: string, at = NOW) {
  const expiresAt = at + 3600
  return new Response(JSON.stringify({ urls: [`turn:${host}:3478?transport=udp`, `turns:${host}:5349?transport=tcp`],
    username: `${expiresAt}:pub-0123456789abcdef01234567`, credential: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtMTI=', expiresAt }),
  { status: 200, headers: { 'content-type': 'application/json' } })
}

function setup(events: unknown[], options: { store?: MemoryStore; fetch?: (url: string) => Promise<Response>; clock?: { now: number } } = {}) {
  const store = options.store ?? new MemoryStore()
  const clock = options.clock ?? { now: NOW }
  const searches: number[] = []
  const fetched: string[] = []
  const relays = new PublicCallRelays({
    store, now: () => clock.now,
    search: async now => { searches.push(now); return events },
    fetch: async url => { fetched.push(url); return options.fetch ? options.fetch(url) : loginReply(new URL(url).hostname, clock.now) },
  })
  return { relays, store, searches, fetched, clock }
}

describe('query discipline', () => {
  it('asks only the default read relays that are not failing', () => {
    const personal = [
      { url: 'wss://a.example.org/', read: true, write: true },
      { url: 'wss://b.example.org/', read: false, write: true },
      { url: 'wss://c.example.org/', read: true, write: false },
      { url: 'wss://d.example.org/', read: true, write: true },
      { url: 'wss://e.example.org/', read: true, write: true },
    ]
    const health = [
      { url: 'wss://a.example.org/', read: true, write: true, state: 'connected' as const },
      { url: 'wss://d.example.org/', read: true, write: true, state: 'disconnected' as const },
      { url: 'wss://e.example.org/', read: true, write: true, state: 'connected' as const, readEvidence: 'authentication-required' as const },
    ]
    expect(publicRelayQueryRelays(personal, health)).toEqual(['wss://a.example.org/', 'wss://c.example.org/'])
  })
  it('sends one bounded filter per relay and keeps the 64 newest distinct adverts', async () => {
    expect(publicRelayFilter(NOW)).toEqual({ kinds: [31478], '#d': ['spry-turn'], limit: 64, since: NOW - 7200 })
    const calls: Array<[string, unknown, number | undefined, number | undefined]> = []
    const many = Array.from({ length: 70 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), created_at: NOW - index }))
    const pool = {
      query: async (url: string, filters: unknown[], timeoutMs?: number, max?: number) => {
        calls.push([url, filters, timeoutMs, max])
        if (url.includes('bad')) throw new Error('down')
        return { events: many as never[], complete: true }
      },
    }
    const events = await queryPublicRelayAdverts(pool, ['wss://one.example.org/', 'wss://bad.example.org/', 'wss://two.example.org/'], NOW) as Array<{ created_at: number }>
    expect(calls.map(call => call[0])).toEqual(['wss://one.example.org/', 'wss://bad.example.org/', 'wss://two.example.org/'])
    expect(calls.every(call => call[2] === 5000 && call[3] === 64 && JSON.stringify(call[1]) === JSON.stringify([publicRelayFilter(NOW)]))).toBe(true)
    expect(events).toHaveLength(64)
    expect(events[0]!.created_at).toBe(NOW - 63)
    expect(events[63]!.created_at).toBe(NOW)
  })
  it('makes no query while off, and shares one query in flight', async () => {
    const { relays, searches } = setup([advert(keyA, 'relay.example.org')])
    await expect(relays.discover()).rejects.toThrow()
    expect(searches).toHaveLength(0)
    relays.setEnabled(true)
    const [first, second] = await Promise.all([relays.discover(), relays.discover()])
    expect(searches).toHaveLength(1)
    expect(first).toEqual(second)
  })
  it('stays off by default', () => expect(setup([]).relays.enabled).toBe(false))
  it('queries over a pool that is not signed in and holds exactly the chosen relays', () => {
    useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket)
    const store = new MemoryStore()
    const connections = new RelayConnections(store, ['wss://relay.primal.net/', 'wss://nos.lol/'])
    // The exact legacy pair, which a room's hints would gain a third relay from.
    const urls = ['wss://relay.primal.net/', 'wss://nos.lol/']
    const pool = connections.pool(PUBLIC_CALL_RELAY_SCOPE, publicRelayPoolHints(urls))
    try {
      expect(pool.configuration().map(relay => relay.url)).toEqual(urls)
      expect(pool.configuration().every(relay => relay.read && !relay.write)).toBe(true)
      for (const url of urls) expect(connections.authenticationIdentity(PUBLIC_CALL_RELAY_SCOPE, url)).toBeUndefined()
      expect(connections.health(PUBLIC_CALL_RELAY_SCOPE, publicRelayPoolHints(urls)).every(relay => relay.authentication === undefined)).toBe(true)
    } finally { pool.close() }
  })
})

describe('picker listing', () => {
  it('lists verified, connectable adverts with cleaned operator claims', async () => {
    const { relays } = setup([
      advert(keyA, 'relay.example.org', { note: 'Fast\u202e evil\u200b\u2028 note', region: 'GB' }),
      advert(keyB, 'relay.example', {}), // connect-time denylist
      { ...advert(keyC, 'bad.example.org'), sig: '0'.repeat(128) },
      advert(keyD, 'zz.example.net', { status: 'withdrawn' }),
    ])
    relays.setEnabled(true)
    const listed = await relays.discover()
    expect(listed).toEqual([{ key: pub(keyA), shortKey: shortTransportKey(pub(keyA)), host: 'relay.example.org', region: 'GB',
      note: 'Fast evil note', lastGood: false, knownHostNewKey: false }])
    expect(cleanOperatorNote('\ufeffa\u2066b\u2069c')).toBe('abc')
  })
  it('puts the last good relay first and flags its hostname under a new key', async () => {
    const { relays } = setup([advert(keyA, 'b.example.org'), advert(keyB, 'a.example.org'), advert(keyC, 'b.example.org', { at: NOW + 1 })])
    relays.setEnabled(true)
    await relays.discover()
    relays.markGood(pub(keyA))
    const listed = relays.listing()
    expect(listed[0]).toMatchObject({ key: pub(keyA), lastGood: true })
    expect(listed.find(entry => entry.key === pub(keyC))).toMatchObject({ knownHostNewKey: true })
    expect(listed.find(entry => entry.key === pub(keyB))).toMatchObject({ knownHostNewKey: false })
  })
})

describe('storage', () => {
  it('persists only the switch, the last good relay and watermarks, never via the hand-entered relay', async () => {
    const { relays, store } = setup([advert(keyA, 'relay.example.org', { note: 'operator note' })])
    relays.setEnabled(true)
    await relays.discover()
    relays.select(pub(keyA))
    const login = await relays.login(pub(keyA))
    relays.markGood(pub(keyA))
    expect(store.getItem(CALL_RELAY_KEY)).toBeNull()
    expect([...store.map.keys()]).toEqual([PUBLIC_CALL_RELAYS_KEY])
    const saved = store.getItem(PUBLIC_CALL_RELAYS_KEY)!
    expect(JSON.parse(saved)).toEqual({ v: 1, on: true, lastGood: { key: pub(keyA), host: 'relay.example.org' },
      watermarks: [{ key: pub(keyA), createdAt: NOW, id: advert(keyA, 'relay.example.org', { note: 'operator note' }).id }] })
    for (const secretish of [login.username, login.credential, 'operator note', 'turn:', 'credentials']) expect(saved).not.toContain(secretish)
  })
  it('carries watermarks to the next visit and still lists the same advert', async () => {
    const event = advert(keyA, 'relay.example.org')
    const store = new MemoryStore()
    const first = setup([event], { store })
    first.relays.setEnabled(true)
    await first.relays.discover()
    const second = setup([event, advert(keyA, 'relay.example.org', { at: NOW - 60 })], { store })
    expect(second.relays.enabled).toBe(true)
    expect((await second.relays.discover()).map(entry => entry.key)).toEqual([pub(keyA)])
  })
  it('a newer withdrawal seen on an earlier visit keeps an older open advert out', async () => {
    const store = new MemoryStore()
    const first = setup([advert(keyA, 'relay.example.org', { at: NOW + 5, status: 'withdrawn' })], { store })
    first.relays.setEnabled(true)
    await first.relays.discover()
    const second = setup([advert(keyA, 'relay.example.org')], { store })
    expect(await second.relays.discover()).toEqual([])
  })
  it('turning it off clears everything it kept', async () => {
    const { relays, store } = setup([advert(keyA, 'relay.example.org')])
    relays.setEnabled(true)
    await relays.discover()
    relays.select(pub(keyA))
    await relays.login(pub(keyA))
    relays.markGood(pub(keyA))
    relays.setEnabled(false)
    expect(store.map.size).toBe(0)
    expect(relays.listing()).toEqual([])
    expect(relays.selected).toBeUndefined()
    expect(relays.lastGood).toBeUndefined()
    await expect(relays.login(pub(keyA))).rejects.toThrow()
    relays.setEnabled(true)
    expect(relays.listing()).toEqual([])
  })
  it('reuses the check’s login while it is valid, and asks again once it is nearly spent', async () => {
    const { relays, fetched, clock } = setup([advert(keyA, 'relay.example.org')])
    relays.setEnabled(true)
    await relays.discover()
    const first = await relays.login(pub(keyA))
    expect(await relays.login(pub(keyA))).toBe(first)
    expect(fetched).toEqual(['https://relay.example.org/v1/public/credentials'])
    clock.now = first.expiresAt - 60
    await relays.login(pub(keyA))
    expect(fetched).toHaveLength(2)
  })
})

describe('precedence', () => {
  const none = { spryPairing: false, handEntered: false, roomTurn: false, spryOffer: false, discovered: false }
  it('orders pairing, hand-entered, room, discovered, default', () => {
    expect(callRelaySource({ ...none, spryPairing: true, handEntered: true, roomTurn: true, discovered: true })).toBe('spry-pairing')
    expect(callRelaySource({ ...none, handEntered: true, roomTurn: true, spryOffer: true, discovered: true })).toBe('hand-entered')
    expect(callRelaySource({ ...none, roomTurn: true, discovered: true })).toBe('room')
    expect(callRelaySource({ ...none, spryOffer: true, discovered: true })).toBe('room')
    expect(callRelaySource({ ...none, discovered: true })).toBe('discovered')
    expect(callRelaySource(none)).toBe('default')
  })
  it('makes no query or login with a pairing or a hand-entered relay', () => {
    expect(publicRelaysMayRun({ enabled: true, spryPairing: true, handEntered: false })).toBe(false)
    expect(publicRelaysMayRun({ enabled: true, spryPairing: false, handEntered: true })).toBe(false)
    expect(publicRelaysMayRun({ enabled: false, spryPairing: false, handEntered: false })).toBe(false)
    expect(publicRelaysMayRun({ enabled: true, spryPairing: false, handEntered: false })).toBe(true)
  })
  it('hands the call only the URLs the login kept', () => {
    const login: PublicRelayLogin = { key: 'k', host: 'h', urls: ['turn:h.example.org:3478'], username: 'u', credential: 'c', expiresAt: NOW }
    expect(publicRelayIceServer(login)).toEqual({ urls: ['turn:h.example.org:3478'], username: 'u', credential: 'c' })
  })
})

function callHarness(relays: PublicCallRelays, clock: { now: number }, relayOnly: boolean) {
  const applied: Array<[PublicRelayLogin | undefined, string]> = []
  const notices: string[] = []
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  const hooks: PublicRelayCallHooks = {
    apply: (login, why) => applied.push([login, why]),
    notice: text => notices.push(text),
    relayOnly, now: () => clock.now, random: () => 0, sleep: async ms => { clock.now += Math.ceil(ms / 1000) },
    setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { (timer as { cleared: boolean }).cleared = true },
  }
  return { call: new PublicRelayCall(relays, hooks), applied, notices, timers, hooks }
}

describe('a call on a discovered relay', () => {
  it('starts from the chosen relay, searching once when its advert is not in hand', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.markGood(pub(keyA))
    const later = setup([advert(keyA, 'relay.example.org')], { store: env.store })
    const { call, applied } = callHarness(later.relays, later.clock, false)
    expect(await call.start()).toBe(true)
    expect(later.searches).toHaveLength(1)
    expect(applied.map(([login, why]) => [login?.host, why])).toEqual([['relay.example.org', 'start']])
  })
  it('never picks a relay the person did not choose', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    const { call, applied } = callHarness(env.relays, env.clock, false)
    expect(await call.start()).toBe(false)
    expect(applied).toEqual([])
    expect(env.fetched).toEqual([])
  })
  it('says so when the chosen relay does not answer', async () => {
    const env = setup([advert(keyA, 'relay.example.org')], { fetch: async () => new Response('', { status: 503 }) })
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, notices, applied } = callHarness(env.relays, env.clock, true)
    expect(await call.start()).toBe(false)
    expect(applied).toEqual([])
    expect(notices).toEqual([PUBLIC_RELAY_START_FAILED])
  })
  it('renews from the same operator only when the login would not outlast the next refresh', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, applied } = callHarness(env.relays, env.clock, false)
    await call.start()
    const refresh = 40 * 60 * 1000
    await call.renew(refresh)
    expect(env.fetched).toHaveLength(1)
    env.clock.now += 20 * 60
    await call.renew(refresh)
    expect(env.fetched).toEqual(['https://relay.example.org/v1/public/credentials', 'https://relay.example.org/v1/public/credentials'])
    expect(applied.map(([, why]) => why)).toEqual(['start', 'renew'])
  })
  it('retries a 429 before the login ends', async () => {
    let busy = 2
    const env = setup([advert(keyA, 'relay.example.org')], {
      fetch: async url => busy-- > 0 && env.fetched.length > 1 ? new Response('', { status: 429 }) : loginReply(new URL(url).hostname, env.clock.now),
    })
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, applied, notices } = callHarness(env.relays, env.clock, false)
    await call.start()
    busy = 2
    env.clock.now += 30 * 60
    await call.renew(40 * 60 * 1000)
    expect(applied.map(([, why]) => why)).toEqual(['start', 'renew'])
    expect(notices).toEqual([])
  })
  it('shows a renewal failure rather than swallowing it', async () => {
    let fail = false
    const env = setup([advert(keyA, 'relay.example.org')], {
      fetch: async url => fail ? new Response('', { status: 500 }) : loginReply(new URL(url).hostname, env.clock.now),
    })
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, notices } = callHarness(env.relays, env.clock, false)
    await call.start()
    fail = true
    env.clock.now += 30 * 60
    await call.renew(40 * 60 * 1000)
    expect(notices).toEqual([PUBLIC_RELAY_RENEW_FAILED])
  })
  it('relay-only fails closed with “call relay lost” when the login lapses', async () => {
    const env = setup([advert(keyA, 'relay.example.org'), advert(keyB, 'other.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, applied, notices, timers } = callHarness(env.relays, env.clock, true)
    await call.start()
    expect(timers.at(-1)!.ms).toBe(3600 * 1000)
    env.clock.now += 3600
    timers.at(-1)!.run()
    expect(applied.map(([login, why]) => [login?.host, why])).toEqual([['relay.example.org', 'start'], [undefined, 'lost']])
    expect(notices).toEqual([PUBLIC_RELAY_LOST_RELAY_ONLY])
    expect(call.active).toBe(false)
    // No failover to a relay nobody chose, and no fresh discovery mid-call.
    expect(env.fetched).toEqual(['https://relay.example.org/v1/public/credentials'])
    expect(env.searches).toHaveLength(1)
  })
  it('says the relay was lost in an ordinary call too', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, notices, timers } = callHarness(env.relays, env.clock, false)
    await call.start()
    timers.at(-1)!.run()
    expect(notices).toEqual([PUBLIC_RELAY_LOST])
  })
  it('drops the login from memory when the call ends', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const { call, timers, applied } = callHarness(env.relays, env.clock, true)
    await call.start()
    call.end()
    expect(call.login).toBeUndefined()
    expect(timers.every(timer => timer.cleared)).toBe(true)
    await env.relays.login(pub(keyA))
    expect(env.fetched).toHaveLength(2)
    timers.at(-1)!.run()
    expect(applied).toHaveLength(1)
  })
  it('stands down for a Spry offer that takes over', async () => {
    const env = setup([advert(keyA, 'relay.example.org')])
    env.relays.setEnabled(true)
    await env.relays.discover()
    env.relays.select(pub(keyA))
    const harness = callHarness(env.relays, env.clock, false)
    const superseded = vi.fn(() => true)
    const call = new PublicRelayCall(env.relays, { ...harness.hooks, superseded })
    expect(await call.start()).toBe(false)
    expect(env.fetched).toEqual([])
  })
})


describe('Connections discovery action composition', () => {
  function view() { return { status: vi.fn<(message: string) => void>(), render: vi.fn() } }

  it.each([false, true])('opens Connections privately without a mode prompt or public lookup when discovery enabled is %s', async enabled => {
    const h = setup([advert(keyA, 'relay.example.org')]), network = new AccountNetwork(h.store, 'private-invitations')
    if (enabled) h.relays.setEnabled(true)
    const display = view(), requireNostr = vi.fn(() => false), outranked = vi.fn(() => false)
    await findPublicCallRelays({ network, relays: h.relays, outranked, generation: () => 0, requireNostr, view: display })
    expect(display.status).toHaveBeenCalledWith(PUBLIC_RELAY_DISCOVERY_PAUSED)
    expect(display.render).toHaveBeenCalledOnce()
    expect(requireNostr).not.toHaveBeenCalled()
    expect(outranked).not.toHaveBeenCalled()
    expect(h.searches).toEqual([]); expect(h.fetched).toEqual([])
    expect(h.relays.enabled).toBe(enabled)
    expect(network.mode).toBe('private-invitations')
  })

  it('lets an explicit Find/On action explain the required mode while keeping public lookup suppressed', async () => {
    const h = setup([advert(keyA, 'relay.example.org')]), network = new AccountNetwork(h.store, 'private-invitations')
    h.relays.setEnabled(true)
    const display = view(), requireNostr = vi.fn(() => false)
    await findPublicCallRelays({ network, relays: h.relays, outranked: () => false, generation: () => 0, requireNostr, view: display }, 'manual')
    expect(requireNostr).toHaveBeenCalledOnce()
    expect(display.status).toHaveBeenCalledWith(PUBLIC_RELAY_DISCOVERY_PAUSED)
    expect(h.searches).toEqual([]); expect(h.fetched).toEqual([])
    expect(network.mode).toBe('private-invitations')
  })

  it.each([[false, false], [true, true]])('keeps ordinary automatic discovery silent when enabled=%s and outranked=%s', async (enabled, outranked) => {
    const h = setup([advert(keyA, 'relay.example.org')]), network = new AccountNetwork(h.store)
    if (enabled) h.relays.setEnabled(true)
    const display = view(), requireNostr = vi.fn(() => true)
    await findPublicCallRelays({ network, relays: h.relays, outranked: () => outranked, generation: () => 0, requireNostr, view: display })
    expect(display.render).toHaveBeenCalledOnce()
    expect(requireNostr).not.toHaveBeenCalled()
    expect(h.searches).toEqual([]); expect(h.fetched).toEqual([])
  })

  it('retains ordinary discovery, automatic freshness and an explicit manual refresh', async () => {
    const h = setup([advert(keyA, 'relay.example.org')]), network = new AccountNetwork(h.store)
    h.relays.setEnabled(true)
    const display = view(), requireNostr = vi.fn(() => true)
    const options = { network, relays: h.relays, outranked: () => false, generation: () => 0, requireNostr, view: display }
    await findPublicCallRelays(options)
    expect(h.searches).toHaveLength(1)
    expect(display.status).toHaveBeenCalledWith('1 public call relay found. Select one to use it.')
    await findPublicCallRelays(options)
    expect(h.searches).toHaveLength(1)
    await findPublicCallRelays(options, 'manual')
    expect(h.searches).toHaveLength(2)
    expect(requireNostr).not.toHaveBeenCalled()
    expect(h.fetched).toEqual([])
  })
})
