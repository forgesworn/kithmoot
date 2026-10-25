import { describe, expect, it, vi } from 'vitest'
import { nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import type { JournalHead, JournalSegment } from '../../src/journal-storage.js'
import { validateOrdinaryJournalSnapshot as validate } from './ordinary-journal-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { JOURNAL_MODES, JOURNAL_FAULTS, journalFixture, damageJournalFixture, upperContextJournal } from '../../test/ordinary-journal-fixture.js'

const digest = (value: string): string => bytesToHex(sha256(new TextEncoder().encode(value)))
const sideRef = (root: string, raw: string) => ({ key: `${root}.journal.v2.${digest(raw)}`, sha256: digest(raw) })
function rewriteTip(records: Map<string, string>, root: string, change: (segment: JournalSegment) => JournalSegment): void {
  const head = JSON.parse(records.get(root)!) as JournalHead
  const segment = JSON.parse(records.get(head.tip!.key)!) as JournalSegment
  const raw = JSON.stringify(change(segment)), tip = sideRef(root, raw)
  records.set(tip.key, raw); records.set(root, JSON.stringify({ ...head, tip }))
}

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
        events: ['assignment-overlap', 'assignment-delivered', 'assignment-v2-overlap', 'assignment-v2-delivered', 'all'].includes(mode) ? 1 : 0,
        pending: ['assignment-pending', 'assignment-overlap', 'assignment-v2-pending', 'assignment-v2-overlap'].includes(mode) ? 1 : 0,
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
  it('retains a well-formed unreferenced v2 crash orphan without changing logical counts', async () => {
    const fixture = await journalFixture('assignment-v2-delivered'), records = new Map(fixture.records)
    const root = `kithmoot.assignments.v1.${fixture.account}.${fixture.room}`, head = JSON.parse(records.get(root)!) as JournalHead
    const tip = JSON.parse(records.get(head.tip!.key)!) as JournalSegment
    const raw = JSON.stringify({ ...tip, previous: head.tip, body: JSON.stringify({ v: 2, add: [], outbox: [] }) }), orphan = sideRef(root, raw)
    records.set(orphan.key, raw)
    expect(validate(records, false, { kind: 'browser' })).toEqual({ projects: 0, assignments: 1, events: 1, pending: 0, contexts: 0, collections: 0 })
  })
  it.each(['missing-base', 'missing-tip', 'bad-delta', 'unknown-delta', 'wrong-base', 'outbox-cap', 'event-cap', 'head-extra', 'unsupported-head', 'side-hash'])('holds v2 %s without rewriting any record', async fault => {
    const fixture = await journalFixture('assignment-v2-delivered'), records = new Map(fixture.records)
    const root = `kithmoot.assignments.v1.${fixture.account}.${fixture.room}`, head = JSON.parse(records.get(root)!) as JournalHead
    const ciphertext = nip44.v2.encrypt('x'.repeat(32), new Uint8Array(32))
    if (fault === 'missing-base') records.delete(head.base!.key)
    if (fault === 'missing-tip') records.delete(head.tip!.key)
    if (fault === 'bad-delta') rewriteTip(records, root, segment => ({ ...segment, body: JSON.stringify({ v: 2, add: ['invalid_ciphertext'] }) }))
    if (fault === 'unknown-delta') rewriteTip(records, root, segment => ({ ...segment, body: JSON.stringify({ v: 2, add: [], unknown: true }) }))
    if (fault === 'wrong-base') rewriteTip(records, root, segment => ({ ...segment, base: { ...segment.base, key: segment.base.key.replace(fixture.room, 'f'.repeat(64)) } }))
    if (fault === 'outbox-cap') rewriteTip(records, root, segment => ({ ...segment, body: JSON.stringify({ v: 2, add: [], outbox: Array(101).fill(ciphertext) }) }))
    if (fault === 'event-cap') rewriteTip(records, root, segment => ({ ...segment, body: JSON.stringify({ v: 2, add: Array(20001).fill(ciphertext) }) }))
    if (fault === 'head-extra') records.set(root, JSON.stringify({ ...head, extra: true }))
    if (fault === 'unsupported-head') records.set(root, JSON.stringify({ ...head, v: 3 }))
    if (fault === 'side-hash') records.set(head.tip!.key, records.get(head.tip!.key)! + ' ')
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it('retains a well-formed unreferenced project v2 crash orphan without changing logical counts', async () => {
    const fixture = await journalFixture('project-v2-delivered'), records = new Map(fixture.records)
    const root = `kithmoot.shared-projects.v1.${fixture.account}`, head = JSON.parse(records.get(root)!) as JournalHead
    const tip = JSON.parse(records.get(head.tip!.key)!) as JournalSegment
    const body = nip44.v2.encrypt('x'.repeat(32), new Uint8Array(32))
    const raw = JSON.stringify({ ...tip, previous: head.tip, body }), orphan = sideRef(root, raw)
    records.set(orphan.key, raw)
    expect(validate(records, false, { kind: 'browser' })).toEqual({ projects: 1, assignments: 0, events: 0, pending: 0, contexts: 0, collections: 0 })
  })
  it.each(['missing-base', 'missing-tip', 'bad-body', 'wrong-base', 'head-extra', 'unsupported-head', 'side-hash'])('holds project v2 %s without rewriting any record', async fault => {
    const fixture = await journalFixture('project-v2-delivered'), records = new Map(fixture.records)
    const root = `kithmoot.shared-projects.v1.${fixture.account}`, head = JSON.parse(records.get(root)!) as JournalHead
    if (fault === 'missing-base') records.delete(head.base!.key)
    if (fault === 'missing-tip') records.delete(head.tip!.key)
    if (fault === 'bad-body') rewriteTip(records, root, segment => ({ ...segment, body: 'invalid_ciphertext' }))
    if (fault === 'wrong-base') rewriteTip(records, root, segment => ({ ...segment, base: { ...segment.base, key: segment.base.key.replace(fixture.account, 'f'.repeat(64)) } }))
    if (fault === 'head-extra') records.set(root, JSON.stringify({ ...head, extra: true }))
    if (fault === 'unsupported-head') records.set(root, JSON.stringify({ ...head, v: 3 }))
    if (fault === 'side-hash') records.set(head.tip!.key, records.get(head.tip!.key)! + ' ')
    const before = [...records]
    for (const migrated of [false, true]) expect(() => validate(records, migrated, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect([...records]).toEqual(before)
  })
  it('leaves unrelated families for the required complete composite', () => {
    expect(validate(new Map([['kithmoot.device.private', 'opaque']]), false, { kind: 'browser' }).projects).toBe(0)
  })
})
