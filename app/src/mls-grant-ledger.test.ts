import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { BrowserMlsGrantLedger, mlsBoxNode, mlsGrantReference, mlsGrantScope, planMlsGrant, removalGrantRefs, type MlsGrantRecord } from './mls-grant-ledger.js'

const node = new Uint8Array(32).fill(31)
const box = { routeId: 'bothy-one', eventUrl: `ws://${base32nopad.encode(node).toLowerCase()}/events` }
const persona = '22'.repeat(32), device = '33'.repeat(32), leaf = '44'.repeat(32)
const room = { session: '66'.repeat(32), name: 'Planning room', leaf }
function signer(): ParticipantIdentity {
  const key = generateSecretKey()
  return { pubkey: getPublicKey(key), signEvent: async template => finalizeEvent(template, key) }
}
function fixture() {
  const identity = signer(), records: MlsGrantRecord[] = [], snapshots: MlsGrantRecord[] = [], published: string[] = []
  let fail = false, now = 1000
  const store = { all: async () => structuredClone(records), put: async (record: MlsGrantRecord) => {
    records.splice(0, records.length, ...records.filter(item => item.node !== record.node || item.device !== record.device), structuredClone(record)); snapshots.push(structuredClone(record))
  } }
  const link = { resume: vi.fn(async () => [box]), boxes: () => [box], openSocket: vi.fn() }
  const ledger = new BrowserMlsGrantLedger(() => identity, link as any, store, record => ({
    publish: async event => { published.push(event.id); if (fail) throw new Error('lost OK') }, close: () => undefined,
  }), () => now, async (_key, work) => work())
  return { identity, records, snapshots, published, ledger, fail: (value: boolean) => { fail = value }, clock: (value: number) => { now = value } }
}

