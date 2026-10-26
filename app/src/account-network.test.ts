import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import type { SignetSession, SignetSigner } from 'signet-login'
import { AccountNetwork, ACCOUNT_NETWORK_KEY, accountNetworkDefault, NOSTR_MODE_REQUIRED, PRIVATE_SYNC_PAUSED } from './account-network.js'
import { accountSyncServices } from './account-sync.js'
import { RelayConnections } from './relay-settings.js'
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
  const connections = new RelayConnections(settings, [url], () => false, { intervalMs: 0 })
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
    saved.setItem(ACCOUNT_NETWORK_KEY, 'corrupt')
    expect(new AccountNetwork(saved).mode).toBe('private-invitations')
    expect(new AccountNetwork({ getItem: () => { throw Error('locked') }, setItem: () => {} }).mode).toBe('private-invitations')
  })


  it('refuses allocation when authoritative storage changes during lease acquisition', () => {
    let reads = 0
    const network = new AccountNetwork({ getItem: () => ++reads <= 2 ? 'nostr' : 'private-invitations', setItem: () => {} })
    const make = vi.fn(() => ({ publish: async () => {}, subscribe: () => () => {}, close: vi.fn() }))
    expect(() => network.publicTransport(make)).toThrow(NOSTR_MODE_REQUIRED)
    expect(make).not.toHaveBeenCalled()
  })

  it('closes a transport if its factory observes a concurrent private choice', () => {
    const saved = storage(), network = new AccountNetwork(saved), close = vi.fn()
    expect(() => network.publicTransport(() => {
      saved.setItem(ACCOUNT_NETWORK_KEY, 'private-invitations')
      return { publish: async () => {}, subscribe: () => () => {}, close }
    })).toThrow(NOSTR_MODE_REQUIRED)
    expect(close).toHaveBeenCalledOnce()
  })

  it('holds privately and cancels existing services when saving private mode fails', async () => {
    const saved = storage(), network = new AccountNetwork({ getItem: saved.getItem, setItem: () => { throw Error('quota') } })
    const close = vi.fn(), pool = network.publicTransport(() => ({ publish: async () => {}, publishGuarded: async () => {}, subscribe: () => () => {}, close }))
    expect(() => network.choose('private-invitations')).toThrow('could not be saved')
    expect(network.mode).toBe('private-invitations'); expect(network.persisted).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    saved.setItem(ACCOUNT_NETWORK_KEY, 'nostr'); network.refresh()
    expect(network.mode).toBe('private-invitations')
    const event = finalizeEvent({ kind: 1, content: '', tags: [], created_at: 1 }, generateSecretKey())
    await expect(pool.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
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
    expect(h.settings.getItem(ACCOUNT_NETWORK_KEY)).toBe('nostr')
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
    expect(() => pool.reconnect()).toThrow(NOSTR_MODE_REQUIRED)
    h.network.choose('nostr')
    await expect(pool.publish(event)).rejects.toThrow(NOSTR_MODE_REQUIRED)
    expect(() => pool.subscribe([{ kinds: [0] }], () => {})).toThrow(NOSTR_MODE_REQUIRED)
  })

  it('guards old callback adoption even if Nostr is enabled again before the callback arrives', () => {
    const settings = storage(), network = new AccountNetwork(settings), receive = vi.fn(), eose = vi.fn()
    let late!: () => void, done!: () => void
    const pool = network.publicTransport(() => ({
      publish: async () => {}, publishGuarded: async () => {}, close: vi.fn(),
      subscribe: (_filters: unknown, callback: () => void, completed?: () => void) => { late = callback; done = completed!; return () => {} },
    }))
    pool.subscribe([], receive, eose)
    network.choose('private-invitations'); network.choose('nostr')
    late(); done()
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
