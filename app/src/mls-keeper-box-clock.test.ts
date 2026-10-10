import { afterEach, describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64Encode } from './mls-vault.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { pairingFixture } from '../../test/mls-pairing-fixture.js'
import { BrowserMlsBoxClient } from './mls-box-client.js'
import { BrowserMlsKeeperBoxClock } from './mls-keeper-box-clock.js'
import { mlsGrantReference, planMlsGrant } from './mls-grant-ledger.js'
import type { LinkRequest, LinkRoute } from './browser-link-types.js'
import type { BoxReply, BoxRequest } from './mls-coordinated-vault.js'

vi.mock('./mls-engine.js', () => ({ loadMlsEngine: async () => ({ parseCapabilities: (raw: Uint8Array) => {
  const a = JSON.parse(new TextDecoder().decode(raw))
  if (a.v !== 1 || a.security_contract !== 1 || a.slot_receipts !== 1 || a.fork_evidence !== 1 || a.restore_fence !== 1 || Object.keys(a).length !== 6 || !/^[0-9a-f]{64}$/.test(a.installation)) throw new Error('Invalid capabilities')
  return hexToBytes(a.installation)
} }) }))
const installation = '79'.repeat(32), nextInstallation = '80'.repeat(32)
const caps = (id = installation) => ({ v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1, installation: id })
const encoder = new TextEncoder()
async function fixture() {
  const p = pairingFixture(), r = p.route, keeper = localIdentity(generateSecretKey()), member = localIdentity(generateSecretKey())
  const route: LinkRoute = { routeId: r.routeId, card: hexToBytes(r.card), pairedRouteSecret: hexToBytes(r.pairedRouteSecret), cardSerial: BigInt(r.cardSerial), cardVerifiedAt: BigInt(r.cardVerifiedAt) }
  const box = { routeId: r.routeId, eventUrl: `ws://${base32nopad.encode(hexToBytes(p.witness)).toLowerCase()}/events` }
  const grant = await planMlsGrant(keeper, box, member.pubkey, '33'.repeat(32), { session: '44'.repeat(32), name: 'Room', leaf: '55'.repeat(32) }, 1_000)
  const binding = { principal: 'https://keeper.test', persona: keeper.pubkey, generation: 1, revision: 'current' }
  let foreground = true, live = true, now = 1_000
  const context = () => ({ vault: { ...binding }, current: () => live, foreground: () => foreground })
  const made = new WeakMap<object, BoxRequest>(), calls: LinkRequest[] = []
  const vault = {
    current: () => live,
    signBoxRequestV1: vi.fn(async (_: unknown, request: BoxRequest) => {
      const reply: BoxReply = { v: 1, device: '66'.repeat(32), authorization: `Nostr request-${calls.length}` }
      made.set(reply, request); return { ok: true as const, value: reply }
    }),
    acceptBoxReply: (request: BoxRequest, reply: unknown) => made.get(reply as object) === request ? { ok: true as const, value: reply as BoxReply } : { ok: false as const, refusal: 'unauthorised' as const },
  }
  const responses = [caps(), { v: 1, code: 'ok', server_time: 1_000, records: [], next: null }, caps()]
  const transport = { request: vi.fn(async (request: LinkRequest) => {
    calls.push(request)
    return { status: 200, body: encoder.encode(JSON.stringify(responses[calls.length - 1])), witnessRefused: false, path: { status: 'up' as const, relay: null, direct: null, cause: '' } }
  }) }
  const client = new BrowserMlsBoxClient(transport, route, p.witness, vault, binding, async () => 'approve', () => live)
  const clock = new BrowserMlsKeeperBoxClock(client, context, () => now)
  return { p, grant, binding, responses, calls, vault, transport, client, clock, context, now: () => now,
    time: (at: number) => { now = at }, account: () => { binding.generation++ }, hide: () => { foreground = false }, stale: () => { live = false } }
}
afterEach(() => vi.useRealTimers())

