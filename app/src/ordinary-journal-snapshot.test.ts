import { describe, expect, it, vi } from 'vitest'
import { nip44 } from 'nostr-tools'
import { validateOrdinaryJournalSnapshot as validate } from './ordinary-journal-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { JOURNAL_MODES, JOURNAL_FAULTS, journalFixture, damageJournalFixture, upperContextJournal } from '../../test/ordinary-journal-fixture.js'

describe('encrypted journal offline custody', () => {
  it.each(JOURNAL_MODES)('retains actual %s writer cut exactly without clock, decrypt or network', async mode => {
    const { records } = await journalFixture(mode), before = [...records]
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No custody clock') })
    try {
      const result = validate(records, false, { kind: 'browser' })
      expect(Object.isFrozen(result)).toBe(true); expect([...records]).toEqual(before)
      expect(validate(records, true, { kind: 'browser' })).toEqual(result)
      expect(result).toEqual({ projects: mode.startsWith('project-') || mode === 'all' ? 1 : 0,
        assignments: mode.startsWith('assignment-') || mode === 'all' ? 1 : 0,
        events: ['assignment-overlap', 'assignment-delivered', 'all'].includes(mode) ? 1 : 0,
        pending: ['assignment-pending', 'assignment-overlap'].includes(mode) ? 1 : 0,
        contexts: mode.startsWith('context-') || mode === 'all' ? 1 : 0,
        collections: mode === 'context-large' ? 25 : mode.startsWith('context-') && mode !== 'context-empty' || mode === 'all' ? 1 : 0 })
    } finally { clock.mockRestore() }
  })
  it.each(JOURNAL_FAULTS)('holds %s intact in raw and completed custody', async fault => {
    const fixture = await journalFixture(), records = new Map(fixture.records)
    damageJournalFixture(fixture, records, fault); const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it('refuses browser journals in a temporary owner', async () => {
    const fixture = await journalFixture(); expect(() => validate(fixture.records, true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
  it('preserves signer-returned event insertion order', async () => {
    const fixture = await journalFixture('context-one'), [key, raw] = [...fixture.records][0]!, value = JSON.parse(raw)
    value.collections[0].access = Object.fromEntries(Object.entries(value.collections[0].access).reverse())
    const reordered = JSON.stringify(value); fixture.records.set(key, reordered)
    expect(validate(fixture.records, false, { kind: 'browser' }).collections).toBe(1)
    expect(fixture.records.get(key)).toBe(reordered)
  })
  it('rejects a reordered fixed outer writer object instead of normalising it', async () => {
    const fixture = await journalFixture('context-empty'), [key, raw] = [...fixture.records][0]!
    fixture.records.set(key, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).reverse())))
    expect(() => validate(fixture.records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it.each([1, 32, 33, 64, 255, 256, 257, 65535, 65536, 65537, 100000])('accepts primary NIP44 writer framing at %s bytes', async length => {
    const fixture = await journalFixture('assignment-delivered'), key = [...fixture.records.keys()][0]!, value = JSON.parse(fixture.records.get(key)!)
    // Primary encryption, synthetic plaintext: this checks framing only, not
    // a valid inner Assignment operation or room-key authentication.
    value.events = [nip44.v2.encrypt('x'.repeat(length), new Uint8Array(32))]; fixture.records.set(key, JSON.stringify(value))
    expect(validate(fixture.records, false, { kind: 'browser' }).events).toBe(1)
  })
  it('does not claim ciphertext MAC authentication or assignment physical account/room binding', async () => {
    const fixture = await journalFixture('assignment-delivered'), [key, raw] = [...fixture.records][0]!, value = JSON.parse(raw)
    value.events[0] = value.events[0].slice(0, 10) + (value.events[0][10] === 'A' ? 'B' : 'A') + value.events[0].slice(11)
    const changed = JSON.stringify(value); fixture.records.clear(); fixture.records.set(key.replace(fixture.account, 'f'.repeat(64)), changed)
    expect(validate(fixture.records, false, { kind: 'browser' }).events).toBe(1)
    expect([...fixture.records.values()]).toEqual([changed])
  })
  it('keeps larger possibly legitimate journal values intact before JSON parsing', () => {
    const raw = 'x'.repeat(ORDINARY_VALUE_BYTES + 1), records = new Map([['kithmoot.context.v1.' + 'a'.repeat(64), raw]])
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('Parse must not run') })
    try { expect(() => validate(records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold); expect(parse).not.toHaveBeenCalled() }
    finally { parse.mockRestore() }
    expect([...records.values()]).toEqual([raw])
  })
  it('recognises the real v2 envelope upper writer bucket and restores its encrypted bytes', async () => {
    const fixture = await upperContextJournal(), [key, raw] = [...fixture.records][0]!, value = JSON.parse(raw)
    const binary = atob(value.collections[0].envelope)
    expect(binary.length).toBe(2 * 1024 * 1024 + 88); expect(fixture.envelopePreserved).toBe(true)
    expect(fixture.snapshotBytes).toBe(1024 * 1024); expect(binary.slice(0, 8)).toBe('FSWNENC2')
    expect(new DataView(Uint8Array.from(binary.slice(0, 56), c => c.charCodeAt(0)).buffer).getUint32(12, false)).toBe(2)
    expect(validate(fixture.records, false, { kind: 'browser' }).collections).toBe(1)
    value.collections[0].envelope = btoa(binary + 'x'); fixture.records.set(key, JSON.stringify(value))
    expect(() => validate(fixture.records, false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
  it('leaves unrelated families for the required complete composite', () => {
    expect(validate(new Map([['kithmoot.device.private', 'opaque']]), false, { kind: 'browser' }).projects).toBe(0)
  })
})
