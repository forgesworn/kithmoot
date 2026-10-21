import { describe, expect, it } from 'vitest'
import { validateOrdinaryMetadataSnapshot as validate } from './ordinary-metadata-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { metadataFixture, damageMetadataFixture, METADATA_MODES, METADATA_FAULTS } from '../../test/ordinary-metadata-fixture.js'

describe('private UI metadata custody', () => {
  it.each(METADATA_MODES)('retains byte-exact actual %s writer rows without returning authority or identifiers', mode => {
    const { records } = metadataFixture(mode), before = [...records]
    const result = validate(records, false, { kind: 'browser' })
    expect([...records]).toEqual(before); expect(Object.isFrozen(result)).toBe(true)
    expect(result).toEqual({ volumes: ['all', 'volume'].includes(mode) ? 2 : 0, pinLists: ['all', 'pins'].includes(mode) ? 1 : 0,
      notificationScopes: ['all', 'notifications'].includes(mode) ? 4 : 0, projects: ['all', 'projects'].includes(mode) ? 2 : 0, mutes: ['all', 'mutes'].includes(mode) ? 1 : 0, boardContexts: 0 })
    expect(validate(records, true, { kind: 'browser' })).toEqual(result)
  })
  it.each(METADATA_FAULTS)('holds %s intact before or after completed custody', fault => {
    const fixture = metadataFixture(), records = new Map(fixture.records); damageMetadataFixture(fixture, records, fault)
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it.each(['volume', 'pins', 'notifications', 'projects', 'mutes'] as const)('holds %s relocated into a temporary tab owner', mode => {
    const { records } = metadataFixture(mode), before = [...records]
    expect(() => validate(records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold); expect([...records]).toEqual(before)
  })
  it('preserves a real empty pin list after unpinning; it is not an absence repair', () => {
    expect(validate(new Map([['kithmoot.pinned-rooms.v1', '[]']]), false, { kind: 'browser' }).pinLists).toBe(1)
  })
  it('keeps other families for the mandatory complete composite to classify', () => {
    expect(validate(new Map([['kithmoot.channel-checks.v1.private', 'not metadata']]), false, { kind: 'browser' })).toEqual({ volumes: 0, pinLists: 0, notificationScopes: 0, projects: 0, mutes: 0, boardContexts: 0 })
  })
  it.each(['0', '01', '-1', '1.5', 'abc', '9007199254740993', ''])('holds a mute end of %j', value => {
    const records = new Map([[`kithmoot.mute-until.v1.visitor.${'1'.repeat(64)}`, value]])
    expect(() => validate(records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('holds a mute moved into a temporary tab owner', () => {
    expect(() => validate(metadataFixture('mutes').records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
})
