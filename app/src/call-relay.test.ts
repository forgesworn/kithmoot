import { describe, expect, it } from 'vitest'
import { CALL_RELAY_KEY, callRelayPeerConnection, callRelaySetConfiguration, callRelayServers, loadCallRelay, parseCallRelay, saveCallRelay } from './call-relay.js'
import { resolveIceServers } from './ice-resolve.js'

const relay = parseCallRelay('turn:relay.example:3478, turns:relay.example:5349', 'friend', 'test-secret')!

describe('a device-owned call relay', () => {
  it('uses credentials only with the explicitly configured hosts, even for an existing room', async () => {
    const result = await resolveIceServers(['turn:untrusted-room.example:3478'], {
      relay, endpoint: '/turn', location: { protocol: 'https:', hostname: 'site.example' },
      fetch: async () => { throw new Error('must not fetch the retired mint') },
    })
    expect(result).toEqual([{ urls: 'stun:relay.example:3478' }, { urls: relay.urls, username: 'friend', credential: 'test-secret' }])
    expect(JSON.stringify(result)).not.toContain('untrusted-room')
  })
  it('round trips device storage and removes credentials explicitly', () => {
    const values = new Map<string, string>()
    const store = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    expect(loadCallRelay(store)).toBeUndefined()
    saveCallRelay(store, relay)
    expect(loadCallRelay(store)).toEqual(relay)
    saveCallRelay(store, undefined)
    expect(values.has(CALL_RELAY_KEY)).toBe(false)
  })
  it('accepts IPv6, ports, UDP, TCP and TLS', () => {
    expect(parseCallRelay('turn:[2001:db8::1]:3478?transport=tcp,turns:relay.example:443?transport=tcp', 'u', 'p')?.urls).toHaveLength(2)
  })
  it('normalises case so the relay-only and routing checks recognise the scheme', () => {
    expect(parseCallRelay('TURN:Relay.Example:3478?transport=TCP', 'u', 'p')?.urls).toEqual(['turn:relay.example:3478?transport=tcp'])
  })
  it('preserves TURN TCP on browsers that support it', () => {
    const configuration = { iceServers: [{ urls: 'turn:relay.example:3478?transport=tcp', username: 'u', credential: 'p' }] }
    callRelayPeerConnection(configuration, config => { expect(config).toBe(configuration); return {} as RTCPeerConnection })
  })
  it('retries WebKit syntax rejection with the same authenticated UDP and TLS hosts and privacy policy', () => {
    let calls = 0
    const config: RTCConfiguration = { iceTransportPolicy: 'relay', iceServers: [{
      urls: ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:5349'], username: 'u', credential: 'p',
    }] }
    callRelayPeerConnection(config, next => {
      if (++calls === 1) throw new DOMException('unsupported URI', 'SyntaxError')
      expect(next).toEqual({ ...config, iceServers: [{ ...config.iceServers![0], urls: ['turn:relay.example:3478', 'turns:relay.example:5349'] }] })
      return {} as RTCPeerConnection
    })
    expect(calls).toBe(2)
  })
  it('refuses an unsupported TCP-only relay and does not mask unrelated errors', () => {
    const config = { iceServers: [{ urls: 'turn:relay.example:3478?transport=tcp', username: 'u', credential: 'p' }] }
    expect(() => callRelayPeerConnection(config, () => { throw new DOMException('unsupported URI', 'SyntaxError') })).toThrow('Plain TURN over TCP is unsupported')
    expect(() => callRelayPeerConnection(config, () => { throw new Error('other failure') })).toThrow('other failure')
  })
  it('returns independent URL arrays for each connection', () => {
    const first = callRelayServers(relay)
    ;(first.at(-1)!.urls as string[]).push('turn:other.example:3478')
    expect(relay.urls).toHaveLength(2)
  })
  for (const address of ['https://relay.example', 'turn:user:password@relay.example:3478', 'turn:relay.example:0',
    'turn:relay.example:65536', 'turn:relay.example/path', 'turn:relay.example#fragment', 'turns:relay.example?transport=udp', 'stun:relay.example:3478']) {
    it(`rejects an invalid relay address (${address}) without echoing credentials`, () => {
      expect(() => parseCallRelay(address, 'u', 'test-secret')).toThrow()
      try { parseCallRelay(address, 'u', 'test-secret') } catch (error) { expect(String(error)).not.toContain('test-secret') }
    })
  }
  it('rejects partial settings and refuses corrupt storage without silently falling back', () => {
    expect(() => parseCallRelay('turn:relay.example', '', 'p')).toThrow()
    expect(() => parseCallRelay('', 'u', 'p')).toThrow()
    expect(() => parseCallRelay('turn:relay.example', 'u', 'p\n')).toThrow()
    expect(parseCallRelay('', '', '')).toBeUndefined()
    for (const text of ['{test-secret', '{"urls":[],"username":"u","credential":"test-secret"}', 'x'.repeat(16385)]) {
      expect(() => loadCallRelay({ getItem: () => text })).toThrow("The saved relay server can't be read.")
    }
  })
})

describe('renewing a live connection', () => {
  it('goes through the same WebKit TURN/TCP filter', () => {
    const config = { iceServers: [{ urls: ['turn:relay.example.org:3478?transport=udp', 'turn:relay.example.org:3478?transport=tcp'], username: 'u', credential: 'p' }] }
    const applied: RTCConfiguration[] = []
    const pc = { setConfiguration(next: RTCConfiguration) {
      if ((next.iceServers ?? []).some(server => [server.urls].flat().some(url => url.endsWith('transport=tcp')))) throw new DOMException('unsupported URI', 'SyntaxError')
      applied.push(next)
    } }
    callRelaySetConfiguration(pc, config)
    expect(applied).toEqual([{ iceServers: [{ urls: ['turn:relay.example.org:3478?transport=udp'], username: 'u', credential: 'p' }] }])
    expect(() => callRelaySetConfiguration({ setConfiguration() { throw new Error('closed') } }, config)).toThrow('closed')
  })
})
