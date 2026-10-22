import { describe, expect, it } from 'vitest'
import { RELAY_ONLY_NO_RELAY, relayOnlyAvailable, relayOnlyIceConfiguration } from './relay-only.js'

describe('relayOnlyIceConfiguration', () => {
  it('uses credentialed TURN URLs only and requires relay candidates', () => {
    const config = relayOnlyIceConfiguration([
      { urls: 'stun:room.example:3478' },
      {
        urls: ['stun:room.example:3478', 'turn:room.example:3478', 'turns:room.example:5349'],
        username: 'time-bound-user',
        credential: 'time-bound-password',
      },
    ])

    expect(config.iceTransportPolicy).toBe('relay')
    expect(config.iceServers).toEqual([{
      urls: ['turn:room.example:3478', 'turns:room.example:5349'],
      username: 'time-bound-user',
      credential: 'time-bound-password',
    }])
  })

  it('refuses a direct fallback when TURN has no usable credential', () => {
    expect(() => relayOnlyIceConfiguration([
      { urls: 'stun:room.example:3478' },
      { urls: 'turn:room.example:3478' },
    ])).toThrow('no usable TURN relay')
  })

  it('lets a room be joined with no relay, and says calls are refused', () => {
    // Joining only asks whether a relay exists; it does not throw.
    const none: RTCIceServer[] = [{ urls: 'stun:room.example:3478' }]
    expect(() => relayOnlyAvailable(none)).not.toThrow()
    expect(relayOnlyAvailable(none)).toBe(false)
    expect(relayOnlyAvailable([])).toBe(false)
    expect(relayOnlyAvailable([{ urls: 'turn:r.example:3478', username: 'u', credential: 'c' }])).toBe(true)
  })

  it('refuses a call with the existing message and never offers non-relay servers', () => {
    const servers: RTCIceServer[] = [{ urls: 'stun:room.example:3478' }, { urls: 'turn:room.example:3478' }]
    expect(() => relayOnlyIceConfiguration(servers)).toThrow(RELAY_ONLY_NO_RELAY)
    expect(RELAY_ONLY_NO_RELAY).toContain('Turn off \u201cHide my IP address\u201d')
    const ok = relayOnlyIceConfiguration([...servers, { urls: ['stun:x:1', 'turn:x:1'], username: 'u', credential: 'c' }])
    expect(ok.iceTransportPolicy).toBe('relay')
    for (const server of ok.iceServers ?? []) for (const url of [server.urls].flat()) expect(url).toMatch(/^turns?:/)
  })
})
