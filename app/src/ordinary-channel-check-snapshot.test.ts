import { describe, expect, it, vi } from 'vitest'
import { ChannelChecks } from './channel-checks.js'
import { memoryDeviceStore } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { channelCheckHash } from '@forgesworn/signet-contacts'
import { validateOrdinaryChannelCheckSnapshot as validate } from './ordinary-channel-check-snapshot.js'
import { CHANNEL_CHECK_MODES, CHANNEL_CHECK_FAULTS, channelCheckFixture, damageChannelCheckFixture } from '../../test/ordinary-channel-check-fixture.js'

describe('nonce-bearing channel-check custody', () => {
  it.each(CHANNEL_CHECK_MODES)('preserves actual %s writer cuts, including old expired transcripts, without returning nonce or authority', async mode => {
    const { records } = await channelCheckFixture(mode), before = [...records]
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No fresh clock needed for custody') })
    try {
      const result = validate(records, false, { kind: 'browser' })
      expect(result).toEqual({ histories: mode === 'both' ? 2 : mode === 'empty' ? 0 : 1,
        checks: mode === 'both' ? 2 : mode === 'empty' ? 0 : 1, localComparisons: mode === 'both' ? 2 : mode === 'confirmed' ? 1 : 0 })
      expect(Object.isFrozen(result)).toBe(true); expect([...records]).toEqual(before)
      expect(validate(records, true, { kind: 'browser' })).toEqual(result)
    } finally { clock.mockRestore() }
  })
  it.each(CHANNEL_CHECK_FAULTS)('holds %s intact before and after custody, never loader-normalising a partial transcript', async fault => {
    const fixture = await channelCheckFixture(), records = new Map(fixture.records); damageChannelCheckFixture(fixture, records, fault)
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it('holds genuine rows relocated to a temporary tab owner', async () => {
    const { records } = await channelCheckFixture()
    expect(() => validate(records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
  it('accepts different allowed object key orders without changing bytes', async () => {
    const { records } = await channelCheckFixture()
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value
    for (const [key, raw] of records) records.set(key, JSON.stringify(reverse(JSON.parse(raw))))
    const before = [...records]; expect(validate(records, false, { kind: 'browser' }).checks).toBe(2); expect([...records]).toEqual(before)
  })
  it.each(['incoming', 'declined'] as const)('holds a %s request with invented sent or comparison markers', async mode => {
    const { records } = await channelCheckFixture(mode), [key, raw] = [...records][0]!
    for (const marker of ['sent', 'checkedAt']) {
      const rows = JSON.parse(raw); rows[0][marker] = marker === 'sent' ? channelCheckHash(rows[0].request) : 1700000000
      expect(() => validate(new Map([[key, JSON.stringify(rows)]]), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    }
  })
  it('holds an own request without its retained nonce state', async () => {
    const { records } = await channelCheckFixture('requested-unsent'), [key, raw] = [...records][0]!, rows = JSON.parse(raw)
    delete rows[0].state
    expect(() => validate(new Map([[key, JSON.stringify(rows)]]), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('holds a reveal-pending requester with a premature reveal sent marker', async () => {
    const { records } = await channelCheckFixture('reveal-pending'), [key, raw] = [...records][0]!, rows = JSON.parse(raw)
    rows[0].sent = channelCheckHash(rows[0].state.reveal)
    expect(() => validate(new Map([[key, JSON.stringify(rows)]]), true, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it.each(['request', 'reveal'] as const)('holds a recipient claiming it emitted the peer %s', async message => {
    const { records } = await channelCheckFixture('complete-recipient'), [key, raw] = [...records][0]!, rows = JSON.parse(raw)
    rows[0].sent = channelCheckHash(message === 'request' ? rows[0].request : rows[0].state.reveal)
    expect(() => validate(new Map([[key, JSON.stringify(rows)]]), true, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('holds a recipient nonce that does not match its pinned acceptance', async () => {
    const { records } = await channelCheckFixture('accepted-unsent'), [key, raw] = [...records][0]!, rows = JSON.parse(raw)
    rows[0].state.nonce = 'f'.repeat(64)
    expect(() => validate(new Map([[key, JSON.stringify(rows)]]), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('holds a comparison marker before protocol completion', async () => {
    const { records } = await channelCheckFixture('reveal-pending'), [key, raw] = [...records][0]!, rows = JSON.parse(raw)
    rows[0].checkedAt = 1700000000
    expect(() => validate(new Map([[key, JSON.stringify(rows)]]), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('retains the full 256-check actual writer capacity rather than pruning historical nonces', async () => {
    const store = memoryDeviceStore(), local = '1'.repeat(64), peer = '2'.repeat(64), context = '3'.repeat(64)
    let time = 1700000000
    const checks = new ChannelChecks({ store, local, context, current: () => true, now: () => time, lock: async task => task(), send: async () => {} })
    for (let i = 0; i < 256; i++) { await checks.start(peer); time += 601 }
    const records = new Map(store.keys().map(key => [key, store.get(key)!])), before = [...records]
    expect(validate(records, false, { kind: 'browser' })).toEqual({ histories: 1, checks: 256, localComparisons: 0 })
    expect([...records]).toEqual(before)
  })
  it('requires the mandatory complete composite to classify other families', () => {
    expect(validate(new Map([['kithmoot.contacts.v2.private', 'not a channel transcript']]), false, { kind: 'browser' })).toEqual({ histories: 0, checks: 0, localComparisons: 0 })
  })
})
