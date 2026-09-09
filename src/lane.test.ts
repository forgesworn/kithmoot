import { describe, it, expect } from 'vitest'
import { isDowngrade, isLane, laneOfRelayUrl, laneOfRelays, weakestLane, LANE_MEANING, LANES } from './lane.js'

describe('lane', () => {
  it('classifies an onion relay as sheltered and everything else as public', () => {
    expect(laneOfRelayUrl('wss://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567.onion')).toBe('sheltered')
    expect(laneOfRelayUrl('ws://xyz.onion:8080')).toBe('sheltered')
    expect(laneOfRelayUrl('wss://relay.damus.io')).toBe('public')
    expect(laneOfRelayUrl('wss://onion.example.com')).toBe('public')
    expect(laneOfRelayUrl('not a url')).toBe('public')
  })
  it('a set of relays is as weak as its weakest', () => {
    expect(laneOfRelays(['wss://a.onion', 'wss://relay.example'])).toBe('public')
    expect(laneOfRelays(['wss://a.onion', 'wss://b.onion'])).toBe('sheltered')
    expect(laneOfRelays([])).toBeUndefined()
    expect(weakestLane(['direct', 'sheltered'])).toBe('sheltered')
    expect(weakestLane(['direct'])).toBe('direct')
  })
  it('knows a downgrade from a match', () => {
    expect(isDowngrade('sheltered', 'public')).toBe(true)
    expect(isDowngrade('direct', 'sheltered')).toBe(true)
    expect(isDowngrade('public', 'sheltered')).toBe(false)
    expect(isDowngrade('public', 'public')).toBe(false)
  })
  it('every state has a fixed meaning and nothing else is a lane', () => {
    for (const lane of LANES) expect(LANE_MEANING[lane].length).toBeGreaterThan(10)
    expect(isLane('sheltered')).toBe(true)
    expect(isLane('private')).toBe(false)
  })
})
