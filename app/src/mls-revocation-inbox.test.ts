import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { wrapVmlsRevocationRequest, type VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { BrowserMlsKeeperDecisions } from './mls-keeper-decisions.js'
import { readMlsMembership, saveMlsMembership, mlsStandaloneRevocationOperation } from './mls-membership-store.js'
import { MAX_MLS_REVOCATION_SEEN, MAX_MLS_REVOCATION_PROMPTS, MLS_REVOCATION_SEEN_SECONDS, MAX_MLS_KEEPER_PROMPT_COOLDOWNS } from './mls-revocation-inbox-store.js'
import { BrowserMlsRevocationInbox, MAX_MLS_REVOCATION_DECRYPTIONS, MlsRevocationInboxFull } from './mls-revocation-inbox.js'
import { planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'

function identity(): VmlsRevocationIdentity { const secret = generateSecretKey(); return { ...localIdentity(secret), ...localPeerCrypt(secret) } }
const keeper = identity(), member = identity(), other = identity()
const device = '33'.repeat(32), nextDevice = '34'.repeat(32), session = '55'.repeat(32)
const box = { routeId: 'keeper-box', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(44)).toLowerCase()}/events` }
class MemoryTransaction implements PersonaTransaction {
  readonly installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, value: Uint8Array) { this.vault.set(id, value.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
async function fixture() {
  const tx = new MemoryTransaction(), records: MlsGrantRecord[] = []
  let now = 2_000, foreground = true, generation = 1, pending = false
  const context = () => ({ vault: { principal: 'https://test', persona: keeper.pubkey, generation, revision: 'one' }, current: () => true, foreground: () => foreground })
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (pending || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([key, value]) => [key, value.slice()])))
    const value = await work(candidate)
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    tx.vault.clear(); for (const [key, bytes] of candidate.vault) tx.vault.set(key, bytes)
    return { state: 'active', value, marks: new Map() }
  } }
  const grants = { all: vi.fn(async () => structuredClone(records)) }
  const inbox = new BrowserMlsRevocationInbox(coordinator as any, grants, context, () => now)
  async function grant(target = device, person = member.pubkey, issuer = keeper) {
    const record = await planMlsGrant(issuer, box, person, target, { session, name: 'Previous room', leaf: '77'.repeat(32) }, now)
    record.state = 'active'; record.rooms = []; record.revokeAfter = now + 86400
    records.push(record); return record
  }
  async function wrap(target = device, sender = member, lifetime = 7 * 86400) {
    return wrapVmlsRevocationRequest(sender, { sender: sender.pubkey, keeper: keeper.pubkey, device: target,
      sessions: ['aa'.repeat(32)], boxes: ['bb'.repeat(32)], createdAt: now, expiration: now + lifetime }, () => 0, () => true)
  }
  const restart = () => new BrowserMlsRevocationInbox(coordinator as any, grants, context, () => now)
  const decisions = () => new BrowserMlsKeeperDecisions(coordinator as any, grants, context, () => now)
  return { tx, inbox, records, grants, grant, wrap, context, restart, decisions, clock: (value: number) => { now = value },
    hide: () => { foreground = false }, changeAccount: () => { generation++ }, holdWitness: () => { pending = true } }
}

describe('foreground keeper revocation inbox', () => {
  it('matches signed keeper grants rather than untrusted room/box hints, and dedups before decrypting', async () => {
    const f = await fixture(), grant = await f.grant(), wrapper = await f.wrap()
    const receiver = { ...keeper, decrypt: vi.fn(keeper.decrypt) }
    const first = await f.inbox.receive([wrapper], receiver)
    expect(first).toMatchObject({ state: 'active', value: { prompts: [{ conflict: false, grants: [{ node: grant.node }],
      prompt: { state: 'pending', request: { device, sender: member.pubkey } } }] } })
    expect(receiver.decrypt).toHaveBeenCalledTimes(2)
    await f.inbox.receive([wrapper], receiver); expect(receiver.decrypt).toHaveBeenCalledTimes(2)
    const journal = await readMlsMembership(f.tx)
    expect(journal.inbox?.seen).toHaveLength(1); expect(journal.inbox?.prompts).toHaveLength(1)
  })
  it.each(['person', 'issuer', 'device'] as const)('silently drops a request with no matching %s in the signed ledger', async field => {
    const f = await fixture()
    await f.grant(field === 'device' ? nextDevice : device, field === 'person' ? other.pubkey : member.pubkey, field === 'issuer' ? other : keeper)
    expect(await f.inbox.receive([await f.wrap()], keeper)).toMatchObject({ state: 'active', value: { prompts: [] } })
    expect((await readMlsMembership(f.tx)).inbox?.seen).toHaveLength(1)
  })
  it('shows conflicting targets from one person together without granting withdrawal authority', async () => {
    const f = await fixture(); await f.grant(); await f.grant(nextDevice)
    const result = await f.inbox.receive([await f.wrap(), await f.wrap(nextDevice)], keeper)
    expect(result).toMatchObject({ state: 'active', value: { prompts: [{ conflict: true }], deferred: [{ conflict: true, prompt: { deferredUntil: 5_600 } }] } })
    expect(f.records.map(record => record.state)).toEqual(['active', 'active'])
  })
  it('cannot reopen a dismissed request by replaying its rumour in a fresh wrap; only newer requests reopen it', async () => {
    const f = await fixture(); await f.grant(); await f.inbox.receive([await f.wrap()], keeper)
    const journal = await readMlsMembership(f.tx); journal.inbox!.prompts[0]!.state = 'dismissed'; await saveMlsMembership(f.tx, journal)
    expect(await f.inbox.receive([await f.wrap()], keeper)).toMatchObject({ state: 'active', value: { prompts: [] } })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('dismissed')
    f.clock(2_001)
    expect(await f.inbox.receive([await f.wrap()], keeper)).toMatchObject({ state: 'active', value: { prompts: [], deferred: [{ prompt: { state: 'pending', request: { createdAt: 2_001 } } }] } })
    const done = await readMlsMembership(f.tx); done.inbox!.prompts[0]!.state = 'done'; delete done.inbox!.prompts[0]!.deferredUntil; await saveMlsMembership(f.tx, done)
    f.clock(2_002)
    expect(await f.inbox.receive([await f.wrap()], keeper)).toMatchObject({ state: 'active', value: { prompts: [] } })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('done')
  })
  it('caps each pass at eight wraps and no more than sixteen signer decryptions', async () => {
    const f = await fixture(); await f.grant()
    const wrappers = await Promise.all(Array.from({ length: 12 }, () => f.wrap()))
    const receiver = { ...keeper, decrypt: vi.fn(keeper.decrypt) }
    await f.inbox.receive(wrappers, receiver)
    expect(receiver.decrypt).toHaveBeenCalledTimes(MAX_MLS_REVOCATION_DECRYPTIONS * 2)
    expect((await readMlsMembership(f.tx)).inbox?.seen).toHaveLength(MAX_MLS_REVOCATION_DECRYPTIONS)
    await expect(f.inbox.receive(Array.from({ length: 65 }, () => wrappers[0]!), receiver)).rejects.toThrow('Too many')
  })
  it('does not prompt for malformed, oversized, forged or irrelevant wrappers', async () => {
    const f = await fixture(), wrapper = await f.wrap(), receiver = { ...keeper, decrypt: vi.fn(keeper.decrypt) }
    await f.inbox.receive([{ ...wrapper, sig: '00'.repeat(64) }, { ...wrapper, content: 'x'.repeat(40_001) },
      { ...wrapper, tags: Array.from({ length: 1000 }, () => ['p', keeper.pubkey]) }, { ...wrapper, tags: [['p', other.pubkey]] }], receiver)
    expect(receiver.decrypt).not.toHaveBeenCalled()
  })
  it('holds before signer use when the witness is unavailable and withholds a late decryption after hiding', async () => {
    const f = await fixture(); await f.grant(); const wrapper = await f.wrap(), receiver = { ...keeper, decrypt: vi.fn(keeper.decrypt) }
    f.holdWitness(); expect(await f.inbox.receive([wrapper], receiver)).toMatchObject({ state: 'pending' }); expect(receiver.decrypt).not.toHaveBeenCalled()
    const late = await fixture(); await late.grant()
    const hidden = { ...keeper, decrypt: async (peer: string, text: string) => { const result = await keeper.decrypt(peer, text); late.hide(); return result } }
    expect(await late.inbox.receive([await late.wrap()], hidden)).toMatchObject({ state: 'pending', reason: 'stale' })
    expect((await readMlsMembership(late.tx)).inbox?.prompts).toEqual([])
  })
  it('expires unanswered prompts and replay ids on separate bounds and refuses clock rollback', async () => {
    const f = await fixture(); await f.grant(); await f.inbox.receive([await f.wrap()], keeper)
    f.clock(2_000 + 7 * 86400); expect(await f.inbox.view()).toMatchObject({ state: 'active', value: { prompts: [] } })
    expect((await readMlsMembership(f.tx)).inbox?.seen).toHaveLength(1)
    f.clock(1_999); await expect(f.inbox.view()).rejects.toThrow('trusted request time')
    f.clock(2_000 + MLS_REVOCATION_SEEN_SECONDS); await f.inbox.view(); expect((await readMlsMembership(f.tx)).inbox?.seen).toEqual([])
  })
  it('evicts the oldest verified replay attempt at capacity and keeps processing', async () => {
    const f = await fixture(); await f.inbox.view()
    const journal = await readMlsMembership(f.tx)
    journal.inbox!.seen = Array.from({ length: MAX_MLS_REVOCATION_SEEN }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), receivedAt: 2_000 }))
    await saveMlsMembership(f.tx, journal)
    const oldest = journal.inbox!.seen[0]!.id, receiver = { ...keeper, decrypt: vi.fn(keeper.decrypt) }, wrapper = await f.wrap()
    await f.inbox.receive([wrapper], receiver)
    expect(receiver.decrypt).toHaveBeenCalledTimes(2)
    const after = await readMlsMembership(f.tx)
    expect(after.inbox!.seen).toHaveLength(MAX_MLS_REVOCATION_SEEN)
    expect(after.inbox!.seen.some(item => item.id === oldest)).toBe(false)
    expect(after.inbox!.seen.at(-1)!.id).toBe(wrapper.id)
  })
  it('refuses a full prompt inbox while retaining the reserved failed signer attempt', async () => {
    const f = await fixture(); await f.inbox.view(); await f.grant()
    const journal = await readMlsMembership(f.tx)
    journal.inbox!.prompts = Array.from({ length: MAX_MLS_REVOCATION_PROMPTS }, (_, index) => {
      const target = index.toString(16).padStart(64, '0')
      return { operation: mlsStandaloneRevocationOperation(member.pubkey, keeper.pubkey, target), receivedAt: 2_000, state: 'pending',
        request: { sender: member.pubkey, keeper: keeper.pubkey, device: target, sessions: [session], boxes: ['bb'.repeat(32)], createdAt: 2_000, expiration: 2_000 + 7 * 86400 } }
    })
    await saveMlsMembership(f.tx, journal)
    const before = await readMlsMembership(f.tx)
    await expect(f.inbox.receive([await f.wrap()], keeper)).rejects.toBeInstanceOf(MlsRevocationInboxFull)
    const after = await readMlsMembership(f.tx)
    expect(after.inbox!.prompts).toEqual(before.inbox!.prompts)
    expect(after.inbox!.attempts).toEqual([2_000]); expect(after.inbox!.seen).toHaveLength(1)
  })
  it('rejects a rebound persisted keeper and cannot authorise an account with a different signer', async () => {
    const f = await fixture(); await f.inbox.view()
    const journal = await readMlsMembership(f.tx); journal.inbox!.keeper = other.pubkey; await saveMlsMembership(f.tx, journal)
    await expect(f.inbox.view()).rejects.toBeInstanceOf(InvalidPersonaRecord)
    await expect(f.inbox.receive([], other)).rejects.toThrow('receiving keeper')
  })
  it('withholds signer results across account changes and refuses concurrent intake', async () => {
    const f = await fixture(); await f.grant()
    let release!: () => void, entered!: () => void
    const wait = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const receiver = { ...keeper, decrypt: async (peer: string, text: string) => { entered(); await wait; return keeper.decrypt(peer, text) } }
    const pending = f.inbox.receive([await f.wrap()], receiver)
    await ready
    await expect(f.inbox.receive([], keeper)).rejects.toThrow('already running')
    f.changeAccount(); release()
    expect(await pending).toMatchObject({ state: 'pending', reason: 'stale' })
    expect((await readMlsMembership(f.tx)).inbox?.prompts).toEqual([])
  })
  it('refuses duplicate or corrupted grant authority and an unrestored room without creating a prompt', async () => {
    const f = await fixture(), record = await f.grant()
    f.records.push(structuredClone(record))
    await expect(f.inbox.receive([await f.wrap()], keeper)).rejects.toThrow('duplicate device authority')
    f.records.pop(); record.active.tags[0]![1] = 'changed'
    await expect(f.inbox.receive([await f.wrap()], keeper)).rejects.toThrow('Invalid saved VMLS grant')
    const unrestored = await fixture(); await unrestored.grant(); unrestored.records[0]!.rooms = [{ session, leaf: '77'.repeat(32), name: 'Previous room' }]; unrestored.records[0]!.revokeAfter = null
    await expect(unrestored.inbox.receive([await unrestored.wrap()], keeper)).rejects.toThrow('must be restored')
    expect((await readMlsMembership(unrestored.tx)).inbox?.prompts).toEqual([])
  })
})

describe('keeper prompt admission across restart', () => {
  it('retains a later target quietly, preserves conflict advice, and reserves a new hour when the group resurfaces', async () => {
    const f = await fixture(), third = '35'.repeat(32)
    await f.grant(); await f.grant(nextDevice); await f.grant(third)
    await f.inbox.receive([await f.wrap(), await f.wrap(nextDevice)], keeper)
    expect(await f.restart().view()).toMatchObject({ value: { prompts: [{ conflict: true, prompt: { request: { device } } }], deferred: [{ prompt: { request: { device: nextDevice }, deferredUntil: 5_600 } }] } })
    f.clock(5_600)
    expect(await f.restart().view()).toMatchObject({ value: { prompts: [{ conflict: true }, { conflict: true }] } })
    const current = await readMlsMembership(f.tx)
    expect(current.inbox!.prompts.every(prompt => prompt.deferredUntil === undefined)).toBe(true)
    expect(current.inbox!.promptAfter).toEqual([{ sender: member.pubkey, until: 9_200 }])
    f.clock(5_601)
    expect(await f.restart().receive([await f.wrap(third)], keeper)).toMatchObject({ value: { prompts: [{ conflict: true }, { conflict: true }], deferred: [{ prompt: { request: { device: third }, deferredUntil: 9_200 } }] } })
  })
  it('does not let short expiry or restart reset the identity cooldown, including migration of a retained older record', async () => {
    const f = await fixture(); await f.grant(); await f.grant(nextDevice)
    await f.inbox.receive([await f.wrap(device, member, 1)], keeper)
    const old = await readMlsMembership(f.tx); delete old.inbox!.promptAfter; await saveMlsMembership(f.tx, old)
    f.clock(2_002)
    expect(await f.restart().receive([await f.wrap(nextDevice)], keeper)).toMatchObject({ value: { prompts: [], deferred: [{ prompt: { deferredUntil: 5_600 } }] } })
    expect((await readMlsMembership(f.tx)).inbox!.prompts).toHaveLength(1)
  })
  it('preserves the later pending expiration and original deferral when a newer request asks for a shorter lifetime', async () => {
    const f = await fixture(); await f.grant(); await f.grant(nextDevice)
    await f.inbox.receive([await f.wrap(), await f.wrap(nextDevice)], keeper)
    f.clock(2_001)
    await f.restart().receive([await f.wrap(device, member, 600), await f.wrap(nextDevice, member, 600)], keeper)
    const state = (await readMlsMembership(f.tx)).inbox!
    expect(state.prompts.map(prompt => prompt.request.expiration)).toEqual([2_000 + 7 * 86400, 2_000 + 7 * 86400])
    expect(state.prompts[1]!.deferredUntil).toBe(5_600)
    expect(state.promptAfter).toEqual([{ sender: member.pubkey, until: 5_600 }])
  })
  it('keeps another sender immediately eligible without guessing devices or using request hints', async () => {
    const f = await fixture(); await f.grant(); await f.grant(nextDevice, other.pubkey)
    expect(await f.inbox.receive([await f.wrap(), await f.wrap(nextDevice, other)], keeper)).toMatchObject({ value: { prompts: [{ conflict: false }, { conflict: false }] } })
    expect((await readMlsMembership(f.tx)).inbox!.promptAfter).toHaveLength(2)
  })
  it('refuses a full cooldown journal without dropping retained cooldowns or creating an immediate prompt', async () => {
    const f = await fixture(); await f.grant(); await f.inbox.view()
    const journal = await readMlsMembership(f.tx)
    journal.inbox!.promptAfter = Array.from({ length: MAX_MLS_KEEPER_PROMPT_COOLDOWNS }, (_, index) => ({ sender: index.toString(16).padStart(64, '0'), until: 5_600 }))
    await saveMlsMembership(f.tx, journal)
    await expect(f.restart().receive([await f.wrap()], keeper)).rejects.toThrow('cooldown journal is full')
    const after = await readMlsMembership(f.tx)
    expect(after.inbox!.prompts).toEqual([]); expect(after.inbox!.promptAfter).toEqual(journal.inbox!.promptAfter)
    expect(after.inbox!.seen).toHaveLength(1)
  })
})
