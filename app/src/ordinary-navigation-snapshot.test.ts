import { describe, expect, it, vi } from 'vitest'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { captureOrdinaryNavigationContext as capture, validateOrdinaryNavigationRecord, type OrdinaryNavigationContext } from './ordinary-navigation-snapshot.js'
import { validateOrdinaryRoomAccessSnapshot as access } from './ordinary-room-access-snapshot.js'
import { roomAccessFixture } from '../../test/ordinary-room-access.browser-entry.js'

const way = 'kithmoot.way-back', change = 'kithmoot.room-switch.v1'
describe('explicit navigation custody/context transfer', () => {
  it('rejects oversized navigation before JSON parsing', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => validateOrdinaryNavigationRecord(way, 'x'.repeat(8 * 1024 * 1024 + 1))).toThrow(OrdinaryStateHold)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })
  it('captures source bytes once, keeps empty switch inert and exposes counts only', () => {
    const rows = new Map([[way, JSON.stringify({ link: 'opaque', name: 'old' })], [change, JSON.stringify({ hash: '', account: null, at: 0 })]])
    const ctx = capture(rows, { kind: 'tab' }); rows.set(way, JSON.stringify({ link: 'changed', name: 'later' })); rows.clear()
    expect(ctx).toEqual({ wayBacks: 1, roomSwitches: 1 }); expect(Object.isFrozen(ctx)).toBe(true)
    expect(access(new Map(), false, { kind: 'tab', navigation: ctx }).invitations).toEqual([])
  })
  it('rejects copied/forged contexts even when no access row needs a binding', () => {
    const ctx = capture(new Map(), { kind: 'tab' })
    for (const fake of [{ ...ctx }, JSON.parse(JSON.stringify(ctx)), null]) {
      expect(() => access(new Map(), false, { kind: 'tab', navigation: fake as OrdinaryNavigationContext })).toThrow(OrdinaryStateHold)
    }
  })
  it('rejects context from a different access partition, changed rows or owner', () => {
    const fixture = roomAccessFixture({ tab: true }), rows = new Map([...fixture.records].filter(([n]) => n !== way && n !== change))
    const isolated = capture(new Map([...fixture.records].filter(([n]) => n === way || n === change)), { kind: 'tab' })
    expect(() => access(rows, false, { kind: 'tab', navigation: isolated })).toThrow(OrdinaryStateHold)
    const context = capture(fixture.records, { kind: 'tab' }), changed = new Map(rows)
    for (const [n, v] of changed) changed.set(n, v.replace('roomSecret', 'otherSecret'))
    expect(() => access(changed, false, { kind: 'tab', navigation: context })).toThrow(OrdinaryStateHold)
    expect(() => access(new Map(), false, { kind: 'tab', navigation: context })).toThrow(OrdinaryStateHold)
    expect(() => access(new Map(), false, { kind: 'browser', navigation: context })).toThrow(OrdinaryStateHold)
    fixture.records.clear()
    expect(access(rows, false, { kind: 'tab', navigation: context }).invitations).toHaveLength(1)
  })
  it('uses real grant/writer state through explicit navigation context without redispatching physical rows', () => {
    const fixture = roomAccessFixture({ tab: true }), rows = new Map([...fixture.records].filter(([n]) => n !== way && n !== change)), ctx = capture(fixture.records, { kind: 'tab' })
    expect(() => access(rows, false, { kind: 'tab' })).toThrow(OrdinaryStateHold)
    expect(access(rows, false, { kind: 'tab', navigation: ctx }).invitations[0]!.roomId).toBe(fixture.roomId)
    expect(() => access(fixture.records, false, { kind: 'tab', navigation: ctx })).toThrow(OrdinaryStateHold)
  })
  it('keeps opaque navigation inert when no room binding depends on it', () => {
    const ctx = capture(new Map([[way, JSON.stringify({ link: 'opaque', name: '' })]]), { kind: 'tab' })
    expect(access(new Map(), false, { kind: 'tab', navigation: ctx }).invitations).toEqual([])
    const fixture = roomAccessFixture({ tab: true }), rows = new Map([...fixture.records].filter(([n]) => n !== way && n !== change))
    expect(() => access(rows, false, { kind: 'tab', navigation: ctx })).toThrow(OrdinaryStateHold)
  })
  it('never makes empty switch a guessed link for an unbound admission', () => {
    const ctx = capture(new Map([[change, JSON.stringify({ hash: '', account: null, at: 0 })]]), { kind: 'tab' })
    const fixture = roomAccessFixture({ tab: true }), rows = new Map([...fixture.records].filter(([n]) => n !== way && n !== change))
    expect(() => access(rows, false, { kind: 'tab', navigation: ctx })).toThrow(OrdinaryStateHold)
  })
  for (const [name, raw] of [[way + '.v2', '{}'], [change, '{'], [way, JSON.stringify({ link: '', name: '' })], [change, JSON.stringify({ hash: '', account: 'unknown', at: 0 })], [change, JSON.stringify({ hash: '', account: null, at: -1 })], [change, JSON.stringify({ hash: 'not-hash', account: null, at: 0 })]]) it(`holds invalid navigation ${name} ${raw.slice(0, 30)}`, () => {
    const rows = new Map([[name!, raw!]]), before = [...rows]; expect(() => capture(rows, { kind: 'tab' })).toThrow(OrdinaryStateHold); expect([...rows]).toEqual(before)
  })
  it('rejects browser or account-wrapped navigation', () => {
    const raw = JSON.stringify({ link: 'opaque', name: '' }); expect(() => capture(new Map([[way, raw]]), { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect(() => capture(new Map([['kithmoot.account.' + 'a'.repeat(64) + '.' + way, raw]]), { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
})
