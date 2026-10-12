import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { MAX_KEPT, PendingSends, type KeptPendingSend } from './pending-sends.js'
import { validateOrdinaryPendingSnapshot as validate, validateOrdinaryPendingPair as pair } from './ordinary-pending-snapshot.js'

const key = new Uint8Array(32); key[31] = 1
const account = getPublicKey(key), roomId = 'a'.repeat(64)
const name = (a = account, r = roomId) => `kithmoot.account.${a}.kithmoot.pending.${r}`
function row(id = 'one'): KeptPendingSend { return { id, channel: 'Chat', text: 'text ' + id, files: [], state: 'waiting',
  event: finalizeEvent({ kind: 1, created_at: 1, tags: [['d', roomId], ['p', account]], content: id }, key) } }
const options = { accepts: (a: string, r: string, v: KeptPendingSend) => a === account && r === roomId && v.event.content === v.id &&
  v.event.tags.some(t => t[0] === 'd' && t[1] === r) && v.event.tags.some(t => t[0] === 'p' && t[1] === a) }
const image = (rows: KeptPendingSend[]) => new Map([[name(), JSON.stringify(rows)]])
afterEach(() => vi.restoreAllMocks())
describe('pre-owner pending partition', () => {
  it('validates actual queue writer bytes for both owners without sending', async () => {
    let saved = { durable: null as string | null, transient: null as string | null }
    const q = new PendingSends({ connected: () => false, schedule: () => {}, storage: { load: async () => ({ ...saved }), retain: async (_room, durable, transient) => { saved = { durable, transient } } } })
    for (const [id, durable] of [['one', true], ['two', false]] as const) { const v = row(id); await q.add({ ...v, roomId, durable }) }
    expect(validate(new Map([[name(), saved.durable!]]), new Map([[name(), saved.transient!]]), options)).toEqual({ queues: 1, records: 2, durableRecords: 1, transientRecords: 1 })
    await q.close()
  })
  it('does not allocate entropy, consult the clock or expose send records', () => {
    const a = image([row()]), b = image([row('two')]), before = [[...a], [...b]]
    vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('clock') })
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw Error('entropy') })
    const c = validate(a, b, options)
    expect(c).toEqual({ queues: 1, records: 2, durableRecords: 1, transientRecords: 1 }); expect(Object.isFrozen(c)).toBe(true)
    expect([[...a], [...b]]).toEqual(before)
  })
  it('requires a binding callback even for empty images', () => {
    expect(() => validate(new Map(), new Map(), {} as typeof options)).toThrow(OrdinaryStateHold)
    expect(() => pair({ durable: null, transient: null }, undefined as never)).toThrow(OrdinaryStateHold)
  })
  it('preserves the adapter binding exception while raw preflight normalises it to HOLD', () => {
    const error = new Error('binding failed'), accepts = () => { throw error }
    expect(() => pair({ durable: JSON.stringify([row()]), transient: null }, accepts)).toThrow(error)
    expect(() => validate(image([row()]), new Map(), { accepts })).toThrow(OrdinaryStateHold)
  })
  it('retains empty cuts without inventing sends', () => { expect(validate(image([]), new Map(), options)).toEqual({ queues: 1, records: 0, durableRecords: 0, transientRecords: 0 }) })
  for (const state of ['waiting', 'refused', 'unknown', 'moved'] as const) it(`retains ${state} without attaching a publisher`, () => {
    const v = row(); v.state = state; expect(validate(image([v]), new Map(), options).records).toBe(1)
  })
  it('checks one queue capacity across both owners', () => {
    const rows = Array.from({ length: MAX_KEPT }, (_, i) => row(String(i)))
    expect(validate(image(rows.slice(0, 25)), image(rows.slice(25)), options).records).toBe(MAX_KEPT)
    expect(() => validate(image(rows.slice(0, 25)), image([...rows.slice(25), row('extra')]), options)).toThrow(OrdinaryStateHold)
  })
  it('captures every queue before callbacks can mutate caller maps', () => {
    const other = name(account, 'b'.repeat(64)), a = image([row()]); a.set(other, JSON.stringify([row('two')]))
    let called = 0
    expect(validate(a, new Map(), { accepts: (acct, room, value) => { called++; a.delete(other); value.id = 'changed'; return acct === account && [roomId, 'b'.repeat(64)].includes(room) } })).toEqual({ queues: 2, records: 2, durableRecords: 2, transientRecords: 0 })
    expect(called).toBe(2)
  })
  for (const fault of ['legacy', 'root', 'wrapped', 'version', 'scope', 'signature', 'cache', 'event-extra', 'row-extra', 'state', 'editable', 'files', 'artwork', 'duplicate', 'cross-owner-duplicate', 'capacity', 'oversize', 'binding-false', 'binding-undefined', 'binding-throw']) it(`holds ${fault} and preserves source bytes`, () => {
    const v = row(); let a = image([v]), b = new Map<string, string>(), opts = options
    if (fault === 'legacy') a = new Map([['kithmoot.pending.' + roomId, JSON.stringify([v])]])
    if (fault === 'root') a = new Map([['kithmoot.pending', '[]']])
    if (fault === 'wrapped') a = new Map([['kithmoot.account.' + account + '.' + name(), JSON.stringify([v])]])
    if (fault === 'version') a = new Map([[name() + '.v2', JSON.stringify([v])]])
    if (fault === 'scope') a = new Map([[name('b'.repeat(64)), JSON.stringify([v])]])
    if (fault === 'signature') { v.event.content = 'tampered'; a = image([v]) }
    if (fault === 'cache') { v.event.content = 'tampered'; (v.event as unknown as Record<symbol, unknown>)[Symbol.for('verified')] = true; a = image([v]) }
    if (fault === 'event-extra') { Object.assign(v.event, { extra: true }); a = image([v]) }
    if (fault === 'row-extra') { Object.assign(v, { extra: true }); a = image([v]) }
    if (fault === 'state') { v.state = 'sending' as never; a = image([v]) }
    if (fault === 'editable') { v.editable = false as never; a = image([v]) }
    if (fault === 'files') { v.files = [1] as never; a = image([v]) }
    if (fault === 'artwork') { v.artwork = [{}] as never; a = image([v]) }
    if (fault === 'duplicate') a = image([v, v])
    if (fault === 'cross-owner-duplicate') b = image([v])
    if (fault === 'capacity') a = image(Array.from({ length: MAX_KEPT + 1 }, (_, i) => row(String(i))))
    if (fault === 'oversize') a = new Map([[name(), 'x'.repeat(ORDINARY_VALUE_UNITS + 1)]])
    if (fault === 'binding-false') opts = { accepts: () => false }
    if (fault === 'binding-undefined') opts = { accepts: () => undefined as never }
    if (fault === 'binding-throw') opts = { accepts: () => { throw Error('binding') } }
    const before = [[...a], [...b]]; expect(() => validate(a, b, opts)).toThrow(OrdinaryStateHold); expect([[...a], [...b]]).toEqual(before)
  })
})
