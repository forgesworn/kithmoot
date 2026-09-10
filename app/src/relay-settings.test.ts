import { describe, expect, it } from 'vitest'
import { RelayConnections, profilePreference } from './relay-settings.js'

const defaults = ['wss://default.test']
const room = `room:${'a'.repeat(64)}`
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('device relay preferences', () => {
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
