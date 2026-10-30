import { RoomSession } from '../../src/session.js'
import { retireAccountNetworkRooms, accountNetworkRoomOpening } from './account-network-rooms.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import type { SignetSession, SignetSigner } from 'signet-login'
import { AccountNetwork, ACCOUNT_NETWORK_KEY, accountNetworkDefault, NOSTR_MODE_REQUIRED, PRIVATE_SYNC_PAUSED } from './account-network.js'
import { accountSyncServices } from './account-sync.js'
import { RelayConnections } from './relay-settings.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { encodeJoinUrl, deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { knownRooms } from './rooms-store.js'
import { ProfileBook } from './profiles.js'
import { FollowBook } from './follow-list.js'
import { BrowserRoomPool } from './browser-room-pool.js'
import type { RoomConsent } from './browser-room-consent.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../../test/fake-socket.js'

const url = 'wss://account-network.test'
function storage() {
  const entries = new Map<string, string>()
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
}
function actor() {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  const signer: SignetSigner = { pubkey, method: 'nip07', capabilities: { canSignEvents: true, hasNip44: true }, close: vi.fn(async () => {}),
    signEvent: vi.fn(async event => finalizeEvent({ ...event, tags: event.tags ?? [], created_at: event.created_at ?? Math.floor(Date.now() / 1000) }, secret)),
    nip44: { encrypt: vi.fn(async (peer, text) => encrypt(text, getConversationKey(secret, peer))),
      decrypt: vi.fn(async (peer, text) => decrypt(text, getConversationKey(secret, peer))) } }
  return { account: { pubkey, signer, method: 'nip07' } as SignetSession, secret }
}
const roomSecret = new Uint8Array(32).fill(19)
const room = { roomId: deriveRoom(roomSecret).roomId, name: 'Local room', link: encodeJoinUrl('https://example.test/j/', roomSecret, [url]), openedAt: 1, readAt: 0 }
const cleanups: (() => void)[] = []
beforeEach(() => { resetFakeRelays(); useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket); vi.stubGlobal('WebSocket', FakeWebSocket) })
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function harness(mode: 'nostr' | 'private-invitations' = 'private-invitations') {
  const settings = storage(), network = new AccountNetwork(settings, mode), relay = fakeRelay(url)
  const connections = new RelayConnections(settings, [url], () => false, { intervalMs: 60_000 })
  connections.accountNetwork(network)
  const { account, secret } = actor(), store = memoryDeviceStore(), statuses: string[] = [], adopted: unknown[] = []
  const restore = () => {
    const service = accountSyncServices({ network, account, store, pool: () => connections.pool('default'), current: () => true,
      changed: () => {}, status: text => statuses.push(text), spry: value => adopted.push(value), spryStatus: text => statuses.push(text), read: () => {} })
    cleanups.push(service.close); service.start(); return service
  }
  return { settings, network, relay, connections, account, secret, store, statuses, adopted, restore }
}

