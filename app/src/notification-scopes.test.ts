import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { notificationMode, roomNotificationsEnabled, setNotificationMode } from './notification-scopes.js'

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
