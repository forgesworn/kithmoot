import { describe, expect, it, beforeAll, vi } from 'vitest'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { currentRoomRelayHints, RelayConnections, profilePreference } from './relay-settings.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../../test/fake-socket.js'

beforeAll(() => {
  useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket)
})

const defaults = ['wss://default.test']
const room = `room:${'a'.repeat(64)}`
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('device relay preferences', () => {
  it('adds the solid public fallback to invitations carrying the exact old default pair', () => {
    expect(currentRoomRelayHints(['wss://relay.primal.net', 'wss://nos.lol'])).toEqual([
      { url: 'wss://relay.primal.net/', read: true, write: true },
      { url: 'wss://nos.lol/', read: true, write: true },
      { url: 'wss://nostr.mom/', read: true, write: true },
    ])
  })

  it('leaves custom, private and permissioned relay hints unchanged', () => {
    const custom = [{ url: 'wss://nos.lol', read: true, write: false }, { url: 'wss://relay.primal.net', read: false, write: true }]
    expect(currentRoomRelayHints(custom)).toBe(custom)
    const extra = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://private.test']
    expect(currentRoomRelayHints(extra)).toBe(extra)
  })

  it('honours room hints until explicitly changed, persists permissions and keeps defaults separate', () => {
    const saved = storage()
    const connections = new RelayConnections(saved, defaults)
    const hints = ['wss://room.test']
    const pool = connections.pool(room, hints)
    try {
      const chosen = [{ url: 'wss://read.test', read: true, write: false }, { url: 'wss://write.test', read: false, write: true }]
      connections.save(room, chosen)
      expect(pool.configuration()).toEqual(chosen.map(relay => ({ ...relay, url: `${relay.url}/` })))
      const restored = new RelayConnections(saved, defaults)
      expect(restored.configuration(room, hints)).toEqual(pool.configuration())
      expect(restored.configuration('default')[0]!.url).toBe('wss://default.test/')
      expect(restored.configuration(`room:${'b'.repeat(64)}`, hints)[0]!.url).toBe('wss://room.test/')
    } finally { pool.close() }
  })
  it('carries default permissions into a new room without flattening them into URL strings', () => {
    const saved = storage()
    const connections = new RelayConnections(saved, defaults)
    const chosen = [{ url: 'wss://read.test', read: true, write: false }, { url: 'wss://write.test', read: false, write: true }]
    connections.save('default', chosen)
    connections.inheritDefaults(room)
    const inherited = connections.configuration(room)
    const pool = connections.pool(room, inherited)
    try {
      expect(pool.configuration()).toEqual(inherited)
      const restored = new RelayConnections(saved, defaults)
      expect(restored.configuration(room, inherited.map(relay => relay.url))).toEqual(inherited)
      expect(restored.configuration(room, ['wss://updated.test'])).toEqual([{ url: 'wss://updated.test/', read: true, write: true }])
      restored.save(room, inherited)
      expect(restored.configuration(room, ['wss://updated.test'])).toEqual(inherited)
    } finally { pool.close() }
  })
  it('leaves existing configuration intact when persistence or permissions fail', () => {
    const saved = storage()
    const connections = new RelayConnections(saved, defaults)
    expect(() => connections.save(room, [{ url: 'wss://read.test', read: true, write: false }])).toThrow('writable')
    saved.setItem = () => { throw new Error('storage full') }
    expect(() => connections.save(room, [{ url: 'wss://other.test', read: true, write: true }])).toThrow('storage full')
    expect(connections.configuration(room)[0]!.url).toBe('wss://default.test/')
  })
  it('starts profiles enabled and honours a saved opt-out', () => {
    const saved = storage()
    expect(profilePreference(saved)).toBe(true)
    saved.setItem('kithmoot.profiles.enabled', 'false')
    expect(profilePreference(saved)).toBe(false)
    saved.setItem('kithmoot.profiles.enabled', 'true')
    expect(profilePreference(saved)).toBe(true)
  })
})

