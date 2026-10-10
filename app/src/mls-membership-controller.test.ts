import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsMembershipController, removalComponentCopy } from './mls-membership-controller.js'
import { mlsGrantReference, planMlsGrant } from './mls-grant-ledger.js'
import type { MlsRemovalStatus } from './mls-room-operations.js'

const session = '11'.repeat(32), persona = '22'.repeat(32), device = '33'.repeat(32), leaf = '44'.repeat(32)
const node = new Uint8Array(32).fill(41), box = { routeId: 'box', eventUrl: `ws://${base32nopad.encode(node).toLowerCase()}/events` }
const context = { vault: { principal: 'https://test', persona, generation: 1, revision: 'rev-1' }, rendezvousKey: '55'.repeat(32), current: () => true } as any
const room = { session, name: 'Planning room', leaf }
function removal(reference: string): MlsRemovalStatus {
  return { operation: '66'.repeat(32), session, kind: 'device', target: leaf, compromised: true, createdAt: 1000, attempts: 0, failure: null, leaves: [leaf],
    mls: 'Pending', credential: 'Unchanged', grants: [{ grant: { node, grant: hexToBytes(reference), keeper: true }, state: { type: 'Pending' } }],
    claim: 'ComponentsOnly', claimCopy: 'Only the component states below are known.', next: { type: 'Propose', leafIds: [hexToBytes(leaf)] } }
}

