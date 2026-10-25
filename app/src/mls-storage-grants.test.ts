import { mlsGrantCustody as frozenA10Custody } from './mls-grant-custody-a10-frozen.fixture.js'
import { mlsGrantCustody } from './mls-grant-custody.js'
import { mlsKeeperGrantAuthority } from './mls-revocation-decision-store.js'
import { assertLegacyGrantScope, assertStorageGrantScopeAvailable, claimStorageGrantScope, changeStorageGrantScope, type MlsGrantScopeCustody } from './mls-grant-scope-custody.js'
import { BrowserMlsGrantLedger, planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { BrowserMlsKeeperAdmission } from './mls-keeper-admission.js'
import { storageInboxCoordinator, storageInboxTransaction } from './mls-storage-inbox.js'
import { BrowserMlsKeeperPrivateInboxFetch } from './mls-keeper-private-inbox-fetch.js'
import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { wrapVmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import type { PersonaTransaction } from './mls-persona-coordinator.js'
import { BrowserMlsGrantForeground } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { BrowserMlsStorageGrants } from './mls-storage-grants.js'
import { BrowserMlsRevocationInbox } from './mls-revocation-inbox.js'
import { readMlsMembership } from './mls-membership-store.js'

const native = vi.hoisted(() => ({ load: vi.fn(() => { throw new Error('Legacy/native membership sentinel') }) }))
vi.mock('./mls-engine.js', () => ({ loadMlsEngine: native.load }))
class MemoryTransaction implements PersonaTransaction {
  installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession(): Promise<never> { throw new Error('Storage decisions must not open a room') }
  async putSession(): Promise<never> { throw new Error('Storage decisions must not change MLS state') }
  async dropSession(): Promise<never> { throw new Error('Storage decisions must not delete MLS state') }
}
const value = (result: any): any => { expect(result.state).toBe('active'); return result.value }
async function fixture() {
  const key = generateSecretKey(), keeper = { ...localIdentity(key), ...localPeerCrypt(key) }, memberKey = generateSecretKey()
  const member = { ...localIdentity(memberKey), ...localPeerCrypt(memberKey) }, device = '33'.repeat(32), tx = new MemoryTransaction()
  let live = true, now = 1_800_000_000, hold = false, refuseSave = false, inTransaction = false
  const context = () => ({ vault: { principal: 'https://test', persona: keeper.pubkey, generation: 1, revision: 'one' }, current: () => live, foreground: () => live })
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (inTransaction) throw new Error('Nested persona transaction')
    if (hold || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([id, bytes]) => [id, bytes.slice()])))
    inTransaction = true
    try {
      const result = await work(candidate)
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      if (refuseSave) throw new Error('Witness refused durable save')
      tx.vault.clear(); for (const [id, bytes] of candidate.vault) tx.vault.set(id, bytes)
      return { state: 'active', value: result, marks: new Map() }
    } finally { inTransaction = false }
  } }
  const box = { routeId: 'storage-node', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(44)).toLowerCase()}/events` }
  const endpoint = new BrowserMlsGrantEndpoint(new BrowserMlsGrantForeground(), () => keeper, () => live)
  vi.spyOn(endpoint, 'pairedBoxes').mockResolvedValue([box]); vi.spyOn(endpoint, 'resume').mockResolvedValue([box])
  const publish = vi.spyOn(endpoint, 'publishLabDeviceGrant').mockImplementation(async (_box, _event, _device, current) => { if (!current()) throw new Error('stale') })
  let custody: MlsGrantScopeCustody = { version: 2, phase: 'ready', fence: '88'.repeat(32), records: [] }
  const scopes = {
    assertStorageAvailable: async (g: Pick<MlsGrantRecord, 'node' | 'device'>, at: number) => assertStorageGrantScopeAvailable(custody, g, at),
    claimStorageScope: async (g: MlsGrantRecord, at: number) => { custody = claimStorageGrantScope(custody, g, at) },
    changeStorageScope: async (g: MlsGrantRecord, state: any, at: number) => { custody = changeStorageGrantScope(custody, g, state, at) },
  }
  const legacyStore = { all: async () => structuredClone(custody.records), put: async (record: MlsGrantRecord) => {
    assertLegacyGrantScope(custody, record, now)
    custody = { ...custody, records: [...custody.records.filter(r => r.node !== record.node || r.device !== record.device), structuredClone(record)] }
  }, assertLegacyScope: async (g: Pick<MlsGrantRecord, 'node' | 'device'>, at: number) => assertLegacyGrantScope(custody, g, at) }
  const legacyCarrier = vi.fn(async (_event: Event) => {})
  const legacySigner = { ...keeper, signEvent: vi.fn(keeper.signEvent) }
  let service!: BrowserMlsStorageGrants
  const legacyLedger = new BrowserMlsGrantLedger(() => legacySigner, { resume: async () => [box], boxes: () => [box], pairedBoxes: async () => [box] } as any,
    legacyStore, () => ({ publish: legacyCarrier, close() {} }), () => now, undefined, undefined, new BrowserMlsKeeperAdmission(coordinator as any, context, undefined, (tx, node, device, at) => service.assertLegacyScope(tx, node, device, at)))
  service = new BrowserMlsStorageGrants(coordinator as any, endpoint, context, scopes, () => now)
  const storageCoordinator = storageInboxCoordinator(coordinator as any)
  const inbox = new BrowserMlsRevocationInbox(storageCoordinator, service, context, () => now, { storage: tx => service.authority(tx) })
  const signer = { ...keeper, signEvent: vi.fn(keeper.signEvent) }
  const prepare = async () => value(await service.prepare(box.routeId, member.pubkey, device, signer, () => true))
  const records = async () => value(await service.records())
  const receive = async (person = member, target = device) => {
    const wrapped = await wrapVmlsRevocationRequest(person, { sender: person.pubkey, keeper: keeper.pubkey, device: target, sessions: ['aa'.repeat(32)], boxes: ['bb'.repeat(32)], createdAt: now, expiration: now + 7 * 86400 }, () => 0, () => true)
    return value(await inbox.receive([wrapped], keeper))
  }
  return { service, inbox, scopes, legacySigner, legacyStore, legacyLedger, legacyCarrier, legacyUnguarded: () => new BrowserMlsGrantLedger(() => legacySigner, { resume: async () => [box], boxes: () => [box], pairedBoxes: async () => [box] } as any, legacyStore, () => ({ publish: legacyCarrier, close() {} }), () => now), custody: () => custody, replaceLegacy: (records: MlsGrantRecord[]) => { custody = { ...custody, records } }, coordinator, storageCoordinator, context, signer, prepare, records, receive, tx, keeper, member, device, publish, endpoint, box,
    clock: (at: number) => { now = at }, now: () => now, hide: () => { live = false }, hold: () => { hold = true }, refuseSave: () => { refuseSave = true } }
}
describe('protected storage authority separate from MLS', () => {
  it.each(['installing','active','revoking'] as const)('blocks storage preparation before signing while a legacy scope is %s', async state => {
    const f = await fixture(), legacy = await planMlsGrant(f.keeper, f.box, f.member.pubkey, f.device, { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) }, f.now())
    legacy.state = state; f.replaceLegacy([legacy])
    await expect(f.prepare()).rejects.toThrow('legacy authority')
    expect(f.signer.signEvent).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.custody().records).toEqual([legacy])
  })
  it('persists a critical v3 scope reservation that the exact old decoder refuses, then blocks legacy signing and raw custody creation', async () => {
    const f = await fixture(), prepared = await f.prepare()
    expect(mlsGrantCustody(f.custody()).version).toBe(3)
    expect(() => frozenA10Custody(f.custody())).toThrow('could not be verified')
    expect(f.custody().records).toEqual([])
    const room = { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) }
    await expect(f.legacyLedger.install(f.box, f.member.pubkey, f.device, room)).rejects.toThrow('storage-only authority')
    expect(f.legacySigner.signEvent).not.toHaveBeenCalled(); expect(f.legacyCarrier).not.toHaveBeenCalled()
    const raw = await planMlsGrant(f.keeper, f.box, f.member.pubkey, f.device, room, f.now())
    await expect(f.legacyStore.put(raw)).rejects.toThrow('storage-only authority')
    value(await f.service.publish(prepared.grant.grantId, prepared.revision, false, () => true))
    await expect(f.legacyLedger.install(f.box, f.member.pubkey, f.device, room)).rejects.toThrow('storage-only authority')
    const current = (await f.records())[0]; f.publish.mockRejectedValueOnce(new Error('terminal ACK unknown'))
    await expect(f.service.publish(current.grant.grantId, current.revision, true, () => true)).rejects.toThrow('terminal ACK unknown')
    await expect(f.legacyLedger.install(f.box, f.member.pubkey, f.device, room)).rejects.toThrow('storage-only authority')
  })
  it('allows expired legacy custody but centrally blocks its exact pending terminal publication while storage owns the scope', async () => {
    const f = await fixture(), legacy = await planMlsGrant(f.keeper, f.box, f.member.pubkey, f.device, { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) }, f.now() - 31 * 86400)
    legacy.state = 'revoking'; f.replaceLegacy([legacy]); await f.prepare()
    await expect(f.legacyUnguarded().withdrawRequestedDevice(mlsKeeperGrantAuthority(legacy), f.member.pubkey, f.device, () => true)).rejects.toThrow('storage-only authority')
    expect(f.legacyCarrier).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
  })
  it('refuses legacy preparation and withdrawal against preserved historical storage authority even before a scope fence exists', async () => {
    const f = await fixture(); await f.prepare()
    const custody = f.custody(); custody.version = 2; delete custody.storageScopes
    const room = { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) }
    await expect(f.legacyLedger.install(f.box, f.member.pubkey, f.device, room)).rejects.toThrow('historical custody')
    expect(f.legacySigner.signEvent).not.toHaveBeenCalled()
    const expired = await planMlsGrant(f.keeper, f.box, f.member.pubkey, f.device, room, f.now() - 31 * 86400)
    expired.state = 'revoking'; f.replaceLegacy([expired])
    await expect(f.legacyLedger.withdrawRequestedDevice(mlsKeeperGrantAuthority(expired), f.member.pubkey, f.device, () => true)).rejects.toThrow('historical custody')
    expect(f.legacyCarrier).not.toHaveBeenCalled(); expect((await f.records())[0].grant.state).toBe('installing')
  })
  it('does not send an exact storage terminal into a live legacy-owned scope after storage expiry', async () => {
    const f = await fixture(), prepared = await f.prepare(); f.clock(prepared.grant.expiration + 1)
    await f.legacyLedger.install(f.box, f.member.pubkey, f.device, { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) })
    await expect(f.service.publish(prepared.grant.grantId, prepared.revision, true, () => true)).rejects.toThrow('legacy authority')
    expect(f.publish).not.toHaveBeenCalled(); expect((await f.records())[0].revision).toBe(0)
    expect(f.custody().records[0].state).toBe('active')
    expect(f.custody().version).toBe(3); expect(() => frozenA10Custody(f.custody())).toThrow()
  })
  it('serialises storage preparation behind a legacy installation through actual carrier settlement', async () => {
    const f = await fixture(); let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    f.legacyCarrier.mockImplementationOnce(async () => { enter(); await waiting })
    const install = f.legacyLedger.install(f.box, f.member.pubkey, f.device, { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) })
    await entered
    const storage = f.prepare(), refused = expect(storage).rejects.toThrow('legacy authority')
    await Promise.resolve(); expect(f.signer.signEvent).not.toHaveBeenCalled()
    release(); await install; await refused; expect(f.publish).not.toHaveBeenCalled()
  })
  it('serialises legacy installation behind storage signing and protected scope reservation', async () => {
    const f = await fixture(); let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const sign = f.signer.signEvent.getMockImplementation()!
    f.signer.signEvent.mockImplementationOnce(async template => { enter(); await waiting; return sign(template) })
    const storage = f.prepare(); await entered
    const install = f.legacyLedger.install(f.box, f.member.pubkey, f.device, { session: '55'.repeat(32), name: 'Legacy', leaf: '66'.repeat(32) })
    const refused = expect(install).rejects.toThrow('storage-only authority')
    await Promise.resolve(); expect(f.legacySigner.signEvent).not.toHaveBeenCalled()
    release(); await storage; await refused; expect(f.legacyCarrier).not.toHaveBeenCalled()
  })
  it('retains both signed statements before any endpoint publication and retries the exact active bytes after unknown ACK', async () => {
    const f = await fixture(), r = await f.prepare()
    expect(f.signer.signEvent).toHaveBeenCalledTimes(2); expect(f.publish).not.toHaveBeenCalled()
    expect(r.grant.rooms).toEqual([]); expect(r.grant.expiration - r.grant.active.created_at).toBe(3600)
    expect((await readMlsMembership(f.tx)).inbox).toBeUndefined()
    const sent: Event[] = []
    f.publish.mockImplementationOnce(async (_box, event) => { sent.push(structuredClone(event)); const retained = (await f.records())[0]; expect(retained.grant.active).toEqual(event); expect(retained.grant.revocation.sig).toHaveLength(128); throw new Error('ACK lost') })
    await expect(f.service.publish(r.grant.grantId, r.revision, false, () => true)).rejects.toThrow('ACK lost')
    const retry = (await f.records())[0]; expect(retry.grant.state).toBe('installing')
    f.publish.mockImplementationOnce(async (_box, event) => { sent.push(structuredClone(event)) })
    expect(value(await f.service.publish(r.grant.grantId, retry.revision, false, () => true)).record.grant.state).toBe('active')
    expect(sent[1]).toEqual(sent[0]); expect(f.signer.signEvent).toHaveBeenCalledTimes(2)
    await expect(f.service.publish(r.grant.grantId, r.revision, false, () => true)).rejects.toThrow('revision')
  })
  it('never publishes when protected preparation is refused or interrupted', async () => {
    const f = await fixture(); f.refuseSave()
    await expect(f.prepare()).rejects.toThrow('Witness refused'); expect(f.publish).not.toHaveBeenCalled()
    const held = await fixture(); held.hold(); expect((await held.service.prepare(held.box.routeId, held.member.pubkey, held.device, held.signer, () => true)).state).toBe('pending')
    expect(held.signer.signEvent).not.toHaveBeenCalled(); expect(held.publish).not.toHaveBeenCalled()
  })
  it('privately receives, reviews and explicitly approves only exact issued storage authority, without opening a room', async () => {
    const f = await fixture(), r = await f.prepare(), received = await f.receive()
    expect(received.prompts).toHaveLength(1); expect(f.publish).not.toHaveBeenCalled()
    const operation = received.prompts[0].prompt.operation, review = value(await f.service.review(operation))
    expect(review.records[0].grant.grantId).toBe(r.grant.grantId)
    await expect(f.service.advance(operation, () => true)).rejects.toThrow('approval')
    value(await f.service.approve(review, () => true))
    f.publish.mockImplementationOnce(async (_box, event) => {
      const retained = (await f.records())[0]
      expect(retained.approval.active).toBe(r.grant.active.id); expect(retained.grant.state).toBe('revoking')
      expect(event).toEqual(r.grant.revocation); throw new Error('terminal ACK unknown')
    })
    await expect(f.service.advance(operation, () => true)).rejects.toThrow('terminal ACK unknown')
    expect((await f.records())[0].grant.state).toBe('revoking')
    const result = value(await f.service.advance(operation, () => true))
    expect(result).toMatchObject({ storage: 'withdrawn', membership: 'unchanged', records: [{ grant: { state: 'revoked' } }] })
    expect(f.publish.mock.calls[1][1]).toEqual(f.publish.mock.calls[0][1])
    expect(native.load).not.toHaveBeenCalled(); expect((await readMlsMembership(f.tx)).removals).toEqual([])
    await expect(f.service.publish(r.grant.grantId, result.records[0].revision, false, () => true)).rejects.toThrow('cannot be reactivated')
  })
  it.each(['legacy-first', 'storage-first'] as const)('keeps seen IDs, prompts and scan cursors independent with %s on the same private route', async order => {
    const f = await fixture(); await f.prepare()
    const wrapped = await wrapVmlsRevocationRequest(f.member, { sender: f.member.pubkey, keeper: f.keeper.pubkey, device: f.device, sessions: ['aa'.repeat(32)], boxes: ['bb'.repeat(32)], createdAt: f.now(), expiration: f.now() + 7 * 86400 }, () => 0, () => true)
    const page = vi.spyOn(f.endpoint, 'keeperInboxPage').mockResolvedValue({ events: [wrapped], complete: true })
    const legacyInbox = new BrowserMlsRevocationInbox(f.coordinator as any, { all: async () => [] }, f.context, f.now)
    const legacyFetch = new BrowserMlsKeeperPrivateInboxFetch(f.coordinator as any, legacyInbox, f.endpoint, f.context, f.now)
    const storageFetch = new BrowserMlsKeeperPrivateInboxFetch(f.storageCoordinator, f.inbox, f.endpoint, f.context, f.now)
    const permission = { routeId: f.box.routeId, authenticate: true, mode: 'retained' as const, current: () => true }
    const first = order === 'legacy-first' ? legacyFetch : storageFetch, second = order === 'legacy-first' ? storageFetch : legacyFetch
    value(await first.check(f.keeper, permission)); value(await second.check(f.keeper, permission))
    expect(page).toHaveBeenCalledTimes(2)
    expect(page.mock.calls.map(call => call[1].until)).toEqual([f.now(), f.now()])
    expect(value(await f.inbox.view()).prompts).toHaveLength(1)
    const old = (await readMlsMembership(f.tx)).inbox!, own = (await readMlsMembership(storageInboxTransaction(f.tx))).inbox!
    expect(old.prompts).toEqual([]); expect(old.seen).toHaveLength(1); expect(own.seen).toHaveLength(1)
    expect(old.privateScan!.cursors).toHaveLength(1); expect(own.privateScan!.cursors).toHaveLength(1)
    expect(old.privateScan).not.toBe(own.privateScan)
  })
  it('retains the terminal grant and separately reviews a later grant for the same device without inheriting old approval', async () => {
    const f = await fixture(), first = await f.prepare(), intake = await f.receive(), operation = intake.prompts[0].prompt.operation
    value(await f.service.approve(value(await f.service.review(operation)), () => true)); value(await f.service.advance(operation, () => true))
    f.clock(f.now() + 2)
    const next = await f.prepare(); expect(next.grant.grantId).not.toBe(first.grant.grantId)
    await f.receive()
    const review = value(await f.service.review(operation))
    expect(review.records.map((r: any) => r.grant.grantId)).toEqual([next.grant.grantId]); expect(review.records[0].approval).toBeUndefined()
    value(await f.service.approve(review, () => true)); value(await f.service.advance(operation, () => true))
    const retained = await f.records()
    expect(retained).toHaveLength(2); expect(retained[0].grant.revocation).toEqual(first.grant.revocation)
    expect(retained.map((r: any) => r.grant.state)).toEqual(['revoked','revoked'])
    expect(f.publish.mock.calls.map(call => call[1].id)).toEqual([first.grant.revocation.id, next.grant.revocation.id])
  })
  it('refuses a stale reviewed revision before retaining approval', async () => {
    const f = await fixture(), r = await f.prepare(), received = await f.receive(), operation = received.prompts[0].prompt.operation
    const review = value(await f.service.review(operation))
    value(await f.service.publish(r.grant.grantId, r.revision, false, () => true))
    await expect(f.service.approve(review, () => true)).rejects.toThrow('changed')
    expect((await f.records())[0].approval).toBeUndefined()
  })
  it('ignores signed request hints and refuses wrong persona/device without issuing authority', async () => {
    const f = await fixture(); await f.prepare()
    const otherKey = generateSecretKey(), other = { ...localIdentity(otherKey), ...localPeerCrypt(otherKey) }
    expect((await f.receive(other)).prompts).toEqual([])
    expect((await f.receive(f.member, '34'.repeat(32))).prompts).toEqual([])
    expect(f.publish).not.toHaveBeenCalled()
  })
  it('blocks expired active installation, clock rollback and foreground/account loss', async () => {
    const f = await fixture(), r = await f.prepare(); f.clock(r.grant.expiration)
    await expect(f.service.publish(r.grant.grantId, r.revision, false, () => true)).rejects.toThrow('expired')
    const g = await fixture(), pending = await g.prepare(); g.clock(g.now() - 1)
    await expect(g.service.publish(pending.grant.grantId, pending.revision, false, () => true)).rejects.toThrow('backwards')
    g.hide(); expect(() => g.service.records()).toThrow('foreground')
  })
})
