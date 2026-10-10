import { describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import { BrowserMlsMessageDriver } from './mls-message-driver.js'
import { MLS_PACKAGE_EXPIRY_SKEW_SECONDS, type MlsDriverState, type MlsDriverCommand, type MlsDriverGuard, type MlsOutbound } from './mls-room-operations.js'

const id = (n = 1) => new Uint8Array(32).fill(n), hex = (n = 1) => bytesToHex(id(n))
const ok = (value: any) => ({ state: 'ok' as const, value, serverTime: 100 })
const active = (value: any) => ({ state: 'active' as const, value: structuredClone(value) })
const leaf = (n: number, recipient = 9): MlsOutbound => ({ recordId: id(n), mailbox: id(n + 30), envelope: id(n), destination: { type: 'Leaf', leafId: id(recipient), homeBox: id(1) } })
function fixture() {
  const s: MlsDriverState = { generation: '1', phase: { type: 'Active' }, epoch: 1n,
    binding: { device: hex(2), credentialId: hex(3), rendezvousKey: hex(4), homeBox: hex(), installation: hex(5) }, packages: [], ordering: [], outbox: [], watch: [] }
  let valid = true, now = 100
  const commands: MlsDriverCommand[] = []
  const bump = () => { s.generation = String(BigInt(s.generation) + 1n) }
  const effect = (extra = {}) => active({ session: hex(6), generation: s.generation, events: [], outbound: [], ...extra })
  const rooms = {
    confirmTransport: vi.fn(async () => active(undefined)),
    driverState: vi.fn(async () => active(s)),
    drive: vi.fn(async (_: any, __: string, guard: MlsDriverGuard, command: MlsDriverCommand) => {
      if (guard.generation !== s.generation) return { state: 'pending' as const, reason: 'stale' as const, refused: false }
      commands.push(structuredClone(command))
      if (command.type === 'installation' && guard.installation !== s.binding.installation && s.binding.installation !== null) s.phase = { type: 'NeedsRecovery', reason: 'RestoreFenced' }
      if (command.type === 'tick' && s.join && now >= s.join.expiresAt && s.phase.type === 'PendingJoin') s.phase = { type: 'Expired' }
      if (command.type === 'prune-packages') {
        const expired = new Set(s.packages.filter(route => {
          const welcomes = s.outbox.filter(outbound => outbound.destination.type === 'Welcome' && bytesToHex(outbound.destination.packageId) === route.packageId)
          return route.expiresAt < now - MLS_PACKAGE_EXPIRY_SKEW_SECONDS && route.homeBox === s.binding.homeBox && route.leafId === hex(9) &&
            welcomes.length === 1 && bytesToHex(welcomes[0].mailbox) === route.welcomeMailbox
        }).map(route => route.packageId))
        s.outbox = s.outbox.filter(outbound => outbound.destination.type !== 'Welcome' || !expired.has(bytesToHex(outbound.destination.packageId)))
        s.packages = s.packages.filter(route => !expired.has(route.packageId))
      }
      if (command.type === 'delivered') s.outbox = s.outbox.filter(r => !command.records.some(i => bytesToHex(i) === bytesToHex(r.recordId)))
      if (command.type === 'receipt') s.ordering = s.ordering.filter(q => q.slot !== command.slot || q.attempt !== command.attempt)
      bump(); return effect()
    }),
    process: vi.fn(async (_: any, __: string, input: Partial<MlsDriverGuard>) => {
      if (input.generation !== s.generation) return { state: 'pending' as const, reason: 'stale' as const, refused: false }
      bump(); return effect({ ack: { type: 'AfterCommitAck' } })
    }),
  }
  const client = {
    box: hex(), isCurrent: () => valid, invalidate: vi.fn(),
    capabilities: vi.fn(async (): Promise<any> => ok({ installation: hex(5) })),
    deposit: vi.fn(async (): Promise<any> => ok({ duplicate: false, receipt: id(7), welcomeAcknowledged: null })),
    depositSlot: vi.fn(async (): Promise<any> => ok({ outcome: 'won', attempt: 0, receipt: id(7), signedReceipt: id(8) })),
    fetch: vi.fn(async (): Promise<any> => ok({ records: [], next: null })),
    slotStatus: vi.fn(async (): Promise<any> => ok({ state: 'empty' })),
    ack: vi.fn(async (): Promise<any> => ok({ deleted: true, acked: 1 })),
    registerPackage: vi.fn(async (_packageId: Uint8Array, _mailbox: Uint8Array, _expiresAt: number, _now: number): Promise<any> => ok({ fresh: true })),
  }
  const context = { vault: { persona: hex(2), principal: 'https://test', generation: 0 } as any, rendezvousKey: hex(4), current: () => valid }
  const locks = { request: vi.fn(async (_: any, __: any, work: any) => work()) } as any
  const shutdown = vi.fn(async () => undefined)
  const make = () => new BrowserMlsMessageDriver(rooms, client, context, hex(6), shutdown, locks, () => now, 2, 4)
  return { s, rooms, client, commands, bump, effect, locks, shutdown, make, driver: make(), invalidate: () => { valid = false }, clock: (n: number) => { now = n } }
}
describe('witnessed browser MLS message driver', () => {
  for (const answer of [{ state: 'unavailable' }, { state: 'refused', status: 403, code: 'authority', serverTime: 100 }, { state: 'malformed' }, { state: 'not-signed', reason: 'denied' }]) it(`capabilities ${answer.state} holds without fencing`, async () => {
    const f = fixture(); f.s.outbox = [leaf(10)]; f.client.capabilities.mockResolvedValue(answer)
    expect(await f.driver.round()).toEqual({ state: 'offline', answer })
    expect(f.commands).toEqual([]); expect(f.client.deposit).not.toHaveBeenCalled(); expect(f.client.fetch).not.toHaveBeenCalled()
  })
  it('witnesses an authenticated installation replacement before stopping', async () => {
    const f = fixture(); f.client.capabilities.mockResolvedValue(ok({ installation: hex(99) }))
    expect(await f.driver.round()).toEqual({ state: 'stopped', phase: 'NeedsRecovery', reason: 'RestoreFenced' })
    expect(f.commands[0].type).toBe('installation'); expect(f.client.fetch).not.toHaveBeenCalled()
  })
  it('rejects a different box before any request', async () => {
    const f = fixture(); f.s.binding.homeBox = hex(99)
    expect(await f.driver.round()).toEqual({ state: 'refused', reason: 'wrong-box' }); expect(f.client.capabilities).not.toHaveBeenCalled()
  })
  it('stale capabilities cannot be reinterpreted against a new generation', async () => {
    const f = fixture(); f.client.capabilities.mockImplementation(async () => { f.bump(); return ok({ installation: hex(99) }) })
    expect(await f.driver.round()).toMatchObject({ state: 'pending', reason: 'stale' }); expect(f.commands).toEqual([])
  })
  it('preserves per-leaf order across mailboxes/epochs while other leaves proceed', async () => {
    const f = fixture(); f.s.outbox = [leaf(10), leaf(11), leaf(12, 8)]
    f.client.deposit.mockResolvedValueOnce({ state: 'refused', code: 'full' })
    expect(await f.driver.round()).toMatchObject({ state: 'done', delivered: 1, leafHeld: 1 })
    expect(f.client.deposit).toHaveBeenCalledTimes(2); expect(f.s.outbox.map(r => r.recordId[0])).toEqual([10, 11])
  })
  it('uncertain deposit stops the round and retries the exact retained bytes', async () => {
    const f = fixture(); f.s.outbox = [leaf(10), leaf(11)]; const before = structuredClone(f.s.outbox)
    f.client.deposit.mockResolvedValueOnce({ state: 'unavailable' })
    expect(await f.driver.round()).toMatchObject({ stalled: true, delivered: 0 }); expect(f.s.outbox).toEqual(before)
    expect(f.client.fetch).not.toHaveBeenCalled()
    expect(await f.make().round()).toMatchObject({ delivered: 2 }); expect(f.s.outbox).toEqual([])
  })
  it('does not clear a deposit whose response was overtaken by a local mutation', async () => {
    const f = fixture(); f.s.outbox = [leaf(10)]
    f.client.deposit.mockImplementation(async () => { f.bump(); return ok({ receipt: id(7) }) })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.s.outbox).toHaveLength(1)
  })
  it('does not release a delivery when its witness is held', async () => {
    const f = fixture(); f.s.outbox = [leaf(10)]; const drive = f.rooms.drive.getMockImplementation()!
    f.rooms.drive.mockImplementation(async (...args) => args[3].type === 'delivered' ? { state: 'pending', reason: 'stale', refused: false } : drive(...args))
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.s.outbox).toHaveLength(1)
  })
  it('holds foreign destinations, missing Welcome mapping and mismatched Introduction peer', async () => {
    const f = fixture(); const out = leaf(10); (out.destination as any).homeBox = id(99)
    f.s.outbox = [out, { ...leaf(11), destination: { type: 'Welcome', packageId: id(8) } }, { ...leaf(12), destination: { type: 'Introduction', peerRz: id(8) } }]
    f.s.join = { operation: hex(), counter: '0', adderRz: hex(9), introductionBox: hex(), expiresAt: 200 }
    expect(await f.driver.round()).toMatchObject({ held: 3, delivered: 0 }); expect(f.client.deposit).not.toHaveBeenCalled()
  })
  for (const acknowledged of [false, true]) it(`delivers a pre-registered routed Welcome, acknowledged: ${acknowledged}`, async () => {
    const f = fixture(), packageId = id(8), mailbox = id(40)
    f.s.packages = [{ packageId: hex(8), welcomeMailbox: hex(40), homeBox: hex(), leafId: hex(9), expiresAt: 200 }]
    f.s.outbox = [{ ...leaf(11), mailbox, destination: { type: 'Welcome', packageId } }]
    f.client.deposit.mockResolvedValue(ok({ duplicate: false, receipt: id(7), welcomeAcknowledged: acknowledged }))
    expect(await f.driver.round()).toMatchObject({ state: 'done', delivered: 1 })
    expect(f.commands.filter(command => command.type === 'confirm')).toHaveLength(acknowledged ? 1 : 0)
    expect(f.s.outbox).toEqual([])
  })
  it('refuses a Welcome whose package route names another mailbox', async () => {
    const f = fixture()
    f.s.packages = [{ packageId: hex(8), welcomeMailbox: hex(41), homeBox: hex(), leafId: hex(9), expiresAt: 200 }]
    f.s.outbox = [{ ...leaf(11), mailbox: id(40), destination: { type: 'Welcome', packageId: id(8) } }]
    expect(await f.driver.round()).toMatchObject({ held: 1, delivered: 0 })
    expect(f.client.deposit).not.toHaveBeenCalled()
  })
  it('atomically drops a Welcome and route only after the full box clock-skew window', async () => {
    const f = fixture(), packageId = id(8)
    f.s.packages = [{ packageId: hex(8), welcomeMailbox: hex(40), homeBox: hex(), leafId: hex(9), expiresAt: 200 }]
    f.s.outbox = [{ ...leaf(11), mailbox: id(40), destination: { type: 'Welcome', packageId } }]
    f.clock(200 + MLS_PACKAGE_EXPIRY_SKEW_SECONDS)
    expect(await f.driver.round()).toMatchObject({ state: 'done', delivered: 0, held: 1 })
    expect(f.s.outbox).toHaveLength(1); expect(f.s.packages).toHaveLength(1)
    f.clock(201 + MLS_PACKAGE_EXPIRY_SKEW_SECONDS)
    expect(await f.make().round()).toMatchObject({ state: 'done', delivered: 0, held: 0 })
    expect(f.s.outbox).toEqual([]); expect(f.s.packages).toEqual([])
    expect(f.client.deposit).not.toHaveBeenCalled()
    expect(f.commands.filter(command => command.type === 'prune-packages')).toHaveLength(1)
  })
  it('retains an expired route whose saved mailbox does not match its Welcome', async () => {
    const f = fixture(), packageId = id(8)
    f.s.packages = [{ packageId: hex(8), welcomeMailbox: hex(41), homeBox: hex(), leafId: hex(9), expiresAt: 200 }]
    f.s.outbox = [{ ...leaf(11), mailbox: id(40), destination: { type: 'Welcome', packageId } }]
    f.clock(201 + MLS_PACKAGE_EXPIRY_SKEW_SECONDS)
    expect(await f.driver.round()).toMatchObject({ state: 'done', delivered: 0, held: 1 })
    expect(f.s.outbox).toHaveLength(1); expect(f.s.packages).toHaveLength(1)
    expect(f.client.deposit).not.toHaveBeenCalled()
  })
  it('uses the persisted Introduction destination and checks expiry at dispatch', async () => {
    const f = fixture(); f.s.phase = { type: 'PendingJoin' }; f.s.binding.installation = null
    f.s.join = { operation: hex(), counter: '0', adderRz: hex(9), introductionBox: hex(), expiresAt: 200 }
    f.s.outbox = [{ ...leaf(10), destination: { type: 'Introduction', peerRz: id(9) } }]
    f.client.deposit.mockImplementation(async (...args: any[]) => { f.clock(200); expect(args[2]()).toBe(false); return { state: 'unavailable' } })
    expect(await f.driver.round()).toMatchObject({ stalled: true, delivered: 0 }); expect(f.s.outbox).toHaveLength(1)
    expect(await f.driver.round()).toMatchObject({ state: 'stopped', phase: 'Expired' })
  })
  it('prunes decided commits without redepositing and suppresses current commits during Gap', async () => {
    const f = fixture(); f.s.phase = { type: 'NeedsRecovery', reason: 'Gap' }; f.s.epoch = 2n
    f.s.outbox = [0n, 2n].map((epoch, i) => ({ ...leaf(i + 10), destination: { type: 'CommitSlot', homeBox: id(), epoch, attempt: 0 } }))
    expect(await f.driver.round()).toMatchObject({ delivered: 1 }); expect(f.s.outbox).toHaveLength(1); expect(f.client.depositSlot).not.toHaveBeenCalled()
  })
  it('retains a commit without a signed deposit receipt and reads status, never fetch', async () => {
    const f = fixture(); f.s.outbox = [{ ...leaf(10), destination: { type: 'CommitSlot', homeBox: id(), epoch: 1n, attempt: 2 } }]
    f.s.watch = [{ mailbox: id(40), homeBox: id(), kind: { type: 'CommitSlot', epoch: 1n, attempt: 2 } }]
    f.client.depositSlot.mockResolvedValue(ok({ signedReceipt: null }))
    await f.driver.round(); expect(f.s.outbox).toHaveLength(1); expect(f.client.slotStatus).toHaveBeenCalledTimes(1); expect(f.client.fetch).not.toHaveBeenCalled()
  })
  it('does not clear a commit with an unverifiable signed receipt', async () => {
    const f = fixture(); f.s.outbox = [{ ...leaf(10), destination: { type: 'CommitSlot', homeBox: id(), epoch: 1n, attempt: 0 } }]
    const drive = f.rooms.drive.getMockImplementation()!
    f.rooms.drive.mockImplementation(async (...args): Promise<any> => args[3].type === 'deposit' ? { state: 'refused', reason: 'engine:ReceiptUnverified' } : drive(...args))
    expect(await f.driver.round()).toMatchObject({ delivered: 0 }); expect(f.s.outbox).toHaveLength(1)
  })
  it('acks only an active witnessed process and not Keep', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'OwnLeaf' } }]
    f.client.fetch.mockResolvedValue(ok({ records: [{ mailbox: id(10), receipt: id(11), envelope: id(12) }], next: null }))
    f.rooms.process.mockResolvedValueOnce(f.effect({ ack: { type: 'Keep' } }))
    await f.driver.round(); expect(f.client.ack).not.toHaveBeenCalled()
    f.rooms.process.mockResolvedValueOnce({ state: 'pending', reason: 'stale', refused: false })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.client.ack).not.toHaveBeenCalled()
    await f.driver.round(); expect(f.client.ack).toHaveBeenCalledTimes(1)
  })
  it('advances expected generation only from its own process in a page', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'OwnLeaf' } }]
    f.client.fetch.mockResolvedValue(ok({ records: [11, 12].map(n => ({ mailbox: id(10), receipt: id(n), envelope: id(n) })), next: null }))
    f.client.ack.mockImplementationOnce(async () => { f.bump(); return ok({ acked: 1 }) })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.client.ack).toHaveBeenCalledTimes(1)
  })
  it('rejects a stale empty retained-mailbox response', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'RetainedLeaf' } }]
    f.client.fetch.mockImplementationOnce(async () => { f.bump(); return ok({ records: [], next: null }) })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.commands.some(c => c.type === 'drained')).toBe(false)
  })
  it('drains only a complete empty fetch, never pages that contained records', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'RetainedLeaf' } }]
    f.client.fetch.mockResolvedValueOnce(ok({ records: [{ mailbox: id(10), receipt: id(11), envelope: id(12) }], next: 'cursor' }))
    await f.driver.round(); expect(f.commands.some(c => c.type === 'drained')).toBe(false)
    await f.driver.round(); expect(f.commands.some(c => c.type === 'drained')).toBe(true)
  })
  it('lost ack stops processing without asserting a drain', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'RetainedLeaf' } }]
    f.client.fetch.mockResolvedValue(ok({ records: [{ mailbox: id(10), receipt: id(11), envelope: id(12) }], next: 'cursor' }))
    f.client.ack.mockResolvedValue({ state: 'unavailable' })
    expect(await f.driver.round()).toMatchObject({ stalled: true }); expect(f.client.fetch).toHaveBeenCalledTimes(1); expect(f.commands.some(c => c.type === 'drained')).toBe(false)
  })
  it('bounds a malicious cursor loop', async () => {
    const f = fixture(); f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'RetainedLeaf' } }]
    f.client.fetch.mockResolvedValue(ok({ records: [], next: 'same' }))
    await f.driver.round(); expect(f.client.fetch).toHaveBeenCalledTimes(2); expect(f.commands.some(c => c.type === 'drained')).toBe(false)
  })
  it('reopens durable ordering queries, retaining unverifiable and empty answers', async () => {
    const f = fixture(); f.s.ordering = [{ slot: hex(9), attempt: 2 }]
    await f.driver.round(); expect(f.s.ordering).toHaveLength(1)
    f.client.slotStatus.mockResolvedValue(ok({ state: 'expired', signedReceipt: id(8) }))
    const drive = f.rooms.drive.getMockImplementation()!
    f.rooms.drive.mockImplementation(async (...args): Promise<any> => args[3].type === 'receipt' ? { state: 'refused', reason: 'engine:ReceiptUnverified' } : drive(...args))
    await f.make().round(); expect(f.s.ordering).toHaveLength(1)
    f.rooms.drive.mockImplementation(drive); await f.make().round(); expect(f.s.ordering).toEqual([])
  })
  it('coalesces concurrent rounds and closes its own endpoint exactly once', async () => {
    const f = fixture(); const first = f.driver.round(); expect(f.driver.round()).toBe(first); await first
    await Promise.all([f.driver.close(), f.driver.close()]); expect(f.shutdown).toHaveBeenCalledTimes(1)
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.client.capabilities).toHaveBeenCalledTimes(1)
  })
  it('withholds late results after account change and after lock cleanup', async () => {
    const f = fixture(); f.client.capabilities.mockImplementation(async () => { f.invalidate(); return ok({ installation: hex(5) }) })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' }); expect(f.commands).toEqual([])
    const g = fixture(); g.locks.request.mockImplementation(async (_: any, __: any, work: any) => { const r = await work(); g.invalidate(); return r })
    expect(await g.driver.round()).toMatchObject({ state: 'pending' })
  })
  for (const operation of ['drive', 'process'] as const) it(`wipes a returned ${operation} effect invalidated before adoption`, async () => {
    const f = fixture(), secret = Uint8Array.of(31, 32, 33), outgoing = Uint8Array.of(34, 35)
    const value = { session: hex(6), generation: '2', events: [{ type: 'Message', body: secret }], outbound: [{ envelope: outgoing }] }
    if (operation === 'process') {
      f.s.watch = [{ mailbox: id(10), homeBox: id(), kind: { type: 'OwnLeaf' } }]
      f.client.fetch.mockResolvedValue(ok({ records: [{ mailbox: id(10), receipt: id(11), envelope: id(12) }], next: null }))
      f.rooms.process.mockImplementation(async (): Promise<any> => { f.invalidate(); return { state: 'active', value } })
    } else f.rooms.drive.mockImplementation(async (): Promise<any> => { f.invalidate(); return { state: 'active', value } })
    expect(await f.driver.round()).toMatchObject({ state: 'pending' })
    expect(Array.from(secret)).toEqual([0, 0, 0]); expect(Array.from(outgoing)).toEqual([0, 0])
    expect(f.client.ack).not.toHaveBeenCalled()
  })

})
