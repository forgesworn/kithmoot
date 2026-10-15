import { describe, expect, it } from 'vitest'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { classifyOrdinaryPhysicalName as route } from './ordinary-physical-snapshot.js'
import { validateOrdinaryMetadataSnapshot as validate } from './ordinary-metadata-snapshot.js'
import { boardContextFixture, damageBoardContextFixture, BOARD_CONTEXT_MODES, BOARD_CONTEXT_FAULTS } from '../../test/ordinary-board-context-fixture.js'

describe('strict board-context personal metadata custody', () => {
  it.each(BOARD_CONTEXT_MODES)('accepts the exact actual %s writer, without returning labels or authority', mode => {
    const f = boardContextFixture(mode), before = [...f.records]
    expect(route(f.name, 'browser')).toEqual({ family: 'metadata', custody: 'protected' })
    const counts = validate(f.records, false, { kind: 'browser' })
    expect(counts).toEqual({ volumes: 0, pinLists: 0, notificationScopes: 0, projects: 0, boardContexts: 1 })
    expect(Object.isFrozen(counts)).toBe(true)
    expect(validate(f.records, true, { kind: 'browser' })).toEqual(counts)
    expect([...f.records]).toEqual(before)
    expect(f.raw).not.toContain('cardId')
    expect(() => route(f.name, 'tab')).toThrow(OrdinaryStateHold)
    expect(() => validate(f.records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
  it.each(BOARD_CONTEXT_FAULTS)('holds %s intact before and after migration', fault => {
    const f = boardContextFixture(), records = new Map(f.records); damageBoardContextFixture(f, records, fault)
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
})
