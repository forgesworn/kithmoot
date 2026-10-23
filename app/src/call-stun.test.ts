import { describe, expect, it } from 'vitest'
import { CALL_STUN_FORMAT_ERROR, CALL_STUN_KEY, loadCallStun, parseCallStun, saveCallStun, withDeviceStun } from './call-stun.js'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

describe('parseCallStun', () => {
  it('reads blank as "use the default"', () => {
    expect(parseCallStun('')).toBeUndefined()
    expect(parseCallStun(' , ,')).toBeUndefined()
  })

  it('accepts plain stun: addresses, with or without a port, and IPv6', () => {
    expect(parseCallStun('stun:stun.example.org:3478, STUN:Home.Example')).toEqual(['stun:stun.example.org:3478', 'stun:home.example'])
    expect(parseCallStun('stun:[2001:db8::1]:3478')).toEqual(['stun:[2001:db8::1]:3478'])
  })

  it('drops repeats', () => {
    expect(parseCallStun('stun:a.example, stun:a.example')).toEqual(['stun:a.example'])
  })

  it('refuses relays, stuns:, logins, queries and bad ports', () => {
    for (const bad of ['turn:relay.example:3478', 'stuns:stun.example:5349', 'stun:user@stun.example', 'stun:stun.example:3478?transport=tcp',
      'stun:stun.example:0', 'stun:stun.example:70000', 'https://stun.example', 'stun:', 'stun:-bad.example']) {
      expect(() => parseCallStun(bad), bad).toThrow(CALL_STUN_FORMAT_ERROR)
    }
  })

  it('caps the list', () => {
    expect(() => parseCallStun('stun:a.example, stun:b.example, stun:c.example, stun:d.example, stun:e.example')).toThrow(/up to 4/)
  })
})

describe('saving and loading', () => {
  it('round-trips and removes', () => {
    const store = memoryStore()
    saveCallStun(store, ['stun:home.example:3478'])
    expect(loadCallStun(store)).toEqual(['stun:home.example:3478'])
    saveCallStun(store, undefined)
    expect(store.data.has(CALL_STUN_KEY)).toBe(false)
    expect(loadCallStun(store)).toBeUndefined()
  })

  it('ignores a saved value that no longer parses, so the default applies', () => {
    expect(loadCallStun(memoryStore({ [CALL_STUN_KEY]: '["turn:relay.example"]' }))).toBeUndefined()
    expect(loadCallStun(memoryStore({ [CALL_STUN_KEY]: 'not json' }))).toBeUndefined()
    expect(loadCallStun(memoryStore({ [CALL_STUN_KEY]: '{"urls":[]}' }))).toBeUndefined()
  })

  it('survives storage that throws', () => {
    expect(loadCallStun({ getItem: () => { throw new Error('blocked') } })).toBeUndefined()
  })
})

describe('withDeviceStun', () => {
  const relay: RTCIceServer = { urls: ['turn:relay.example:3478', 'turns:relay.example:5349'], username: 'u', credential: 'c' }

  it('leaves the list alone when nothing is chosen', () => {
    const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }, relay]
    expect(withDeviceStun(servers, undefined)).toBe(servers)
  })

  it('replaces the default and any room or relay-derived STUN, keeping the relay and its login', () => {
    const servers: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: ['stun:relay.example:3478', 'stuns:x.example'] }, relay]
    expect(withDeviceStun(servers, ['stun:home.example:3478'])).toEqual([{ urls: ['stun:home.example:3478'] }, relay])
  })

  it('removes STUN from a mixed entry without touching its relay URLs', () => {
    const mixed: RTCIceServer = { urls: ['stun:relay.example:3478', 'turn:relay.example:3478'], username: 'u', credential: 'c' }
    expect(withDeviceStun([mixed], ['stun:home.example'])).toEqual([
      { urls: ['stun:home.example'] },
      { urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' },
    ])
  })

  it('applies when the call had no STUN at all', () => {
    expect(withDeviceStun([], ['stun:home.example'])).toEqual([{ urls: ['stun:home.example'] }])
  })
})
