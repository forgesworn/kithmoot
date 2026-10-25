import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { dmRelayListTemplate } from '../../src/dm-relays.js'
import { unwrapVmlsRevocationRequest, VMLS_REVOCATION_REQUEST_SECONDS } from '../../src/vmls-revocation-request.js'
import { BrowserMlsGrantForeground } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { BrowserMlsRevocationOutbox, rememberStandaloneRevocations } from './mls-revocation-outbox.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { keeperInboxDestination, type KeeperInboxAuthPrompt } from './mls-keeper-inbox-auth.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { LinkEngine, LinkListener } from './browser-link-types.js'
import { publicRoomOperation } from './public-room-operation.js'

const memory = vi.hoisted(() => ({ state: undefined as any }))
vi.mock('./mls-grant-link-vault.js', () => ({ MLS_GRANT_LINK_OWNER: 'private-outbox-test-owner',
  BrowserMlsGrantLinkVault: class { async read() { return structuredClone(memory.state) } async write(state: unknown) { memory.state = structuredClone(state) } } }))
vi.mock('./public-room-operation.js', () => ({ publicRoomOperation: vi.fn(() => { throw new Error('public route sentinel') }) }))
class MemoryTransaction implements PersonaTransaction {
  installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
const endpoints: BrowserMlsGrantEndpoint[] = []
afterEach(async () => { for (const endpoint of endpoints.splice(0)) await endpoint.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(credentialSeconds = 86400) {
  const key = generateSecretKey(), base = { ...localIdentity(key), ...localPeerCrypt(key) }
  const keeperKey = generateSecretKey(), keeper = { ...localIdentity(keeperKey), ...localPeerCrypt(keeperKey) }
  const identity = { ...base, signEvent: vi.fn(base.signEvent), encrypt: vi.fn(base.encrypt), decrypt: vi.fn(base.decrypt) }
  let live = true, permitted = true, generation = 0, revision = '', clock = 1_800_000_000, held = false, ack = true, auth = true, stallAck = false, stallAuth = false
  let activeIdentity = identity
  let beforeConfirmation: (() => void | Promise<void>) | undefined
  let reservationCleanup: (() => void | Promise<void>) | undefined
  let startHook: () => void | Promise<void> = () => {}
  let socketHook: () => void | Promise<void> = () => {}
  const tx = new MemoryTransaction()
  let tail = Promise.resolve()
  const coordinator = { invalidate() {}, transact: (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    const turn = tail.then(async () => {
      if (beforeConfirmation) { const work = beforeConfirmation; beforeConfirmation = undefined; await work() }
      if (held || !current()) return { state: 'pending', reason: 'stale', refused: false }
      const candidate = new MemoryTransaction(new Map([...tx.vault].map(([id, bytes]) => [id, bytes.slice()])))
      const value = await work(candidate)
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      tx.vault.clear(); for (const [id, bytes] of candidate.vault) tx.vault.set(id, bytes)
      if (reservationCleanup && [...candidate.vault.values()].some(bytes => JSON.parse(new TextDecoder().decode(bytes)).standalone?.observations.some((item: any) => item.attempt))) {
        const cleanup = reservationCleanup; reservationCleanup = undefined; await cleanup()
      }
      return { state: 'active', value, marks: new Map() }
    })
    tail = turn.then(() => undefined, () => undefined); return turn
  }, readConfirmed: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (held || !current()) return { state: 'pending', reason: 'stale', refused: false }
    const value = await work(tx)
    return current() ? { state: 'active', value, marks: new Map() } : { state: 'pending', reason: 'stale', refused: false }
  } }
  const vault = new CoordinatedMlsVault(coordinator as any, { now: () => clock, generation: () => generation,
    signals: { revision: () => revision, invalidate: () => { revision += 'x' } } })
  const ctx = () => vault.context('https://test', identity.pubkey)
  const context = () => ({ vault: ctx(), current: () => live, foreground: () => live })
  const device = await vault.enrol(ctx(), identity, clock + credentialSeconds)
  if (!device.ok) throw new Error(device.refusal)
  const card = new Uint8Array(126); card.set(new TextEncoder().encode('FSL1')); card[4] = 1; card.fill(3, 5, 37)
  const otherCard = card.slice(); otherCard.fill(4, 5, 37)
  memory.state = { account: identity.pubkey, transportSeed: new Uint8Array(32).fill(9), relayUrls: ['wss://synthetic-link.test/'],
    routes: [{ routeId: 'keeper-box', card, pairedRouteSecret: new Uint8Array(32).fill(5), cardSerial: 1n, cardVerifiedAt: 1n },
      { routeId: 'other-box', card: otherCard, pairedRouteSecret: new Uint8Array(32).fill(6), cardSerial: 1n, cardVerifiedAt: 1n }] }
  const sent: any[][] = [], listeners: LinkListener[] = [], reservations: unknown[] = []
  const engine = { stop: vi.fn(async () => {}), pairRoute: vi.fn(), removeRoute: vi.fn(), request: vi.fn(), retireRoute: vi.fn(), finalizeRoute: vi.fn(),
    openSocket: vi.fn(async (_url: string, _route: string, listener: LinkListener) => {
      listeners.push(listener)
      await socketHook()
      queueMicrotask(() => listener.onText?.(JSON.stringify(['AUTH', 'ab'.repeat(32)])))
      return { disconnect: vi.fn(() => listener.onClosed?.('closed')), path: () => ({ status: 'relayed', relay: null, direct: null, cause: '' }),
        sendText: (text: string) => {
          const frame = JSON.parse(text); sent.push(frame)
          if (frame[0] === 'AUTH' && !stallAuth) queueMicrotask(() => listener.onText?.(JSON.stringify(['OK', frame[1].id, auth, ''])))
          if (frame[0] === 'EVENT' && !stallAck) queueMicrotask(() => listener.onText?.(JSON.stringify(['OK', frame[1].id, ack, ''])))
        } }
    }) } satisfies LinkEngine
  const start = vi.fn(async () => { reservations.push(structuredClone((await readMlsMembership(tx)).standalone?.observations[0]?.attempt)); await startHook(); return engine })
  const foreground = new BrowserMlsGrantForeground(), controller = new AbortController(), scope = { signal: controller.signal, current: () => live && !controller.signal.aborted }
  vi.spyOn(foreground, 'capture').mockImplementation(() => scope)
  vi.spyOn(foreground, 'prepared').mockImplementation(candidate => candidate === scope && scope.current())
  vi.spyOn(foreground, 'track').mockImplementation(async (_scope, work) => work())
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } })
  const nativeSocket = vi.fn(function () { throw new Error('native socket sentinel') }); vi.stubGlobal('WebSocket', nativeSocket)
  vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000)
  const endpoint = new BrowserMlsGrantEndpoint(foreground, () => activeIdentity, () => live, start); endpoints.push(endpoint)
  const boxes = await endpoint.pairedBoxes(identity.pubkey), box = boxes[0]!, node = mlsBoxNode(box)
  const permission = (change: { node?: string; keeperKey?: Uint8Array; device?: string; expiration?: number } = {}) => finalizeEvent({ kind: 24242, created_at: clock, content: '', tags: [
    ['t', 'keeper-inbox-deposit'], ['server', keeperInboxDestination(change.node ?? node)], ['device', change.device ?? device.value.device],
    ['grant', 'cd'.repeat(16)], ['expiration', String(change.expiration ?? clock + 3600)], ['status', 'active'],
  ] }, change.keeperKey ?? keeperKey)
  const permit = permission(), current = () => permitted, consent = vi.fn<KeeperInboxAuthPrompt>(async () => 'approve')
  const options = (over = {}) => ({ identity, endpoint, vault, routeId: box.routeId, permission: permit, consent, current, random: () => 0, ...over })
  await rememberStandaloneRevocations(tx, identity.pubkey, keeper.pubkey, '11'.repeat(32), [
    { identity: identity.pubkey, device: '33'.repeat(32), homeBox: '44'.repeat(32), own: false, pending: false },
  ], clock)
  const restart = () => new BrowserMlsRevocationOutbox(coordinator as any, context, () => clock), outbox = restart()
  const operation = (await readMlsMembership(tx)).standalone!.observations[0]!.operation
  identity.signEvent.mockClear(); identity.encrypt.mockClear()
  const publicTransport = { directory: vi.fn(async () => [await keeper.signEvent(dmRelayListTemplate(['wss://keeper.test/'], clock))]), publish: vi.fn(async () => {}) }
  return { outbox, restart, operation, options, identity, keeper, permit, permission, node, box, boxes, tx, vault, ctx, endpoint, start, engine, sent, listeners, reservations, nativeSocket, consent, publicTransport,
    now: () => clock, clock: (value: number) => { clock = value }, unpermit: () => { permitted = false }, hide: () => { live = false; controller.abort() },
    swap: () => { generation++ }, replaceSigner: () => { activeIdentity = { ...identity } }, hold: () => { held = true }, refuseAuth: () => { auth = false }, refuseAck: () => { ack = false },
    stallAck: () => { stallAck = true }, stallAuth: () => { stallAuth = true },
    cleanupReservation: (work: () => void | Promise<void>) => { reservationCleanup = work },
    beforeConfirmation: (work: () => void | Promise<void>) => { beforeConfirmation = work },
    beforeStartReturns: (work: () => void | Promise<void>) => { startHook = work },
    beforeSocketReturns: (work: () => void | Promise<void>) => { socketHook = work },
    removeSavedRoute: () => { memory.state.routes = memory.state.routes.filter((route: any) => route.routeId !== box.routeId) },
    rebindSavedRoute: () => { memory.state.routes[0].card = otherCard.slice() } }
}
const record = async (f: Awaited<ReturnType<typeof fixture>>) => (await readMlsMembership(f.tx)).standalone!.observations[0]!
const noPublic = (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(f.nativeSocket).not.toHaveBeenCalled(); expect(publicRoomOperation).not.toHaveBeenCalled(); expect(f.engine.request).not.toHaveBeenCalled()
  expect(f.publicTransport.directory).not.toHaveBeenCalled(); expect(f.publicTransport.publish).not.toHaveBeenCalled()
}

