// The predicates only - the DOM wiring `installCallShortcuts` does is proven
// in the browser by test/shortcuts.spec.ts (no jsdom in this workspace's
// vitest config).
import { expect, test } from 'vitest'
import { isCameraShortcut, isMicShortcut, isPushToTalkKey, isTextEntry, modifierGlyph, spaceBelongsToTarget } from './call-shortcuts.js'

const base = { key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }

test('Control or Command plus D is the microphone shortcut, and nothing else is', () => {
  expect(isMicShortcut({ ...base, key: 'd', ctrlKey: true })).toBe(true)
  expect(isMicShortcut({ ...base, key: 'D', metaKey: true })).toBe(true)
  expect(isMicShortcut({ ...base, key: 'd' })).toBe(false)
  expect(isMicShortcut({ ...base, key: 'd', ctrlKey: true, shiftKey: true })).toBe(false)
  expect(isMicShortcut({ ...base, key: 'd', ctrlKey: true, altKey: true })).toBe(false)
  expect(isMicShortcut({ ...base, key: 'e', ctrlKey: true })).toBe(false)
})

test('Control or Command plus E is the camera shortcut, and nothing else is', () => {
  expect(isCameraShortcut({ ...base, key: 'e', ctrlKey: true })).toBe(true)
  expect(isCameraShortcut({ ...base, key: 'E', metaKey: true })).toBe(true)
  expect(isCameraShortcut({ ...base, key: 'e' })).toBe(false)
  expect(isCameraShortcut({ ...base, key: 'd', ctrlKey: true })).toBe(false)
})

test('plain Space is the push-to-talk key; a modified one is not', () => {
  expect(isPushToTalkKey({ ...base, key: ' ' })).toBe(true)
  expect(isPushToTalkKey({ ...base, key: ' ', ctrlKey: true })).toBe(false)
  expect(isPushToTalkKey({ ...base, key: ' ', metaKey: true })).toBe(false)
  expect(isPushToTalkKey({ ...base, key: ' ', altKey: true })).toBe(false)
  expect(isPushToTalkKey({ ...base, key: 'Spacebar' })).toBe(false)
})

test('isTextEntry reads the target\'s closest(), and is false for anything without one', () => {
  const input = { closest: (selector: string) => (selector.includes('input') ? {} : null) }
  const chatLog = { closest: () => null }
  expect(isTextEntry(input)).toBe(true)
  expect(isTextEntry(chatLog)).toBe(false)
  expect(isTextEntry(null)).toBe(false)
  expect(isTextEntry(undefined)).toBe(false)
  expect(isTextEntry('not an element')).toBe(false)
})

test('modifierGlyph reads Mac platforms as the command glyph and everything else as Ctrl', () => {
  expect(modifierGlyph('MacIntel')).toBe('⌘')
  expect(modifierGlyph('macOS')).toBe('⌘')
  expect(modifierGlyph('Win32')).toBe('Ctrl')
  expect(modifierGlyph('Linux x86_64')).toBe('Ctrl')
})

test('spaceBelongsToTarget keeps Space for buttons, roles and focusable items, not the bare page', () => {
  const button = { closest: (selector: string) => (selector.includes('button') ? {} : null) }
  const body = { closest: () => null }
  expect(spaceBelongsToTarget(button)).toBe(true)
  expect(spaceBelongsToTarget(body)).toBe(false)
  expect(spaceBelongsToTarget(null)).toBe(false)
})
