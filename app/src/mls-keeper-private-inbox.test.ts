import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { wrapVmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { planMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import { BrowserMlsGrantForeground } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { BrowserMlsKeeperPrivateInboxFetch } from './mls-keeper-private-inbox-fetch.js'
import { BrowserMlsKeeperInboxFetch } from './mls-keeper-inbox-fetch.js'
import { BrowserMlsRevocationInbox } from './mls-revocation-inbox.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { LinkEngine, LinkListener } from './browser-link-types.js'
import { NostrVmlsRevocationTransport } from './mls-revocation-relay.js'
import { publicRoomOperation } from './public-room-operation.js'

// Storage and native-Link test seams only. Exercise real BrowserLink pinning,
// concrete endpoint lifecycle, NIP-42 page protocol and witnessed inbox intake.
const memory = vi.hoisted(() => ({ state: undefined as any }))
vi.mock('./mls-grant-link-vault.js', () => ({ MLS_GRANT_LINK_OWNER: 'private-inbox-test-owner',
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
async function fixture() {
  const secret = generateSecretKey(), base = { ...localIdentity(secret), ...localPeerCrypt(secret) }
  let now = 1_000_000, live = true, generation = 1, permitted = true, complete = true, authority = true, held = false, paging = false, pageLimit = 64
  const signer = { ...base, signEvent: vi.fn(base.signEvent), decrypt: vi.fn(base.decrypt) }
  let activeIdentity = signer
  const card = new Uint8Array(126); card.set(new TextEncoder().encode('FSL1')); card[4] = 1; card.fill(3, 5, 37)
  memory.state = { account: base.pubkey, transportSeed: new Uint8Array(32).fill(9), relayUrls: ['wss://synthetic-link.test/'],
    routes: [{ routeId: 'keeper-box', card, pairedRouteSecret: new Uint8Array(32).fill(5), cardSerial: 1n, cardVerifiedAt: 1n }] }
  const events: Event[] = [], sent: any[] = []
  const listeners: LinkListener[] = []
  const engine = { stop: vi.fn(async () => {}), pairRoute: vi.fn(), removeRoute: vi.fn(), request: vi.fn(), retireRoute: vi.fn(), finalizeRoute: vi.fn(),
    openSocket: vi.fn(async (_url: string, _routeId: string, listener: LinkListener) => {
      listeners.push(listener)
      const socket = { disconnect: vi.fn(() => listener.onClosed?.('closed')), path: () => ({ status: 'relayed', relay: null, direct: null, cause: '' }),
        sendText: (text: string) => {
          const frame = JSON.parse(text); sent.push(frame)
          if (frame[0] === 'AUTH') queueMicrotask(() => listener.onText?.(JSON.stringify(['OK', frame[1].id, authority, authority ? '' : 'denied'])))
          if (frame[0] === 'REQ') queueMicrotask(() => {
            const filter = frame[2]
            const page = paging ? events.filter(event => event.created_at >= filter.since && event.created_at <= filter.until)
              .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, Math.min(filter.limit, pageLimit)) : events
            for (const event of page) listener.onText?.(JSON.stringify(['EVENT', frame[1], event]))
            listener.onText?.(JSON.stringify(complete ? ['EOSE', frame[1]] : ['CLOSED', frame[1], 'incomplete']))
          })
        } }
      queueMicrotask(() => listener.onText?.(JSON.stringify(['AUTH', 'synthetic-challenge'])))
      return socket
    }) } satisfies LinkEngine
  const start = vi.fn(async () => engine), foreground = new BrowserMlsGrantForeground(), controller = new AbortController()
  const scope = { signal: controller.signal, current: () => live && !controller.signal.aborted }
  vi.spyOn(foreground, 'capture').mockImplementation(() => scope)
  vi.spyOn(foreground, 'prepared').mockImplementation(candidate => candidate === scope && scope.current())
  vi.spyOn(foreground, 'track').mockImplementation(async (_scope, work) => work())
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } })
  const nativeSocket = vi.fn(function () { throw new Error('native socket sentinel') })
  vi.stubGlobal('WebSocket', nativeSocket)
  vi.spyOn(Date, 'now').mockImplementation(() => now * 1000)
  const endpoint = new BrowserMlsGrantEndpoint(foreground, () => activeIdentity, () => live, start)
  endpoints.push(endpoint)
  const tx = new MemoryTransaction()
  const context = () => ({ vault: { principal: 'https://test', persona: base.pubkey, generation, revision: 'one' }, current: () => live, foreground: () => live })
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (held || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([key, bytes]) => [key, bytes.slice()])))
    const value = await work(candidate)
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    tx.vault.clear(); for (const [key, bytes] of candidate.vault) tx.vault.set(key, bytes)
    return { state: 'active', value, marks: new Map() }
  } }
  const records: MlsGrantRecord[] = []
  const inbox = new BrowserMlsRevocationInbox(coordinator as any, { all: async () => structuredClone(records) }, context, () => now)
  const fetch = () => new BrowserMlsKeeperPrivateInboxFetch(coordinator as any, inbox, endpoint, context, () => now)
  const permission = { routeId: 'keeper-box', authenticate: true, mode: 'retained' as const, current: () => permitted }
  const wrap = async (withGrant = false) => {
    const memberSecret = generateSecretKey(), member = { ...localIdentity(memberSecret), ...localPeerCrypt(memberSecret) }
    if (withGrant) {
      const box = (await endpoint.pairedBoxes(base.pubkey))[0]!
      const record = await planMlsGrant(base, box, member.pubkey, '33'.repeat(32), { session: '55'.repeat(32), name: 'Previous room', leaf: '77'.repeat(32) }, now)
      record.state = 'active'; record.rooms = []; records.push(record)
    }
    return wrapVmlsRevocationRequest(member, { sender: member.pubkey, keeper: base.pubkey, device: '33'.repeat(32),
      sessions: ['55'.repeat(32)], boxes: ['44'.repeat(32)], createdAt: now, expiration: now + 600 }, () => 0)
  }
  return { tx, inbox, endpoint, coordinator, context, signer, fetch, permission, start, engine, sent, events, listeners, nativeSocket, wrap,
    now: () => now, clock: (value: number) => { now = value }, hide: () => { live = false }, change: () => { generation++ },
    unpermit: () => { permitted = false }, incomplete: () => { complete = false }, refuseAuth: () => { authority = false }, hold: () => { held = true },
    pageServer: (limit = 64) => { paging = true; pageLimit = limit }, replaceSigner: () => { activeIdentity = { ...signer } } }
}

