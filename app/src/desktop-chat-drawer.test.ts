// No jsdom in this workspace's vitest config (environment: 'node'), so
// `wrapConversation`'s DOM surgery is proven in the browser instead, by
// test/desktop-room-layout.spec.ts. What is tested here is everything that
// does not need a document: the storage round-trip and the placeholder rule.
import { expect, test } from 'vitest'
import { loadDrawerOpen, needsNamePlaceholder, saveDrawerOpen } from './desktop-chat-drawer.js'

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

test('loadDrawerOpen falls back when nothing is stored yet', () => {
  expect(loadDrawerOpen(memoryStorage(), false)).toBe(false)
  expect(loadDrawerOpen(memoryStorage(), true)).toBe(true)
})

test('saveDrawerOpen and loadDrawerOpen round-trip', () => {
  const storage = memoryStorage()
  saveDrawerOpen(storage, true)
  expect(loadDrawerOpen(storage, false)).toBe(true)
  saveDrawerOpen(storage, false)
  expect(loadDrawerOpen(storage, true)).toBe(false)
})

test('loadDrawerOpen falls back to the given default on a storage read that throws', () => {
  const storage = {
    getItem: () => { throw new Error('blocked') },
  } as unknown as Storage
  expect(loadDrawerOpen(storage, true)).toBe(true)
  expect(loadDrawerOpen(storage, false)).toBe(false)
})

test('saveDrawerOpen swallows a storage write that throws', () => {
  const storage = {
    setItem: () => { throw new Error('quota') },
  } as unknown as Storage
  expect(() => saveDrawerOpen(storage, true)).not.toThrow()
})

test('needsNamePlaceholder is true only when there is no camera', () => {
  expect(needsNamePlaceholder(false)).toBe(true)
  expect(needsNamePlaceholder(true)).toBe(false)
})