describe('explicit authenticated keeper box clock', () => {
  it('does no constructor I/O and brackets one deterministic read-only probe with exact installation checks', async () => {
    const f = await fixture()
    expect(f.calls).toEqual([]); expect(f.vault.signBoxRequestV1).not.toHaveBeenCalled()
    expect(await f.clock.probe(f.grant)).toEqual({ binding: f.binding, node: f.p.witness, reference: mlsGrantReference(f.grant.node, f.grant.grantId), expiration: f.grant.expiration,
      boxTime: 1_000, phoneTime: 1_000, installation, observedAt: 1_000 })
    expect(f.calls.map(r => [r.method, r.path])).toEqual([['GET', '/vmls/v1/capabilities'], ['POST', '/vmls/v1/fetch'], ['GET', '/vmls/v1/capabilities']])
    const first = JSON.parse(new TextDecoder().decode(f.calls[1]!.body!))
    expect(first).toMatchObject({ v: 1, mailboxes: [expect.stringMatching(/^[0-9a-f]{64}$/)] })
    expect(first.mailboxes).toHaveLength(1)
    f.responses.push(caps(), f.responses[1]!, caps())
    await f.clock.probe(f.grant)
    expect(f.calls[4]!.body).toEqual(f.calls[1]!.body)
    expect(f.vault.signBoxRequestV1).toHaveBeenCalledTimes(6)
  })
  it.each(['node', 'route', 'issuer', 'malformed'] as const)('refuses %s authority before signing or transport', async kind => {
    const f = await fixture(), changed = structuredClone(f.grant)
    if (kind === 'node') changed.node = 'ff'.repeat(32)
    if (kind === 'route') changed.box.routeId = 'other-route'
    if (kind === 'issuer') f.binding.persona = 'ff'.repeat(32)
    if (kind === 'malformed') changed.expiration = -1
    await expect(f.clock.probe(changed)).rejects.toThrow()
    expect(f.calls).toEqual([]); expect(f.vault.signBoxRequestV1).not.toHaveBeenCalled()
  })
  it.each([0, 1, 2])('withholds evidence on installation/refusal failure at request %i', async index => {
    const f = await fixture()
    if (index === 2) f.responses[2] = caps(nextInstallation)
    else f.transport.request.mockImplementation(async request => {
      f.calls.push(request)
      const refused = f.calls.length - 1 === index
      return { status: refused ? 503 : 200, body: encoder.encode(JSON.stringify(refused ? { v: 1, code: 'clock-unsafe', server_time: Number.MAX_SAFE_INTEGER } : f.responses[f.calls.length - 1])), witnessRefused: false,
        path: { status: 'up' as const, relay: null, direct: null, cause: '' } }
    })
    expect(await f.clock.probe(f.grant)).toBeNull()
    expect(f.calls).toHaveLength(index + 1)
  })
  it.each([0, 1, 2])('checks account and foreground after await %i before another request or evidence', async index => {
    for (const transition of ['account', 'hide', 'stale'] as const) {
      const f = await fixture(), original = f.transport.request.getMockImplementation()!
      f.transport.request.mockImplementation(async request => {
        const response = await original(request)
        if (f.calls.length - 1 === index) f[transition]()
        return response
      })
      expect(await f.clock.probe(f.grant)).toBeNull()
      expect(f.calls).toHaveLength(index + 1)
    }
  })
  it('takes the final monotonic phone time and refuses a rewind after the probe', async () => {
    for (const at of [999, 1_001]) {
      const f = await fixture(), original = f.transport.request.getMockImplementation()!
      f.transport.request.mockImplementation(async request => { const response = await original(request); if (f.calls.length === 3) f.time(at); return response })
      if (at === 999) await expect(f.clock.probe(f.grant)).rejects.toThrow('trusted keeper time')
      else expect(await f.clock.probe(f.grant)).toMatchObject({ phoneTime: at, observedAt: at, boxTime: 1_000 })
    }
  })
  it('retains the phone clock floor across explicit probes in the same lifetime', async () => {
    const f = await fixture()
    expect(await f.clock.probe(f.grant)).toMatchObject({ phoneTime: 1_000 })
    f.time(999)
    await expect(f.clock.probe(f.grant)).rejects.toThrow('trusted keeper time')
    expect(f.calls).toHaveLength(3)
  })
  it('ignores and wipes returned probe records without following their cursor or acknowledging them', async () => {
    const f = await fixture(), original = f.transport.request.getMockImplementation()!, envelope = Uint8Array.of(7, 8, 9)
    let retained: any
    f.transport.request.mockImplementation(async request => {
      const response = await original(request)
      if (request.path.endsWith('/fetch')) {
        const query = JSON.parse(new TextDecoder().decode(request.body))
        response.body = encoder.encode(JSON.stringify({ v: 1, code: 'ok', server_time: 1_000,
          records: [{ mailbox: query.mailboxes[0], receipt: bytesToHex(sha256(envelope)), envelope: base64Encode(envelope) }], next: 'next-page' }))
      }
      return response
    })
    const fetch = f.client.fetch.bind(f.client)
    vi.spyOn(f.client, 'fetch').mockImplementation(async (...args) => { retained = await fetch(...args); return retained })
    expect(await f.clock.probe(f.grant)).toMatchObject({ boxTime: 1_000 })
    for (const field of ['mailbox', 'receipt', 'envelope']) expect([...retained.value.records[0][field]].every(byte => byte === 0)).toBe(true)
    expect(f.calls).toHaveLength(3); expect(f.calls.every(r => !r.path.endsWith('/ack'))).toBe(true)
  })
  it('releases admission after signer rejection and captures immutable grant input before asynchronous work', async () => {
    const f = await fixture(), expiration = f.grant.expiration
    f.vault.signBoxRequestV1.mockRejectedValueOnce(new Error('fixture signer refused'))
    await expect(f.clock.probe(f.grant)).rejects.toThrow('fixture signer refused')
    const original = f.transport.request.getMockImplementation()!
    f.transport.request.mockImplementation(async request => { f.grant.expiration++; return original(request) })
    expect(await f.clock.probe(f.grant)).toMatchObject({ expiration })
    expect(f.calls).toHaveLength(3)
  })
  it('bounds an abandoned probe and refuses another until underlying work settles', async () => {
    const f = await fixture(); vi.useFakeTimers()
    let resolve!: (r: any) => void
    f.transport.request.mockImplementation(() => new Promise(r => { resolve = r }))
    const clock = new BrowserMlsKeeperBoxClock(f.client, f.context, f.now, 5), pending = clock.probe(f.grant)
    await vi.advanceTimersByTimeAsync(5)
    expect(await pending).toBeNull()
    await expect(clock.probe(f.grant)).rejects.toThrow('still settling')
    resolve({ status: 200, body: encoder.encode(JSON.stringify(caps())), witnessRefused: false, path: { status: 'up', relay: null, direct: null, cause: '' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.transport.request).toHaveBeenCalledTimes(1)
  })
  it('invalidates a live probe promptly and never follows late capability results', async () => {
    const f = await fixture()
    let resolve!: (r: any) => void
    f.transport.request.mockImplementation(() => new Promise(r => { resolve = r }))
    const pending = f.clock.probe(f.grant)
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledTimes(1))
    f.clock.invalidate(); expect(await pending).toBeNull()
    resolve({ status: 200, body: encoder.encode(JSON.stringify(caps())), witnessRefused: false, path: { status: 'up', relay: null, direct: null, cause: '' } })
    await Promise.resolve(); expect(f.transport.request).toHaveBeenCalledTimes(1)
  })
})
