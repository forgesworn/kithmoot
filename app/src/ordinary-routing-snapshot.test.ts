import { expect, it, vi } from 'vitest'
import { validateOrdinaryRoutingSnapshot as validate } from './ordinary-routing-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { ROUTING_MODES, ROUTING_FAULTS, routingFixture, damageRoutingFixture } from '../../test/ordinary-routing-fixture.js'

it.each(ROUTING_MODES)('retains %s primary writer bytes without clock, dials or authority output', mode => {
  const f = routingFixture(mode), before = [...f.records]
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('No custody clock') })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('No custody fetch') })
  try {
    const result = validate(f.records, false, { kind: 'browser' })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.values(result).every(v => Number.isSafeInteger(v) && v >= 0)).toBe(true)
    expect(validate(f.records, true, { kind: 'browser' })).toEqual(result); expect([...f.records]).toEqual(before)
    expect(clock).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    if (mode === 'all') expect(result).toEqual({ savedLists:1,savedScopes:1,relayChoices:1,fixedLists:1,fixedRooms:1,fixedChoices:2,markLists:1,marks:1,roomRecords:1,storageRecords:0 })
    if (mode === 'saved-carried-sixteen') expect(result.relayChoices).toBe(17)
    if (mode === 'marks-opaque-carried') expect(result.marks).toBe(3)
    if (mode === 'room-record-inert-signature') expect(result.roomRecords).toBe(1)
    expect(f.provenance.snippet).toContain('localStorage.setItem(ROOM_RELAYS_PREFIX + roomId, JSON.stringify(record))')
  } finally { clock.mockRestore(); fetcher.mockRestore() }
})
it.each(ROUTING_FAULTS)('holds %s intact in raw and completed images', fault => {
  const f = routingFixture(); damageRoutingFixture(f.records, fault); const before = [...f.records]
  for (const migrated of [false, true]) expect(() => validate(f.records, migrated, { kind:'browser' })).toThrow(OrdinaryStateHold)
  expect([...f.records]).toEqual(before)
})
it('rejects routing rows in tab custody', () => {
  expect(() => validate(routingFixture().records, false, { kind:'tab' })).toThrow(OrdinaryStateHold)
})
it('rejects oversized values before JSON parsing', () => {
  const records = new Map([['kithmoot.circle.v1', 'x'.repeat(ORDINARY_VALUE_BYTES+1)]])
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw Error('Must not parse') })
  try { expect(() => validate(records, false, { kind:'browser' })).toThrow(OrdinaryStateHold); expect(parse).not.toHaveBeenCalled() }
  finally { parse.mockRestore() }
})
it('leaves other families for the complete composite', () => {
  expect(validate(new Map([['kithmoot.callProfile', '1']]), false, { kind:'browser' }).savedLists).toBe(0)
})
