import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { localPeerCrypt } from '../../src/dm.js'
import { dmRelayListTemplate } from '../../src/dm-relays.js'
import { localIdentity } from '../../src/identity.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { VMLS_REVOCATION_REQUEST_SECONDS } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { MAX_MLS_STANDALONE_REVOCATIONS, MAX_MLS_MEMBERSHIP_BYTES, MLS_MEMBERSHIP_SEEN_RESERVE_BYTES, mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { BrowserMlsRevocationOutbox, MlsRevocationOutboxFull, rememberStandaloneRevocations } from './mls-revocation-outbox.js'

const session = '11'.repeat(32), nextSession = '12'.repeat(32), device = '33'.repeat(32), nextDevice = '34'.repeat(32)
const box = '44'.repeat(32), nextBox = '45'.repeat(32)
const member = (() => { const key = generateSecretKey(); return { ...localIdentity(key), ...localPeerCrypt(key) } satisfies VmlsRevocationIdentity })()
const keeper = localIdentity(generateSecretKey()), other = localIdentity(generateSecretKey())

class MemoryTransaction implements PersonaTransaction {
  readonly installation = '55'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, value: Uint8Array) { this.vault.set(id, value.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}

function fixture() {
  const tx = new MemoryTransaction()
  let live = true, generation = 1, now = 2_000
  const context = () => ({ vault: { principal: 'https://test', persona: member.pubkey, generation, revision: 'one' }, current: () => live })
  let tail: Promise<unknown> = Promise.resolve()
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    const turn = tail.then(async () => {
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      const candidate = new MemoryTransaction(new Map([...tx.vault].map(([key, value]) => [key, value.slice()])))
      const value = await work(candidate)
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      tx.vault.clear(); for (const [key, value] of candidate.vault) tx.vault.set(key, value)
      return { state: 'active', value, marks: new Map() }
    })
    tail = turn.then(() => undefined, () => undefined)
    return turn
  } }
  const outbox = new BrowserMlsRevocationOutbox(coordinator as any, context, () => now)
  const observe = (over: Partial<{ session: string; device: string; box: string; createdAt: number }> = {}) => rememberStandaloneRevocations(tx, member.pubkey,
    keeper.pubkey, over.session ?? session, [
      { identity: member.pubkey, device: over.device ?? device, homeBox: over.box ?? box, own: false, pending: false },
      { identity: member.pubkey, device: nextDevice, homeBox: nextBox, own: true, pending: false },
      { identity: member.pubkey, device: nextDevice, homeBox: nextBox, own: false, pending: true },
      { identity: other.pubkey, device: nextDevice, homeBox: nextBox, own: false, pending: false },
    ], over.createdAt ?? now)
  return { tx, outbox, observe, context, restart: () => new BrowserMlsRevocationOutbox(coordinator as any, context, () => now), setLive: (value: boolean) => { live = value }, changeAccount: () => { generation++ }, clock: (value: number) => { now = value } }
}