describe('concrete private standalone revocation sending', () => {
  it('journals exact private intent before sealing or Link startup and ACKs only one private wrap after device AUTH', async () => {
    const f = await fixture(), originalEncrypt = f.identity.encrypt.getMockImplementation()!
    f.identity.encrypt.mockImplementation(async (...args) => {
      expect((await record(f)).attempt).toMatchObject({ confirmed: false, private: { routeId: f.box.routeId, eventUrl: f.box.eventUrl,
        node: f.node, keeper: f.keeper.pubkey, permissionId: f.permit.id, transmittingDevice: f.permit.tags[2]![1] } })
      expect(f.start).not.toHaveBeenCalled(); return originalEncrypt(...args)
    })
    const result = await f.outbox.sendPrivately(f.operation, f.options())
    expect(result).toMatchObject({ state: 'active', value: { requestState: 'sent', publicAttempted: false,
      privateDestination: { routeId: f.box.routeId, permissionId: f.permit.id } } })
    expect(f.reservations).toEqual([expect.objectContaining({ confirmed: false, private: expect.objectContaining({ node: f.node }) })])
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT'])
    expect(f.sent[0]![1]).toMatchObject({ kind: 22242, pubkey: f.permit.tags[2]![1], tags: [['relay', f.box.eventUrl], ['challenge', 'ab'.repeat(32)]] })
    const wrap = f.sent[1]![1] as Event
    expect(wrap.tags).toEqual([['p', f.keeper.pubkey]])
    expect(await unwrapVmlsRevocationRequest(wrap, f.keeper, f.now())).toMatchObject({ sender: f.identity.pubkey, keeper: f.keeper.pubkey, device: '33'.repeat(32) })
    expect(f.identity.signEvent).toHaveBeenCalledOnce(); expect(f.identity.signEvent.mock.calls[0]![0].kind).toBe(13)
    expect(f.consent).toHaveBeenCalledOnce(); noPublic(f)
  })
  it.each(['signature', 'device', 'keeper', 'route', 'expired', 'missing-route'] as const)('rejects %s before crypto or network', async change => {
    const f = await fixture()
    const permission = change === 'signature' ? { ...f.permit, sig: '00'.repeat(64) } :
      change === 'device' ? f.permission({ device: '56'.repeat(32) }) :
      change === 'keeper' ? f.permission({ keeperKey: generateSecretKey() }) :
      change === 'route' ? f.permission({ node: mlsBoxNode(f.boxes[1]!) }) :
      change === 'expired' ? f.permission({ expiration: f.now() }) : f.permit
    await expect(f.outbox.sendPrivately(f.operation, f.options({ permission, ...(change === 'missing-route' ? { routeId: 'absent' } : {}) }))).rejects.toThrow()
    expect((await record(f)).attempt).toBeUndefined(); expect(f.identity.encrypt).not.toHaveBeenCalled(); expect(f.identity.signEvent).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled(); noPublic(f)
  })
  it.each(['expired', 'revoked'] as const)('refuses an already %s transmitting credential before payload crypto or startup', async change => {
    const f = await fixture(change === 'expired' ? 1 : 86400)
    if (change === 'expired') f.clock(f.now() + 1)
    else {
      const device = await f.vault.device(f.ctx())
      if (!device.ok) throw new Error(device.refusal)
      await f.vault.revokeCredential(f.ctx(), device.value.credentialId)
    }
    await expect(f.outbox.sendPrivately(f.operation, f.options())).rejects.toThrow('current transmitting device is unavailable')
    expect((await record(f)).attempt).toBeUndefined(); expect(f.identity.encrypt).not.toHaveBeenCalled(); expect(f.identity.signEvent).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled(); noPublic(f)
  })
  it('keeps a pending reservation from reaching payload crypto or startup', async () => {
    const f = await fixture(); f.hold()
    expect(await f.outbox.sendPrivately(f.operation, f.options())).toMatchObject({ state: 'pending' })
    expect((await record(f)).attempt).toBeUndefined(); expect(f.identity.encrypt).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); noPublic(f)
  })
  it.each(['expired', 'removed-route', 'rebound-route'] as const)('refuses %s after blocked reservation cleanup before payload crypto and startup', async change => {
    const f = await fixture(change === 'expired' ? 1 : 86400)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    f.cleanupReservation(async () => { enter(); await waiting })
    const pending = f.outbox.sendPrivately(f.operation, f.options()), refusal = expect(pending).rejects.toThrow()
    await entered
    expect(f.identity.encrypt).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
    if (change === 'expired') f.clock(f.now() + 1)
    if (change === 'removed-route') f.removeSavedRoute()
    if (change === 'rebound-route') f.rebindSavedRoute()
    release(); await refusal
    expect(f.identity.encrypt).not.toHaveBeenCalled(); expect(f.identity.signEvent).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
    expect((await record(f)).attempt?.confirmed).toBe(false); expect(f.sent).toEqual([]); noPublic(f)
  })
  it('rechecks the actual saved route after payload crypto and before native startup', async () => {
    const f = await fixture(), encrypt = f.identity.encrypt.getMockImplementation()!
    f.identity.encrypt.mockImplementation(async (...args) => { const result = await encrypt(...args); f.removeSavedRoute(); return result })
    await expect(f.outbox.sendPrivately(f.operation, f.options())).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled(); expect(f.sent).toEqual([]); expect((await record(f)).attempt?.confirmed).toBe(false); noPublic(f)
  })
  it.each(['expired', 'removed-route', 'rebound-route'] as const)('refuses %s after blocked native startup and stops that engine before any socket', async change => {
    const f = await fixture(change === 'expired' ? 1 : 86400)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    f.beforeStartReturns(async () => { enter(); await waiting })
    const pending = f.outbox.sendPrivately(f.operation, f.options()), refusal = expect(pending).rejects.toThrow()
    await entered
    if (change === 'expired') f.clock(f.now() + 1)
    if (change === 'removed-route') f.removeSavedRoute()
    if (change === 'rebound-route') f.rebindSavedRoute()
    release(); await refusal
    expect(f.engine.stop).toHaveBeenCalledOnce(); expect(f.engine.openSocket).not.toHaveBeenCalled()
    expect(f.sent).toEqual([]); expect((await record(f)).attempt?.confirmed).toBe(false); noPublic(f)
  })
  it.each(['expired', 'removed-route', 'rebound-route'] as const)('refuses %s after native socket negotiation before any AUTH', async change => {
    const f = await fixture(change === 'expired' ? 1 : 86400)
    f.beforeSocketReturns(() => {
      if (change === 'expired') f.clock(f.now() + 1)
      if (change === 'removed-route') f.removeSavedRoute()
      if (change === 'rebound-route') f.rebindSavedRoute()
    })
    await expect(f.outbox.sendPrivately(f.operation, f.options())).rejects.toThrow()
    expect(f.sent).toEqual([]); expect((await record(f)).attempt?.confirmed).toBe(false); noPublic(f)
  })
  it('snapshots permission before the first await and the wrapper before endpoint scheduling', async () => {
    const f = await fixture(), permission = structuredClone(f.permit), original = f.endpoint.depositKeeperInbox.bind(f.endpoint)
    const passed: string[] = []
    vi.spyOn(f.endpoint, 'depositKeeperInbox').mockImplementation((box, input) => {
      passed.push(input.event.id)
      const waiting = original(box, input)
      input.event.content = 'tampered after endpoint invocation'
      return waiting
    })
    const pending = f.outbox.sendPrivately(f.operation, f.options({ permission }))
    permission.tags[1]![1] = keeperInboxDestination(mlsBoxNode(f.boxes[1]!))
    expect(await pending).toMatchObject({ value: { requestState: 'sent' } })
    expect(f.sent.find(frame => frame[0] === 'EVENT')![1].id).toBe(passed[0])
    expect(f.sent[0]![1].tags[0]).toEqual(['relay', f.box.eventUrl]); noPublic(f)
  })
  it.each(['routeId', 'eventUrl', 'node', 'keeper', 'permissionId', 'transmittingDevice', 'history'] as const)('fences corrupt protected private %s binding', async field => {
    const f = await fixture(); await f.outbox.sendPrivately(f.operation, f.options())
    const [id, bytes] = [...f.tx.vault].find(([, data]) => JSON.parse(new TextDecoder().decode(data)).standalone)!
    const journal = JSON.parse(new TextDecoder().decode(bytes)), item = journal.standalone.observations[0]
    if (field === 'history') delete item.publicAttempted
    else item.attempt.private[field] = field === 'keeper' || field === 'node' ? '77'.repeat(32) : field === 'routeId' ? 'bad/' : 'bad'
    f.tx.vault.set(id, new TextEncoder().encode(JSON.stringify(journal)))
    await expect(f.restart().records()).rejects.toBeInstanceOf(InvalidPersonaRecord)
  })
  it('does not reuse public success as private ACK; explicit revision switching preserves public history', async () => {
    const f = await fixture()
    await f.outbox.send(f.operation, { identity: f.identity, transport: f.publicTransport, random: () => 0 })
    await expect(f.outbox.sendPrivately(f.operation, f.options())).rejects.toThrow('different delivery destination')
    expect(f.start).not.toHaveBeenCalled()
    expect(await f.outbox.sendPrivately(f.operation, f.options(), 1)).toMatchObject({ value: { requestState: 'sent', requestRevision: 2, publicAttempted: true } })
    await expect(f.outbox.send(f.operation, { identity: f.identity, transport: f.publicTransport })).rejects.toThrow('different delivery destination')
    expect(await f.restart().records()).toMatchObject({ value: [{ publicAttempted: true, privateDestination: { permissionId: f.permit.id } }] })
  })
  it('allows explicit private-to-public-to-private retries while retaining public attempt history', async () => {
    const f = await fixture(); await f.outbox.sendPrivately(f.operation, f.options())
    const publicResult = await f.outbox.retry(f.operation, 1, { identity: f.identity, transport: f.publicTransport, random: () => 0 })
    expect(publicResult).toMatchObject({ value: { requestRevision: 2, requestState: 'sent', publicAttempted: true } })
    if (publicResult.state === 'active') expect(publicResult.value.privateDestination).toBeUndefined()
    expect(await f.outbox.sendPrivately(f.operation, f.options(), 2)).toMatchObject({ value: { requestRevision: 3, publicAttempted: true,
      privateDestination: { routeId: f.box.routeId } } })
  })
  it('requires explicit revision for cross-route retry and retains fresh private history through expiry', async () => {
    const f = await fixture(); await f.outbox.sendPrivately(f.operation, f.options())
    const alternative = { routeId: f.boxes[1]!.routeId, permission: f.permission({ node: mlsBoxNode(f.boxes[1]!) }) }
    await expect(f.restart().sendPrivately(f.operation, f.options(alternative))).rejects.toThrow('different delivery destination')
    expect(await f.outbox.sendPrivately(f.operation, f.options(alternative), 1)).toMatchObject({ value: { requestRevision: 2, publicAttempted: false, privateDestination: { routeId: alternative.routeId } } })
    f.clock(f.now() + VMLS_REVOCATION_REQUEST_SECONDS)
    expect(await f.restart().records()).toMatchObject({ value: [{ requestState: 'none', publicAttempted: false }] })
  })
  it('refuses incompatible in-flight mode, route, revision and signer while coalescing identical intent', async () => {
    const f = await fixture(); let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    const originalEncrypt = f.identity.encrypt.getMockImplementation()!
    f.identity.encrypt.mockImplementation(async (...args) => { enter(); await wait; return originalEncrypt(...args) })
    const options = f.options(), first = f.outbox.sendPrivately(f.operation, options)
    await entered
    expect(f.outbox.sendPrivately(f.operation, options)).toBe(first)
    await expect(f.outbox.send(f.operation, { identity: f.identity, transport: f.publicTransport })).rejects.toThrow('already running')
    await expect(f.outbox.sendPrivately(f.operation, f.options({ routeId: f.boxes[1]!.routeId, permission: f.permission({ node: mlsBoxNode(f.boxes[1]!) }) }))).rejects.toThrow('already running')
    await expect(f.outbox.sendPrivately(f.operation, options, 1)).rejects.toThrow('already running')
    await expect(f.outbox.sendPrivately(f.operation, f.options({ identity: { ...f.identity } }))).rejects.toThrow('already running')
    expect(await f.restart().sendPrivately(f.operation, options)).toMatchObject({ value: { requestState: 'unconfirmed' } })
    release(); await first; expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT']); noPublic(f)
  })
  it('bounds pending sends before independent reservation callbacks settle', async () => {
    const f = await fixture(), options = { identity: f.identity, transport: f.publicTransport }
    const pending = Array.from({ length: 64 }, (_, index) => f.outbox.send((index + 1).toString(16).padStart(64, '0'), options).catch(() => undefined))
    await expect(f.outbox.send('ff'.repeat(32), options)).rejects.toThrow('send queue is full')
    await Promise.all(pending); noPublic(f)
  })
  it.each(['permission', 'account', 'pause', 'signer', 'device-revoked'] as const)('suppresses late AUTH after %s changes during consent', async change => {
    const f = await fixture()
    const consent: KeeperInboxAuthPrompt = async () => {
      if (change === 'permission') f.unpermit()
      if (change === 'account') f.swap()
      if (change === 'pause') f.hide()
      if (change === 'signer') f.replaceSigner()
      if (change === 'device-revoked') { const d = await f.vault.device(f.ctx()); if (d.ok) await f.vault.revokeCredential(f.ctx(), d.value.credentialId) }
      return 'approve'
    }
    await expect(f.outbox.sendPrivately(f.operation, f.options({ consent }))).rejects.toThrow()
    expect(f.sent).toEqual([]); expect((await record(f)).attempt?.confirmed).toBe(false); noPublic(f)
  })
  it.each(['AUTH', 'EVENT'] as const)('retains an uncertain private attempt after %s refusal and never automatically retries', async phase => {
    const f = await fixture(); if (phase === 'AUTH') f.refuseAuth(); else f.refuseAck()
    await expect(f.outbox.sendPrivately(f.operation, f.options())).rejects.toThrow()
    expect((await record(f)).attempt?.confirmed).toBe(false)
    const count = f.sent.length
    expect(await f.restart().sendPrivately(f.operation, f.options())).toMatchObject({ value: { requestState: 'unconfirmed' } })
    expect(f.sent).toHaveLength(count); noPublic(f)
  })
  it.each(['expired', 'revoked'] as const)('sends no EVENT when the original credential becomes %s while AUTH ACK is pending', async change => {
    const f = await fixture(change === 'expired' ? 1 : 86400); f.stallAuth()
    const pending = f.outbox.sendPrivately(f.operation, f.options())
    const refusal = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.sent.map(frame => frame[0])).toEqual(['AUTH']))
    if (change === 'expired') f.clock(f.now() + 1)
    else {
      const device = await f.vault.device(f.ctx())
      if (!device.ok) throw new Error(device.refusal)
      await f.vault.revokeCredential(f.ctx(), device.value.credentialId)
    }
    f.listeners[0]!.onText?.(JSON.stringify(['OK', f.sent[0]![1].id, true, '']))
    await refusal
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH'])
    expect((await record(f)).attempt?.confirmed).toBe(false); expect(f.consent).toHaveBeenCalledOnce(); noPublic(f)
  })
  it('keeps a queued final confirmation unconfirmed when the original credential expires after EVENT ACK', async () => {
    const f = await fixture(1); f.stallAck()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const pending = f.outbox.sendPrivately(f.operation, f.options())
    await vi.waitFor(() => expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT']))
    f.beforeConfirmation(async () => { enter(); await waiting })
    f.listeners[0]!.onText?.(JSON.stringify(['OK', f.sent[1]![1].id, true, '']))
    await entered
    f.clock(f.now() + 1); release()
    expect(await pending).toMatchObject({ state: 'pending' })
    expect((await record(f)).attempt?.confirmed).toBe(false)
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT']); expect(f.consent).toHaveBeenCalledOnce(); noPublic(f)
  })
  it('holds queued final confirmation on a rewind that stays after reservation time', async () => {
    const f = await fixture(), reservedAt = f.now(); f.stallAck()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const pending = f.outbox.sendPrivately(f.operation, f.options())
    await vi.waitFor(() => expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT']))
    f.clock(reservedAt + 10)
    f.beforeConfirmation(async () => { enter(); await waiting })
    f.listeners[0]!.onText?.(JSON.stringify(['OK', f.sent[1]![1].id, true, '']))
    await entered
    f.clock(reservedAt + 5); release()
    expect(await pending).toMatchObject({ state: 'pending' })
    expect((await record(f)).attempt?.confirmed).toBe(false)
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'EVENT']); expect(f.consent).toHaveBeenCalledOnce(); noPublic(f)
  })
  it('cannot confirm a late ACK after private permission withdrawal', async () => {
    const f = await fixture(); f.stallAck()
    const pending = f.outbox.sendPrivately(f.operation, f.options())
    const refusal = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.sent.some(frame => frame[0] === 'EVENT')).toBe(true))
    const wrap = f.sent.find(frame => frame[0] === 'EVENT')![1]
    f.unpermit(); f.listeners[0]!.onText?.(JSON.stringify(['OK', wrap.id, true, 'late']))
    await refusal; expect((await record(f)).attempt?.confirmed).toBe(false); noPublic(f)
  })
  it('retains legacy public history even when the old attempt expires before a private retry', async () => {
    const f = await fixture(), journal = await readMlsMembership(f.tx), item = journal.standalone!.observations[0]!
    item.requestRevision = 1; item.attempt = { revision: 1, createdAt: f.now(), expiration: f.now() + VMLS_REVOCATION_REQUEST_SECONDS, confirmed: true }
    await saveMlsMembership(f.tx, journal)
    f.clock(f.now() + VMLS_REVOCATION_REQUEST_SECONDS)
    const enrolled = await f.vault.enrol(f.ctx(), f.identity, f.now() + 86400, { replace: true })
    if (!enrolled.ok) throw new Error(enrolled.refusal)
    const permission = f.permission({ device: enrolled.value.device })
    expect(await f.outbox.sendPrivately(f.operation, f.options({ permission }), 1)).toMatchObject({ value: { publicAttempted: true, requestRevision: 2 } })
  })
})