describe('a room\'s own relays', () => {
  const roomId = 'a'.repeat(64)
  const fixed = ['wss://room-a.test/', 'wss://room-b.test/']
  const mine = [{ url: 'wss://mine.test/', read: true, write: false }, { url: 'wss://room-a.test/', read: false, write: true }]

  it('come first, read and write, ahead of this device\'s saved list, which they never enter', () => {
    const saved = storage()
    const connections = new RelayConnections(saved, defaults)
    connections.save(room, mine)
    expect(connections.setRoomRelays(roomId, { fixed, signed: true })).toBe(true)
    expect(connections.configuration(room)).toEqual([
      { url: 'wss://room-a.test/', read: true, write: true },
      { url: 'wss://room-b.test/', read: true, write: true },
      { url: 'wss://mine.test/', read: true, write: false },
    ])
    expect(connections.personal(room)).toEqual(mine)
    expect(JSON.parse(saved.getItem('kithmoot.relays.v1')!)[room]).toEqual(mine)
    // Kept apart, and still there for the next visit.
    expect(JSON.parse(saved.getItem('kithmoot.room-relays-fixed.v1')!)).toEqual({ [roomId]: { c: fixed, signed: true } })
    expect(new RelayConnections(saved, defaults).configuration(room).map(relay => relay.url)).toEqual(['wss://room-a.test/', 'wss://room-b.test/', 'wss://mine.test/'])
    // Saving the room again saves only what the person chose.
    connections.save(room, connections.personal(room))
    expect(JSON.parse(saved.getItem('kithmoot.relays.v1')!)[room]).toEqual(mine)
  })

  it('are also used ahead of a link\'s hints and the defaults, and only for their own room', () => {
    const connections = new RelayConnections(storage(), defaults)
    connections.setRoomRelays(roomId, { fixed, signed: true })
    expect(connections.configuration(room, ['wss://hint.test']).map(relay => relay.url)).toEqual([...fixed, 'wss://hint.test/'])
    expect(connections.configuration(room).map(relay => relay.url)).toEqual([...fixed, 'wss://default.test/'])
    expect(connections.configuration(`room:${'b'.repeat(64)}`).map(relay => relay.url)).toEqual(['wss://default.test/'])
    expect(connections.configuration('default').map(relay => relay.url)).toEqual(['wss://default.test/'])
  })

  it('take a signed list over anything, and an unsigned one only when nothing is held', () => {
    const connections = new RelayConnections(storage(), defaults)
    expect(connections.setRoomRelays(roomId, { fixed: ['wss://link.test/'] })).toBe(true)
    expect(connections.setRoomRelays(roomId, { fixed: ['wss://other.test/'] })).toBe(false)
    expect(connections.roomRelays(roomId)).toEqual({ c: ['wss://link.test/'], signed: false })
    expect(connections.setRoomRelays(roomId, { fixed, signed: true })).toBe(true)
    expect(connections.setRoomRelays(roomId, { fixed: ['wss://link.test/'] })).toBe(false)
    expect(connections.roomRelays(roomId)).toEqual({ c: fixed, signed: true })
    // Not a list an invitation may carry: ignored, never trimmed.
    for (const bad of [[], ['wss://room-a.test'], ['ws://remote.test/'], Array.from({ length: 9 }, (_, i) => `wss://r${i}.test/`)]) {
      expect(connections.setRoomRelays(roomId, { fixed: bad, signed: true })).toBe(false)
    }
    expect(connections.roomRelays(roomId)).toEqual({ c: fixed, signed: true })
  })

  it('cut this device\'s own relays first when the pool is full, never their own', () => {
    const connections = new RelayConnections(storage(), defaults)
    const eight = Array.from({ length: 8 }, (_, i) => `wss://fixed${i}.test/`)
    const added = Array.from({ length: 8 }, (_, i) => `wss://added${i}.test/`)
    connections.save(room, Array.from({ length: 8 }, (_, i) => ({ url: `wss://mine${i}.test/`, read: true, write: true })))
    connections.setRoomRelays(roomId, { fixed: eight.slice(0, 4), signed: true })
    expect(connections.configuration(room).map(relay => relay.url)).toEqual([...eight.slice(0, 4), ...Array.from({ length: 8 }, (_, i) => `wss://mine${i}.test/`)])
    connections.setRoomRelays(roomId, { fixed: eight, signed: true, added })
    expect(connections.configuration(room).map(relay => relay.url)).toEqual([...eight, ...added])
    // A saved list is still held to eight.
    expect(() => connections.save(room, Array.from({ length: 9 }, (_, i) => ({ url: `wss://mine${i}.test/`, read: true, write: true })))).toThrow(/at most 8/)
  })

  it('an authority\'s op adds to them without touching the saved list or cutting it', () => {
    const saved = storage()
    const connections = new RelayConnections(saved, defaults)
    const own = Array.from({ length: 8 }, (_, i) => ({ url: `wss://mine${i}.test/`, read: true, write: true }))
    connections.save(room, own)
    connections.setRoomRelays(roomId, { fixed, signed: true })
    expect(connections.setRoomRelays(roomId, { added: ['wss://owner.test', 'wss://room-a.test/'] })).toBe(true)
    expect(connections.sharedRelays(roomId)).toEqual([...fixed, 'wss://owner.test/'])
    expect(connections.configuration(room).map(relay => relay.url)).toEqual([...fixed, 'wss://owner.test/', ...own.map(relay => relay.url)])
    expect(JSON.parse(saved.getItem('kithmoot.relays.v1')!)[room]).toEqual(own)
    expect(connections.setRoomRelays(roomId, { added: ['wss://owner.test/'] })).toBe(false)
  })

  it('say whether the maker took a snapshot of its defaults for the room', () => {
    const connections = new RelayConnections(storage(), defaults)
    expect(connections.inherits(room)).toBe(false)
    connections.inheritDefaults(room)
    expect(connections.inherits(room)).toBe(true)
    expect(connections.inherits('default')).toBe(false)
  })

  it('move every live pool for the room at once, and leave other rooms\' pools alone', () => {
    const connections = new RelayConnections(storage(), defaults)
    const pool = connections.pool(room, ['wss://hint.test'])
    const other = connections.pool(`room:${'b'.repeat(64)}`, ['wss://hint.test'])
    try {
      connections.setRoomRelays(roomId, { fixed, signed: true })
      expect(pool.configuration().map(relay => relay.url)).toEqual([...fixed, 'wss://hint.test/'])
      expect(other.configuration().map(relay => relay.url)).toEqual(['wss://hint.test/'])
      connections.setRoomRelays(roomId, { added: ['wss://owner.test/'] })
      expect(pool.configuration().map(relay => relay.url)).toEqual([...fixed, 'wss://owner.test/', 'wss://hint.test/'])
    } finally { pool.close(); other.close() }
  })
})

