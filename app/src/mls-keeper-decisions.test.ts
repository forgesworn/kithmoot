import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { BrowserMlsKeeperDecisions } from './mls-keeper-decisions.js'
import { BrowserMlsKeeperRequestController } from './mls-keeper-request-controller.js'
import { BrowserMlsRevocationInbox } from './mls-revocation-inbox.js'
import { mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { BrowserMlsGrantLedger, planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { BrowserMlsKeeperBoxClock } from './mls-keeper-box-clock.js'

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
  let now = 1_000, generation = 1, foreground = true, unavailable = false, readHook: (() => void) | undefined, commitHook: (() => void) | undefined
  const context = () => ({ vault: { principal: 'https://keeper.test', persona: keeper.pubkey, generation, revision: 'current' }, current: () => true, foreground: () => foreground })
  const host = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (unavailable || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([k, v]) => [k, v.slice()])))
    const value = await work(candidate)
    commitHook?.()
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
  let boxTime: number | undefined
  const client = { isCurrent: () => true, usesBinding: (_route: string, _node: string, binding: unknown) => JSON.stringify(binding) === JSON.stringify(context().vault),
    capabilities: vi.fn(async () => ({ state: 'ok', value: { installation: '79'.repeat(32) } })),
    fetch: vi.fn(async () => ({ state: 'ok', serverTime: boxTime ?? now, value: { records: [] } })) }
  const boxClock = new BrowserMlsKeeperBoxClock(client as any, context, () => now)
  const decisions = new BrowserMlsKeeperDecisions(host as any, grants, context, () => now, undefined, node => node === grant.node ? boxClock : undefined)
  const inbox = new BrowserMlsRevocationInbox(host as any, grants, context, () => now)
  return { tx, records, operation, decisions, inbox, context, host, grants, boxClock, client, boxTime: (at: number) => { boxTime = at },
    restart: (routes?: ConstructorParameters<typeof BrowserMlsKeeperDecisions>[4]) => new BrowserMlsKeeperDecisions(host as any, grants, context, () => now, routes, node => node === grant.node ? boxClock : undefined),
    clock: (v: number) => { now = v }, changeAccount: () => { generation++ }, hide: () => { foreground = false },
    hold: () => { unavailable = true }, onRead: (fn: () => void) => { readHook = fn }, beforeCommit: (fn: () => void) => { commitHook = fn } }
}