function noPublic(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.nativeSocket).not.toHaveBeenCalled()
  expect(publicRoomOperation).not.toHaveBeenCalled()
  expect(f.engine.request).not.toHaveBeenCalled()
}

describe('private keeper inbox on the dedicated grant endpoint', () => {
  it('reads a real signed request only after keeper AUTH on the pinned Link route, with no public IO', async () => {
    const f = await fixture(); f.events.push(await f.wrap()); f.clock(f.now() + 1)
    const result = await f.fetch().check(f.signer, f.permission)
    expect(result).toMatchObject({ state: 'active', value: { status: 'checked', complete: true, view: { prompts: [] } } })
    expect(f.start).toHaveBeenCalledOnce(); expect(f.engine.openSocket).toHaveBeenCalledOnce()
    const [url, route] = f.engine.openSocket.mock.calls[0]!
    expect(url).toMatch(/^ws:\/\/[a-z2-7]+\/events$/); expect(route).toBe('keeper-box')
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH', 'REQ', 'CLOSE'])
    expect(f.sent[0][1]).toMatchObject({ pubkey: f.signer.pubkey, kind: 22242, tags: [['relay', url], ['challenge', 'synthetic-challenge']] })
    expect(f.sent[1][2]).toMatchObject({ kinds: [1059], '#p': [f.signer.pubkey], limit: 64 })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(2)
    const state = (await readMlsMembership(f.tx)).inbox!
    expect(state.privateScan!.cursors[0]).toMatchObject({ keeper: f.signer.pubkey, routeId: 'keeper-box', eventUrl: url })
    expect(Object.keys(state.privateScan!.cursors[0]!).sort()).toEqual(['eventUrl', 'keeper', 'routeId', 'until'])
    // Successful intake must not bypass the unchanged retained-grant/roster gate.
    expect(state.seen).toHaveLength(1)
    expect(state.scan).toBeUndefined(); expect(state.directory).toBeUndefined(); noPublic(f)
  })

  it('refuses missing consent, unknown route and a different receiving keeper before opening a socket', async () => {
    const f = await fixture()
    await expect(f.fetch().check(f.signer, { ...f.permission, authenticate: false })).rejects.toThrow('explicitly allow')
    await expect(f.fetch().check(f.signer, { ...f.permission, routeId: 'not-saved' })).rejects.toThrow('not saved')
    await expect(f.fetch().check({ ...f.signer, pubkey: '11'.repeat(32) }, f.permission)).rejects.toThrow('receiving keeper')
    expect(f.start).not.toHaveBeenCalled(); expect(f.signer.signEvent).not.toHaveBeenCalled(); noPublic(f)
  })

  it('refuses a structural endpoint substitute and invalidated witness/foreground without network work', async () => {
    const f = await fixture()
    expect(() => new BrowserMlsKeeperPrivateInboxFetch(f.coordinator as any, f.inbox, {} as any, f.context)).toThrow('dedicated grant endpoint')
    f.hold(); expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ state: 'pending' })
    expect(f.start).not.toHaveBeenCalled(); f.hide()
    await expect(f.fetch().check(f.signer, f.permission)).rejects.toThrow('foreground'); noPublic(f)
  })

  it('does not treat pairing as event authority and preserves the cursor on AUTH refusal', async () => {
    const f = await fixture(); f.refuseAuth()
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    expect(f.sent.map(frame => frame[0])).toEqual(['AUTH'])
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(f.now()); noPublic(f)
  })

  it('validates signature and exact recipient before decrypting or reserving an id', async () => {
    const f = await fixture(), valid = await f.wrap()
    f.events.push({ ...valid, content: 'forged', verified: true } as any,
      finalizeEvent({ kind: 1059, created_at: f.now(), tags: [['p', '11'.repeat(32)]], content: 'foreign' }, generateSecretKey()), valid)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(2)
    expect((await readMlsMembership(f.tx)).inbox!.seen).toHaveLength(1); noPublic(f)
  })

  it('keeps incomplete private progress across fetch reconstruction without borrowing public cursors at the same URL', async () => {
    const f = await fixture(); f.events.push(await f.wrap()); f.incomplete()
    const box = (await f.endpoint.pairedBoxes(f.signer.pubkey))[0]!
    await f.inbox.view()
    const journal = await readMlsMembership(f.tx)
    journal.inbox!.scan = { lastPageAt: f.now() - 100, nextRelay: box.eventUrl, cursors: [{ relay: box.eventUrl, until: f.now() - 500 }] }
    await saveMlsMembership(f.tx, journal)
    await f.fetch().check(f.signer, f.permission)
    const firstUntil = f.sent.find(frame => frame[0] === 'REQ')[2].until
    f.clock(f.now() + 60); await f.fetch().check(f.signer, f.permission)
    expect(f.sent.filter(frame => frame[0] === 'REQ')[1][2].until).toBe(firstUntil)
    const state = (await readMlsMembership(f.tx)).inbox!
    expect(state.privateScan!.cursors[0]!.until).toBe(firstUntil)
    expect(state.scan!.cursors[0]!.until).toBe(firstUntil - 500); noPublic(f)
  })

  it('shares the page budget with public checks so switching transport cannot reset it', async () => {
    const f = await fixture(); await f.fetch().check(f.signer, f.permission)
    const transport = { directory: vi.fn(async () => []), page: vi.fn() }
    const publicFetch = new BrowserMlsKeeperInboxFetch(f.coordinator as any, f.inbox, transport, f.context, f.now)
    expect(await publicFetch.check(f.signer)).toMatchObject({ value: { status: 'rate-limited' } })
    expect(transport.directory).not.toHaveBeenCalled(); expect(transport.page).not.toHaveBeenCalled()
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { status: 'rate-limited' } })
    expect(f.engine.openSocket).toHaveBeenCalledOnce(); noPublic(f)
  })

  it('does not advance an EOSE page until the shared decryption budget has processed every verified candidate', async () => {
    const f = await fixture()
    f.events.push(...Array.from({ length: 9 }, (_, index) => finalizeEvent({ kind: 1059, created_at: f.now() - index,
      tags: [['p', f.signer.pubkey]], content: `unsupported-${index}` }, generateSecretKey())))
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(8)
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(f.now())
    f.clock(f.now() + 60)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: true } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(9)
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(f.now() - 68); noPublic(f)
  })

  it('honours a prior public page reservation before starting the private endpoint', async () => {
    const f = await fixture(); await f.inbox.view()
    const journal = await readMlsMembership(f.tx)
    journal.inbox!.scan = { lastPageAt: f.now(), nextRelay: null, cursors: [] }
    await saveMlsMembership(f.tx, journal)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { status: 'rate-limited' } })
    expect(f.start).not.toHaveBeenCalled(); expect(f.signer.signEvent).not.toHaveBeenCalled(); noPublic(f)
  })

  it.each(['permission', 'account', 'signer'] as const)('suppresses late AUTH after %s change', async change => {
    const f = await fixture(); let release!: () => void
    const originalSign = f.signer.signEvent.getMockImplementation()!
    f.signer.signEvent.mockImplementation(template => new Promise(resolve => { release = () => { void originalSign(template).then(resolve) } }))
    const pending = f.fetch().check(f.signer, f.permission)
    await vi.waitFor(() => expect(f.signer.signEvent).toHaveBeenCalledOnce(), { interval: 1 })
    if (change === 'permission') f.unpermit()
    if (change === 'account') f.change()
    if (change === 'signer') f.replaceSigner()
    release()
    const result = await pending
    expect(result).toMatchObject(change === 'signer' ? { value: { complete: false } } : { state: 'pending' })
    expect(f.sent).toEqual([]); noPublic(f)
  })

  it('pins route and keeper at the concrete endpoint and closes pending reads on stop', async () => {
    const f = await fixture(), boxes = await f.endpoint.resume(f.signer.pubkey), box = boxes[0]!
    const query = { keeper: f.signer.pubkey, since: 0, until: f.now(), authenticate: true, current: () => true }
    await expect(f.endpoint.keeperInboxPage({ ...box, eventUrl: 'wss://outside.test/' }, query)).rejects.toThrow('unavailable')
    await expect(f.endpoint.keeperInboxPage(box, { ...query, keeper: '11'.repeat(32) })).rejects.toThrow('unavailable')
    f.engine.openSocket.mockImplementation(async (_url, _route, listener) => ({ sendText: () => {}, disconnect: vi.fn(() => listener.onClosed?.('stopped')), path: () => ({ status: 'relayed', relay: null, direct: null, cause: '' }) }))
    const pending = f.endpoint.keeperInboxPage(box, query)
    await vi.waitFor(() => expect(f.engine.openSocket).toHaveBeenCalledOnce(), { interval: 1 })
    await f.endpoint.stop()
    expect(await pending).toEqual({ complete: false, events: [] }); expect(f.engine.stop).toHaveBeenCalledOnce(); noPublic(f)
  })

  it('rejects corrupt private route/keeper cursors rather than replacing them', async () => {
    const f = await fixture(); await f.fetch().check(f.signer, f.permission)
    for (const change of [{ keeper: '11'.repeat(32) }, { routeId: 'bad route' }, { eventUrl: 'https://not-events.test/' }]) {
      const journal = await readMlsMembership(f.tx)
      Object.assign(journal.inbox!.privateScan!.cursors[0]!, change)
      await expect(saveMlsMembership(f.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    }
    noPublic(f)
  })

  it.each([1, 2])('withdrawal during decrypt layer %i stops subsequent decryptions, later wraps and prompt commits', async layer => {
    const f = await fixture(); f.events.push(await f.wrap(true), await f.wrap())
    const originalDecrypt = f.signer.decrypt.getMockImplementation()!
    let calls = 0, release!: () => void
    f.signer.decrypt.mockImplementation((peer, ciphertext) => {
      calls++
      if (calls !== layer) return originalDecrypt(peer, ciphertext)
      return new Promise(resolve => { release = () => { void originalDecrypt(peer, ciphertext).then(resolve) } })
    })
    const pending = f.fetch().check(f.signer, f.permission)
    await vi.waitFor(() => expect(f.signer.decrypt).toHaveBeenCalledTimes(layer), { interval: 1 })
    f.unpermit(); release()
    expect(await pending).toMatchObject({ state: 'pending', reason: 'stale' })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(layer)
    const state = (await readMlsMembership(f.tx)).inbox!
    expect(state.seen).toHaveLength(1); expect(state.attempts).toHaveLength(1); expect(state.prompts).toEqual([])
    expect(state.privateScan!.cursors[0]!.until).toBe(f.now()); noPublic(f)
  })

  it('pages past 64 newer signed unsupported wraps to an older valid request after reconstruction', async () => {
    const f = await fixture(), valid = await f.wrap(true); f.pageServer(); f.clock(f.now() + 100)
    f.events.push(...Array.from({ length: 64 }, (_, index) => finalizeEvent({ kind: 1059, created_at: f.now() - index,
      tags: [['p', f.signer.pubkey], ['x', 'unsupported']], content: `opaque-${index}` }, generateSecretKey())), valid,
      { ...valid, created_at: valid.created_at - 100, content: 'forged boundary', verified: true } as any)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: true } })
    expect(f.signer.decrypt).not.toHaveBeenCalled()
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(f.now() - 63)
    f.clock(f.now() + 60)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: true, view: { prompts: [expect.any(Object)] } } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(2)
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(valid.created_at); noPublic(f)
  })

  it.each([1, 64])('holds a timestamp at server cap %i with inclusive overlap rather than skipping an older request', async cap => {
    const f = await fixture(), valid = await f.wrap(true); f.pageServer(cap); f.clock(f.now() + 1)
    f.events.push(...Array.from({ length: cap }, (_, index) => finalizeEvent({ kind: 1059, created_at: f.now(),
      tags: [['p', f.signer.pubkey], ['x', 'unsupported']], content: `opaque-${index}` }, generateSecretKey())), valid)
    const until = f.now()
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    f.clock(f.now() + 60)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    expect(f.sent.filter(frame => frame[0] === 'REQ').map(frame => frame[2].until)).toEqual([until, until])
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(until)
    expect(f.signer.decrypt).not.toHaveBeenCalled(); noPublic(f)
  })

  it('holds forged/irrelevant-only and empty pages without resetting an older private cursor to the head', async () => {
    const f = await fixture(), valid = await f.wrap()
    f.events.push({ ...valid, content: 'forged', verified: true } as any,
      finalizeEvent({ kind: 1059, created_at: f.now(), tags: [['p', '11'.repeat(32)]], content: 'foreign' }, generateSecretKey()))
    const until = f.now()
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    f.events.length = 0; f.clock(f.now() + 60)
    expect(await f.fetch().check(f.signer, f.permission)).toMatchObject({ value: { complete: false } })
    expect(f.sent.filter(frame => frame[0] === 'REQ').map(frame => frame[2].until)).toEqual([until, until])
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(until)
    expect(f.signer.decrypt).not.toHaveBeenCalled(); noPublic(f)
  })

  it.each(['empty', 'held'] as const)('a fresh default check reaches a later request after a %s head, preserving backfill through reconstruction', async scenario => {
    const f = await fixture(); f.pageServer(1)
    const retainedUntil = f.now()
    if (scenario === 'held') f.events.push(finalizeEvent({ kind: 1059, created_at: retainedUntil,
      tags: [['p', f.signer.pubkey], ['x', 'unsupported']], content: 'held boundary' }, generateSecretKey()))
    const latest: { routeId: string; authenticate: boolean; current(): boolean; mode?: 'latest' | 'retained' } = {
      routeId: f.permission.routeId, authenticate: true, current: f.permission.current,
    }
    expect(await f.fetch().check(f.signer, latest)).toMatchObject({ value: { mode: 'latest', complete: false } })
    f.clock(f.now() + 1); const valid = await f.wrap(true); f.events.push(valid)
    f.clock(f.now() + 60)
    const freshUntil = f.now(), pending = f.fetch().check(f.signer, latest)
    // The click-time mode is already captured; later caller mutation cannot
    // reinterpret the in-flight fresh check as retained history work.
    latest.mode = 'retained'
    expect(await pending).toMatchObject({ value: { mode: 'latest', view: { prompts: [expect.any(Object)] } } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(2)
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(retainedUntil)
    expect(await f.fetch().check(f.signer, latest)).toMatchObject({ value: { status: 'rate-limited', mode: 'retained' } })
    f.clock(f.now() + 60)
    expect(await f.fetch().check(f.signer, latest)).toMatchObject({ value: { mode: 'retained', complete: false } })
    expect(f.sent.filter(frame => frame[0] === 'REQ').map(frame => frame[2].until)).toEqual([retainedUntil, freshUntil, retainedUntil])
    expect((await readMlsMembership(f.tx)).inbox!.privateScan!.cursors[0]!.until).toBe(retainedUntil)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(2); noPublic(f)
  })

  it('refuses an unsupported scan mode without network or signer work', async () => {
    const f = await fixture()
    await expect(f.fetch().check(f.signer, { ...f.permission, mode: 'reset' as any })).rejects.toThrow('latest or retained')
    expect(f.start).not.toHaveBeenCalled(); expect(f.signer.signEvent).not.toHaveBeenCalled(); noPublic(f)
  })

  it('positive controls catch the public route gate and native WebSocket path', async () => {
    const f = await fixture()
    expect(() => new WebSocket('wss://public-sentinel.test/')).toThrow('native socket sentinel')
    await expect(new NostrVmlsRevocationTransport(['wss://directory-sentinel.test/']).directory(f.signer.pubkey)).rejects.toThrow('public route sentinel')
    expect(f.nativeSocket).toHaveBeenCalledOnce(); expect(publicRoomOperation).toHaveBeenCalledOnce()
  })
})