describe('the circle\'s relays', () => {
  it('marks a box known from a contact card on every configuration, never saves the mark, and moves it when the circle changes', () => {
    const saved = storage()
    const circle = new Set(['wss://box.test/'])
    const connections = new RelayConnections(saved, ['wss://default.test', 'wss://box.test'], url => circle.has(url))
    expect(connections.configuration('default')).toEqual([
      { url: 'wss://default.test/', read: true, write: true },
      { url: 'wss://box.test/', read: true, write: true, circle: true },
    ])
    // A saved preference claiming the mark does not get it: the mark is a fact about the relay.
    connections.save('default', [{ url: 'wss://default.test', read: true, write: true, circle: true }])
    expect(connections.configuration('default')).toEqual([{ url: 'wss://default.test/', read: true, write: true }])
    expect(JSON.parse(saved.getItem('kithmoot.relays.v1')!).default[0].circle).toBeUndefined()
    const pool = connections.pool(room, ['wss://box.test'])
    try {
      expect(pool.describe().map(r => r.circle)).toEqual([true])
      circle.clear()
      connections.circleChanged()
      expect(pool.describe().map(r => r.circle)).toEqual([undefined])
    } finally { pool.close() }
  })
})

describe('session-only relay identity permission', () => {
  const identity = { pubkey: 'd'.repeat(64), signEvent: async () => { throw new Error('no signature is requested by preferences') } }
  it('scopes permission to the chosen connection and never serialises it or inherits it from defaults', () => {
    const saved = storage(), connections = new RelayConnections(saved, defaults)
    const first = connections.pool(room), other = connections.pool(`room:${'b'.repeat(64)}`), account = connections.pool('default')
    try {
      connections.authenticate(room, defaults[0]!, identity)
      expect(first.health()[0]?.authentication).toBe('allowed')
      expect(other.health()[0]?.authentication).toBeUndefined()
      expect(account.health()[0]?.authentication).toBeUndefined()
      connections.authenticate('default', defaults[0]!, identity)
      connections.inheritDefaults(`room:${'c'.repeat(64)}`)
      expect(connections.authenticationIdentity(`room:${'c'.repeat(64)}`, 'wss://default.test/')).toBeUndefined()
      connections.save(room, connections.configuration(room))
      expect(saved.getItem('kithmoot.relays.v1')).not.toContain(identity.pubkey)
      expect(saved.getItem('kithmoot.relays.v1')).not.toContain('authentication')
      const restored = new RelayConnections(saved, defaults)
      expect(restored.authenticationIdentity(room, 'wss://default.test/')).toBeUndefined()
    } finally { first.close(); other.close(); account.close() }
  })
  it('withdraws permission from existing and future pools when the account changes', () => {
    const connections = new RelayConnections(storage(), defaults)
    const first = connections.pool(room)
    let later: ReturnType<RelayConnections['pool']> | undefined
    try {
      connections.authenticate(room, defaults[0]!, identity)
      connections.clearAuthentication()
      expect(first.health()[0]?.authentication).toBe('withdrawn')
      later = connections.pool(room)
      expect(later.health()[0]?.authentication).toBe('withdrawn')
      connections.reconnect(room)
      expect(first.health()[0]?.authentication).toBe('withdrawn')
      connections.authenticate(room, defaults[0]!, identity)
      expect(first.health()[0]?.authentication).toBe('allowed')
      expect(later.health()[0]?.authentication).toBe('allowed')
    } finally { first.close(); later?.close() }
  })
  it('forgets room permissions when an inherited default endpoint is removed', () => {
    const connections = new RelayConnections(storage(), defaults)
    connections.authenticate(room, defaults[0]!, identity)
    connections.save('default', [{ url: 'wss://other.test', read: true, write: true }])
    connections.save('default', [{ url: defaults[0]!, read: true, write: true }])
    expect(connections.authenticationIdentity(room, 'wss://default.test/')).toBeUndefined()
    const recreated = connections.pool(room)
    try { expect(recreated.health()[0]?.authentication).toBeUndefined() } finally { recreated.close() }
  })
  it('does not restore a grant when a removed endpoint is added again', () => {
    const connections = new RelayConnections(storage(), defaults)
    connections.authenticate(room, defaults[0]!, identity)
    connections.save(room, [{ url: 'wss://other.test', read: true, write: true }])
    connections.save(room, [{ url: defaults[0]!, read: true, write: true }])
    expect(connections.authenticationIdentity(room, 'wss://default.test/')).toBeUndefined()
    expect(() => connections.authenticate(room, 'wss://invitation-only.test', identity)).toThrow('Apply this relay')
  })
})

