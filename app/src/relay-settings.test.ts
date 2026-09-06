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
    const inherited = connections.configuration(room)
    const pool = connections.pool(room, inherited)
    try { expect(pool.configuration()).toEqual(inherited) } finally { pool.close() }
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
