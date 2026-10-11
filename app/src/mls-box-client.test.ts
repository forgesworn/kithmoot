import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { BrowserMlsBoxClient, MAX_MLS_ENVELOPE } from './mls-box-client.js'
import { base64Encode } from './mls-vault.js'
import { pairingFixture } from '../../test/mls-pairing-fixture.js'
import type { LinkRequest, LinkResponse, LinkRoute } from './browser-link-types.js'
import type { BoxRequest, BoxReply } from './mls-coordinated-vault.js'
vi.mock('./mls-engine.js', () => ({ loadMlsEngine: async () => ({ parseCapabilities: (raw: Uint8Array) => {
  const text = new TextDecoder().decode(raw), a = JSON.parse(text)
  if (text.includes(' ') || a.v !== 1 || a.security_contract !== 1 || a.slot_receipts !== 1 || a.fork_evidence !== 1 || a.restore_fence !== 1 ||
    Object.keys(a).length !== 6 || !/^[0-9a-f]{64}$/.test(a.installation)) throw new Error('UnsupportedSecurityContract')
  return hexToBytes(a.installation)
} }) }))
const enc = new TextEncoder(), id = new Uint8Array(32).fill(1), other = new Uint8Array(32).fill(2), env = Uint8Array.of(1, 2, 3)
const hash = bytesToHex(sha256(env)), installation = '79'.repeat(32)
const ctx = { principal: 'test', persona: '42'.repeat(32), generation: 0, revision: 'test' }
const wire = (value: unknown) => enc.encode(JSON.stringify(value))
const body = (code: string, extra = {}) => ({ v: 1, code, server_time: 123, ...extra })
const capabilities = { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1, installation }
function setup(status = 200, payload: unknown = capabilities, timeout = 1000) {
  const p = pairingFixture(), r = p.route
  const route: LinkRoute = { routeId: r.routeId, card: hexToBytes(r.card), pairedRouteSecret: hexToBytes(r.pairedRouteSecret), cardSerial: BigInt(r.cardSerial), cardVerifiedAt: BigInt(r.cardVerifiedAt) }
  const made = new WeakMap<object, BoxRequest>(), calls: LinkRequest[] = [], signed: BoxRequest[] = []
  let live = true
  const response: LinkResponse = { status, body: payload instanceof Uint8Array ? payload : wire(payload), witnessRefused: false, path: { status: 'up', relay: null, direct: null, cause: '' } }
  const vault = {
    current: vi.fn(() => live),
    signBoxRequestV1: vi.fn(async (_: unknown, req: BoxRequest) => { const reply: BoxReply = Object.freeze({ v: 1, device: ctx.persona, authorization: `Nostr fresh-${signed.length}` }); signed.push(req); made.set(reply, req); return { ok: true as const, value: reply } }),
    acceptBoxReply: vi.fn((req: BoxRequest, reply: unknown) => made.get(reply as object) === req ? { ok: true as const, value: reply as BoxReply } : { ok: false as const, refusal: 'unauthorised' as const }),
  }
  const transport = { request: vi.fn(async (req: LinkRequest) => { calls.push(req); return response }) }
  const client = new BrowserMlsBoxClient(transport, route, p.witness, vault, ctx, async () => 'approve', () => live, timeout)
  return { client, calls, signed, response, vault, transport, route, box: p.witness, stale: () => { live = false } }
}
function receipt(box: string, slot = id, attempt = 3, digest = hash) {
  const signed = new Uint8Array(197); signed[0] = 1
  signed.set(hexToBytes(box), 1); signed.set(hexToBytes(installation), 33); signed.set(slot, 65)
  new DataView(signed.buffer).setUint32(97, attempt); signed.set(hexToBytes(digest), 101)
  // Framing fixture only: signature validation is the engine's responsibility.
  return signed
}
afterEach(() => vi.useRealTimers())

