import { describe, expect, it } from 'vitest'
import { INVALID_CALL_RELAY_PROFILE, parseCallRelayProfile } from './call-relay-profile.js'

const login = { urls: ['turns:relay.example:443?transport=tcp'], username: 'device', credential: 'synthetic-password' }

describe('provider-supplied call relay files', () => {
  it('accepts one RTCIceServer login without discarding transport or auth', () => {
    expect(parseCallRelayProfile(JSON.stringify(login))).toEqual(login)
    expect(parseCallRelayProfile(JSON.stringify({ ...login, urls: login.urls[0], credentialType: 'password' }))).toEqual(login)
  })
  it('normalises URL case through the existing device relay validator', () => {
    expect(parseCallRelayProfile(JSON.stringify({ ...login, urls: 'TURNS:RELAY.EXAMPLE:443?transport=TCP' }))).toEqual(login)
  })
  const invalid = [
    'null', '[]', '{"credential":"synthetic-password"', ' '.repeat(16_385),
    { ...login, apiKey: 'synthetic-root-key' }, { ...login, secret: 'synthetic-root-key' },
    { ...login, expiresAt: 1 }, { ...login, credentialType: 'oauth' },
    { ...login, urls: ['stun:relay.example'] }, { ...login, urls: ['turns:user:pass@relay.example'] },
    { ...login, urls: ['turns:relay.example, turns:other.example'] },
    { ...login, urls: ['https://provider.example/credentials'] },
    { ...login, username: '' }, { ...login, credential: 'password\n' },
    { iceServers: [login] }, { ...login, urls: new Array(9).fill(login.urls[0]) },
  ]
  for (const [index, value] of invalid.entries()) it(`rejects unsupported or unsafe input ${index} without exposing it`, () => {
    expect(() => parseCallRelayProfile(typeof value === 'string' ? value : JSON.stringify(value))).toThrow(INVALID_CALL_RELAY_PROFILE)
  })
})
