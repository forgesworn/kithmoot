// Same shape as desktop-chat-drawer.test.ts next door, and for the same
// reason: no jsdom in this workspace's vitest config, so `wrapRail`'s DOM
// surgery and the collapse itself are proven in the browser by
// test/desktop-room-layout.spec.ts. What is tested here is the storage
// round-trip and the wording of the total the slim rail carries.
import { expect, test } from 'vitest'
import { loadRailOpen, railUnreadDescription, railUnreadLabel, saveRailOpen } from './desktop-projects-rail.js'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

test('the rail is shown until this device says otherwise', () => {
  expect(loadRailOpen(memoryStorage(), true)).toBe(true)
  expect(loadRailOpen(memoryStorage(), false)).toBe(false)
})

test('saveRailOpen and loadRailOpen round-trip', () => {
  const storage = memoryStorage()
  saveRailOpen(storage, false)
  expect(loadRailOpen(storage, true)).toBe(false)
  saveRailOpen(storage, true)
  expect(loadRailOpen(storage, false)).toBe(true)
})

test('the rail does not depend on storage working', () => {
  const blocked = { getItem: () => { throw new Error('blocked') } } as unknown as Storage
  expect(loadRailOpen(blocked, true)).toBe(true)
  expect(loadRailOpen(blocked, false)).toBe(false)
  const full = { setItem: () => { throw new Error('quota') } } as unknown as Storage
  expect(() => saveRailOpen(full, false)).not.toThrow()
})

test('the chat drawer and the rail remember themselves separately', () => {
  const storage = memoryStorage()
  saveRailOpen(storage, false)
  expect(storage.getItem('kithmoot.desktopChatDrawerOpen')).toBe(null)
})

test('nothing new says nothing at all', () => {
  expect(railUnreadLabel(0)).toBe('')
  expect(railUnreadLabel(-3)).toBe('')
  expect(railUnreadLabel(Number.NaN)).toBe('')
})

test('the total is capped so it fits a 3.5rem rail', () => {
  expect(railUnreadLabel(1)).toBe('1')
  expect(railUnreadLabel(99)).toBe('99')
  expect(railUnreadLabel(100)).toBe('99+')
  expect(railUnreadLabel(4821)).toBe('99+')
})

test('the spoken total is not capped and counts one properly', () => {
  expect(railUnreadDescription(1)).toBe('1 unread message in your rooms')
  expect(railUnreadDescription(127)).toBe('127 unread messages in your rooms')
  expect(railUnreadDescription(0)).toBe('0 unread messages in your rooms')
})
