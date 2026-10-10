import { describe, expect, it } from 'vitest'
import { base32nopad } from '@scure/base'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { BrowserMlsKeeperDecisions } from './mls-keeper-decisions.js'
import { BrowserMlsKeeperRequestController } from './mls-keeper-request-controller.js'
import { BrowserMlsRevocationInbox } from './mls-revocation-inbox.js'
import { mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { BrowserMlsGrantLedger, planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'

const keeper = localIdentity(generateSecretKey()), member = localIdentity(generateSecretKey())
const device = '33'.repeat(32), session = '44'.repeat(32)
class MemoryTransaction implements PersonaTransaction {
  readonly installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
async function fixture() {
  const tx = new MemoryTransaction(), records: MlsGrantRecord[] = []
  let now = 1_000, generation = 1, foreground = true, unavailable = false, readHook: (() => void) | undefined
  const context = () => ({ vault: { principal: 'https://keeper.test', persona: keeper.pubkey, generation, revision: 'current' }, current: () => true, foreground: () => foreground })
  const host = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (unavailable || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([k, v]) => [k, v.slice()])))
    const value = await work(candidate)
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    tx.vault.clear(); for (const [key, value] of candidate.vault) tx.vault.set(key, value)
    return { state: 'active', value, marks: new Map() }
  } }
  const box = { routeId: 'keeper', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(31)).toLowerCase()}/events` }
  const grant = await planMlsGrant(keeper, box, member.pubkey, device, { session, name: 'Ended room', leaf: '55'.repeat(32) }, now)
  grant.state = 'active'; grant.rooms = []; grant.revokeAfter = 2_000; records.push(grant)
  const operation = mlsStandaloneRevocationOperation(member.pubkey, keeper.pubkey, device)
  await saveMlsMembership(tx, { version: 1, removals: [], requests: [], inbox: { keeper: keeper.pubkey, checkedAt: now, seen: [], prompts: [{ operation, receivedAt: now, state: 'pending',
    request: { sender: member.pubkey, keeper: keeper.pubkey, device, sessions: [session], boxes: ['aa'.repeat(32)], createdAt: now, expiration: now + 7 * 86400 } }] } })
  const grants = { all: async () => { readHook?.(); return structuredClone(records) } }
  const decisions = new BrowserMlsKeeperDecisions(host as any, grants, context, () => now)
  const inbox = new BrowserMlsRevocationInbox(host as any, grants, context, () => now)
  return { tx, records, operation, decisions, inbox, context, restart: () => new BrowserMlsKeeperDecisions(host as any, grants, context, () => now),
    clock: (v: number) => { now = v }, changeAccount: () => { generation++ }, hide: () => { foreground = false },
    hold: () => { unavailable = true }, onRead: (fn: () => void) => { readHook = fn } }
}

describe('witnessed keeper operator decisions', () => {
  it('freezes exact signed ledger-only scope on explicit approval and retains it across restart and expiry', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    expect(plan).toMatchObject({ state: 'active', value: { conflict: false, rooms: [], grants: [{ active: f.records[0]!.active.id, revocation: f.records[0]!.revocation.id }] } })
    if (plan.state !== 'active') throw new Error('missing plan')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('pending')
    const accepted = await f.decisions.decide(plan.value, true)
    expect(accepted).toMatchObject({ state: 'active', value: { state: 'approved', approval: { approvedAt: 1_000, rooms: [], grants: plan.value.grants } } })
    expect(f.records[0]!.state).toBe('active')
    f.clock(1_000 + 8 * 86400); await f.inbox.view()
    expect(await f.restart().retained(f.operation)).toEqual(accepted)
  })
  it('records an explicit dismissal without an approval or any grant change', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    expect(await f.decisions.decide(plan.value, false)).toMatchObject({ state: 'active', value: { state: 'dismissed' } })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.approval).toBeUndefined()
    expect(f.records[0]!.state).toBe('active')
    await expect(f.decisions.decide(plan.value, true)).rejects.toThrow('no longer awaiting')
  })
  it('reopens frozen approval after expiry and completes only exact witnessed withdrawals', async () => {
    const f = await fixture(), review = await f.decisions.plan(f.operation)
    if (review.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(review.value, true)
    f.clock(1_000 + 8 * 86400)
    expect(await f.restart().execution(f.operation)).toMatchObject({ state: 'active', value: { rooms: [], revoked: [], prompt: { state: 'approved' } } })
    await expect(f.decisions.complete(f.operation)).rejects.toThrow('still pending')
    f.records[0]!.state = 'revoked'
    expect(await f.restart().approvals()).toMatchObject({ state: 'active', value: [{ state: 'approved' }] })
    expect(await f.decisions.complete(f.operation)).toMatchObject({ state: 'active', value: { state: 'done' } })
    expect(await f.restart().approvals()).toMatchObject({ state: 'active', value: [] })
    expect(await f.restart().execution(f.operation)).toMatchObject({ state: 'active', value: { revoked: [review.value.grants[0]!.reference], prompt: { state: 'done' } } })
  })
  it('refuses missing, replaced and expanded authority on an approved retry', async () => {
    const f = await fixture(), review = await f.decisions.plan(f.operation)
    if (review.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(review.value, true)
    const old = f.records[0]!
    f.records[0] = await planMlsGrant(keeper, old.box, member.pubkey, device, { session, name: 'New use', leaf: '55'.repeat(32) }, 1_001, { ...old, state: 'revoked' })
    f.records[0]!.rooms = []; f.records[0]!.revokeAfter = 2_000
    await expect(f.decisions.execution(f.operation)).rejects.toThrow('authority changed')
    f.records.length = 0
    await expect(f.decisions.execution(f.operation)).rejects.toThrow('no longer matches')
    f.records.push(old); old.rooms = [{ session, name: 'Expanded', leaf: '55'.repeat(32) }]; old.revokeAfter = null
    await expect(f.decisions.execution(f.operation)).rejects.toThrow('must be restored')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('approved')
  })
  it.each(['reference', 'active', 'route', 'sender'] as const)('refuses tampered operator plans (%s)', async field => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    if (field === 'reference') plan.value.grants[0]!.reference = '77'.repeat(32)
    if (field === 'active') plan.value.grants[0]!.active = '77'.repeat(32)
    if (field === 'route') plan.value.grants[0]!.box.routeId = 'unreviewed'
    if (field === 'sender') plan.value.prompt.request.sender = keeper.pubkey
    await expect(f.decisions.decide(plan.value, true)).rejects.toThrow('authority changed')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('pending')
  })
  it('refuses a grant replacement, missing room, expired request and expiry during the fresh review without a storage fence', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    const old = f.records[0]!
    f.records[0] = await planMlsGrant(keeper, old.box, member.pubkey, device, { session, name: 'Other room', leaf: '55'.repeat(32) }, 1_001, { ...old, state: 'revoked' })
    f.records[0]!.rooms = []; f.records[0]!.revokeAfter = 2_000
    await expect(f.decisions.decide(plan.value, true)).rejects.toThrow('authority changed')
    f.records[0] = old; old.rooms = [{ session, name: 'Missing room', leaf: '55'.repeat(32) }]; old.revokeAfter = null
    await expect(f.decisions.plan(f.operation)).rejects.toThrow('must be restored')
    old.rooms = []; old.revokeAfter = 2_000
    f.onRead(() => f.clock(1_000 + 7 * 86400))
    await expect(f.decisions.decide(plan.value, true)).rejects.toThrow('expired before')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('pending')
    await expect(f.decisions.plan(f.operation)).rejects.toThrow('no longer awaiting')
  })
  it('withholds account/foreground transitions and unavailable witness results', async () => {
    const held = await fixture(); held.hold(); expect(await held.decisions.plan(held.operation)).toMatchObject({ state: 'pending' })
    for (const action of ['account', 'hide'] as const) {
      const f = await fixture(), plan = await f.decisions.plan(f.operation)
      if (plan.state !== 'active') throw new Error('missing plan')
      f.onRead(() => action === 'account' ? f.changeAccount() : f.hide())
      expect(await f.decisions.decide(plan.value, true)).toMatchObject({ state: 'pending', reason: 'stale' })
      expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('pending')
    }
  })
  it('rejects malformed persisted approval references as sealed-record corruption', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const journal = await readMlsMembership(f.tx); journal.inbox!.prompts[0]!.approval!.grants[0]!.reference = '99'.repeat(32)
    await expect(saveMlsMembership(f.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
  })
})

describe('keeper acceptance with the genuine signed grant ledger', () => {
  async function setup() {
    const f = await fixture(), events: string[] = []
    let refused = false, publishHook: (() => Promise<void> | void) | undefined
    const store = { all: async () => structuredClone(f.records), put: async (record: MlsGrantRecord) => {
      const index = f.records.findIndex(item => item.node === record.node && item.device === record.device)
      f.records[index] = structuredClone(record)
    } }
    const ledger = new BrowserMlsGrantLedger(() => keeper, { resume: async () => undefined, boxes: () => [f.records[0]!.box] } as any, store,
      () => ({ publish: async event => { events.push(event.id); await publishHook?.(); if (refused) throw new Error('box refused') }, close: () => undefined }), () => 1_000,
      async (_key, work) => work())
    const operations = new Proxy({}, { get: () => () => { throw new Error('A ledger-only request must not invoke room operations.') } }) as any
    const controller = () => new BrowserMlsKeeperRequestController(f.restart(), operations, ledger, f.context)
    const plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    return { ...f, events, plan: plan.value, controller, refuse: (value: boolean) => { refused = value }, onPublish: (hook: () => Promise<void> | void) => { publishHook = hook } }
  }
  it('requires witnessed explicit approval before any publication', async () => {
    const f = await setup()
    await expect(f.controller().advance(f.operation)).rejects.toThrow('no witnessed keeper approval')
    f.hold()
    await expect(f.controller().approve(f.plan)).rejects.toThrow('awaiting its witness')
    expect(f.events).toEqual([]); expect(f.records[0]!.state).toBe('active')
  })
  it('retains a failed withdrawal and retries its identical statement after restart and request expiry', async () => {
    const f = await setup(); f.refuse(true)
    expect(await f.controller().approve(f.plan)).toMatchObject({ state: 'approved', rooms: [], grants: [{ state: 'pending', failure: 'box refused' }] })
    expect(f.records[0]!.state).toBe('revoking')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('approved')
    f.clock(1_000 + 8 * 86400); f.refuse(false)
    expect(await f.controller().advance(f.operation)).toMatchObject({ state: 'done', rooms: [], grants: [{ state: 'revoked' }] })
    expect(f.events).toEqual([f.plan.grants[0]!.revocation, f.plan.grants[0]!.revocation])
    expect(f.records[0]!.state).toBe('revoked')
  })
  it('coalesces explicit retries and never republishes confirmed terminal grants', async () => {
    const f = await setup()
    await f.decisions.decide(f.plan, true)
    let release!: () => void, started!: () => void
    const began = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { release = resolve })
    f.onPublish(async () => { started(); await held })
    const controller = f.controller(), first = controller.advance(f.operation), second = controller.advance(f.operation)
    expect(second).toBe(first)
    await began; release(); expect(await first).toMatchObject({ state: 'done' })
    expect(await f.controller().advance(f.operation)).toMatchObject({ state: 'done' })
    expect(f.events).toHaveLength(1)
  })
  it('withholds terminal state after an account transition during uncertain publication', async () => {
    const f = await setup()
    f.onPublish(() => f.changeAccount())
    await expect(f.controller().approve(f.plan)).rejects.toThrow('account or foreground')
    expect(f.records[0]!.state).toBe('revoking')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.state).toBe('approved')
    expect(f.events).toEqual([f.plan.grants[0]!.revocation])
  })
})