describe('installation account network and production account composition', () => {
  it('validates distribution defaults and keeps a saved choice across distributions', () => {
    expect(accountNetworkDefault(undefined)).toBe('nostr')
    expect(accountNetworkDefault('private-invitations')).toBe('private-invitations')
    expect(() => accountNetworkDefault('private')).toThrow('VITE_ACCOUNT_NETWORK_DEFAULT')
    const saved = storage(), first = new AccountNetwork(saved, 'private-invitations')
    expect(first.mode).toBe('private-invitations')
    first.choose('nostr')
    expect(new AccountNetwork(saved, 'private-invitations').mode).toBe('nostr')
    saved.setItem(ACCOUNT_NETWORK_KEY, JSON.stringify({ v: 1, mode: 'nostr', revision: 'broken' }))
    expect(new AccountNetwork(saved).mode).toBe('private-invitations')
    saved.setItem(ACCOUNT_NETWORK_KEY, 'corrupt')
    expect(new AccountNetwork(saved).mode).toBe('private-invitations')
    expect(new AccountNetwork({ getItem: () => { throw Error('locked') }, setItem: () => {} }).mode).toBe('private-invitations')
  })


  it('refuses allocation when authoritative storage changes during lease acquisition', () => {
    let reads = 0
    const network = new AccountNetwork({ getItem: key => key === ACCOUNT_NETWORK_KEY ? ++reads <= 2 ? 'nostr' : 'private-invitations' : null, setItem: () => {} })
    const make = vi.fn(() => ({ publish: async (_event: Event) => {}, subscribe: () => () => {}, close: vi.fn() }))
    expect(() => network.publicTransport(make)).toThrow(NOSTR_MODE_REQUIRED)
    expect(make).not.toHaveBeenCalled()
  })

  it('closes a transport if its factory observes a concurrent private choice', () => {
    const saved = storage(), network = new AccountNetwork(saved), close = vi.fn()
    expect(() => network.publicTransport(() => {
      saved.setItem(ACCOUNT_NETWORK_KEY, 'private-invitations')
      return { publish: async (_event: Event) => {}, subscribe: () => () => {}, close }
    })).toThrow(NOSTR_MODE_REQUIRED)
    expect(close).toHaveBeenCalledOnce()
  })

  it('holds privately and cancels existing services when saving private mode fails', async () => {
    const saved = storage(), network = new AccountNetwork({ getItem: saved.getItem, setItem: () => { throw Error('quota') } })
    const close = vi.fn(), pool = network.publicTransport(() => ({ publish: async (_event: Event) => {}, publishGuarded: async (_event: Event) => {}, subscribe: () => () => {}, close }))
    expect(() => network.choose('private-invitations')).toThrow('could not be saved')
    expect(network.mode).toBe('private-invitations'); expect(network.persisted).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    saved.setItem(ACCOUNT_NETWORK_KEY, 'nostr'); network.refresh()
    expect(network.mode).toBe('private-invitations')
    const event = finalizeEvent({ kind: 1, content: '', tags: [], created_at: 1 }, generateSecretKey())
    await expect(pool.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
  })


  it('holds privately when enabling Nostr cannot be persisted, including an already public tab', () => {
    for (const mode of ['private-invitations', 'nostr'] as const) {
      const saved = storage(), network = new AccountNetwork({ getItem: saved.getItem, setItem: () => { throw Error('quota') } }, mode)
      const close = vi.fn()
      if (network.nostr) network.publicTransport(() => ({ publish: async (_event: Event) => {}, subscribe: () => () => {}, close }))
      expect(() => network.choose('nostr')).toThrow('could not be saved')
      expect(network.mode).toBe('private-invitations'); expect(network.persisted).toBe(false)
      if (mode === 'nostr') expect(close).toHaveBeenCalledOnce()
      saved.setItem(ACCOUNT_NETWORK_KEY, 'nostr'); network.refresh()
      expect(network.mode).toBe('private-invitations')
    }
  })

  it('reads the authoritative atomic record when a stale storage wakeup arrives', () => {
    const saved = storage(), network = new AccountNetwork(saved), otherTab = new AccountNetwork(saved)
    otherTab.choose('nostr')
    const stalePublicRecord = saved.getItem(ACCOUNT_NETWORK_KEY)
    otherTab.choose('private-invitations')
    // A queued event may still carry stalePublicRecord. The handler calls
    // refresh with no payload, so that earlier public value cannot enable I/O.
    expect(JSON.parse(stalePublicRecord!).mode).toBe('nostr')
    network.refresh()
    expect(network.mode).toBe('private-invitations')
    expect(() => network.requireNostr()).toThrow(NOSTR_MODE_REQUIRED)
  })

  it('cold restore, reconnect and local pending changes make no public account I/O or optional signer requests', async () => {
    const h = harness(), first = h.restore()
    first.bookmarks.save(room)
    await first.bookmarks.retry()
    const retained = h.store.keys().map(key => [key, h.store.get(key)])
    first.close()
    const restored = h.restore()
    await restored.bookmarks.retry()
    expect(knownRooms(restored.bookmarks.rooms).map(entry => entry.roomId)).toContain(room.roomId)
    expect(h.store.keys().map(key => [key, h.store.get(key)])).toEqual(retained)
    expect(h.account.signer.nip44!.encrypt).not.toHaveBeenCalled()
    expect(h.account.signer.nip44!.decrypt).not.toHaveBeenCalled()
    expect(h.account.signer.signEvent).not.toHaveBeenCalled()
    expect(h.relay.attempts).toBe(0)
    expect(h.relay.frames).toEqual([])
    expect(h.statuses).toEqual([PRIVATE_SYNC_PAUSED, PRIVATE_SYNC_PAUSED])
    expect(() => h.connections.pool('default')).toThrow(NOSTR_MODE_REQUIRED)
    expect(() => h.connections.pool(`room:${room.roomId}`)).toThrow(NOSTR_MODE_REQUIRED)
    expect(h.account.signer.close).not.toHaveBeenCalled()
  })

  it('only the explicit Nostr choice resumes real account subscriptions and pending publication', async () => {
    const h = harness(), local = h.restore()
    local.bookmarks.save(room)
    h.network.choose('nostr')
    const active = h.restore()
    active.read!.follow(room.roomId, new Uint8Array(32).fill(7), {})
    await active.bookmarks.retry()
    await vi.waitFor(() => expect(h.relay.stored.some(event => event.kind === 30078 && event.pubkey === h.account.pubkey)).toBe(true))
    const filters = h.relay.requestedFilters().flat()
    expect(filters.filter(filter => filter.kinds?.includes(30078) && filter.authors?.includes(h.account.pubkey)).length).toBeGreaterThanOrEqual(3)
    expect(h.account.signer.nip44!.encrypt).toHaveBeenCalled()
    expect(h.account.signer.signEvent).toHaveBeenCalled()
    expect(JSON.parse(h.settings.getItem(ACCOUNT_NETWORK_KEY)!).mode).toBe('nostr')
    h.network.choose('private-invitations')
    await vi.waitFor(() => expect(h.relay.connections).toBe(0))
    const attempts = h.relay.attempts
    await h.connections.probeAll()
    h.restore()
    expect(h.relay.attempts).toBe(attempts)
    expect(h.account.signer.close).not.toHaveBeenCalled()
  })

  it('keeps pending bookmark changes when a signature resolves after private mode was selected', async () => {
    const h = harness('nostr'), active = h.restore(), sign = h.account.signer.signEvent.bind(h.account.signer)
    let release!: () => void
    h.account.signer.signEvent = vi.fn(async template => { await new Promise<void>(resolve => { release = resolve }); return sign(template) })
    await vi.waitFor(() => expect(h.relay.requestedFilters().length).toBeGreaterThanOrEqual(2))
    active.bookmarks.save(room)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    h.network.choose('private-invitations')
    const paused = h.restore(), retained = h.store.keys().filter(key => key.startsWith('kithmoot.bookmarks.')).map(key => h.store.get(key))
    release()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.relay.stored).toEqual([])
    expect(h.store.keys().filter(key => key.startsWith('kithmoot.bookmarks.')).map(key => h.store.get(key))).toEqual(retained)
    expect(knownRooms(paused.bookmarks.rooms).map(entry => entry.roomId)).toContain(room.roomId)
    expect(h.statuses.some(status => status.includes('accepted by a relay'))).toBe(false)
  })

  it('attributes a guarded relay OK only to the current public pool', async () => {
    const h = harness('nostr'), first = h.connections.pool('default')
    cleanups.push(() => first.close())
    const event = finalizeEvent({ kind: 30078, content: 'encrypted', tags: [], created_at: 1 }, h.secret)
    await first.publish(event)
    expect(h.relay.stored.some(stored => stored.id === event.id)).toBe(true)
    expect(h.connections.health('default')[0]?.lastPublishedAt).toBeGreaterThan(0)
    h.network.choose('private-invitations')
    expect(h.connections.health('default')[0]?.lastPublishedAt).toBeUndefined()
    h.network.choose('nostr')
    const next = h.connections.pool('default')
    cleanups.push(() => next.close())
    expect(h.connections.health('default')[0]?.lastPublishedAt).toBeUndefined()
    await expect(first.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
  })

  it('publishes ordinary events over the pool\'s own socket, not a new connection each time', async () => {
    // Public relays rate limit and ban by IP; a heartbeat every 20 s must not
    // open a fresh connection to every relay.
    const h = harness('nostr'), pool = h.connections.pool('default')
    cleanups.push(() => pool.close())
    for (let i = 0; i < 5; i++) {
      await pool.publish(finalizeEvent({ kind: 30078, content: `encrypted ${i}`, tags: [], created_at: 1 + i }, h.secret))
    }
    expect(h.relay.stored.length).toBe(5)
    expect(h.relay.attempts).toBe(1)
  })

  it('cancels a stalled socket publication and prevents retained handles from restarting after cross-tab changes', async () => {
    const h = harness('nostr'), pool = h.connections.pool('default')
    cleanups.push(() => pool.close())
    h.relay.stallConnections = true
    const event = finalizeEvent({ kind: 30078, content: 'encrypted', tags: [], created_at: 1 }, h.secret)
    const publishing = pool.publish(event).then(() => 'success', () => 'cancelled')
    await vi.waitFor(() => expect(h.relay.stalled.size).toBeGreaterThan(0))
    // Another tab changes authoritative storage; no event payload is trusted.
    h.settings.setItem(ACCOUNT_NETWORK_KEY, 'private-invitations')
    h.network.refresh()
    expect(await publishing).toBe('cancelled')
    expect(h.relay.stalled.size).toBe(0)
    expect(h.relay.stored).toEqual([])
    expect(h.connections.health('default')[0]?.lastPublishedAt).toBeUndefined()
    expect(() => pool.reconnect()).toThrow(NOSTR_MODE_REQUIRED)
    h.network.choose('nostr')
    await expect(pool.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
    expect(() => pool.subscribe([{ kinds: [0] }], () => {})).toThrow(NOSTR_MODE_REQUIRED)
  })


  it('invalidates retained work after a different tab privately pauses and re-enables before this tab wakes', async () => {
    const saved = storage(), network = new AccountNetwork(saved), otherTab = new AccountNetwork(saved), close = vi.fn()
    const pool = network.publicTransport(() => ({ publish: async (_event: Event) => {}, publishGuarded: async (_event: Event) => {}, subscribe: () => () => {}, close }))
    otherTab.choose('private-invitations'); otherTab.choose('nostr')
    // This tab missed both events; final mode alone is unchanged. The durable
    // revision still invalidates its earlier callbacks/publication ownership.
    const event = finalizeEvent({ kind: 1, content: '', tags: [], created_at: 1 }, generateSecretKey())
    await expect(pool.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
    expect(close).toHaveBeenCalledOnce()
    expect(network.mode).toBe('nostr')
  })

  it('carries a room handover all-relay requirement through the current public guard', async () => {
    const network = new AccountNetwork(storage()), guarded = vi.fn(async (_event: Event, current: () => boolean, _options?: { allRelays?: boolean }) => { expect(current()).toBe(true) })
    const pool = network.publicTransport<RelayTransport>(() => ({ publish: async (_event: Event) => {}, publishGuarded: guarded, subscribe: () => () => {}, close: vi.fn() }))
    const event = finalizeEvent({ kind: 1, content: 'room relay change', tags: [], created_at: 1 }, generateSecretKey())
    await pool.publish(event, { allRelays: true })
    expect(guarded).toHaveBeenCalledWith(event, expect.any(Function), { allRelays: true })
    network.choose('private-invitations')
    await expect(pool.publish(event, { allRelays: true })).rejects.toThrow(NOSTR_MODE_REQUIRED)
    expect(guarded).toHaveBeenCalledTimes(1)
  })

  it('guards old callback adoption even if Nostr is enabled again before the callback arrives', () => {
    const settings = storage(), network = new AccountNetwork(settings), receive = vi.fn(), eose = vi.fn()
    let late!: (event: Event) => void, done!: () => void
    const pool = network.publicTransport(() => ({
      publish: async (_event: Event) => {}, publishGuarded: async (_event: Event) => {}, close: vi.fn(),
      subscribe: (_filters: unknown, callback: (event: Event) => void, completed?: () => void) => { late = callback; done = completed!; return () => {} },
    }))
    pool.subscribe([], receive, eose)
    network.choose('private-invitations'); network.choose('nostr')
    late(finalizeEvent({ kind: 1, content: '', tags: [], created_at: 1 }, generateSecretKey())); done()
    expect(receive).not.toHaveBeenCalled(); expect(eose).not.toHaveBeenCalled()
  })

  it('closes profile/follow subscriptions and aborts HTTP while retaining saved lookup preference', async () => {
    const h = harness('nostr'), preference = true
    const profiles = new ProfileBook({ relays: () => [url], publicRelays: () => [url], transport: urls => h.connections.pool('public-profiles', urls), onChange: () => {} })
    const follows = new FollowBook({ relays: () => [url], transport: urls => h.connections.pool('follows', urls), onChange: () => {} })
    cleanups.push(() => { profiles.close(); follows.close() })
    profiles.want([h.account.pubkey], 'public'); follows.setAccount(h.account.pubkey); follows.refresh()
    await vi.waitFor(() => expect(h.relay.requestedFilters().flat().some(filter => filter.kinds?.includes(3))).toBe(true))
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { signal = init.signal!; return new Response('{}') }))
    await h.network.fetch('https://example.test/.well-known/nostr.json')
    h.network.choose('private-invitations')
    profiles.setEnabled(h.network.nostr && preference); follows.setEnabled(h.network.nostr && preference)
    expect(signal.aborted).toBe(true)
    expect(profiles.get(h.account.pubkey)).toBeUndefined()
    expect(follows.snapshot().status).toBe('off')
    expect(preference).toBe(true)
    expect(() => h.network.fetch('https://example.test/avatar.png')).toThrow(NOSTR_MODE_REQUIRED)
    await vi.waitFor(() => expect(h.relay.connections).toBe(0))
  })


  it('rebinds a live ordinary room to a fresh public delegate after a skipped cross-tab private round trip', async () => {
    const h = harness('nostr'), otherTab = new AccountNetwork(h.settings), changes = new Set<() => void>()
    const delegates: ReturnType<RelayConnections['pool']>[] = []
    const roomPool = new BrowserRoomPool({ room: room.roomId, account: () => h.account.pubkey, store: { all: async () => [] },
      barrier: { publicLease: async () => async () => {}, listen: listener => { changes.add(listener); return () => { changes.delete(listener) } } },
      publicPool: () => { const delegate = h.connections.pool(`room:${room.roomId}`); delegates.push(delegate); return delegate },
      privatePool: async () => { throw Error('No private room route selected') },
    })
    const unlisten = h.network.listen(() => { for (const changed of changes) changed() })
    cleanups.push(() => { unlisten(); roomPool.close() })
    roomPool.subscribe([{ kinds: [42] }], () => {})
    await vi.waitFor(() => expect(h.relay.requestedFilters().length).toBe(1))
    const old = delegates[0]
    otherTab.choose('private-invitations'); otherTab.choose('nostr')
    h.network.refresh()
    await vi.waitFor(() => expect(h.relay.requestedFilters().length).toBe(2))
    expect(old.closed).toBe(true)
    expect(roomPool.closed).toBe(false)
    expect(delegates).toHaveLength(2)
    const late = finalizeEvent({ kind: 42, content: 'old delegate', tags: [], created_at: 1 }, h.secret)
    await expect(old.publish(late)).rejects.toThrow(NOSTR_MODE_REQUIRED)
    const fresh = finalizeEvent({ kind: 42, content: 'fresh delegate', tags: [], created_at: 2 }, h.secret)
    await roomPool.publish(fresh)
    expect(h.relay.stored.some(event => event.id === fresh.id)).toBe(true)
    expect(h.relay.stored.some(event => event.id === late.id)).toBe(false)
    expect(h.network.mode).toBe('nostr')
  })



  it('does not adopt an old ordinary opening after delayed route selection and a missed private round trip', async () => {
    const h = harness('nostr'), otherTab = new AccountNetwork(h.settings)
    const check = accountNetworkRoomOpening(h.network), make = vi.fn(() => h.connections.pool(`room:${room.roomId}`))
    let select!: (privateRoute: boolean) => void
    const route = new Promise<boolean>(resolve => { select = resolve })
    const opening = (async () => { const privateRoute = await route; check(privateRoute); if (!privateRoute) return make() })()
      .then(() => undefined, error => error as Error)
    otherTab.choose('private-invitations'); otherTab.choose('nostr')
    select(false)
    expect(await opening).toMatchObject({ message: NOSTR_MODE_REQUIRED })
    expect(make).not.toHaveBeenCalled()
    expect(() => check(true)).not.toThrow()
  })

  it('revokes a real pending room credential before a late signature can inherit a new public delegate', async () => {
    const h = harness('nostr'), otherTab = new AccountNetwork(h.settings), changes = new Set<() => void>()
    const makePool = () => new BrowserRoomPool({ room: room.roomId, account: () => h.account.pubkey, store: { all: async () => [] },
      barrier: { publicLease: async () => async () => {}, listen: listener => { changes.add(listener); return () => { changes.delete(listener) } } },
      publicPool: () => h.connections.pool(`room:${room.roomId}`), privatePool: async () => { throw Error('No private route') },
    })
    const outer = makePool(), sign = h.account.signer.signEvent.bind(h.account.signer)
    let release!: () => void
    const identity = { pubkey: h.account.pubkey, signEvent: vi.fn(async (template: Parameters<typeof sign>[0]) => {
      await new Promise<void>(resolve => { release = resolve }); return sign(template)
    }) }
    const old = new RoomSession({ transport: outer, secret: roomSecret, identity, deviceSk: generateSecretKey(), announceJitterMs: 0,
      timing: { heartbeatIntervalMs: 1_000_000_000, sweepIntervalMs: 1_000_000_000 } })
    const privateSession = { leave: vi.fn(async () => {}) }, privateTransport = { close: vi.fn() }
    const unlisten = h.network.listen(() => {
      void retireAccountNetworkRooms([{ session: old, transport: outer, privateRoute: false },
        { session: privateSession, transport: privateTransport, privateRoute: true }])
      for (const changed of changes) changed()
    })
    cleanups.push(() => { unlisten(); release?.(); outer.close(); void old.leave() })
    const joining = old.join([], {}).then(() => undefined, error => error as Error)
    await vi.waitFor(() => expect(identity.signEvent).toHaveBeenCalledOnce())
    otherTab.choose('private-invitations'); otherTab.choose('nostr')
    h.network.refresh()
    expect(outer.closed).toBe(true)
    expect(privateSession.leave).not.toHaveBeenCalled(); expect(privateTransport.close).not.toHaveBeenCalled()
    release()
    expect(await joining).toMatchObject({ message: expect.stringContaining('cancelled') })
    expect(old.credential).toBeUndefined()
    expect(h.relay.stored).toEqual([])
    // Explicit reopen constructs a new session under the latest policy.
    const reopenedPool = makePool(), reopened = new RoomSession({ transport: reopenedPool, secret: roomSecret,
      identity: { pubkey: h.account.pubkey, signEvent: sign }, deviceSk: generateSecretKey(), announceJitterMs: 0,
      timing: { heartbeatIntervalMs: 1_000_000_000, sweepIntervalMs: 1_000_000_000 } })
    cleanups.push(() => { reopenedPool.close(); void reopened.leave() })
    await reopened.join([], {})
    expect(reopened.credential).toBeDefined()
    expect(h.relay.stored.length).toBeGreaterThan(0)
  })

  it('leaves the selected private room transport available without allocating a public delegate', async () => {
    const h = harness(), privateReceive = vi.fn(), publicMake = vi.fn(() => h.connections.pool(`room:${room.roomId}`))
    const consent = { room: room.roomId, aliases: [], account: h.account.pubkey, phase: 'active', expires: Math.floor(Date.now() / 1000) + 1000, box: { eventUrl: 'link:private' } } as unknown as RoomConsent
    const privatePool = { publish: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}), close: vi.fn(), describe: () => [] }
    const pool = new BrowserRoomPool({ room: room.roomId, account: () => h.account.pubkey, store: { all: async () => [consent] },
      barrier: { publicLease: async () => async () => {}, listen: () => () => {} }, publicPool: publicMake, privatePool: async () => privatePool })
    cleanups.push(() => pool.close())
    pool.subscribe([{ kinds: [42] }], privateReceive)
    const event = finalizeEvent({ kind: 42, content: 'private', tags: [], created_at: 1 }, h.secret)
    await pool.publish(event)
    expect(privatePool.publish).toHaveBeenCalledWith(event)
    expect(publicMake).not.toHaveBeenCalled()
    expect(h.relay.attempts).toBe(0)
    expect(h.network.mode).toBe('private-invitations')
  })
})
