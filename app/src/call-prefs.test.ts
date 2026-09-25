// Storage only - the DOM wiring that applies these on the next camera/mic
// start is proven in the browser by test/effects.spec.ts and
// test/call-prefs.spec.ts (no jsdom in this workspace's vitest config).
import { expect, test } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import {
  loadBackgroundId, loadBlurStrength, loadCameraDeviceId, loadEffectMode, loadMicDeviceId,
  loadVoicePreset, storeBackgroundId, storeBlurStrength, storeCameraDeviceId, storeEffectMode,
  storeMicDeviceId, storeVoicePreset,
} from './call-prefs.js'

test('nothing stored yet reads back as undefined', () => {
  const store = memoryDeviceStore()
  expect(loadEffectMode(store)).toBeUndefined()
  expect(loadBackgroundId(store)).toBeUndefined()
  expect(loadBlurStrength(store)).toBeUndefined()
  expect(loadVoicePreset(store)).toBeUndefined()
  expect(loadCameraDeviceId(store)).toBeUndefined()
  expect(loadMicDeviceId(store)).toBeUndefined()
})

test('effect mode round-trips and rejects anything not one of the three', () => {
  const store = memoryDeviceStore()
  storeEffectMode(store, 'replace')
  expect(loadEffectMode(store)).toBe('replace')
  store.set('kithmoot.call.effectMode', 'sepia')
  expect(loadEffectMode(store)).toBeUndefined()
})

test('background id round-trips as an opaque string', () => {
  const store = memoryDeviceStore()
  storeBackgroundId(store, 'coral-reef')
  expect(loadBackgroundId(store)).toBe('coral-reef')
})

test('blur strength round-trips and rejects out-of-range or non-numeric values', () => {
  const store = memoryDeviceStore()
  storeBlurStrength(store, 0.35)
  expect(loadBlurStrength(store)).toBe(0.35)
  storeBlurStrength(store, 1.5)
  // The bad write never lands: the previous valid value survives.
  expect(loadBlurStrength(store)).toBe(0.35)
  store.set('kithmoot.call.blurStrength', 'not-a-number')
  expect(loadBlurStrength(store)).toBeUndefined()
})

test('voice preset round-trips and rejects anything not a real preset', () => {
  const store = memoryDeviceStore()
  storeVoicePreset(store, 'deep')
  expect(loadVoicePreset(store)).toBe('deep')
  store.set('kithmoot.call.voicePreset', 'robot')
  expect(loadVoicePreset(store)).toBeUndefined()
})

test('camera and microphone device ids round-trip independently', () => {
  const store = memoryDeviceStore()
  storeCameraDeviceId(store, 'cam-1')
  storeMicDeviceId(store, 'mic-1')
  expect(loadCameraDeviceId(store)).toBe('cam-1')
  expect(loadMicDeviceId(store)).toBe('mic-1')
})

test('an empty device id is never stored', () => {
  const store = memoryDeviceStore()
  storeCameraDeviceId(store, '')
  storeMicDeviceId(store, '')
  expect(loadCameraDeviceId(store)).toBeUndefined()
  expect(loadMicDeviceId(store)).toBeUndefined()
})

test('a storage read or write that throws is not fatal', () => {
  const angry = {
    get: () => { throw new Error('blocked') },
    set: () => { throw new Error('blocked') },
    remove: () => { throw new Error('blocked') },
    keys: () => [],
  }
  expect(loadEffectMode(angry)).toBeUndefined()
  expect(() => storeEffectMode(angry, 'blur')).not.toThrow()
})
