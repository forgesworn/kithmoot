// Same shape as desktop-chat-drawer.test.ts next door, and for the same
// reason: no jsdom in this workspace's vitest config, so `wrapRail`'s DOM
// surgery and the collapse itself are proven in the browser by
// test/desktop-room-layout.spec.ts. What is tested here is the storage
// round-trip and the wording of the total the slim rail carries.
import { expect, test } from 'vitest'
import {
  RAIL_DEFAULT_PX, RAIL_MAX_PX, RAIL_MIN_PX, clampRailWidth, loadRailOpen, loadRailWidth, railUnreadDescription, railUnreadLabel,
  saveRailOpen, saveRailWidth,
} from './desktop-projects-rail.js'

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

test('the dragged rail is held between its floor and a share of the window', () => {
  expect(clampRailWidth(100, 1600)).toBe(RAIL_MIN_PX)
  expect(clampRailWidth(300, 1600)).toBe(300)
  expect(clampRailWidth(2000, 1600)).toBe(RAIL_MAX_PX)
  // 40% of a 1100px window is 440px, below the absolute ceiling.
  expect(clampRailWidth(500, 1100)).toBe(440)
  // A window too small for even the floor still gets the floor, not less.
  expect(clampRailWidth(300, 300)).toBe(RAIL_MIN_PX)
  expect(clampRailWidth(Number.NaN, 1600)).toBe(RAIL_DEFAULT_PX)
})

test('a dragged rail width round-trips, and the reset forgets it', () => {
  const storage = memoryStorage()
  expect(loadRailWidth(storage)).toBeUndefined()
  saveRailWidth(storage, 287.6)
  expect(loadRailWidth(storage)).toBe(288)
  saveRailWidth(storage, undefined)
  expect(loadRailWidth(storage)).toBeUndefined()
})

test('a stored rail width that is out of bounds or not a number is ignored', () => {
  for (const raw of ['', 'wide', '12', '9000', 'NaN']) {
    const storage = memoryStorage()
    storage.setItem('kithmoot.desktopProjectsRailWidth', raw)
    expect(loadRailWidth(storage), raw).toBeUndefined()
  }
})
