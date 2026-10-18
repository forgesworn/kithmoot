import { readCallProfile } from './call-profile.js'
import { expect, it, vi } from 'vitest'
import { validateOrdinaryMediaSnapshot as validate } from './ordinary-media-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { MEDIA_MODES, MEDIA_FAULTS, mediaFixture, damageMediaFixture } from '../../test/ordinary-media-fixture.js'

it.each(MEDIA_MODES)('retains actual %s writer bytes without media, clock or authority output', mode => {
  const f = mediaFixture(mode), before = [...f.records]
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('No clock') })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('No fetch') })
  try {
    const result = validate(f.records, false, { kind: f.kind })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.values(result).every(v => Number.isSafeInteger(v) && v >= 0)).toBe(true)
    expect(validate(f.records, true, { kind: f.kind })).toEqual(result)
    expect([...f.records]).toEqual(before); expect(clock).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    if (mode === 'all') expect(Object.values(result)).toEqual([1, 1, 1, 1, 1, 1, 1, 0])
    else expect(Object.values(result).reduce((a, b) => a + b)).toBe(1)
  } finally { clock.mockRestore(); fetcher.mockRestore() }
})
it.each(MEDIA_FAULTS)('holds %s intact in raw and completed browser images', fault => {
  const f = mediaFixture(); damageMediaFixture(f.records, fault); const before = [...f.records]
  for (const migrated of [false, true]) expect(() => validate(f.records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  expect([...f.records]).toEqual(before)
})
it('refuses browser media choices in a tab owner', () => {
  expect(() => validate(mediaFixture().records, false, { kind: 'tab' })).toThrow(OrdinaryStateHold)
})
it.each(['off', 'mask', 'avatar'])('retains %s face privacy across protected startup', mode => {
  const records = new Map([['kithmoot.call.facePrivacy', mode]])
  expect(validate(records, false, { kind: 'browser' }).facePrivacyModes).toBe(1)
  expect(validate(records, true, { kind: 'browser' }).facePrivacyModes).toBe(1)
  expect(() => validate(records, false, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  expect(records.get('kithmoot.call.facePrivacy')).toBe(mode)
})
it('holds unknown face privacy values for recovery', () => {
  expect(() => validate(new Map([['kithmoot.call.facePrivacy', 'unknown']]), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
})
it('refuses unknown owner kinds even for an empty snapshot', () => {
  expect(() => validate(new Map(), false, { kind: 'other' as 'browser' })).toThrow(OrdinaryStateHold)
})
it('holds oversized UTF8 values before interpretation', () => {
  const raw = 'é'.repeat(ORDINARY_VALUE_BYTES / 2 + 1), records = new Map([['kithmoot.call.background', raw]])
  expect(() => validate(records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  expect(records.get('kithmoot.call.background')).toBe(raw)
})
it('leaves unrelated namespaces for the required full composite', () => {
  expect(validate(new Map([['kithmoot.camera.framing', 'true']]), false, { kind: 'browser' }).cameraChoices).toBe(0)
})

it('retains the historical durable on value without enabling the current loader', () => {
  const f = mediaFixture('profile-browser-legacy-on')
  expect(f.records.get('kithmoot.callProfile')).toBe('2')
  expect(validate(f.records, false, { kind: 'browser' }).callProfiles).toBe(1)
  expect(readCallProfile('', { getItem: k => f.records.get(k) ?? null, setItem: (k, v) => { f.records.set(k, v) } })).toBe(1)
  expect(f.records.get('kithmoot.callProfile')).toBe('2')
})
