import { describe, expect, it } from 'vitest'
import { relayOnlyIceConfiguration } from './relay-only.js'

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
})