describe('witnessed keeper operator decisions', () => {
  it('requires both clocks at the signed expiration boundary and records lapse without a revoked claim', async () => {
    for (const [phoneOffset, boxOffset] of [[-1, 0], [0, -1], [0, 0]]) {
      const f = await fixture(), plan = await f.decisions.plan(f.operation)
      if (plan.state !== 'active') throw new Error('missing plan')
      await f.decisions.decide(plan.value, true)
      const record = structuredClone(f.records[0]!), expires = record.expiration
      f.clock(expires + phoneOffset!); f.boxTime(expires + boxOffset!)
      const evidence = await f.boxClock.probe(record)
      if (!evidence) throw new Error('missing evidence')
      const calls = f.client.fetch.mock.calls.length
      if (phoneOffset || boxOffset) {
        await expect(f.decisions.lapse(f.operation, record, evidence)).rejects.toThrow('Both authenticated clocks')
        expect((await f.decisions.retained(f.operation) as any).value.grantOutcomes).toBeUndefined()
      } else {
        expect(await f.decisions.lapse(f.operation, record, evidence)).toMatchObject({ state: 'active', value: { grantOutcomes: [{ outcome: 'no-live', evidence }] } })
        const execution = await f.restart().execution(f.operation)
        expect(execution).toMatchObject({ value: { revoked: [], unavailable: [], lapsed: [plan.value.grants[0]!.reference] } })
        const effects = { withdrawRequestedDevice: vi.fn(async () => { throw new Error('must not publish') }) }
        const controller = new BrowserMlsKeeperRequestController(f.restart(), {} as any, effects, f.context)
        expect(await controller.advance(f.operation)).toMatchObject({ state: 'done', grants: [{ state: 'no-live' }], notice: 'No live grants remain in this keeper’s ledger.' })
        expect(effects.withdrawRequestedDevice).not.toHaveBeenCalled()
      }
      expect(f.client.fetch.mock.calls.length).toBe(calls); expect(JSON.stringify(f.records)).toBe(JSON.stringify([record]))
    }
  })
  it('rejects copied provenance, consumes admission once and requires a new probe after an aborted witness', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const record = structuredClone(f.records[0]!); f.clock(record.expiration)
    const evidence = (await f.boxClock.probe(record))!
    await expect(f.decisions.lapse(f.operation, record, structuredClone(evidence))).rejects.toThrow('no longer current')
    await expect(f.decisions.lapse(f.operation, record, evidence)).rejects.toThrow('no longer current')
    const fresh = (await f.boxClock.probe(record))!
    f.beforeCommit(f.changeAccount)
    expect(await f.decisions.lapse(f.operation, record, fresh)).toMatchObject({ state: 'pending' })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.grantOutcomes).toBeUndefined()
    f.beforeCommit(() => undefined)
    await expect(f.decisions.lapse(f.operation, record, fresh)).rejects.toThrow('no longer current')
    expect(await f.decisions.lapse(f.operation, record, (await f.boxClock.probe(record))!)).toMatchObject({ state: 'active' })
  })
  it('allows exact witnessed lapse absence across restart while holding unproved loss and replacement authority', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const record = structuredClone(f.records[0]!); f.clock(record.expiration)
    f.records.length = 0
    await expect(f.restart().execution(f.operation)).rejects.toThrow('no longer matches')
    f.records.push(record)
    await f.decisions.lapse(f.operation, record, (await f.boxClock.probe(record))!)
    f.records.length = 0
    expect(await f.restart().execution(f.operation)).toMatchObject({ value: { revoked: [], lapsed: [plan.value.grants[0]!.reference] } })
    expect(await f.restart().complete(f.operation)).toMatchObject({ value: { state: 'done' } })
    f.records.push({ ...record, state: 'revoking' })
    await expect(f.restart().execution(f.operation)).rejects.toThrow('lapsed grant record changed')
    f.records[0] = await planMlsGrant(keeper, record.box, member.pubkey, device, { session, name: 'Replacement', leaf: '55'.repeat(32) }, record.expiration, { ...record, state: 'revoked' })
    f.records[0]!.rooms = []
    await expect(f.restart().execution(f.operation)).rejects.toThrow('grant authority changed')
  })
  it('holds changed grants, missing clock providers and late phone regressions at lapse admission', async () => {
    for (const change of ['record', 'provider', 'clock', 'foreground'] as const) {
      const f = await fixture(), plan = await f.decisions.plan(f.operation)
      if (plan.state !== 'active') throw new Error('missing plan')
      await f.decisions.decide(plan.value, true)
      const record = structuredClone(f.records[0]!); f.clock(record.expiration)
      const evidence = (await f.boxClock.probe(record))!
      if (change === 'record') f.records[0]!.state = 'revoking'
      if (change === 'clock') f.clock(record.expiration - 1)
      if (change === 'foreground') f.hide()
      const decisions = change === 'provider' ? new BrowserMlsKeeperDecisions(f.host as any, f.grants, f.context, () => record.expiration) : f.decisions
      if (change === 'clock') expect(await decisions.lapse(f.operation, record, evidence)).toMatchObject({ state: 'pending' })
      else await expect(decisions.lapse(f.operation, record, evidence)).rejects.toThrow()
      expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.grantOutcomes).toBeUndefined()
    }
  })
  it('withholds clock regression during witness commit and refuses malformed persisted lapse evidence', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const record = structuredClone(f.records[0]!); f.clock(record.expiration)
    const evidence = (await f.boxClock.probe(record))!
    f.beforeCommit(() => f.clock(record.expiration - 1))
    expect(await f.decisions.lapse(f.operation, record, evidence)).toMatchObject({ state: 'pending' })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.grantOutcomes).toBeUndefined()
    f.beforeCommit(() => undefined); f.clock(record.expiration)
    await f.decisions.lapse(f.operation, record, (await f.boxClock.probe(record))!)
    const saved = await readMlsMembership(f.tx)
    for (const kind of ['box-time', 'phone-time', 'binding', 'expiry', 'digest', 'observed-at', 'extra'] as const) {
      const changed = structuredClone(saved), item = changed.inbox!.prompts[0]!.grantOutcomes![0]!
      if (item.outcome !== 'no-live') throw new Error('missing lapse')
      if (kind === 'box-time') (item.evidence as any).boxTime = record.expiration - 1
      if (kind === 'phone-time') (item.evidence as any).phoneTime = record.expiration - 1
      if (kind === 'binding') (item.evidence.binding as any).persona = member.pubkey
      if (kind === 'expiry') (item.evidence as any).expiration++
      if (kind === 'digest') item.recordDigest = 'not a digest'
      if (kind === 'observed-at') (item.evidence as any).observedAt++
      if (kind === 'extra') (item as any).revoked = true
      await expect(saveMlsMembership(f.tx, changed)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    }
  })
  it('persists exact unavailable authority across restart and route restoration without publication or a revoked claim', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const routes = { available: vi.fn(async () => false) }, decisions = f.restart(routes)
    const execution = await decisions.execution(f.operation)
    expect(execution).toMatchObject({ state: 'active', value: { revoked: [], unavailable: [plan.value.grants[0]!.reference], prompt: { state: 'approved', grantOutcomes: [{ outcome: 'route-unavailable' }] } } })
    expect(f.records[0]!.state).toBe('active')
    routes.available.mockResolvedValue(true)
    const effects = { withdrawRequestedDevice: vi.fn(async () => { throw new Error('must not publish') }) }
    const operations = new Proxy({}, { get: () => vi.fn(() => { throw new Error('must not mutate room grants') }) }) as any
    const controller = new BrowserMlsKeeperRequestController(f.restart(routes), operations, effects as any, f.context)
    expect(await controller.advance(f.operation)).toMatchObject({ state: 'done', grants: [{ state: 'unavailable', access: 'unconfirmed' }] })
    expect(await controller.advance(f.operation)).toMatchObject({ state: 'done', grants: [{ state: 'unavailable', access: 'unconfirmed' }] })
    expect(routes.available).toHaveBeenCalledTimes(1); expect(effects.withdrawRequestedDevice).not.toHaveBeenCalled()
    expect((await f.restart().retained(f.operation) as any).value.grantOutcomes).toEqual((execution as any).value.prompt.grantOutcomes)
  })
  it('holds missing authority and failed or malformed pairing evidence without recording unavailable', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const original = f.records[0]!, routes = { available: vi.fn(async () => false) }
    f.records.length = 0
    await expect(f.restart(routes).execution(f.operation)).rejects.toThrow('no longer matches')
    expect(routes.available).not.toHaveBeenCalled(); f.records.push(original)
    routes.available.mockRejectedValueOnce(new Error('local vault unavailable'))
    await expect(f.restart(routes).execution(f.operation)).rejects.toThrow('local vault unavailable')
    routes.available.mockResolvedValueOnce(undefined as any)
    await expect(f.restart(routes).execution(f.operation)).rejects.toThrow('pairing evidence could not be verified')
    expect((await f.decisions.retained(f.operation) as any).value.grantOutcomes).toBeUndefined()
    expect(await f.restart().execution(f.operation)).toMatchObject({ value: { revoked: [], unavailable: [] } })
    await expect(f.decisions.complete(f.operation)).rejects.toThrow('still pending')
  })
  it('catches concurrent replacement after pairing evidence and withholds late account or commit changes', async () => {
    for (const change of ['replacement', 'account', 'foreground', 'commit'] as const) {
      const f = await fixture(), plan = await f.decisions.plan(f.operation)
      if (plan.state !== 'active') throw new Error('missing plan')
      await f.decisions.decide(plan.value, true)
      const routes = { available: vi.fn(async () => {
        if (change === 'replacement') f.records[0] = await planMlsGrant(keeper, f.records[0]!.box, member.pubkey, device, { session, name: 'Replacement', leaf: '55'.repeat(32) }, 1_001, { ...f.records[0]!, state: 'revoked' })
        if (change === 'account') f.changeAccount()
        if (change === 'foreground') f.hide()
        if (change === 'commit') f.beforeCommit(f.changeAccount)
        return false
      }) }
      if (change === 'commit') expect(await f.restart(routes).execution(f.operation)).toMatchObject({ state: 'pending' })
      else await expect(f.restart(routes).execution(f.operation)).rejects.toThrow(change === 'replacement' ? 'authority changed while checking' : 'session changed')
      expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.grantOutcomes).toBeUndefined()
    }
  })
  it('refuses a rewound or unsafe clock after asynchronous pairing evidence and records the final checked time', async () => {
    for (const at of [999, Number.MAX_SAFE_INTEGER, 1_001]) {
      const f = await fixture(), plan = await f.decisions.plan(f.operation)
      if (plan.state !== 'active') throw new Error('missing plan')
      await f.decisions.decide(plan.value, true)
      const decisions = f.restart({ available: async () => { f.clock(at); return false } })
      if (at !== 1_001) {
        await expect(decisions.execution(f.operation)).rejects.toThrow('trusted request time')
        expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.grantOutcomes).toBeUndefined()
      } else {
        expect(await decisions.execution(f.operation)).toMatchObject({ value: { prompt: { grantOutcomes: [{ at }] } } })
        expect((await readMlsMembership(f.tx)).inbox!.checkedAt).toBe(at)
      }
    }
  })
  it('migrates legacy expiration only from exact signed authority and fences forged terminal outcomes', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    const journal = await readMlsMembership(f.tx), prompt = journal.inbox!.prompts[0]!
    delete prompt.approval!.grants[0]!.expiration; await saveMlsMembership(f.tx, journal)
    expect(await f.restart().execution(f.operation)).toMatchObject({ value: { prompt: { approval: { grants: [{ expiration: f.records[0]!.expiration }] } } } })
    const saved = await readMlsMembership(f.tx), target = saved.inbox!.prompts[0]!
    for (const outcomes of [
      [{ node: f.records[0]!.node, reference: 'ff'.repeat(32), at: 1_000, outcome: 'route-unavailable' }],
      [{ node: f.records[0]!.node, reference: plan.value.grants[0]!.reference, at: 999, outcome: 'route-unavailable' }],
      [{ node: f.records[0]!.node, reference: plan.value.grants[0]!.reference, at: 1_001, outcome: 'route-unavailable' }],
      [{ node: f.records[0]!.node, reference: plan.value.grants[0]!.reference, at: 1_000, outcome: 'no-live' }],
    ]) {
      target.grantOutcomes = outcomes as any
      await expect(saveMlsMembership(f.tx, saved)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    }
  })
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
  it('persists one-hour Later for the sender group and refuses a stale pending approval until that hour ends', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    const journal = await readMlsMembership(f.tx), next = structuredClone(journal.inbox!.prompts[0]!)
    next.request.device = '34'.repeat(32); next.operation = mlsStandaloneRevocationOperation(member.pubkey, keeper.pubkey, next.request.device)
    journal.inbox!.prompts.push(next); await saveMlsMembership(f.tx, journal)
    const deferred = await f.decisions.defer(plan.value)
    expect(deferred).toMatchObject({ state: 'active', value: [{ deferredUntil: 4_600, state: 'pending' }, { deferredUntil: 4_600, state: 'pending' }] })
    expect(await f.inbox.view()).toMatchObject({ value: { prompts: [], deferred: [{ prompt: { deferredUntil: 4_600 } }] } })
    await expect(f.restart().decide(plan.value, true)).rejects.toThrow('deferred')
    expect(f.records[0]!.state).toBe('active')
    f.clock(4_600)
    await expect(f.restart().decide(plan.value, true)).rejects.toThrow('authority changed')
    const fresh = await f.restart().plan(f.operation)
    expect(fresh).toMatchObject({ state: 'active', value: { prompt: { state: 'pending' } } })
    if (fresh.state !== 'active') throw new Error('missing renewed plan')
    expect(fresh.value.prompt.deferredUntil).toBeUndefined()
    expect((await readMlsMembership(f.tx)).inbox!.promptAfter).toEqual([{ sender: member.pubkey, until: 8_200 }])
    expect(await f.restart().decide(fresh.value, true)).toMatchObject({ state: 'active', value: { state: 'approved' } })
  })
  it('defers an approved prompt across restart and request expiry without losing approval or claiming cancellation', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    await f.decisions.decide(plan.value, true)
    f.clock(1_000 + 8 * 86400)
    const retained = await f.decisions.retained(f.operation)
    if (retained.state !== 'active') throw new Error('missing retained approval')
    const approval = structuredClone(retained.value.approval)
    expect(await f.decisions.defer({ binding: f.context().vault, prompt: retained.value })).toMatchObject({ state: 'active', value: [{ state: 'approved' }] })
    expect(await f.restart().approvals()).toMatchObject({ state: 'active', value: [] })
    expect(await f.restart().approvals(true)).toMatchObject({ state: 'active', value: [{ state: 'approved', approval }] })
    // Later affects prompts, not the authority of an already explicit approval.
    expect(await f.restart().execution(f.operation)).toMatchObject({ state: 'active', value: { prompt: { state: 'approved', approval } } })
    f.clock(1_000 + 8 * 86400 + 3_600)
    expect(await f.restart().approvals()).toMatchObject({ state: 'active', value: [{ state: 'approved', approval }] })
    expect(f.records[0]!.state).toBe('active')
  })
  it('cannot defer a replaced request, a terminal record or a different account binding', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    const altered = structuredClone(plan.value); altered.prompt.request.expiration--
    await expect(f.decisions.defer(altered)).rejects.toThrow('retained request changed')
    const rebound = structuredClone(plan.value); rebound.binding = { ...rebound.binding, generation: rebound.binding.generation + 1 }
    await expect(f.decisions.defer(rebound)).rejects.toThrow('current keeper account')
    await f.decisions.decide(plan.value, false)
    await expect(f.decisions.defer(plan.value)).rejects.toThrow('retained request changed')
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.deferredUntil).toBeUndefined()
  })
  it('holds Later at an unavailable witness and rejects invalid persisted cooldown or deferral metadata', async () => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    f.hold(); expect(await f.decisions.defer(plan.value)).toMatchObject({ state: 'pending' })
    expect((await readMlsMembership(f.tx)).inbox!.prompts[0]!.deferredUntil).toBeUndefined()
    const corrupt = await fixture(), journal = await readMlsMembership(corrupt.tx)
    journal.inbox!.promptAfter = [{ sender: member.pubkey, until: 4_601 }]
    await expect(saveMlsMembership(corrupt.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    delete journal.inbox!.promptAfter; journal.inbox!.prompts[0]!.deferredUntil = 4_601
    await expect(saveMlsMembership(corrupt.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    journal.inbox!.prompts[0]!.deferredUntil = 4_600; journal.inbox!.prompts[0]!.state = 'dismissed'
    await expect(saveMlsMembership(corrupt.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
  })
  it.each(['account', 'foreground'] as const)('does not persist Later when %s changes before the witnessed commit', async change => {
    const f = await fixture(), plan = await f.decisions.plan(f.operation)
    if (plan.state !== 'active') throw new Error('missing plan')
    const before = await readMlsMembership(f.tx)
    f.beforeCommit(change === 'account' ? f.changeAccount : f.hide)
    expect(await f.decisions.defer(plan.value)).toMatchObject({ state: 'pending', reason: 'stale' })
    expect(await readMlsMembership(f.tx)).toEqual(before)
    expect(f.records[0]!.state).toBe('active')
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
