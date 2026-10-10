import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsMembershipController, removalComponentCopy } from './mls-membership-controller.js'
import { mlsGrantReference, planMlsGrant } from './mls-grant-ledger.js'
import type { MlsRemovalStatus } from './mls-room-operations.js'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { dmRelayListTemplate } from '../../src/dm-relays.js'
import { vmlsMemberGrantReference, type VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'

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

  it('journals an own-device member request and marks it requested only after OK true', async () => {
    const memberKey = generateSecretKey(), keeperKey = generateSecretKey()
    const member = { ...localIdentity(memberKey), ...localPeerCrypt(memberKey) } satisfies VmlsRevocationIdentity
    const keeper = localIdentity(keeperKey), accountContext = { ...context, vault: { ...context.vault, persona: member.pubkey } }
    const otherLeaf = 'aa'.repeat(32), otherDevice = 'bb'.repeat(32), nodeHex = bytesToHex(node)
    const reference = vmlsMemberGrantReference(nodeHex, otherDevice)
    let current: MlsRemovalStatus | undefined
    const operations = {
      members: vi.fn(async () => ({ state: 'active', value: [{ leafId: otherLeaf, identity: member.pubkey, device: otherDevice,
        homeBox: nodeHex, bindingExpiresAt: 9999, own: false, pending: false }] })),
      membership: vi.fn(async () => ({ state: 'active', value: current ? [structuredClone(current)] : [] })),
      roomRevocationAuthority: vi.fn(async () => ({ state: 'active', value: { name: 'Member room', keeper: keeper.pubkey } })),
      removeDevice: vi.fn(async (_c, _s, options) => {
        expect(options.grants.map((item: any) => ({ node: bytesToHex(item.node), grant: bytesToHex(item.grant), keeper: item.keeper })))
          .toEqual([{ node: nodeHex, grant: reference, keeper: false }])
        current = { operation: options.operation, session, kind: 'device', target: otherLeaf, compromised: true, createdAt: 1000,
          attempts: 0, failure: null, leaves: [otherLeaf], mls: 'Pending', credential: 'Unchanged',
          grants: [{ grant: options.grants[0], state: { type: 'NotAuthorised', requested: false } }],
          claim: 'ComponentsOnly', claimCopy: 'Only the component states below are known.', next: { type: 'Propose', leafIds: [hexToBytes(otherLeaf)] },
          request: structuredClone(options.request) }
        return { state: 'active', value: structuredClone(current) }
      }),
      removePerson: vi.fn(), driveRemoval: vi.fn(), retryRemoval: vi.fn(), setRemovalGrant: vi.fn(),
      setRemovalGrants: vi.fn(async (_c, _s, _o, changes) => {
        expect(changes).toEqual([{ grant: reference, state: { type: 'NotAuthorised', requested: true } }])
        current = { ...current!, grants: [{ ...current!.grants[0]!, state: changes[0]!.state }] }
        return { state: 'active', value: structuredClone(current) }
      }),
    }
    const grants = { records: vi.fn(async () => []), withdraw: vi.fn() }
    const controller = new BrowserMlsMembershipController(operations as any, grants as any, () => accountContext as any, () => session, () => member.pubkey, () => 1000)
    const plan = await controller.plan('device', otherLeaf, true)
    expect(plan.request).toEqual({ keeper: keeper.pubkey, device: otherDevice, sessions: [session], boxes: [nodeHex] })
    expect(plan.grants).toEqual([{ node: nodeHex, reference, device: otherDevice,
      rooms: [{ session, name: 'Member room', leaf: otherLeaf }], action: 'request' }])
    const opened = await controller.begin(plan)
    const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 1000))
    const publish = vi.fn(async (): Promise<void> => { throw new Error('relay refused') })
    await expect(controller.requestRevocation(opened.operation, { identity: member, directoryEvents: [list], publish, random: () => 0 }))
      .rejects.toThrow('relay refused')
    expect(operations.setRemovalGrants).not.toHaveBeenCalled()
    publish.mockImplementation(async () => undefined)
    const sent = await controller.requestRevocation(opened.operation, { identity: member, directoryEvents: [list], publish, random: () => 0 })
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ relays: ['wss://keeper.example/'], authenticate: false }))
    expect(sent.grants[0]!.state).toEqual({ type: 'NotAuthorised', requested: true })
    expect(grants.records).not.toHaveBeenCalled()
  })

  it('shows the engine claim verbatim and keeps component claims separate', () => {
    const status = removal('77'.repeat(32)), copy = removalComponentCopy(status)
    expect(copy.claim).toBe(status.claimCopy)
    expect(copy.mls).toContain('not yet applied and witnessed')
    expect(copy.grants[0]).toContain('not yet revoked at the box')
    expect(copy.hold).toContain('sends and Adds')
  })
})