describe('scheduled liveness probing', () => {
  // `NostrRelayPool` no longer lets nostr-tools' own ping close a
  // subscription out from under it (see relay-pool.ts): this is what runs in
  // its place, on `RelayConnections`' own clock.
  const probeDefaults = ['wss://probe-a.test']

  it('reconnects a relay that has stopped answering within about two intervals, and its subscription hears events again', async () => {
    vi.useFakeTimers()
    try {
      resetFakeRelays()
      const relay = fakeRelay(probeDefaults[0]!)
      const connections = new RelayConnections(storage(), probeDefaults, undefined, { intervalMs: 1_000, visible: () => true })
      const pool = connections.pool('default')
      try {
        const seen: string[] = []
        pool.subscribe([{ kinds: [1] }], event => seen.push(event.id))
        await vi.advanceTimersByTimeAsync(1)
        relay.silent = true
        const missed = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' }, generateSecretKey())
        relay.seed(missed)
        // Interval + the largest possible jitter (half the interval), twice
        // over, comfortably covers "within about two intervals" even at the
        // unluckiest jitter draw.
        await vi.advanceTimersByTimeAsync(3_000)
        relay.silent = false
        await vi.advanceTimersByTimeAsync(3_000)
        expect(seen).toContain(missed.id)
      } finally { pool.close() }
    } finally { vi.useRealTimers() }
  })

  it('does not probe while the tab is hidden', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      resetFakeRelays()
      const relay = fakeRelay(probeDefaults[0]!)
      let hidden = true
      const connections = new RelayConnections(storage(), probeDefaults, undefined, { intervalMs: 1_000, visible: () => !hidden })
      const pool = connections.pool('default')
      try {
        pool.subscribe([{ kinds: [1] }], () => {})
        await vi.advanceTimersByTimeAsync(1)
        const before = relay.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
        await vi.advanceTimersByTimeAsync(5_000)
        expect(relay.frames.filter(frame => JSON.parse(frame)[0] === 'REQ')).toHaveLength(before)
        hidden = false
        // Jitter is mocked to 0, so the next tick lands exactly on the
        // interval: no need to wait out a whole extra cycle to see it fire.
        await vi.advanceTimersByTimeAsync(1_000)
        expect(relay.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length).toBeGreaterThan(before)
      } finally { pool.close() }
    } finally { random.mockRestore(); vi.useRealTimers() }
  })

  it('spreads several pools apart instead of probing them all in the same tick', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random')
    try {
      resetFakeRelays()
      const relayA = fakeRelay('wss://probe-a.test')
      const relayB = fakeRelay('wss://probe-b.test')
      random.mockReturnValueOnce(0).mockReturnValueOnce(1)
      const connections = new RelayConnections(storage(), [], undefined, { intervalMs: 1_000, visible: () => true })
      const poolA = connections.pool('default', ['wss://probe-a.test'])
      const poolB = connections.pool('room:' + 'a'.repeat(64), ['wss://probe-b.test'])
      try {
        poolA.subscribe([{ kinds: [1] }], () => {})
        poolB.subscribe([{ kinds: [1] }], () => {})
        await vi.advanceTimersByTimeAsync(1)
        const beforeA = relayA.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
        const beforeB = relayB.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
        // A's jitter is 0: it probes at exactly the interval. B's jitter is
        // the maximum half-interval: it has not, yet.
        await vi.advanceTimersByTimeAsync(1_000)
        expect(relayA.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length).toBeGreaterThan(beforeA)
        expect(relayB.frames.filter(frame => JSON.parse(frame)[0] === 'REQ')).toHaveLength(beforeB)
        await vi.advanceTimersByTimeAsync(500)
        expect(relayB.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length).toBeGreaterThan(beforeB)
      } finally { poolA.close(); poolB.close() }
    } finally { random.mockRestore(); vi.useRealTimers() }
  })
})

