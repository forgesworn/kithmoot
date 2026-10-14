import { describe, expect, it, vi } from 'vitest'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { buildProjection, parseProjection, projectionByteLength, MAX_WIRE_BYTES } from '@forgesworn/signet-contacts'
import { validateOrdinaryGrantedContactSnapshot as validate } from './ordinary-granted-contact-snapshot.js'
import { GRANTED_CONTACT_MODES, GRANTED_CONTACT_FAULTS, grantedContactFixture, damageGrantedContactFixture } from '../../test/ordinary-granted-contact-fixture.js'

describe('granted-contact custody without grant authority', () => {
  it.each(GRANTED_CONTACT_MODES)('retains exact actual %s writer bytes with count-only output and no fresh clock', async mode => {
    const { records } = await grantedContactFixture(mode), before = [...records]
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No clock for historical custody') })
    try {
      const result = validate(records, false, { kind: 'browser' })
      expect(result).toEqual({ pairings: mode === 'empty' ? 0 : 1, states: ['empty', 'pairing'].includes(mode) ? 0 : 1,
        pendingLists: ['empty', 'pairing'].includes(mode) ? 0 : 1 })
      expect(Object.isFrozen(result)).toBe(true); expect([...records]).toEqual(before)
      expect(validate(records, true, { kind: 'browser' })).toEqual(result)
    } finally { clock.mockRestore() }
  })
  it.each(GRANTED_CONTACT_FAULTS)('holds %s intact before and after custody instead of SDK loader repair', async fault => {
    const fixture = await grantedContactFixture(), records = new Map(fixture.records); damageGrantedContactFixture(fixture, records, fault)
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it('holds browser contact rows relocated to a temporary tab owner', async () => {
    const { records } = await grantedContactFixture()
    expect(() => validate(records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
  it('preserves the actual out-of-order tombstone with its higher old frontier and sticky blocks', async () => {
    const fixture = await grantedContactFixture('revoked'), raw = fixture.records.get(fixture.prefix + 'signet-contacts:state:' + fixture.grant)!
    const state = JSON.parse(raw)
    expect(state.projection.frontier.publishedAt).toBeGreaterThan(state.projection.issuedAt)
    expect(state.blockedPubkeys).toEqual([fixture.peer]); expect(state.projection.contacts).toEqual([])
    expect(validate(fixture.records, false, { kind: 'browser' }).states).toBe(1)
    expect(fixture.records.get(fixture.prefix + 'signet-contacts:state:' + fixture.grant)).toBe(raw)
  })
  it('retains orphan grant histories when no current pairing was saved', async () => {
    const fixture = await grantedContactFixture('blocked'); fixture.records.delete(fixture.prefix + 'pairing')
    expect(validate(fixture.records, false, { kind: 'browser' })).toEqual({ pairings: 0, states: 1, pendingLists: 1 })
  })
  it.each(['empty', 'foreign', 'duplicate'] as const)('holds a non-revoked %s block set inconsistent with the retained projection', async fault => {
    const fixture = await grantedContactFixture('blocked'), key = fixture.prefix + 'signet-contacts:state:' + fixture.grant, state = JSON.parse(fixture.records.get(key)!)
    state.blockedPubkeys = fault === 'empty' ? [] : fault === 'foreign' ? ['f'.repeat(64)] : [fixture.peer, fixture.peer]
    fixture.records.set(key, JSON.stringify(state))
    expect(() => validate(fixture.records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('accepts different allowed key insertion orders without changing bytes', async () => {
    const { records } = await grantedContactFixture()
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value
    for (const [key, raw] of records) records.set(key, JSON.stringify(reverse(JSON.parse(raw))))
    const before = [...records]; expect(validate(records, false, { kind: 'browser' }).states).toBe(1); expect([...records]).toEqual(before)
  })
  it('requires the complete composite to classify other private families', () => {
    expect(validate(new Map([['kithmoot.contact.private', 'not a grant']]), false, { kind: 'browser' })).toEqual({ pairings: 0, states: 0, pendingLists: 0 })
  })
  it('holds a fully parseable aggregate wire-size breach that the actual projection builder refuses', async () => {
    const fixture = await grantedContactFixture(), records = new Map(fixture.records)
    damageGrantedContactFixture(fixture, records, 'projection-wire-size')
    const key = fixture.prefix + 'signet-contacts:state:' + fixture.grant, projection = JSON.parse(records.get(key)!).projection
    const parsed = parseProjection(JSON.stringify(projection))!
    expect(parsed).toEqual(projection); expect(projectionByteLength(parsed)).toBeGreaterThan(MAX_WIRE_BYTES)
    expect(() => buildProjection(parsed)).toThrow(/over the .* cap/)
    expect(() => validate(records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
})
