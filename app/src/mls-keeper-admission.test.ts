import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { localIdentity } from '../../src/identity.js'
import { BrowserMlsKeeperAdmission } from './mls-keeper-admission.js'
import { BrowserMlsGrantLedger, planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { mlsKeeperGrantAuthority } from './mls-revocation-decision-store.js'
import { mlsStandaloneRevocationOperation, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'

const keeper = localIdentity(new Uint8Array(32).fill(41)), member = localIdentity(new Uint8Array(32).fill(42))
const device = '33'.repeat(32), room = { session: '44'.repeat(32), name: 'Keeper room', leaf: '55'.repeat(32) }
const box = { routeId: 'keeper', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(31)).toLowerCase()}/events` }
class MemoryTransaction implements PersonaTransaction {
  readonly installation = '66'.repeat(32)
  bytes: Uint8Array | undefined
  async readVault() { return this.bytes?.slice() }
  async putVault(_id: string, bytes: Uint8Array) { this.bytes = bytes.slice() }
  async dropVault() { this.bytes = undefined }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
async function fixture(state?: 'pending' | 'dismissed' | 'approved' | 'done', deferred = false) {
  const tx = new MemoryTransaction(), records: MlsGrantRecord[] = []
  let generation = 0, foreground = true, pending = false, fenced = false, afterRead: (() => void) | undefined
  const context = () => ({ vault: { principal: 'https://keeper.test', persona: keeper.pubkey, generation, revision: 'fixture' }, current: () => true, foreground: () => foreground })
  const host = { transact: vi.fn(async (_keeper: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (pending) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    if (fenced) return { state: 'fenced', reason: 'rollback' }
    const value = await work(tx); afterRead?.()
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    return { state: 'active', value, marks: new Map() }
  }) }
  const admission = () => new BrowserMlsKeeperAdmission(host as any, context)
  const grant = await planMlsGrant(keeper, box, member.pubkey, device, room, 1_000)
  if (state) await saveMlsMembership(tx, { version: 1, removals: [], requests: [], inbox: { keeper: keeper.pubkey, checkedAt: 1_000 + 8 * 86400, seen: [], prompts: [{
    operation: mlsStandaloneRevocationOperation(member.pubkey, keeper.pubkey, device), receivedAt: 1_000, state,
    request: { sender: member.pubkey, keeper: keeper.pubkey, device, sessions: [room.session], boxes: [grant.node], createdAt: 1_000, expiration: 1_000 + 7 * 86400 },
    ...(['approved', 'done'].includes(state) ? { approval: { approvedAt: 1_000, grants: [mlsKeeperGrantAuthority(grant)], rooms: [] } } : {}),
    ...(deferred ? { deferredUntil: 1_000 + 8 * 86400 + 3600 } : {}),
  }] } })
  const store = { all: vi.fn(async () => structuredClone(records)), put: vi.fn(async (record: MlsGrantRecord) => {
    records.splice(0, records.length, ...records.filter(item => item.node !== record.node || item.device !== record.device), structuredClone(record))
  }) }
  const signer = { pubkey: keeper.pubkey, signEvent: vi.fn(keeper.signEvent) }, publish = vi.fn(async () => undefined), resume = vi.fn(async () => undefined)
  const ledger = (owner: BrowserMlsKeeperAdmission | undefined = admission()) => new BrowserMlsGrantLedger(() => signer,
    { resume, boxes: () => [box], pairedBoxes: async () => [] } as any, store, () => ({ publish, close: () => undefined }), () => 1_000,
    async (_key, work) => work(), async (_device, _mode, work) => work(), owner)
  return { tx, records, grant, store, signer, publish, resume, ledger, admission, host,
    changeAccount: () => { generation++ }, hide: () => { foreground = false }, hold: () => { pending = true }, fence: () => { fenced = true },
    afterRead: (fn: () => void) => { afterRead = fn } }
}

describe('witnessed keeper grant admission', () => {
  it('requires an active witnessed read even for an empty journal and returns a live scoped predicate', async () => {
    const f = await fixture(), current = await f.admission().admit(keeper.pubkey, member.pubkey, device, () => true)
    expect(f.host.transact).toHaveBeenCalledOnce(); expect(current()).toBe(true)
    f.changeAccount(); expect(current()).toBe(false)
  })
  it('does not turn pending or dismissed requests into operator-approved device holds', async () => {
    for (const state of ['pending', 'dismissed'] as const) {
      const f = await fixture(state)
      expect(await f.ledger().install(box, member.pubkey, device, room)).toMatchObject({ state: 'active' })
      expect(f.signer.signEvent).toHaveBeenCalledTimes(2); expect(f.publish).toHaveBeenCalledOnce()
    }
  })
  it('retains approved, deferred approved and terminal device holds after request expiry and restart', async () => {
    for (const [state, deferred] of [['approved', false], ['approved', true], ['done', false]] as const) {
      const f = await fixture(state, deferred), before = f.tx.bytes!.slice()
      await expect(f.admission().admit(keeper.pubkey, member.pubkey, device, () => true)).rejects.toThrow('retained keeper revocation hold')
      await expect(f.admission().admit(keeper.pubkey, member.pubkey, device, () => true)).rejects.toThrow('new device key')
      expect(f.tx.bytes).toEqual(before)
      expect(await f.admission().admit(keeper.pubkey, member.pubkey, '77'.repeat(32), () => true)).toBeTypeOf('function')
      await expect(f.admission().admit(keeper.pubkey, '88'.repeat(32), device, () => true)).rejects.toThrow('another person')
    }
  })
  it('blocks existing, revoked, expired and new-node grant changes before signing, writes or network', async () => {
    for (const mode of ['active', 'revoked', 'expired', 'new-node'] as const) {
      const f = await fixture('approved'), record = structuredClone(f.grant)
      record.state = mode === 'revoked' ? 'revoked' : 'active'; f.records.push(record)
      const other = { routeId: 'new-node', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(32)).toLowerCase()}/events` }
      await expect(f.ledger().install(mode === 'new-node' ? other : box, member.pubkey, device,
        { ...room, session: '99'.repeat(32), name: 'Expanded use' }, mode === 'expired' ? record.expiration + 1 : 1_000)).rejects.toThrow('retained keeper revocation hold')
      expect(f.records).toEqual([record]); expect(f.signer.signEvent).not.toHaveBeenCalled(); expect(f.store.all).not.toHaveBeenCalled()
      expect(f.store.put).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
    }
  })
  it('never supplies admission on witness unavailability, rollback fencing or an account change during the read', async () => {
    for (const mode of ['unavailable', 'fenced', 'account', 'foreground'] as const) {
      const f = await fixture()
      if (mode === 'unavailable') f.hold()
      if (mode === 'fenced') f.fence()
      if (mode === 'account') f.afterRead(f.changeAccount)
      if (mode === 'foreground') f.afterRead(f.hide)
      await expect(f.ledger().install(box, member.pubkey, device, room)).rejects.toThrow('fresh witnessed keeper admission')
      expect(f.signer.signEvent).not.toHaveBeenCalled(); expect(f.store.all).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
    }
  })
  it('fences malformed persisted membership instead of treating its hold as absent', async () => {
    const f = await fixture('approved')
    f.tx.bytes = new TextEncoder().encode('{broken')
    await expect(f.ledger().install(box, member.pubkey, device, room)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(f.signer.signEvent).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
  })
  it('does not request the second signature or persist after an account or foreground change during signing', async () => {
    for (const mode of ['account', 'foreground'] as const) {
      const f = await fixture()
      f.signer.signEvent.mockImplementationOnce(async template => {
        const signed = await keeper.signEvent(template)
        if (mode === 'account') f.changeAccount(); else f.hide()
        return signed
      })
      await expect(f.ledger().install(box, member.pubkey, device, room)).rejects.toThrow('account or foreground session changed')
      expect(f.signer.signEvent).toHaveBeenCalledOnce(); expect(f.store.put).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.records).toEqual([])
    }
  })
  it('has no default-allow path when the admission owner is omitted', async () => {
    const f = await fixture(), ledger = new BrowserMlsGrantLedger(() => f.signer, {} as any, f.store,
      undefined, undefined, async (_key, work) => work(), async (_device, _mode, work) => work())
    await expect(ledger.install(box, member.pubkey, device, room)).rejects.toThrow('admission owner is required')
    expect(f.signer.signEvent).not.toHaveBeenCalled(); expect(f.store.all).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled()
  })
})