describe('relay health', () => {
  it('reports a relay that accepted chat and did not return it, for the room it was seen in', async () => {
    vi.useFakeTimers()
    resetFakeRelays()
    const kept = fakeRelay('wss://kept.test')
    const dropped = fakeRelay('wss://dropped.test'); dropped.forgetful = true
    const connections = new RelayConnections(storage(), defaults)
    const hints = ['wss://kept.test', 'wss://dropped.test']
    const pool = connections.pool(room, hints)
    try {
      await pool.publish(finalizeEvent({ kind: 1460, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' }, generateSecretKey()))
      await vi.advanceTimersByTimeAsync(4_000)
      const health = connections.health(room, hints)
      expect(health.find(r => r.url === 'wss://kept.test/')?.unreturned).toBeUndefined()
      expect(health.find(r => r.url === 'wss://dropped.test/')?.unreturned).toEqual([1460])
      expect(kept.stored).toHaveLength(1)
      expect(connections.health('default').every(r => r.unreturned === undefined)).toBe(true)
    } finally { pool.close(); vi.useRealTimers() }
  })
})

describe('pools shared by everyone asking for the same relays', () => {
  // Each feature used to get a pool of its own: signing in alone held three
  // sockets to every default relay, and the room on screen two to each of
  // its own. Public relays count sockets per address.
  const url = 'wss://shared.test'
  const event = () => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' }, generateSecretKey())

  it('opens one socket for every caller of the same scope, and ends each caller\'s subscriptions with it', async () => {
    vi.useFakeTimers()
    try {
      resetFakeRelays()
      const relay = fakeRelay(url)
      const connections = new RelayConnections(storage(), [url], undefined, { intervalMs: 60_000, visible: () => true })
      const first = connections.pool('default'), second = connections.pool('default')
      const heard: string[][] = [[], []]
      first.subscribe([{ kinds: [1] }], e => heard[0]!.push(e.id))
      second.subscribe([{ kinds: [1] }], e => heard[1]!.push(e.id))
      await vi.advanceTimersByTimeAsync(10)
      expect(relay.connections).toBe(1)
      first.close()
      expect(first.closed).toBe(true); expect(second.closed).toBe(false)
      await expect(first.publish(event())).rejects.toThrow('pool is closed')
      expect(() => first.subscribe([{ kinds: [1] }], () => {})).toThrow('pool is closed')
      const live = event()
      await second.publish(live)
      await vi.advanceTimersByTimeAsync(10)
      expect(heard[1]).toEqual([live.id]); expect(heard[0]).toEqual([])
      first.close()
      expect(relay.connections).toBe(1)
      second.close()
      await vi.advanceTimersByTimeAsync(10)
      expect(relay.connections).toBe(0)
      const again = connections.pool('default')
      expect(again.closed).toBe(false)
      again.close()
    } finally { vi.useRealTimers() }
  })

  it('keeps a pool apart for another scope or other hints', async () => {
    vi.useFakeTimers()
    try {
      resetFakeRelays()
      const relay = fakeRelay(url)
      const connections = new RelayConnections(storage(), [url], undefined, { intervalMs: 60_000, visible: () => true })
      const pools = [connections.pool('default'), connections.pool(room, [url]), connections.pool(room, [url, 'wss://other.test']), connections.pool(room, [`${url}/`])]
      for (const pool of pools) pool.subscribe([{ kinds: [1] }], () => {})
      await vi.advanceTimersByTimeAsync(10)
      // The last asks for the same relay as the second, written differently.
      expect(relay.connections).toBe(3)
      for (const pool of pools) pool.close()
    } finally { vi.useRealTimers() }
  })

  it('moves a shared room pool once, and every holder sees it', () => {
    const connections = new RelayConnections(storage(), defaults)
    const roomId = 'a'.repeat(64), fixed = ['wss://room-a.test/', 'wss://room-b.test/']
    const session = connections.pool(room, ['wss://hint.test']), watch = connections.pool(room, ['wss://hint.test'])
    try {
      connections.setRoomRelays(roomId, { fixed, signed: true })
      expect(session.configuration().map(relay => relay.url)).toEqual([...fixed, 'wss://hint.test/'])
      expect(watch.configuration()).toEqual(session.configuration())
    } finally { session.close(); watch.close() }
  })
})
