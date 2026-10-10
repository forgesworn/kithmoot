import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { localPeerCrypt } from '../../src/dm.js'
import { dmRelayListTemplate } from '../../src/dm-relays.js'
import { localIdentity } from '../../src/identity.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { MAX_MLS_STANDALONE_REVOCATIONS, mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { BrowserMlsRevocationOutbox, MlsRevocationOutboxFull, rememberStandaloneRevocations } from './mls-revocation-outbox.js'

const session = '11'.repeat(32), nextSession = '12'.repeat(32), device = '33'.repeat(32), nextDevice = '34'.repeat(32)
const box = '44'.repeat(32), nextBox = '45'.repeat(32)
const member = (() => { const key = generateSecretKey(); return { ...localIdentity(key), ...localPeerCrypt(key) } satisfies VmlsRevocationIdentity })()
const keeper = localIdentity(generateSecretKey()), other = localIdentity(generateSecretKey())

class MemoryTransaction implements PersonaTransaction {
  readonly installation = '55'.repeat(32)
  readonly vault = new Map<string, Uint8Array>()
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
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    const value = await work(tx)
    return current() ? { state: 'active', value, marks: new Map() } : { state: 'pending', reason: 'stale', refused: false }
  } }
  const outbox = new BrowserMlsRevocationOutbox(coordinator as any, context, () => now)
  const observe = (over: Partial<{ session: string; device: string; box: string; createdAt: number }> = {}) => rememberStandaloneRevocations(tx, member.pubkey,
    keeper.pubkey, over.session ?? session, [
      { identity: member.pubkey, device: over.device ?? device, homeBox: over.box ?? box, own: false, pending: false },
      { identity: member.pubkey, device: nextDevice, homeBox: nextBox, own: true, pending: false },
      { identity: member.pubkey, device: nextDevice, homeBox: nextBox, own: false, pending: true },
      { identity: other.pubkey, device: nextDevice, homeBox: nextBox, own: false, pending: false },
    ], over.createdAt ?? now)
  return { tx, outbox, observe, context, setLive: (value: boolean) => { live = value }, changeAccount: () => { generation++ }, clock: (value: number) => { now = value } }
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
      sessions: [session], boxes: [box], createdAt: 2_000, sentAt: null }])
    records[0].sentAt = 2_001
    const journal = await readMlsMembership(f.tx); journal.requests[0]!.sentAt = 2_001; await saveMlsMembership(f.tx, journal)
    await f.observe({ session: nextSession, box: nextBox, createdAt: 3_000 })
    records = (await f.outbox.records() as any).value
    expect(records[0]).toMatchObject({ sessions: [session, nextSession], boxes: [box, nextBox], createdAt: 2_000, sentAt: null })
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
    raw.requests[0][field] = field === 'operation' ? 'aa'.repeat(32) : field === 'keeper' ? other.pubkey : nextDevice
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify(raw)))
    const transport = { directory: vi.fn(), publish: vi.fn() }
    await expect(f.outbox.send(original.operation, { identity: member, transport: transport as any })).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(transport.directory).not.toHaveBeenCalled(); expect(transport.publish).not.toHaveBeenCalled()
  })

  it('rejects a retained sender rebound away from the open persona before network work', async () => {
    const f = fixture(); await f.observe()
    const key = [...f.tx.vault.keys()][0]!, raw = JSON.parse(new TextDecoder().decode(f.tx.vault.get(key)!))
    raw.requests[0].sender = other.pubkey
    raw.requests[0].operation = mlsStandaloneRevocationOperation(other.pubkey, raw.requests[0].keeper, raw.requests[0].device)
    f.tx.vault.set(key, new TextEncoder().encode(JSON.stringify(raw)))
    const transport = { directory: vi.fn(), publish: vi.fn() }
    await expect(f.outbox.records()).rejects.toBeInstanceOf(InvalidPersonaRecord)
    await expect(f.outbox.send(raw.requests[0].operation, { identity: member, transport: transport as any })).rejects.toBeInstanceOf(InvalidPersonaRecord)
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
    const sent = await f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })
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

    const rewound = fixture(); await rewound.observe(); rewound.clock(1_999)
    const rewoundRecord = (await rewound.outbox.records() as any).value[0]
    const unused = { directory: vi.fn(), publish: vi.fn() }
    await expect(rewound.outbox.send(rewoundRecord.operation, { identity: member, transport: unused as any, random: () => 0 })).rejects.toThrow('trusted request time')
    expect(unused.directory).not.toHaveBeenCalled()
  })

  it('leaves expanded evidence retryable when it changes after relay acceptance', async () => {
    const f = fixture(); await f.observe()
    const record = (await f.outbox.records() as any).value[0]
    const list = await keeper.signEvent(dmRelayListTemplate(['wss://keeper.example'], 2_000))
    const transport = { directory: vi.fn(async () => [list]), publish: vi.fn(async () => {
      const journal = await readMlsMembership(f.tx)
      journal.requests[0]!.sessions.push(nextSession)
      journal.requests[0]!.sessions.sort()
      await saveMlsMembership(f.tx, journal)
    }) }
    await expect(f.outbox.send(record.operation, { identity: member, transport, random: () => 0 })).rejects.toThrow('changed after it was sent')
    expect((await f.outbox.records() as any).value[0]).toMatchObject({ sessions: [session, nextSession], sentAt: null })
  })
})