describe('standalone browser revocation outbox', () => {
  it('reads the legacy membership journal and rejects malformed retained requests', async () => {
    const tx = new MemoryTransaction()
    await saveMlsMembership(tx, { version: 1, removals: [], requests: [] })
    const record = [...tx.vault.keys()][0]!
    tx.vault.set(record, new TextEncoder().encode(JSON.stringify({ version: 1, removals: [] })))
    await expect(readMlsMembership(tx)).resolves.toEqual({ version: 1, removals: [], requests: [] })
    tx.vault.set(record, new TextEncoder().encode(JSON.stringify({ version: 1, removals: [], requests: [{
      operation: '01'.repeat(32), sender: member.pubkey, keeper: keeper.pubkey, device,
      sessions: [session], boxes: [box], createdAt: 2_000, sentAt: 1_999,
    }] })))
    await expect(readMlsMembership(tx)).rejects.toBeInstanceOf(InvalidPersonaRecord)
  })

  it('retains only witnessed same-person non-local devices and merges later room evidence', async () => {
    const f = fixture()
    await f.observe()
    let records = (await f.outbox.records() as any).value
    expect(records).toEqual([{ operation: expect.stringMatching(/^[0-9a-f]{64}$/), sender: member.pubkey, keeper: keeper.pubkey, device,
      sessions: [session], boxes: [box], createdAt: 2_000, sentAt: null, requestRevision: 0, requestState: 'none' }])
    const journal = await readMlsMembership(f.tx), observed = journal.standalone!.observations[0]!
    observed.requestRevision = 1; observed.attempt = { revision: 1, createdAt: 2_001, expiration: 2_001 + VMLS_REVOCATION_REQUEST_SECONDS, confirmed: true }
    journal.standalone!.checkedAt = 2_001; await saveMlsMembership(f.tx, journal)
    f.clock(3_000)
    await f.observe({ session: nextSession, box: nextBox, createdAt: 3_000 })
    records = (await f.outbox.records() as any).value
    expect(records[0]).toMatchObject({ sessions: [session, nextSession], boxes: [box, nextBox], createdAt: 2_000, sentAt: 2_001 })
  })

  it('refuses a full outbox without evicting retained evidence', async () => {
    const f = fixture()
    for (let index = 1; index <= MAX_MLS_STANDALONE_REVOCATIONS; index++) {
      await f.observe({ device: index.toString(16).padStart(64, '0') })
    }
    const before = (await f.outbox.records() as any).value
    await expect(f.observe({ device: 'ff'.repeat(32) })).rejects.toBeInstanceOf(MlsRevocationOutboxFull)
    expect((await f.outbox.records() as any).value).toEqual(before)
  })

  it('refuses a 65th session or box hint without changing the 64 retained hints', async () => {
    const f = fixture()
    for (let index = 1; index <= 64; index++) {
      await f.observe({ session: index.toString(16).padStart(64, '0'), box: (index + 256).toString(16).padStart(64, '0') })
    }
    const before = (await f.outbox.records() as any).value
    expect(before[0].sessions).toHaveLength(64); expect(before[0].boxes).toHaveLength(64)
    await expect(f.observe({ session: 'ee'.repeat(32), box: 'ff'.repeat(32) })).rejects.toBeInstanceOf(MlsRevocationOutboxFull)
    expect((await f.outbox.records() as any).value).toEqual(before)
  })

  it.each(['operation', 'keeper', 'device'] as const)('rejects an altered retained %s before any network work', async field => {
    const f = fixture(); await f.observe()
    const original = (await f.outbox.records() as any).value[0]
    const key = [...f.tx.vault.keys()][0]!, raw = JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))
    raw.standalone.observations[0][field] = field === 'operation' ? 'aa'.repeat(32) : field === 'keeper' ? other.pubkey : nextDevice
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify(raw)))
    const transport = { directory: vi.fn(), publish: vi.fn() }
    await expect(f.outbox.send(original.operation, { identity: member, transport: transport as any })).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(transport.directory).not.toHaveBeenCalled(); expect(transport.publish).not.toHaveBeenCalled()
  })

  it('rejects a retained sender rebound away from the open persona before network work', async () => {
    const f = fixture(); await f.observe()
    const key = [...f.tx.vault.keys()][0]!, raw = JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))
    raw.standalone.observations[0].sender = other.pubkey
    raw.standalone.observations[0].operation = mlsStandaloneRevocationOperation(other.pubkey, raw.standalone.observations[0].keeper, raw.standalone.observations[0].device)
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify(raw)))
    const transport = { directory: vi.fn(), publish: vi.fn() }
    await expect(f.outbox.records()).rejects.toBeInstanceOf(InvalidPersonaRecord)
    await expect(f.outbox.send(raw.standalone.observations[0].operation, { identity: member, transport: transport as any })).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(transport.directory).not.toHaveBeenCalled(); expect(transport.publish).not.toHaveBeenCalled()
  })

  it('keeps refusal retryable, witnesses OK true, and performs no network work after restart', async () => {
    const f = fixture(); await f.observe()
    const record = (await f.outbox.records() as any).value[0]
    const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 2_000))
    const publish = vi.fn<(publication: unknown) => Promise<void>>(async () => { throw new Error('relay refused') })
    const transport = { directory: vi.fn(async () => [list]), publish }
    await expect(f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })).rejects.toThrow('relay refused')
    expect((await f.outbox.records() as any).value[0].sentAt).toBeNull()
    publish.mockImplementation(async () => undefined)
    f.clock(2_100)
    const sent = await f.outbox.retry(record.operation, 1, { identity: member, transport, random: () => 0 })
    expect(sent).toMatchObject({ state: 'active', value: { sentAt: 2_100 } })
    const noNetwork = new BrowserMlsRevocationOutbox({ transact: async (_p: string, work: any, current: any) => current()
      ? { state: 'active', value: await work(f.tx), marks: new Map() } : { state: 'pending', reason: 'stale', refused: false } } as any, f.context, () => 2_200)
    await expect(noNetwork.send(record.operation, { identity: member, transport, random: () => 0 })).resolves.toMatchObject({ state: 'active', value: { sentAt: 2_100 } })
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('coalesces one instance and sends nothing after an account change', async () => {
    const f = fixture(); await f.observe()
    const record = (await f.outbox.records() as any).value[0]
    const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 2_000))
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const transport = { directory: vi.fn(async () => [list]), publish: vi.fn(() => waiting) }
    const first = f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })
    const second = f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledOnce())
    release(); await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    const changed = fixture(); await changed.observe()
    const changedRecord = (await changed.outbox.records() as any).value[0]
    const stopped = { directory: vi.fn(async () => { changed.changeAccount(); return [list] }), publish: vi.fn() }
    await expect(changed.outbox.send(changedRecord.operation, { identity: member, transport: stopped, random: () => 0 })).rejects.toThrow('account changed')
    expect(stopped.publish).not.toHaveBeenCalled()

    const rewound = fixture(); await rewound.observe()
    const rewoundRecord = (await rewound.outbox.records() as any).value[0]
    rewound.clock(1_999)
    const unused = { directory: vi.fn(), publish: vi.fn() }
    await expect(rewound.outbox.send(rewoundRecord.operation, { identity: member, transport: unused as any, random: () => 0 })).rejects.toThrow('trusted request time')
    expect(unused.directory).not.toHaveBeenCalled()
  })

  it('preserves expanded observations and confirms only the exact reserved attempt after relay acceptance', async () => {
    const f = fixture(); await f.observe()
    const record = (await f.outbox.records() as any).value[0]
    const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 2_000))
    const transport = { directory: vi.fn(async () => [list]), publish: vi.fn(async () => {
      const journal = await readMlsMembership(f.tx)
      journal.standalone!.observations[0]!.sessions.push(nextSession)
      journal.standalone!.observations[0]!.sessions.sort()
      await saveMlsMembership(f.tx, journal)
    }) }
    expect(await f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })).toMatchObject({ state: 'active', value: { sentAt: 2_000 } })
    expect((await f.outbox.records() as any).value[0]).toMatchObject({ sessions: [session, nextSession], sentAt: 2_000 })
  })
})

