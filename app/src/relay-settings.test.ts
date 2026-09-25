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