describe('strict browser MLS box client', () => {
  it('does no constructor I/O and pins the requested identity to the verified paired card', () => {
    const f = setup(); expect(f.calls).toEqual([]); expect(f.signed).toEqual([])
    expect(() => new BrowserMlsBoxClient(f.transport, f.route, '00'.repeat(32), f.vault, ctx, async () => 'approve', () => true)).toThrow('differ')
    f.route.card[70] ^= 1
    expect(() => new BrowserMlsBoxClient(f.transport, f.route, f.box, f.vault, ctx, async () => 'approve', () => true)).toThrow('verified')
  })
  it('parses capabilities through the engine and freshly signs every retry', async () => {
    const f = setup()
    expect(await f.client.capabilities()).toEqual({ state: 'ok', value: { installation }, serverTime: null })
    await f.client.capabilities()
    expect(f.signed).toHaveLength(2); expect(f.calls[0].authorization).not.toBe(f.calls[1].authorization)
    expect(f.signed[0]).toEqual({ v: 1, box: f.box, method: 'GET', path: '/vmls/v1/capabilities', payload: bytesToHex(sha256(new Uint8Array())) })
  })
  it('copies caller bytes before signing and pins the captured route and context', async () => {
    const f = setup(201, body('stored', { receipt: hash })), input = env.slice(), mailbox = id.slice()
    const task = f.client.deposit(mailbox, input)
    input.fill(9); mailbox.fill(8); f.route.routeId = 'substituted'
    expect((await task).state).toBe('ok')
    expect(f.calls[0].body).toEqual(env); expect(f.calls[0].routeId).toBe('witness')
    expect(f.signed[0].payload).toBe(hash); expect(f.signed[0].path).toContain(bytesToHex(id))
  })
  for (const [status, code] of [[201, 'stored'], [200, 'duplicate']] as const) it(`accepts exact ${code} with package acknowledgement`, async () => {
    const f = setup(status, body(code, { receipt: hash, welcome: { acknowledged: false } }))
    expect(await f.client.deposit(id, env)).toEqual({ state: 'ok', value: { duplicate: code === 'duplicate', receipt: sha256(env), welcomeAcknowledged: false }, serverTime: 123 })
  })
  const malformed = [
    body('stored', { receipt: '00'.repeat(32) }), body('stored', { receipt: hash, extra: true }),
    body('stored', { receipt: hash, welcome: null }), body('stored', { receipt: hash, welcome: { acknowledged: 'false' } }),
    body('stored', { receipt: hash, welcome: { acknowledged: false, extra: 1 } }),
    { ...body('stored', { receipt: hash }), v: 2 }, { ...body('stored', { receipt: hash }), server_time: '123' },
    enc.encode(`{"v":1,"v":1,"code":"stored","server_time":123,"receipt":"${hash}"}`),
    enc.encode(`{"v":1,"code":"stored","server_time":1e2,"receipt":"${hash}"}`),
    enc.encode(`{"v":1,"code":"stored","server_time":-0,"receipt":"${hash}"}`),
    enc.encode(`{"v":1,"code":"stored","server_time":123,"receipt":"${hash}","welco\\u006de":{"acknowledged":false},"welcome":{"acknowledged":true}}`),
    concatBytes(wire(body('stored', { receipt: hash })), Uint8Array.of(0xff)),
    enc.encode('['.repeat(10) + '0' + ']'.repeat(10)), new Uint8Array(128 * 1024 + 1),
  ]
  for (const [i, value] of malformed.entries()) it(`refuses malformed deposit ${i}`, async () => {
    expect(await setup(201, value).client.deposit(id, env)).toEqual({ state: 'malformed' })
  })
  it('rejects status/code mismatch and preserves bounded refusal codes', async () => {
    expect(await setup(200, body('stored', { receipt: hash })).client.deposit(id, env)).toEqual({ state: 'malformed' })
    expect(await setup(429, body('rate-limited')).client.deposit(id, env)).toEqual({ state: 'refused', status: 429, code: 'rate-limited', serverTime: 123 })
    expect(await setup(404, new Uint8Array()).client.capabilities()).toEqual({ state: 'refused', status: 404, code: null, serverTime: null })
    expect(await setup(409, body('changed', { receipt: hash })).client.deposit(id, env)).toEqual({ state: 'malformed' })
    expect(await setup(503, body('consumed')).client.deposit(id, env)).toEqual({ state: 'malformed' })
    expect(await setup(503, body('new-server-code')).client.deposit(id, env)).toEqual({ state: 'malformed' })
    expect(await setup(503, body('constructor')).client.deposit(id, env)).toEqual({ state: 'malformed' })
    expect(await setup(409, body('consumed')).client.deposit(id, env)).toMatchObject({ state: 'refused', code: 'consumed' })
  })
  for (const code of ['won', 'duplicate', 'taken'] as const) it(`checks slot ${code} facts`, async () => {
    const f = setup(code === 'won' ? 201 : code === 'taken' ? 409 : 200), winner = code === 'taken' ? 4 : 3
    f.response.body = wire(body(code, { receipt: hash, attempt: winner, signed_receipt: base64Encode(receipt(f.box, id, winner)) }))
    expect(await f.client.depositSlot(id, 3, env)).toMatchObject({ state: 'ok', value: { outcome: code, attempt: winner } })
  })
  for (const offset of [0, 1, 65, 100, 101]) it(`rejects contradictory slot receipt byte ${offset}`, async () => {
    const f = setup(201), signed = receipt(f.box); signed[offset] ^= 1
    f.response.body = wire(body('won', { receipt: hash, attempt: 3, signed_receipt: base64Encode(signed) }))
    expect(await f.client.depositSlot(id, 3, env)).toEqual({ state: 'malformed' })
  })
  it('allows absent deposit signed receipt but rejects null, truncated and noncanonical receipts', async () => {
    const f = setup(201, body('won', { attempt: 3, receipt: hash }))
    expect(await f.client.depositSlot(id, 3, env)).toMatchObject({ state: 'ok', value: { signedReceipt: null } })
    for (const value of [null, base64Encode(receipt(f.box).slice(1)), base64Encode(receipt(f.box)).replace(/=+$/, '')]) {
      f.response.body = wire(body('won', { attempt: 3, receipt: hash, signed_receipt: value }))
      expect(await f.client.depositSlot(id, 3, env)).toEqual({ state: 'malformed' })
    }
  })
  for (const state of ['empty', 'filled', 'expired', 'void'] as const) it(`parses slot status ${state}`, async () => {
    const f = setup(), winner = state === 'void' ? 4 : 3
    f.response.body = wire(body(state, state === 'empty' ? {} : { attempt: winner, receipt: hash, signed_receipt: base64Encode(receipt(f.box, id, winner)), ...(state === 'filled' ? { envelope: base64Encode(env) } : {}) }))
    expect(await f.client.slotStatus(id, 3)).toMatchObject({ state: 'ok', value: { state } })
    if (state === 'empty') f.response.body = wire(body(state, { receipt: hash }))
    else f.response.body = wire(body(state, { attempt: winner, receipt: hash, signed_receipt: base64Encode(receipt(f.box, id, winner)), envelope: base64Encode(other) }))
    expect(await f.client.slotStatus(id, 3)).toEqual({ state: 'malformed' })
  })
  it('checks fetch membership, hashes, canonical base64, duplicates and cursors', async () => {
    const record = { mailbox: bytesToHex(id), receipt: hash, envelope: base64Encode(env) }, f = setup(200, body('ok', { records: [record], next: 'abc=' }))
    expect(await f.client.fetch([id], 'prior=')).toMatchObject({ state: 'ok', value: { records: [{ mailbox: id, receipt: sha256(env), envelope: env }], next: 'abc=' } })
    expect(JSON.parse(new TextDecoder().decode(f.calls[0].body))).toEqual({ v: 1, mailboxes: [bytesToHex(id)], after: 'prior=' })
    for (const fields of [{ records: [{ ...record, mailbox: bytesToHex(other) }] }, { records: [{ ...record, receipt: '00'.repeat(32) }] },
      { records: [{ ...record, envelope: 'AQI' }] }, { records: [record, record] }, { records: [record], next: '' }, { records: new Array(65).fill(record) }, { records: [{ ...record, extra: 1 }] }]) {
      f.response.body = wire(body('ok', fields)); expect(await f.client.fetch([id])).toEqual({ state: 'malformed' })
    }
  })
  it('signs exact acknowledgement and package bodies', async () => {
    const f = setup(200, body('marked', { acked: 1 }))
    expect(await f.client.ack([{ mailbox: id, receipt: sha256(env) }])).toMatchObject({ state: 'ok', value: { deleted: false, acked: 1 } })
    f.response.status = 201; f.response.body = wire(body('registered'))
    expect(await f.client.registerPackage(id, other, 200, 123)).toMatchObject({ state: 'ok', value: { fresh: true } })
    const registered = JSON.parse(new TextDecoder().decode(f.calls[1].body))
    expect(registered).toEqual({ v: 1, welcome_mailbox: bytesToHex(other), expires_at: 200, ciphertext: base64Encode(sha256(concatBytes(enc.encode('VMLS/1 package'), id, other))) })
    f.response.status = 200; f.response.body = wire(body('withdrawn'))
    expect(await f.client.withdrawPackage(id)).toMatchObject({ state: 'ok' }); expect(f.calls[2].body.length).toBe(0)
    for (let i = 0; i < f.calls.length; i++) expect(f.signed[i].payload).toBe(bytesToHex(sha256(f.calls[i].body)))
  })
  it('rejects caller bounds before signing or dispatch', () => {
    const f = setup()
    for (const call of [() => f.client.deposit(id, new Uint8Array(MAX_MLS_ENVELOPE + 1)), () => f.client.depositSlot(id, -1, env),
      () => f.client.slotStatus(id, 2 ** 32), () => f.client.fetch([]), () => f.client.fetch([id, id]), () => f.client.fetch([id], ''), () => f.client.fetch([id], 'abc\n'),
      () => f.client.ack([]), () => f.client.ack([{ mailbox: id, receipt: other }, { mailbox: id, receipt: other }]),
      () => f.client.registerPackage(id, other, 123, 123), () => f.client.registerPackage(id, other, 123 + 7 * 86400 + 1, 123),
      () => f.client.withdrawPackage(new Uint8Array(31))]) expect(call).toThrow()
    expect(f.signed).toEqual([]); expect(f.calls).toEqual([])
  })
  it('propagates signer faults without treating them as transport outages', async () => {
    const f = setup(); f.vault.signBoxRequestV1.mockRejectedValueOnce(new Error('signer fault'))
    await expect(f.client.capabilities()).rejects.toThrow('signer fault'); expect(f.calls).toEqual([])
  })
  it('rejects substituted signing provenance before send', async () => {
    const f = setup(); f.vault.signBoxRequestV1.mockResolvedValueOnce({ ok: true, value: { v: 1, device: ctx.persona, authorization: 'Nostr forged' } })
    expect(await f.client.capabilities()).toEqual({ state: 'not-signed', reason: 'unauthorised' }); expect(f.calls).toEqual([])
  })
  for (const moment of ['sign', 'send'] as const) for (const end of ['invalidate', 'timeout', 'stale'] as const) it(`withholds late ${moment} after ${end}`, async () => {
    vi.useFakeTimers(); const f = setup(); let release!: () => void, entered!: () => void
    const ready = new Promise<void>(r => { entered = r }), waiting = new Promise<void>(r => { release = r })
    const sign = f.vault.signBoxRequestV1.getMockImplementation()!, send = f.transport.request.getMockImplementation()!
    if (moment === 'sign') f.vault.signBoxRequestV1.mockImplementationOnce(async (ctx, req) => { entered(); await waiting; return sign(ctx, req) })
    else f.transport.request.mockImplementationOnce(async req => { entered(); await waiting; return send(req) })
    const task = f.client.capabilities(); await ready
    if (end === 'invalidate') f.client.invalidate()
    if (end === 'timeout') await vi.advanceTimersByTimeAsync(1001)
    if (end === 'stale') f.stale()
    if (end !== 'stale') expect(await task).toEqual({ state: 'unavailable' })
    release(); expect(await task).toEqual({ state: 'unavailable' })
    await Promise.resolve(); await Promise.resolve()
    if (moment === 'sign') expect(f.calls).toEqual([])
  })
  for (const moment of ['sign', 'send'] as const) for (const end of ['invalidate', 'timeout'] as const) it(`settled registration waits for actual ${moment} after ${end} and withholds a late result`, async () => {
    vi.useFakeTimers(); const f = setup(201, body('registered'))
    let release!: () => void, entered!: () => void, settled = false
    const ready = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const sign = f.vault.signBoxRequestV1.getMockImplementation()!, send = f.transport.request.getMockImplementation()!
    if (moment === 'sign') f.vault.signBoxRequestV1.mockImplementationOnce(async (ctx, req) => { entered(); await waiting; return sign(ctx, req) })
    else f.transport.request.mockImplementationOnce(async req => { entered(); await waiting; return send(req) })
    const task = f.client.registerPackageSettled(id, other, 200, 123).then(result => { settled = true; return result })
    await ready
    if (end === 'invalidate') f.client.invalidate()
    else await vi.advanceTimersByTimeAsync(1001)
    await Promise.resolve(); expect(settled).toBe(false)
    release(); expect(await task).toEqual({ state: 'unavailable' })
    expect(f.calls).toHaveLength(moment === 'send' ? 1 : 0)
  })
  it('turns transport faults into uncertain replies', async () => {
    const f = setup(); f.transport.request.mockRejectedValueOnce(new Error('lost response'))
    expect(await f.client.capabilities()).toEqual({ state: 'unavailable' })
  })
  it('bounds pending prompts and cancellation wakes every waiter', async () => {
    const f = setup(); f.vault.signBoxRequestV1.mockImplementation(() => new Promise(() => undefined))
    const pending = Array.from({ length: 32 }, () => f.client.capabilities())
    expect(await f.client.capabilities()).toEqual({ state: 'not-signed', reason: 'busy' })
    f.client.invalidate()
    expect((await Promise.all(pending)).every(r => r.state === 'unavailable')).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('bounds large slot and fetch responses before parsing', async () => {
    const f = setup(200, new Uint8Array(2 * 1024 * 1024 + 1))
    expect(await f.client.fetch([id])).toEqual({ state: 'malformed' })
    expect(await f.client.slotStatus(id, 0)).toEqual({ state: 'malformed' })
  })
  for (const moment of ['sign', 'send'] as const) it(`retains capacity for timed-out ${moment} work until it settles`, async () => {
    vi.useFakeTimers(); const f = setup(), releases: (() => void)[] = []
    const sign = f.vault.signBoxRequestV1.getMockImplementation()!, send = f.transport.request.getMockImplementation()!
    const wait = () => new Promise<void>(resolve => { releases.push(resolve) })
    if (moment === 'sign') f.vault.signBoxRequestV1.mockImplementation(async (ctx, req) => { await wait(); return sign(ctx, req) })
    else f.transport.request.mockImplementation(async req => { await wait(); return send(req) })
    const pending = Array.from({ length: 32 }, () => f.client.capabilities())
    await vi.advanceTimersByTimeAsync(1001)
    expect((await Promise.all(pending)).every(r => r.state === 'unavailable')).toBe(true)
    expect(await f.client.capabilities()).toEqual({ state: 'not-signed', reason: 'busy' })
    releases[0](); await vi.advanceTimersByTimeAsync(0)
    const next = f.client.capabilities(); f.client.invalidate()
    expect(await next).toEqual({ state: 'unavailable' })
    for (const release of releases) release()
    await vi.advanceTimersByTimeAsync(0)
  })
  it('copies an asynchronous capabilities response before the parser yields', async () => {
    const f = setup(), task = f.client.capabilities()
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    f.response.body.fill(0)
    expect(await task).toMatchObject({ state: 'ok', value: { installation } })
  })
  for (const at of ['before', 'signing', 'reply'] as const) it(`checks the driver lifetime ${at}`, async () => {
    const f = setup(201, body('stored', { receipt: hash }))
    let live = at !== 'before'
    const sign = f.vault.signBoxRequestV1.getMockImplementation()!
    f.vault.signBoxRequestV1.mockImplementation(async (...args) => { const answer = await sign(...args); if (at === 'signing') live = false; return answer })
    f.transport.request.mockImplementation(async req => { f.calls.push(req); if (at === 'reply') live = false; return f.response })
    expect(await f.client.deposit(id, env, () => live)).toEqual({ state: 'unavailable' })
    expect(f.calls).toHaveLength(at === 'reply' ? 1 : 0)
    if (at === 'before') expect(f.signed).toHaveLength(0)
  })

})
