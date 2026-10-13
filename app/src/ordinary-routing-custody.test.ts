import { afterEach, expect, it, vi } from 'vitest'
import { ROUTING_CUSTODY_MODES, ROUTING_CUSTODY_FAULTS, routingCustodyFixture } from '../../test/ordinary-routing-custody-fixture.js'
import { captureOrdinarySnapshotContext as capture, validateOrdinarySnapshot as validate } from './ordinary-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flags = { browser: false, tab: false }
it.each(ROUTING_CUSTODY_MODES)('binds %s actual relay writer to retained historical invitation evidence', async mode => {
  const f = await routingCustodyFixture(mode)
  vi.stubGlobal('location', { href: f.startupUrl })
  const before = JSON.stringify([[...f.browser], [...f.tab]])
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('clock') })
  const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw Error('entropy') })
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('network') })
  try {
    const token = capture(f.browser, f.tab), result = validate(f.browser, f.tab, flags, token)
    expect(result.historicalRoomRelayRecords).toBe(1)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.keys(result)).not.toContain('authority'); expect(Object.keys(result)).not.toContain('relays')
    expect(JSON.stringify([[...f.browser], [...f.tab]])).toBe(before)
    expect(clock).not.toHaveBeenCalled(); expect(entropy).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
    expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
    expect(f.provenance.snippet).toContain('localStorage.setItem(ROOM_RELAYS_PREFIX + roomId, JSON.stringify(record))')
    if (mode === 'rotated-old' || mode === 'rotated-new') expect(result.invitations).toBe(2)
    if (mode === 'metadata-only') expect(result).toMatchObject({ rooms: 0, identities: 0, pendingRecords: 0 })
  } finally { f.release() }
})
it.each(ROUTING_CUSTODY_FAULTS)('holds %s routing custody, preserves both images and consumes the capture', async fault => {
  const f = await routingCustodyFixture(fault === 'missing-old-pin' ? 'rotated-old' : 'owner')
  try {
    f.damage(fault); vi.stubGlobal('location', { href: f.startupUrl })
    const before = JSON.stringify([[...f.browser], [...f.tab]]), token = capture(f.browser, f.tab)
    expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
    expect(() => validate(f.browser, f.tab, flags, token)).toThrow(OrdinaryStateHold)
    expect(JSON.stringify([[...f.browser], [...f.tab]])).toBe(before)
  } finally { f.release() }
})
it('holds swapped same-inviter signed records for two actual rooms', async () => {
  const a = await routingCustodyFixture(), b = await routingCustodyFixture('member-kept', { rootSeed: 6, bearerSeed: 9 })
  try {
    for (const [name, raw] of b.browser) if (name === b.roomName || name === b.name || name.startsWith('kithmoot.admission-kept.')) a.browser.set(name, raw)
    vi.stubGlobal('location', { href: a.startupUrl })
    expect(validate(a.browser, a.tab, flags, capture(a.browser, a.tab)).historicalRoomRelayRecords).toBe(2)
    // Both original records passed against real retained room/access rows.
    // Swapping their valid same-inviter signatures must bind to neither room.
    const first = a.browser.get(a.name)!, second = a.browser.get(b.name)!
    a.browser.set(a.name, second); a.browser.set(b.name, first)
    expect(() => validate(a.browser, a.tab, flags, capture(a.browser, a.tab))).toThrow(OrdinaryStateHold)
  } finally { a.release(); b.release() }
})
it('ignores unrelated origin rows without converting historical verification into current permission', async () => {
  const f = await routingCustodyFixture('rotated-old')
  try {
    vi.stubGlobal('location', { href: f.startupUrl }); const token = capture(f.browser, f.tab)
    f.browser.set('another-app.current-authority', 'unsigned')
    const result = validate(f.browser, f.tab, flags, token)
    expect(result.historicalRoomRelayRecords).toBe(1)
    expect(Object.values(result).filter(v => typeof v === 'string')).toEqual([])
  } finally { f.release() }
})