async function carrier() {
  const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 2_000))
  return { directory: vi.fn(async () => [list]), publish: vi.fn(async (_publication: unknown) => undefined) }
}
describe('expiring transport attempts and durable observations', () => {
  it('migrates legacy confirmed and unsent observations only inside a witnessed action', async () => {
    const f = fixture(); await f.observe(); await f.observe({ device: nextDevice })
    const records = (await f.outbox.records() as any).value.map(({ requestRevision: _r, requestState: _s, ...record }: any) => record)
    records[0].sentAt = 2_000
    const key = [...f.tx.vault.keys()][0]!, legacy = { version: 1, removals: [], requests: records }
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify(legacy)))
    expect(await readMlsMembership(f.tx)).toEqual(legacy)
    expect(JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))).toEqual(legacy)
    expect(await f.restart().records()).toMatchObject({ value: [{ requestRevision: 1, requestState: 'sent', sentAt: 2_000 }, { requestRevision: 0, requestState: 'none', sentAt: null }] })
    const canonical = JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))
    expect(canonical.requests).toBeUndefined(); expect(canonical.standalone.observations).toHaveLength(2)
  })
  it('rejects mixed legacy/canonical shapes and overflowing legacy confirmed deadlines', async () => {
    const f = fixture(); await f.observe()
    const key = [...f.tx.vault.keys()][0]!, canonical = JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify({ ...canonical, requests: [] })))
    await expect(readMlsMembership(f.tx)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify({ version: 1, removals: [], requests: [{ operation: mlsStandaloneRevocationOperation(member.pubkey, keeper.pubkey, device),
      sender: member.pubkey, keeper: keeper.pubkey, device, sessions: [session], boxes: [box], createdAt: 2_000, sentAt: Number.MAX_SAFE_INTEGER }] })))
    await expect(readMlsMembership(f.tx)).rejects.toBeInstanceOf(InvalidPersonaRecord)
  })
  it('removes only the expired attempt at the exact boundary and retains authority and revision across restart', async () => {
    const f = fixture(); await f.observe(); const transport = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    await f.outbox.send(operation, { identity: member, transport })
    const before = (await readMlsMembership(f.tx)).standalone!.observations[0]!
    f.clock(2_000 + VMLS_REVOCATION_REQUEST_SECONDS - 1)
    expect(await f.restart().records()).toMatchObject({ value: [{ sentAt: 2_000, requestState: 'sent' }] })
    f.clock(2_000 + VMLS_REVOCATION_REQUEST_SECONDS)
    expect(await f.restart().records()).toMatchObject({ value: [{ sentAt: null, requestState: 'none', requestRevision: 1 }] })
    const { attempt: _attempt, ...evidence } = before
    expect((await readMlsMembership(f.tx)).standalone!.observations[0]).toEqual(evidence)
    expect(transport.publish).toHaveBeenCalledTimes(1)
    expect(await f.restart().retry(operation, 1, { identity: member, transport })).toMatchObject({ value: { sentAt: 2_000 + VMLS_REVOCATION_REQUEST_SECONDS, requestRevision: 2 } })
    expect(transport.publish).toHaveBeenCalledTimes(2)
  })
  it('does not automatically repeat an uncertain attempt after directory refusal or restart', async () => {
    const f = fixture(); await f.observe(); const transport = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    transport.directory.mockRejectedValueOnce(new Error('directory unavailable'))
    await expect(f.outbox.send(operation, { identity: member, transport })).rejects.toThrow('directory unavailable')
    expect(await f.restart().send(operation, { identity: member, transport })).toMatchObject({ value: { requestState: 'unconfirmed', sentAt: null, requestRevision: 1 } })
    expect(transport.directory).toHaveBeenCalledTimes(1); expect(transport.publish).not.toHaveBeenCalled()
    f.clock(2_001)
    expect(await f.restart().retry(operation, 1, { identity: member, transport })).toMatchObject({ value: { requestState: 'sent', sentAt: 2_001, requestRevision: 2 } })
  })
  it('reserves the attempt before I/O and coalesces two independent controllers', async () => {
    const f = fixture(); await f.observe(); const transport = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const original = transport.directory.getMockImplementation()!
    transport.directory.mockImplementation(async () => { await waiting; return original() })
    const first = f.outbox.send(operation, { identity: member, transport })
    await vi.waitFor(() => expect(transport.directory).toHaveBeenCalledTimes(1))
    expect((await readMlsMembership(f.tx)).standalone!.observations[0]!.attempt).toMatchObject({ revision: 1, confirmed: false })
    expect(await f.restart().send(operation, { identity: member, transport })).toMatchObject({ value: { requestState: 'unconfirmed' } })
    expect(transport.directory).toHaveBeenCalledTimes(1)
    release(); expect(await first).toMatchObject({ value: { requestState: 'sent' } })
  })
  it('cannot confirm a newer explicit retry from the old same-second publication completion', async () => {
    const f = fixture(); await f.observe(); const firstRelay = await carrier(), secondRelay = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    firstRelay.publish.mockImplementation(async () => { await waiting })
    const first = f.outbox.send(operation, { identity: member, transport: firstRelay })
    const oldCompletion = expect(first).rejects.toThrow('attempt changed after publication')
    await vi.waitFor(() => expect(firstRelay.publish).toHaveBeenCalledTimes(1))
    secondRelay.publish.mockRejectedValueOnce(new Error('second relay refused'))
    await expect(f.restart().retry(operation, 1, { identity: member, transport: secondRelay })).rejects.toThrow('second relay refused')
    release(); await oldCompletion
    expect(await f.restart().records()).toMatchObject({ value: [{ requestRevision: 2, requestState: 'unconfirmed', sentAt: null }] })
    await expect(f.restart().retry(operation, 1, { identity: member, transport: secondRelay })).rejects.toThrow('request changed')
    expect(secondRelay.publish).toHaveBeenCalledTimes(1)
  })
  it('leaves publication unconfirmed if the account changes after relay OK', async () => {
    const f = fixture(); await f.observe(); const transport = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    transport.publish.mockImplementation(async () => { f.changeAccount() })
    await expect(f.outbox.send(operation, { identity: member, transport })).rejects.toThrow('account changed')
    expect(await f.restart().records()).toMatchObject({ value: [{ requestState: 'unconfirmed', sentAt: null }] })
    await f.restart().send(operation, { identity: member, transport })
    expect(transport.publish).toHaveBeenCalledTimes(1)
  })
  it('refuses attempt admission before any network work when the membership byte budget is full', async () => {
    const f = fixture(); await f.observe(); const transport = await carrier()
    const operation = (await f.outbox.records() as any).value[0].operation
    const record = await readMlsMembership(f.tx), size = () => new TextEncoder().encode(JSON.stringify(record)).length
    const target = MAX_MLS_MEMBERSHIP_BYTES - MLS_MEMBERSHIP_SEEN_RESERVE_BYTES - 64
    while (size() + 500 < target) {
      record.removals.push({ operation: record.removals.length.toString(16).padStart(64, '0'), session, kind: 'device', target: device,
        compromised: false, createdAt: 0, attempts: 0, failure: null, journal: '00' })
      record.removals.at(-1)!.journal += '00'.repeat(Math.floor(Math.min(131_070, target - size()) / 2))
    }
    // Storage-shape fixtures, without claiming decoded engine journal validity.
    await saveMlsMembership(f.tx, record)
    await expect(f.outbox.send(operation, { identity: member, transport })).rejects.toThrow('journal is full')
    expect(transport.directory).not.toHaveBeenCalled(); expect(transport.publish).not.toHaveBeenCalled()
    expect((await readMlsMembership(f.tx)).standalone!.observations[0]!.attempt).toBeUndefined()
  })
})