describe('browser VMLS grant ledger', () => {
  it('signs a device-wide VMLS scope and a retained withdrawal before use', async () => {
    const identity = signer(), record = await planMlsGrant(identity, box, persona, device, room, 1000)
    expect(record.node).toBe(bytesToHex(node))
    expect(record.active.tags).toContainEqual(['d', mlsGrantScope(device)])
    expect(record.active.tags).toContainEqual(['vmls', String(64 * 1024 * 1024)])
    expect(record.active.tags.some(tag => tag[0] === 'write')).toBe(false)
    expect(record.revocation.tags.at(-1)).toEqual(['status', 'revoked'])
    expect(record.revocation.created_at).toBeGreaterThan(record.active.created_at)
  })

  it('retries immutable installation and revocation events after uncertain acknowledgements', async () => {
    const f = fixture(); f.fail(true)
    await expect(f.ledger.install(box, persona, device, room)).rejects.toThrow('lost OK')
    expect(f.records[0].state).toBe('installing')
    const active = f.records[0].active.id
    f.fail(false); await f.ledger.install(box, persona, device, room)
    expect(f.published.slice(0, 2)).toEqual([active, active])
    const reference = mlsGrantReference(f.records[0].node, f.records[0].grantId)
    f.fail(true); await expect(f.ledger.withdraw(bytesToHex(node), device, reference, room.session, [leaf], true)).rejects.toThrow('lost OK')
    expect(f.records[0].state).toBe('revoking')
    const revoked = f.records[0].revocation.id
    f.fail(false); await f.ledger.withdraw(bytesToHex(node), device, reference, room.session, [leaf], true)
    expect(f.published.slice(-2)).toEqual([revoked, revoked])
    expect(f.records[0].state).toBe('revoked')
    expect(f.snapshots.map(record => record.state)).toEqual(['installing','active','revoking','revoked'])
  })

  it('lists only live grants issued by this keeper and hashes their stable grant ids', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    const other = { ...installed, device: '44'.repeat(32), persona: f.identity.pubkey, grantId: '55'.repeat(16) }
    const refs = removalGrantRefs(f.identity.pubkey, [device, other.device], [installed, other])
    expect(refs).toHaveLength(1)
    expect(bytesToHex(refs[0].node)).toBe(mlsBoxNode(box))
    expect(bytesToHex(refs[0].grant)).toBe(mlsGrantReference(installed.node, installed.grantId))
    installed.state = 'revoked'
    expect(removalGrantRefs(f.identity.pubkey, [device], [installed])).toEqual([])
  })

  it('sorts a replacement grant after the terminal revocation on the same device scope', async () => {
    const identity = signer(), retired = await planMlsGrant(identity, box, persona, device, room, 1000)
    retired.state = 'revoked'
    const replacement = await planMlsGrant(identity, box, persona, device, room, 1000, retired)
    expect(replacement.grantId).not.toBe(retired.grantId)
    expect(replacement.active.created_at).toBeGreaterThan(retired.revocation.created_at)
  })

  it('retains a shared normal grant, then gives its last room a durable 24-hour grace', async () => {
    const f = fixture(), other = { session: '77'.repeat(32), name: 'Finance room', leaf: '55'.repeat(32) }
    const first = await f.ledger.install(box, persona, device, room)
    const shared = await f.ledger.install(box, persona, device, other)
    const reference = mlsGrantReference(shared.node, shared.grantId)
    expect(shared.rooms.map(use => use.name)).toEqual(['Planning room', 'Finance room'])
    expect((await f.ledger.withdraw(shared.node, device, reference, room.session, [room.leaf], false)).result).toBe('retained')
    const grace = await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)
    expect(grace).toMatchObject({ result: 'grace', record: { rooms: [], revokeAfter: 87400, state: 'active' } })
    expect(f.published).toEqual([first.active.id])
    f.clock(87399); expect((await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)).result).toBe('grace')
    f.clock(87400); expect((await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)).result).toBe('revoked')
    expect(f.published.at(-1)).toBe(shared.revocation.id)
  })

  it('refuses to withdraw a replacement that does not match the reviewed reference', async () => {
    const f = fixture(), reviewed = await f.ledger.install(box, persona, device, room)
    const reference = mlsGrantReference(reviewed.node, reviewed.grantId)
    const replacement = await planMlsGrant(f.identity, box, persona, device, room, 1002, { ...reviewed, state: 'revoked' })
    f.records[0] = replacement
    await expect(f.ledger.withdraw(reviewed.node, device, reference, room.session, [leaf], true)).rejects.toThrow('changed before withdrawal')
    expect(f.published).toEqual([reviewed.active.id])
  })

  it('preserves every room through uncertain installation and expired renewal', async () => {
    const f = fixture(), other = { session: '77'.repeat(32), name: 'Finance room', leaf: '55'.repeat(32) }
    f.fail(true); await expect(f.ledger.install(box, persona, device, room)).rejects.toThrow('lost OK')
    f.fail(false)
    const recovered = await f.ledger.install(box, persona, device, other)
    expect(recovered.rooms).toEqual([room, other])
    f.clock(recovered.expiration + 1)
    const renewed = await f.ledger.install(box, persona, device, room, recovered.expiration + 1)
    expect(renewed.rooms).toEqual([room, other])
  })

  it('does not let an old removal detach a later admission in the same room', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    const reference = mlsGrantReference(installed.node, installed.grantId)
    expect((await f.ledger.withdraw(installed.node, device, reference, room.session, [room.leaf], false)).result).toBe('grace')
    const admitted = { ...room, leaf: '55'.repeat(32) }
    const restored = await f.ledger.install(box, persona, device, admitted)
    expect(restored).toMatchObject({ rooms: [admitted], revokeAfter: null, state: 'active' })
    f.clock(1000 + 2 * 86400)
    const stale = await f.ledger.withdraw(installed.node, device, reference, room.session, [room.leaf], false)
    expect(stale).toMatchObject({ result: 'retained', record: { rooms: [admitted], revokeAfter: null, state: 'active' } })
    expect(f.published).toEqual([installed.active.id])
  })
})