describe('browser MLS membership composition', () => {
  it('opens from verified members, journals first, then revokes the exact discovered grant alongside Remove', async () => {
    const key = generateSecretKey(), identity = { pubkey: getPublicKey(key), signEvent: async (event: any) => finalizeEvent(event, key) }
    const record = await planMlsGrant(identity, box, persona, device, room, 1000), reference = mlsGrantReference(record.node, record.grantId)
    let current = removal(reference)
    const operations = {
      members: vi.fn(async () => ({ state: 'active', value: [{ leafId: leaf, identity: persona, device, homeBox: bytesToHex(node), bindingExpiresAt: 9999, own: false, pending: false }] })),
      membership: vi.fn(async () => ({ state: 'active', value: [structuredClone(current)] })),
      removeDevice: vi.fn(async (_c, _s, options) => { expect(bytesToHex(options.grants[0].grant)).toBe(reference); return { state: 'active', value: structuredClone(current) } }),
      removePerson: vi.fn(),
      driveRemoval: vi.fn(async () => ({ state: 'active', value: { membership: { ...current, mls: 'Committed' } } })),
      retryRemoval: vi.fn(async () => ({ state: 'active', value: structuredClone(current) })),
      setRemovalGrant: vi.fn(async (_c, _s, _o, _g, state) => { current = { ...current, mls: 'Committed', grants: [{ ...current.grants[0], state }] }; return { state: 'active', value: structuredClone(current) } }),
    }
    const records = vi.fn(async () => [record])
    const grants = { records, withdraw: vi.fn(async () => ({ record: { ...record, state: 'revoked' }, result: 'revoked' })) }
    const controller = new BrowserMlsMembershipController(operations as any, grants as any, () => context, () => session, () => identity.pubkey)
    const plan = await controller.plan('device', leaf, true)
    expect(plan.grants).toEqual([{ node: bytesToHex(node), reference, device, rooms: [room], action: 'revoke' }])
    current = { ...current, operation: plan.operation }
    const opened = await controller.begin(plan)
    expect(operations.removeDevice).toHaveBeenCalledOnce()
    expect(records).toHaveBeenCalledTimes(2)
    const advanced = await controller.advance(opened.operation)
    expect(records).toHaveBeenCalledTimes(3)
    expect(grants.withdraw).toHaveBeenCalledWith(bytesToHex(node), device, reference, session, [leaf], true)
    expect(operations.driveRemoval).toHaveBeenCalledOnce()
    expect(advanced).toMatchObject({ mls: 'Committed', grants: [{ state: { type: 'Revoked' } }] })
    current = { ...current, mls: 'Failed', failure: 'RemoveFailed', next: { type: 'Propose', leafIds: [hexToBytes(leaf)] } }
    await controller.advance(opened.operation)
    expect(operations.retryRemoval).toHaveBeenCalledOnce()
  })

  it('binds confirmation to the exact room and account snapshot', async () => {
    const key = generateSecretKey(), identity = { pubkey: getPublicKey(key), signEvent: async (event: any) => finalizeEvent(event, key) }
    const record = await planMlsGrant(identity, box, persona, device, room, 1000)
    let selected = session
    const operations = {
      members: vi.fn(async () => ({ state: 'active', value: [{ leafId: leaf, identity: persona, device, homeBox: bytesToHex(node), bindingExpiresAt: 9999, own: false, pending: false }] })),
      membership: vi.fn(async () => ({ state: 'active', value: [] })), removeDevice: vi.fn(), removePerson: vi.fn(), driveRemoval: vi.fn(), retryRemoval: vi.fn(), setRemovalGrant: vi.fn(),
    }
    const controller = new BrowserMlsMembershipController(operations as any, { records: async () => [record] } as any, () => context, () => selected, () => identity.pubkey)
    const plan = await controller.plan('device', leaf, false)
    selected = '99'.repeat(32)
    await expect(controller.begin(plan)).rejects.toThrow('room or account changed')
    expect(operations.removeDevice).not.toHaveBeenCalled()
  })

  it('does not start an ordinary grant grace until the Remove is committed', async () => {
    const record = { node: bytesToHex(node), device, grantId: '88'.repeat(16) }, reference = mlsGrantReference(record.node, record.grantId), status = removal(reference)
    status.compromised = false
    let current = structuredClone(status)
    const operations = {
      members: vi.fn(), membership: vi.fn(async () => ({ state: 'active', value: [structuredClone(current)] })), removeDevice: vi.fn(), removePerson: vi.fn(),
      driveRemoval: vi.fn(async () => ({ state: 'active', value: { membership: structuredClone(current) } })), retryRemoval: vi.fn(), setRemovalGrant: vi.fn(),
    }
    const grants = { records: vi.fn(async () => [{ ...record }]), withdraw: vi.fn(async () => ({ record, result: 'grace' })) }
    const controller = new BrowserMlsMembershipController(operations as any, grants as any, () => context, () => session, () => persona)
    await controller.advance(status.operation)
    expect(grants.withdraw).not.toHaveBeenCalled()
    current = { ...current, mls: 'Committed' }
    await controller.advance(status.operation)
    expect(grants.withdraw).toHaveBeenCalledWith(bytesToHex(node), device, reference, session, [leaf], false)
  })

  it('marks the reviewed component failed if withdrawal returns another grant', async () => {
    const key = generateSecretKey(), identity = { pubkey: getPublicKey(key), signEvent: async (event: any) => finalizeEvent(event, key) }
    const record = await planMlsGrant(identity, box, persona, device, room, 1000), reference = mlsGrantReference(record.node, record.grantId)
    let current = removal(reference)
    const replacement = { ...record, grantId: '99'.repeat(16), state: 'revoked' as const }
    const operations = {
      members: vi.fn(), membership: vi.fn(async () => ({ state: 'active', value: [structuredClone(current)] })), removeDevice: vi.fn(), removePerson: vi.fn(),
      driveRemoval: vi.fn(async () => ({ state: 'active', value: { membership: structuredClone(current) } })), retryRemoval: vi.fn(),
      setRemovalGrant: vi.fn(async (_c, _s, _o, _g, state) => { current = { ...current, grants: [{ ...current.grants[0], state }] }; return { state: 'active', value: structuredClone(current) } }),
    }
    const grants = { records: async () => [record], withdraw: vi.fn(async () => ({ record: replacement, result: 'revoked' })) }
    const controller = new BrowserMlsMembershipController(operations as any, grants as any, () => context, () => session, () => identity.pubkey)
    const result = await controller.advance(current.operation)
    expect(operations.setRemovalGrant).toHaveBeenCalledWith(context, session, current.operation, reference, { type: 'Failed' })
    expect(result.grants[0].state).toEqual({ type: 'Failed' })
  })

  it('shows the engine claim verbatim and keeps component claims separate', () => {
    const status = removal('77'.repeat(32)), copy = removalComponentCopy(status)
    expect(copy.claim).toBe(status.claimCopy)
    expect(copy.mls).toContain('not yet applied and witnessed')
    expect(copy.grants[0]).toContain('not yet revoked at the box')
    expect(copy.hold).toContain('sends and Adds')
  })
})
