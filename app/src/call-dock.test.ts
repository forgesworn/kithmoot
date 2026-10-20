import { describe, expect, it } from 'vitest'
import { callElapsed, dockLabel, dockSummary, switchIntent } from './call-dock.js'

describe('switchIntent', () => {
  it('closes and opens rooms as before when there is no call', () => {
    expect(switchIntent({ onCall: false, destination: 'b' })).toBe('plain')
  })
  it('docks a call instead of leaving it', () => {
    expect(switchIntent({ onCall: true, destination: 'b' })).toBe('dock')
  })
  it('keeps the dock while hopping between other rooms', () => {
    expect(switchIntent({ onCall: true, dockedRoomId: 'a', destination: 'c' })).toBe('hop')
  })
  it('undocks on the way back to the call room', () => {
    expect(switchIntent({ onCall: true, dockedRoomId: 'a', destination: 'a' })).toBe('undock')
  })
})

describe('dockSummary', () => {
  it('names the room and the people on the call', () => {
    expect(dockSummary('Town hall', [])).toBe('On a call in Town hall. Just you.')
    expect(dockSummary('Town hall', ['Bo'])).toBe('On a call in Town hall with Bo.')
    expect(dockSummary('Town hall', ['Bo', 'Cam', 'Di', 'Ed', 'Flo'])).toBe('On a call in Town hall with Bo, Cam, Di and 2 more.')
  })
})

describe('dockLabel', () => {
  it('says where the call is, and nothing about the time', () => {
    expect(dockLabel('Release workshop')).toBe('On a call in Release workshop')
  })
})

describe('callElapsed', () => {
  it('reads as minutes and seconds, then hours', () => {
    expect(callElapsed(1000, 1000)).toBe('00:00')
    expect(callElapsed(1000, 1000 + 12 * 60 + 3)).toBe('12:03')
    expect(callElapsed(1000, 1000 + 3600 + 2 * 60 + 3)).toBe('1:02:03')
  })
  it('never goes below zero when the clock is behind the call', () => {
    expect(callElapsed(2000, 1990)).toBe('00:00')
  })
})
