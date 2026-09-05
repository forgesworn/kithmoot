import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { roomProject, setRoomProject, projectKey } from './room-projects.js'

describe('personal room projects', () => {
  it('keeps visitor and different accounts separate for the same room', () => {
    const store = memoryDeviceStore()
    setRoomProject(store, undefined, 'room', 'Personal')
    setRoomProject(store, 'account-a', 'room', 'Work')
    expect(roomProject(store, undefined, 'room')).toBe('Personal')
    expect(roomProject(store, 'account-a', 'room')).toBe('Work')
    expect(roomProject(store, 'account-b', 'room')).toBeUndefined()
    setRoomProject(store, 'account-a', 'room', '')
    expect(roomProject(store, 'account-a', 'room')).toBeUndefined()
    expect(roomProject(store, undefined, 'room')).toBe('Personal')
  })

  it('bounds and sanitises labels read from storage as well as user input', () => {
    const store = memoryDeviceStore()
    store.set(projectKey(undefined, 'room'), '  Work\u202e\u0000  ')
    expect(roomProject(store, undefined, 'room')).toBe('Work')
    setRoomProject(store, undefined, 'room', 'x'.repeat(1000))
    expect(roomProject(store, undefined, 'room')!.length).toBeLessThanOrEqual(64)
  })
})
