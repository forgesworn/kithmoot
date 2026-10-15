import { afterEach, describe, expect, it, vi } from 'vitest'
import { roomAccessFixture } from '../../test/ordinary-room-access.browser-entry.js'
import { bookmarkFixture } from '../../test/ordinary-bookmark-fixture.js'
import { startupCardFragment } from '../../test/ordinary-access-composition.browser-entry.js'
import { base64urlnopad } from '@scure/base'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import {
  captureOrdinaryStartupContext as capture,
  releaseOrdinaryStartupContext as release,
  validateOrdinaryRoomAccessAndBookmarksSnapshot as validate,
  validateOrdinaryRoomAccessSnapshot as access,
  validateOrdinaryRoomBookmarkSnapshot as bookmarks,
  type OrdinaryStartupContext,
} from './ordinary-room-access-snapshot.js'

const empty = () => new Map<string, string>()
const raw = { browser: false, tab: false }
const location = (href = 'https://ordinary-composition.kithmoot.test/j/') => vi.stubGlobal('location', { href })
afterEach(() => vi.unstubAllGlobals())
describe('both-owner captured access and bookmark composition', () => {
  it('binds tab admission to the real browser room without tab navigation or caller links', () => {
    location()
    const browser = roomAccessFixture({ owner: true }), tab = roomAccessFixture({ tab: true })
    const rows = new Map([...tab.records].filter(([n]) => n.startsWith('kithmoot.admission.')))
    const before = JSON.stringify([[...browser.records], [...rows]])
    const context = capture(browser.records, rows), result = validate(browser.records, rows, raw, context)
    expect(result.access.invitations.map(v => v.kind).sort()).toEqual(['owner', 'tab'])
    expect(result.access.invitations.every(v => v.roomId === browser.roomId)).toBe(true)
    expect(context).toEqual({ links: 0, browserAccess: 2, bookmarks: 0, tabAccess: 1, navigation: 0 })
    expect(Object.isFrozen(context)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('https://')
    expect(JSON.stringify([[...browser.records], [...rows]])).toBe(before)
  })
  it('binds orphan owner and tab admission from a real signed bookmark cache in the same image', async () => {
    location()
    const cached = await bookmarkFixture(), owner = roomAccessFixture({ owner: true, persistent: true }), tab = roomAccessFixture({ tab: true, persistent: true })
    const browser = new Map([[cached.name, cached.records.get(cached.name)!]])
    for (const [n, v] of owner.records) if (n.startsWith('kithmoot.invitation-owner.')) browser.set(n, v)
    const rows = new Map([...tab.records].filter(([n]) => n.startsWith('kithmoot.admission.')))
    const result = validate(browser, rows, raw, capture(browser, rows))
    expect(result.bookmarks).toHaveLength(1)
    expect(result.access.invitations.map(v => v.kind).sort()).toEqual(['owner', 'tab'])
  })
  it('retains the original actual startup bearer after history scrubbing and consumes it once', () => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    location(fixture.url)
    const tab = empty(), context = capture(fixture.records, tab)
    location() // Models the root scrubbing history after the protected capture.
    expect(validate(fixture.records, tab, raw, context).access.invitations).toHaveLength(1)
    expect(() => validate(fixture.records, tab, raw, context)).toThrow(OrdinaryStateHold)
  })
  it('holds orphan state when the original startup bearer was not captured before scrubbing', () => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    location()
    const tab = empty(), context = capture(fixture.records, tab), before = [...fixture.records]
    expect(() => validate(fixture.records, tab, raw, context)).toThrow(OrdinaryStateHold)
    expect([...fixture.records]).toEqual(before)
    expect(() => validate(fixture.records, tab, raw, context)).toThrow(OrdinaryStateHold)
  })
  for (const partition of ['browser-access', 'bookmarks', 'tab-access', 'navigation'] as const) {
    for (const fault of ['changed', 'missing', 'substituted'] as const) it(`holds ${fault} ${partition} evidence and consumes the rejected token`, async () => {
      location()
      const cached = await bookmarkFixture(), owner = roomAccessFixture({ owner: true, persistent: true }), tab = roomAccessFixture({ tab: true, persistent: true })
      const browser = new Map([...owner.records, ...cached.records]), rows = new Map(tab.records)
      const context = capture(browser, rows), target = partition === 'browser-access' || partition === 'bookmarks' ? browser : rows
      const prefix = partition === 'browser-access' ? 'kithmoot.invitation-owner.' : partition === 'bookmarks' ? 'kithmoot.bookmarks.' : partition === 'tab-access' ? 'kithmoot.admission.' : 'kithmoot.way-back'
      const [name, value] = [...target].find(([n]) => n.startsWith(prefix))!
      if (fault === 'changed') target.set(name, value + ' ')
      else {
        target.delete(name)
        if (fault === 'substituted') target.set(name === 'kithmoot.way-back' ? 'kithmoot.room-switch.v1' : name.slice(0, -64) + 'a'.repeat(64), value)
      }
      const before = JSON.stringify([[...browser], [...rows]])
      expect(() => validate(browser, rows, raw, context)).toThrow(OrdinaryStateHold)
      expect(JSON.stringify([[...browser], [...rows]])).toBe(before)
      target.delete(name.slice(0, -64) + 'a'.repeat(64)); target.set(name, value)
      expect(() => validate(browser, rows, raw, context)).toThrow(OrdinaryStateHold)
    })
  }
  it('consumes a token even when exact captured state fails semantic signature checks', () => {
    location()
    const fixture = roomAccessFixture({ tab: true }), rows = new Map(fixture.records), name = 'kithmoot.admission.v1.' + fixture.id
    const value = JSON.parse(rows.get(name)!); value.delegation[0].sig = '0'.repeat(128); rows.set(name, JSON.stringify(value))
    const browser = empty(), context = capture(browser, rows)
    expect(() => validate(browser, rows, raw, context)).toThrow(OrdinaryStateHold)
    expect(() => validate(browser, rows, raw, context)).toThrow(OrdinaryStateHold)
  })
  it('rejects copies and forged tokens without burning the genuine private capability', () => {
    location()
    const fixture = roomAccessFixture({ owner: true }), tab = empty(), context = capture(fixture.records, tab)
    for (const fake of [{ ...context }, JSON.parse(JSON.stringify(context)), null]) {
      expect(() => validate(fixture.records, tab, raw, fake as OrdinaryStartupContext)).toThrow(OrdinaryStateHold)
    }
    expect(validate(fixture.records, tab, raw, context).access.invitations).toHaveLength(1)
  })
  it('can release an unused token without releasing or modifying its source state', () => {
    location()
    const fixture = roomAccessFixture({ owner: true }), tab = empty(), context = capture(fixture.records, tab), before = [...fixture.records]
    release(context); release(context)
    expect(() => validate(fixture.records, tab, raw, context)).toThrow(OrdinaryStateHold)
    expect([...fixture.records]).toEqual(before)
  })
  it.each(['delegate', 'cross-role'] as const)('holds valid %s key reuse across owners that isolated validators cannot see', fault => {
    location()
    const browser = roomAccessFixture({ owner: fault === 'cross-role' }), tab = roomAccessFixture({ tab: true, rootSeed: 6, inviterSeed: 3, requesterSeed: fault === 'cross-role' ? 1 : 2, bearerSeed: 8 })
    expect(() => validate(browser.records, tab.records, raw, capture(browser.records, tab.records))).toThrow(OrdinaryStateHold)
  })
  it('uses the browser migration flag for scoped owner custody, never the tab flag', () => {
    location()
    const fixture = roomAccessFixture({ owner: true }), name = 'kithmoot.invitation-owner.v1.' + fixture.id, value = fixture.records.get(name)!
    fixture.records.delete(name); fixture.records.set('kithmoot.account.' + 'a'.repeat(64) + '.' + name, value)
    const tab = empty()
    expect(() => validate(fixture.records, tab, { browser: false, tab: true }, capture(fixture.records, tab))).toThrow(OrdinaryStateHold)
    expect(validate(fixture.records, tab, { browser: true, tab: false }, capture(fixture.records, tab)).access.invitations).toHaveLength(1)
  })
  it('rejects relocation between physical owners at capture and at consumption', () => {
    location()
    const fixture = roomAccessFixture({ owner: true }), browser = new Map(fixture.records), tab = empty(), context = capture(browser, tab)
    expect(() => capture(tab, browser)).toThrow(OrdinaryStateHold)
    expect(() => validate(tab, browser, raw, context)).toThrow(OrdinaryStateHold)
    expect(() => validate(browser, tab, raw, context)).toThrow(OrdinaryStateHold)
  })
  it('rejects legacy raw-link and retained-room handoffs at both public family APIs', () => {
    const fixture = roomAccessFixture({ owner: true })
    for (const helper of [access, bookmarks]) {
      for (const unsafe of [{ links: [fixture.url] }, { retainedRooms: [{ roomId: fixture.roomId, link: fixture.url }] }]) {
        expect(() => helper(fixture.records, false, { kind: 'browser', ...unsafe })).toThrow(OrdinaryStateHold)
      }
    }
  })
  for (const mode of ['opaque', 'contact-card', 'incomplete', 'oversized-startup', 'oversized-navigation'] as const) {
    it.each([false, true])(`keeps ${mode} startup inert beside valid navigation in either row order: reverse=%s`, reverse => {
      const fixture = roomAccessFixture({ owner: true }), tabFixture = roomAccessFixture({ tab: true })
      fixture.records.delete(fixture.roomName)
      const tab = new Map([...tabFixture.records].filter(([n]) => !n.startsWith('kithmoot.admission.')))
      const fragment = mode === 'contact-card' ? startupCardFragment() : mode === 'incomplete' ? 'eyJ2Ijoy' : mode === 'oversized-startup' ? 'x'.repeat(16_385) : 'opaque'
      if (mode === 'oversized-navigation') tab.set('kithmoot.room-switch.v1', JSON.stringify({ hash: '#' + 'x'.repeat(16_385), account: null, at: 100 }))
      location('https://ordinary-composition.kithmoot.test/#' + fragment)
      const rows = reverse ? new Map([...tab].reverse()) : tab
      expect(validate(fixture.records, rows, raw, capture(fixture.records, rows)).access.invitations).toHaveLength(1)
    })
  }
  it('keeps orphan custody held when an oversized hash supplies no room evidence', () => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    location('https://ordinary-composition.kithmoot.test/#' + 'x'.repeat(16_385))
    const tab = new Map([['kithmoot.room-switch.v1', JSON.stringify({ hash: '#' + 'x'.repeat(16_385), account: null, at: 0 })]])
    expect(() => validate(fixture.records, tab, raw, capture(fixture.records, tab))).toThrow(OrdinaryStateHold)
  })
  it.each([false, true])('holds conflicting room policies independently of candidate order: reverse=%s', reverse => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(fixture.url).hash.slice(1))))
    payload.a = { tier: 'kith', members: ['a'.repeat(64)] }
    const restricted = '#' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
    const rows = [['kithmoot.way-back', JSON.stringify({ link: fixture.url, name: '' })],
      ['kithmoot.room-switch.v1', JSON.stringify({ hash: restricted, account: null, at: 100 })]] as [string, string][]
    const tab = new Map(reverse ? rows.reverse() : rows)
    location()
    expect(() => validate(fixture.records, tab, raw, capture(fixture.records, tab))).toThrow(OrdinaryStateHold)
  })
  it('permits name and transport hint changes with the same policy and invitation', () => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(fixture.url).hash.slice(1))))
    payload.n = 'Another label'; payload.r = ['wss://another.example']; payload.i = ['stun:another.example:3478']; payload.a = { tier: 'open' }
    const alternate = '#' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
    const tab = new Map([['kithmoot.way-back', JSON.stringify({ link: fixture.url, name: '' })],
      ['kithmoot.room-switch.v1', JSON.stringify({ hash: alternate, account: null, at: 100 })]])
    location()
    expect(validate(fixture.records, tab, raw, capture(fixture.records, tab)).access.invitations).toHaveLength(1)
  })
  it('holds a recognisable room fragment with an unknown policy despite valid way-back evidence', () => {
    const fixture = roomAccessFixture({ owner: true }); fixture.records.delete(fixture.roomName)
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(fixture.url).hash.slice(1))))
    payload.a = { tier: 'open', hiddenRule: true }
    location('https://ordinary-composition.kithmoot.test/#' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload))))
    const tab = new Map([['kithmoot.way-back', JSON.stringify({ link: fixture.url, name: '' })]])
    expect(() => validate(fixture.records, tab, raw, capture(fixture.records, tab))).toThrow(OrdinaryStateHold)
  })
  it('rejects oversized prospective physical state before any JSON parsing or capture', () => {
    location()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => capture(new Map([['kithmoot.room.' + 'a'.repeat(64), 'x'.repeat(8 * 1024 * 1024 + 1)]]), empty())).toThrow(OrdinaryStateHold)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })
})
