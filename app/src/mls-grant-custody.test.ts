import { expect, it } from 'vitest'
import { base32nopad } from '@scure/base'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { planMlsGrant } from './mls-grant-ledger.js'
import { mlsGrantCustody, mlsGrantCustodyDigest, mlsGrantCustodyRecords } from './mls-grant-custody.js'

async function grant() {
  const key = new Uint8Array(32).fill(42)
  return planMlsGrant({ pubkey: getPublicKey(key), signEvent: async template => finalizeEvent(template, key) },
    { routeId: 'node-one', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(43)).toLowerCase()}/events` },
    '44'.repeat(32), '45'.repeat(32), { session: '46'.repeat(32), leaf: '45'.repeat(32), name: 'Retained room' }, 1_000)
}
it('rejects hostile coercions and noncanonical keys before signed-term processing', async () => {
  const record = await grant(), called: string[] = []
  const hostile = { toString: () => { called.push('coerced'); return record.device } }
  expect(() => mlsGrantCustodyRecords([{ ...record, device: hostile }])).toThrow()
  for (const change of [{ grantId: record.grantId + '\n' }, { box: { ...record.box, routeId: 'node-one\n' } },
    { rooms: [{ ...record.rooms[0], leaf: hostile }] }, { active: { ...record.active, tags: [['t', hostile]] } }]) {
    expect(() => mlsGrantCustodyRecords([{ ...record, ...change }])).toThrow()
  }
  expect(called).toEqual([])
})
it('binds every retained state and full room authority while ignoring object insertion order', async () => {
  const record = await grant(), custody = { version: 2 as const, phase: 'fenced' as const, fence: '47'.repeat(32), records: [record] }
  const reversed = (value: any): any => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value
  expect(mlsGrantCustodyDigest(reversed(custody))).toBe(mlsGrantCustodyDigest(custody))
  for (const state of ['active','revoking','revoked'] as const) expect(mlsGrantCustodyDigest({ ...custody, records: [{ ...record, state }] })).not.toBe(mlsGrantCustodyDigest(custody))
  expect(mlsGrantCustodyDigest({ ...custody, records: [{ ...record, rooms: [{ ...record.rooms[0], name: 'Changed room' }] }] })).not.toBe(mlsGrantCustodyDigest(custody))
  expect(mlsGrantCustodyDigest({ ...custody, phase: 'ready' })).not.toBe(mlsGrantCustodyDigest(custody))
})
it('refuses ambiguous fence envelopes and duplicate or excessive authority', async () => {
  const record = await grant(), custody = { version: 2, phase: 'fenced', fence: '47'.repeat(32), records: [record] }
  for (const change of [{ version: '2' }, { phase: true }, { fence: custody.fence + '\n' }, { ready: true }, { records: [record, record] }, { records: Array(257).fill(record) }]) {
    expect(() => mlsGrantCustody({ ...custody, ...change })).toThrow()
  }
})
it('does not let previously verified signed events authenticate changed retained statements', async () => {
  const record = await grant()
  expect(() => mlsGrantCustodyRecords([{ ...record, active: { ...record.active, content: 'changed after signature' } }])).toThrow()
  expect(() => mlsGrantCustodyRecords([{ ...record, revocation: { ...record.revocation, sig: 'ff'.repeat(64) } }])).toThrow()
  const retained = mlsGrantCustodyRecords([record])[0].revocation
  expect(retained).toEqual(JSON.parse(JSON.stringify(record.revocation)))
  expect(Object.getOwnPropertySymbols(retained)).toHaveLength(0)
})
