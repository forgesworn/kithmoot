import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { MUTE_FOR, MUTE_PREFIX, muteRoom, nextMuteEnd, notificationMode, pruneMutes, roomMute, roomNotificationLevel, roomNotificationsEnabled, setNotificationMode, unmuteRoom } from './notification-scopes.js'

describe('project and room notifications', () => {
  it('inherits defaults, then projects, then explicit room overrides', () => {
    const store = memoryDeviceStore()
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Work')).toBe(true)
    setNotificationMode(store, 'alice', { kind: 'default' }, 'off')
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Work')).toBe(false)
    setNotificationMode(store, 'alice', { kind: 'project', id: 'Work' }, 'all')
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Work')).toBe(true)
    setNotificationMode(store, 'alice', { kind: 'room', id: 'room' }, 'off')
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Work')).toBe(false)
    setNotificationMode(store, 'alice', { kind: 'room', id: 'room' }, 'inherit')
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Work')).toBe(true)
    expect(roomNotificationsEnabled(store, 'alice', 'room', 'Elsewhere')).toBe(false)
  })
  it('mutes overlapping projects deterministically, with an explicit room opt-in', () => {
    const store = memoryDeviceStore()
    setNotificationMode(store, 'alice', { kind: 'project', id: 'shared:a' }, 'all')
    setNotificationMode(store, 'alice', { kind: 'project', id: 'shared:b' }, 'off')
    expect(roomNotificationsEnabled(store, 'alice', 'room', ['shared:a', 'shared:b'])).toBe(false)
    expect(roomNotificationsEnabled(store, 'alice', 'room', ['shared:b', 'shared:a'])).toBe(false)
    setNotificationMode(store, 'alice', { kind: 'room', id: 'room' }, 'all')
    expect(roomNotificationsEnabled(store, 'alice', 'room', ['shared:a', 'shared:b'])).toBe(true)
  })
  it('separates accounts and identically named rooms and projects', () => {
    const store = memoryDeviceStore()
    setNotificationMode(store, 'alice', { kind: 'project', id: 'same' }, 'off')
    expect(notificationMode(store, 'alice', { kind: 'room', id: 'same' })).toBe('inherit')
    expect(roomNotificationsEnabled(store, 'bob', 'room', 'same')).toBe(true)
    expect(roomNotificationsEnabled(store, undefined, 'room', 'same')).toBe(true)
  })
})

describe('timed mutes', () => {
  const NOW = 1_800_000_000
  const room = 'a'.repeat(64)
  it('reads a room set to Nothing as muted with no end', () => {
    const store = memoryDeviceStore()
    expect(roomMute(store, 'alice', room, NOW)).toBeUndefined()
    setNotificationMode(store, 'alice', { kind: 'room', id: room }, 'off')
    expect(roomMute(store, 'alice', room, NOW)).toBe('always')
  })
  it('holds a timed mute until its end and not after', () => {
    const store = memoryDeviceStore()
    muteRoom(store, undefined, room, NOW + 3600)
    expect(store.get(`kithmoot.mute-until.v1.visitor.${room}`)).toBe(String(NOW + 3600))
    expect(roomMute(store, undefined, room, NOW)).toEqual({ until: NOW + 3600 })
    expect(roomMute(store, undefined, room, NOW + 3599)).toEqual({ until: NOW + 3600 })
    expect(roomMute(store, undefined, room, NOW + 3600)).toBeUndefined()
    expect(roomMute(store, 'alice', room, NOW)).toBeUndefined()
  })
  it('keeps the mode when a mute is taken off, and drops the mute when Nothing is chosen', () => {
    const store = memoryDeviceStore()
    setNotificationMode(store, 'alice', { kind: 'room', id: room }, 'all')
    muteRoom(store, 'alice', room, NOW + 60)
    expect(roomNotificationLevel(store, 'alice', room, undefined, NOW)).toBe('off')
    expect(roomNotificationLevel(store, 'alice', room, undefined, NOW + 60)).toBe('all')
    muteRoom(store, 'alice', room, NOW + 60)
    unmuteRoom(store, 'alice', room)
    expect(roomNotificationLevel(store, 'alice', room, undefined, NOW)).toBe('all')
    muteRoom(store, 'alice', room, NOW + 60)
    setNotificationMode(store, 'alice', { kind: 'room', id: room }, 'off')
    expect(store.keys().filter(name => name.startsWith(MUTE_PREFIX))).toEqual([])
  })
  it('is off while muted whatever the mode, and a project or default Nothing is not a mute', () => {
    const store = memoryDeviceStore()
    setNotificationMode(store, 'alice', { kind: 'room', id: room }, 'all')
    muteRoom(store, 'alice', room, NOW + 60)
    expect(roomNotificationsEnabled(store, 'alice', room, undefined, NOW)).toBe(false)
    const other = 'b'.repeat(64)
    setNotificationMode(store, 'alice', { kind: 'project', id: 'Work' }, 'off')
    expect(roomNotificationLevel(store, 'alice', other, 'Work', NOW)).toBe('off')
    expect(roomMute(store, 'alice', other, NOW)).toBeUndefined()
  })
  it('prunes only ended mutes, for any account, and finds the soonest end', () => {
    const store = memoryDeviceStore()
    const other = 'b'.repeat(64), account = 'c'.repeat(64)
    muteRoom(store, undefined, room, NOW - 5)
    muteRoom(store, account, room, NOW + 500)
    muteRoom(store, undefined, other, NOW + 100)
    store.set(`kithmoot.mute-until.v1.visitor.${'d'.repeat(64)}`, 'soon')
    expect(nextMuteEnd(store, NOW)).toBe(NOW + 100)
    pruneMutes(store, NOW)
    expect(store.keys().filter(name => name.startsWith(MUTE_PREFIX)).sort()).toEqual([
      `kithmoot.mute-until.v1.${account}.${room}`, `kithmoot.mute-until.v1.visitor.${other}`,
    ].sort())
    expect(nextMuteEnd(store, NOW + 600)).toBeUndefined()
  })
  it('lasts for the four lengths', () => {
    expect(MUTE_FOR).toEqual({ '1h': 3600, '8h': 28800, '1d': 86400, '1w': 604800 })
  })
})
