import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import {
  GROUP_DELETE_TOKEN_SECONDS, GROUP_GET_TOKEN_SECONDS, GROUP_STORAGE_MESSAGES, GROUP_TOKEN_REUSE_MARGIN_SECONDS, GROUP_UPLOAD_TOKEN_SECONDS,
  GroupStorage, GroupStorageError, buildGroupToken, deleteGroupBlob, type GroupStorageOptions,
} from './group-storage.js'
import { GrantReceiver, buildGrant, buildReset, buildRevocation, parseGroupEvent, type GroupEvent } from './group-grants.js'
import { verifyEventUncached } from './verify.js'

const NOW = 1_800_000_000
const N1 = 'https://n1.example.net'
const N2 = 'https://n2.example.net:8443'
const N3 = 'https://n3.example.net/wb/store'
const ROOM = 'ab'.repeat(32)
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)
const deviceSk = generateSecretKey()
const device = getPublicKey(deviceSk)

const envelope = new TextEncoder().encode('sealed envelope bytes')
const HASH = bytesToHex(sha256(envelope))

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal | null }
type Handler = (call: Call, n: number) => Response | Promise<Response>

const decodeToken = (header: string): Event => JSON.parse(Buffer.from(header.replace(/^Nostr /, ''), 'base64').toString('utf8')) as Event
const tagOf = (e: Event, name: string): string[] => e.tags.filter((t) => t[0] === name).map((t) => t[1]!)

function grant(server: string, scopes: ('upload' | 'get' | 'delete')[] = ['upload', 'get', 'delete'], createdAt = NOW - 100, id = bytesToHex(sha256(new TextEncoder().encode(server + scopes.join()))).slice(0, 32), status: 'active' | 'revoked' = 'active'): GroupEvent {
  return buildGrant({ authoritySk, roomId: ROOM, device, server, scopes, ...(scopes.includes('upload') ? { bytes: 1_000_000 } : {}), grantId: id, createdAt, expiration: createdAt + 30 * 86_400, status })
}

function rig(opts: { nodes?: string[]; grants?: GroupEvent[]; handler?: Handler; over?: Partial<GroupStorageOptions> } = {}) {
  const receiver = new GrantReceiver({ authority, roomId: ROOM, device })
  for (const g of opts.grants ?? [grant('n1.example.net'), grant('n2.example.net'), grant('n3.example.net')]) receiver.offer(g)
  const calls: Call[] = []
  const events = { open: [] as string[], clock: [] as [string, number][], noGrant: 0, lockedOut: 0, acked: 0 }
  let n = 0
  const handler: Handler = opts.handler ?? defaultNode()
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body, signal: init?.signal }
    calls.push(call)
    return handler(call, n++)
  }) as typeof fetch
  const storage = new GroupStorage({
    roomId: ROOM, nodes: () => opts.nodes ?? [N1, N2, N3], deviceSk, receiver, fetch: fetchFn, now: () => NOW,
    onNodeOpen: (s) => events.open.push(s), onClockWrong: (s, k) => events.clock.push([s, k]),
    onNoGrant: () => { events.noGrant++ }, onLockedOut: () => { events.lockedOut++ }, onAcknowledged: () => { events.acked++ },
    ...opts.over,
  })
  return { storage, receiver, calls, events }
}

/** A well-behaved group node: unauthenticated reads are 401, uploads are described, reads return the envelope. */
function defaultNode(): Handler {
  return (call) => {
    const u = new URL(call.url)
    if (call.method === 'POST') return new Response(JSON.stringify({ state: 'active' }), { status: 201 })
    if (!call.headers.Authorization) return new Response(null, { status: 401, headers: { 'x-reason': 'missing' } })
    if (call.method === 'PUT') {
      const hash = call.headers['X-SHA-256']!
      const base = u.origin + u.pathname.replace(/\/upload$/, '')
      return new Response(JSON.stringify({ url: `${base}/${hash}`, sha256: hash, size: envelope.length }), { status: 201 })
    }
    if (call.method === 'GET' || call.method === 'HEAD') {
      const range = call.headers.Range
      if (range) {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!
        return new Response(envelope.slice(Number(a), Number(b) + 1), { status: 206 })
      }
      return new Response(call.method === 'GET' ? envelope : null, { status: 200, headers: { 'content-length': String(envelope.length) } })
    }
    return new Response(null, { status: 405 })
  }
}

const hosts = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).origin}`)

describe('tokens', () => {
  it('a get token: t, expiration, server, x in that order, the content, created_at a second back, 120 seconds', () => {
    const t = buildGroupToken('get', HASH, 'n1.example.net', NOW)
    expect(t.kind).toBe(24242)
    expect(t.created_at).toBe(NOW - 1)
    expect(t.tags).toEqual([['t', 'get'], ['expiration', String(NOW - 1 + GROUP_GET_TOKEN_SECONDS)], ['server', 'n1.example.net'], ['x', HASH]])
    expect(t.content).toBe(`Get blob ${HASH}`)
    expect(GROUP_GET_TOKEN_SECONDS).toBe(120)
  })

  it('an upload token: the same tags, "Upload blob <hash> to <host>", 90 seconds', () => {
    const t = buildGroupToken('upload', HASH, 'n1.example.net', NOW)
    expect(t.tags).toEqual([['t', 'upload'], ['expiration', String(NOW - 1 + 90)], ['server', 'n1.example.net'], ['x', HASH]])
    expect(t.content).toBe(`Upload blob ${HASH} to n1.example.net`)
    expect(GROUP_UPLOAD_TOKEN_SECONDS).toBe(90)
  })

  it('a delete token: 604,801 seconds, exactly the node\'s longest, with the delete target tag last', () => {
    const target = `https://n1.example.net/${HASH}`
    const t = buildGroupToken('delete', HASH, 'n1.example.net', NOW, undefined, target)
    expect(t.tags).toEqual([['t', 'delete'], ['expiration', String(NOW - 1 + 604_801)], ['server', 'n1.example.net'], ['x', HASH], ['kithmoot-delete-target-v1', target]])
    expect(t.content).toBe(`Delete blob ${HASH}`)
    expect(GROUP_DELETE_TOKEN_SECONDS).toBe(604_801)
    expect(t.content.length).toBeLessThan(1024)
  })

  it('refuses a bad hash, a bad host, a bad lifetime, and a target on anything but a delete', () => {
    expect(() => buildGroupToken('get', 'xyz', 'n1.example.net', NOW)).toThrow()
    expect(() => buildGroupToken('get', HASH, 'N1.example.net', NOW)).toThrow()
    expect(() => buildGroupToken('get', HASH, 'n1.example.net', NOW, 0)).toThrow()
    expect(() => buildGroupToken('get', HASH, 'n1.example.net', NOW, undefined, 'https://n1.example.net')).toThrow()
  })

  it('every request carries exactly one Nostr Authorization, signed by the device key, in standard base64 with padding', async () => {
    const { storage, calls } = rig()
    await storage.upload(envelope, HASH)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers.Authorization).toMatch(/^Nostr [A-Za-z0-9+/]+=*$/)
    const token = decodeToken(put.headers.Authorization!)
    expect(token.pubkey).toBe(device)
    expect(verifyEventUncached(token)).toBe(true)
    expect(token.created_at).toBe(NOW - 1)
    expect(tagOf(token, 'server')).toEqual(['n1.example.net'])
    expect(tagOf(token, 'x')).toEqual([HASH])
    expect(put.headers['X-SHA-256']).toBe(HASH)
  })
})

describe('uploading', () => {
  it('goes to the first listed node with an upload grant and builds the url itself from the base', async () => {
    const { storage, calls } = rig({ nodes: [N3, N1, N2] })
    const result = await storage.upload(envelope, HASH)
    expect(result).toEqual({ status: 'stored', url: `${N3}/${HASH}`, base: N3, server: 'n3.example.net', size: envelope.length })
    // The probe, then the upload to the first node, and nothing to the others.
    expect(hosts(calls.filter((c) => c.method !== 'POST'))).toEqual(['HEAD https://n3.example.net', 'PUT https://n3.example.net'])
    expect(calls.find((c) => c.method === 'PUT')!.url).toBe(`${N3}/upload`)
  })

  it('skips nodes without an upload grant, unusable bases and nodes found open', async () => {
    const grants = [grant('n1.example.net', ['get']), grant('n2.example.net'), grant('n3.example.net')]
    const { storage, calls } = rig({ grants, over: { usable: (b) => b !== N2 } })
    const result = await storage.upload(envelope, HASH)
    expect(result.status === 'stored' && result.base).toBe(N3)
    expect(calls.some((c) => c.url.startsWith(N1) || c.url.startsWith('https://n2.example.net'))).toBe(false)
  })

  it('a node that is down moves the call on to the next; every node down is held unreachable', async () => {
    let down = new Set(['n1.example.net'])
    const base = defaultNode()
    const { storage } = rig({ handler: (c, n) => { if (down.has(new URL(c.url).hostname)) throw new TypeError('connection refused'); return base(c, n) } })
    const first = await storage.upload(envelope, HASH)
    expect(first.status === 'stored' && first.base).toBe(N2)
    down = new Set(['n1.example.net', 'n2.example.net', 'n3.example.net'])
    const other = rig({ handler: (c) => { throw new TypeError('connection refused') } })
    expect(await other.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'unreachable' })
    // A 429, a 5xx and a 507 are unreachable too.
    for (const status of [429, 500, 503, 507]) {
      const node = defaultNode()
      const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'PUT' ? new Response(null, { status }) : node(c, n)) })
      expect(await r.storage.upload(envelope, HASH), String(status)).toMatchObject({ status: 'held', reason: 'unreachable' })
    }
  })

  it('no grant anywhere: held no-grant, and the caller is told to ask the keeper', async () => {
    const { storage, calls, events } = rig({ grants: [] })
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'no-grant', detail: GROUP_STORAGE_MESSAGES['no-grant'] })
    expect(events.noGrant).toBe(1)
    expect(calls).toEqual([])
  })

  it('every grant ended by a revocation or a reset: held locked-out, and the caller is told', async () => {
    const own = grant('n1.example.net', ['upload', 'get'], NOW - 100, '11'.repeat(16))
    const grants = [own, grant('n2.example.net', ['upload', 'get'], NOW - 100, '22'.repeat(16))]
    const { storage, receiver, events, calls } = rig({ nodes: [N1, N2], grants })
    const parsed = parseGroupEvent(own)
    if (!parsed.ok || parsed.parsed.type !== 'grant') throw new Error('test grant did not parse')
    receiver.offer(buildRevocation(parsed.parsed, authoritySk, NOW - 50))
    receiver.offer(buildReset({ authoritySk, roomId: ROOM, server: 'n2.example.net', createdAt: NOW - 50 }))
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'locked-out' })
    expect(events.lockedOut).toBe(1)
    expect(events.noGrant).toBe(0)
    expect(calls).toEqual([])
  })

  it('a descriptor that names other bytes, another size or another place is a refusal at that node', async () => {
    const base = defaultNode()
    const bad = (d: Record<string, unknown>): Handler => (c, n) => (c.method === 'PUT'
      ? new Response(JSON.stringify({ url: `${N1}/${HASH}`, sha256: HASH, size: envelope.length, ...d }), { status: 201 })
      : base(c, n))
    for (const d of [{ sha256: 'f'.repeat(64) }, { size: 5 }, { url: `https://elsewhere.example.net/${HASH}` }, { url: `${N1}/other` }, { url: `${N1}/${HASH}?x=1` }, { url: `${N1}/sub/${HASH}` }]) {
      expect(await rig({ nodes: [N1], handler: bad(d) }).storage.upload(envelope, HASH), JSON.stringify(d)).toMatchObject({ status: 'held', reason: 'refused' })
    }
    // An extension is allowed; the url returned is still the one built here.
    const ok = await rig({ nodes: [N1], handler: bad({ url: `${N1}/${HASH}.wbenc` }) }).storage.upload(envelope, HASH)
    expect(ok).toMatchObject({ status: 'stored', url: `${N1}/${HASH}` })
    // And a node that serves a base path is checked against that path.
    const under = await rig({ nodes: [N3] }).storage.upload(envelope, HASH)
    expect(under).toMatchObject({ status: 'stored', url: `${N3}/${HASH}` })
  })

  it('has no total timeout, only the caller\'s abort signal (A3)', async () => {
    const base = defaultNode()
    // A slow upload, far longer than the 20 ms headers timeout: a timeout on the PUT would cut it.
    const slow = rig({
      nodes: [N1], over: { requestTimeoutMs: 20 },
      handler: (c, n) => (c.method === 'PUT' ? new Promise<Response>((resolve) => setTimeout(() => resolve(base(c, n) as Response), 120)) : base(c, n)),
    })
    expect(await slow.storage.upload(envelope, HASH)).toMatchObject({ status: 'stored' })

    // The caller's signal does cancel it.
    const controller = new AbortController()
    const hung = rig({
      nodes: [N1], over: { signal: controller.signal, requestTimeoutMs: 20 },
      handler: (c, n) => (c.method === 'PUT'
        ? new Promise<Response>((_, reject) => c.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
        : base(c, n)),
    })
    const pending = hung.storage.upload(envelope, HASH).then(() => 'done', (e: Error) => e.message)
    await new Promise((r) => setTimeout(r, 80))
    controller.abort()
    expect(await pending).toBe('The upload was cancelled.')
  })

  it('the probe, HEAD and POST wait 30 s for headers at most (here, a short stand-in)', async () => {
    const hang = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const calls: string[] = []
    const receiver = new GrantReceiver({ authority, roomId: ROOM, device })
    receiver.offer(grant('n1.example.net'))
    const storage = new GroupStorage({
      roomId: ROOM, nodes: () => [N1], deviceSk, receiver, now: () => NOW, requestTimeoutMs: 25,
      fetch: ((_: RequestInfo | URL, init?: RequestInit) => { calls.push(init?.method ?? 'GET'); return hang(init?.signal) }) as typeof fetch,
    })
    const started = Date.now()
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'unreachable' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls).toEqual(['HEAD'])
  })
})

describe('the first contact with a node', () => {
  it('probes unauthenticated first: 401 is closed and the call goes on', async () => {
    const { storage, calls } = rig({ nodes: [N1] })
    await storage.upload(envelope, HASH)
    expect(calls[0]).toMatchObject({ method: 'HEAD', url: `${N1}/${HASH}` })
    expect(calls[0]!.headers.Authorization).toBeUndefined()
  })

  it('probes once per node per session, not on every call', async () => {
    const { storage, calls } = rig({ nodes: [N1] })
    await storage.upload(envelope, HASH)
    await storage.upload(envelope, HASH)
    expect(calls.filter((c) => c.method === 'HEAD').length).toBe(1)
  })

  it('a node that answers the probe with 200 or 404 is open: skipped for the session, told once, and no bytes or tokens are sent to it', async () => {
    for (const status of [200, 404, 204, 410, 302]) {
      const { storage, calls, events } = rig({ nodes: [N1], handler: () => new Response(null, { status }) })
      expect(await storage.upload(envelope, HASH), String(status)).toMatchObject({ status: 'held' })
      await storage.upload(envelope, HASH)
      expect(events.open, String(status)).toEqual(['n1.example.net'])
      expect(calls.every((c) => c.method === 'HEAD' && !c.headers.Authorization), String(status)).toBe(true)
      expect(calls.length).toBe(1)
    }
    // The next node is used.
    const open = (c: Call, n: number) => (new URL(c.url).hostname === 'n1.example.net' ? new Response(null, { status: 200 }) : defaultNode()(c, n))
    const r = rig({ handler: open })
    const result = await r.storage.upload(envelope, HASH)
    expect(result.status === 'stored' && result.base).toBe(N2)
    expect(r.calls.some((c) => c.method === 'PUT' && c.url.startsWith(N1))).toBe(false)
    expect(r.events.open).toEqual(['n1.example.net'])
  })

  it('an open node is not read from either', async () => {
    const { storage, calls } = rig({ nodes: [N1], handler: () => new Response(envelope, { status: 200 }) })
    await expect(storage.get(HASH)).rejects.toBeInstanceOf(GroupStorageError)
    expect(calls.every((c) => !c.headers.Authorization)).toBe(true)
  })

  it('a node that answers the probe 503, 429 or not at all is unreachable for the call and probed again next time', async () => {
    let status = 503
    const base = defaultNode()
    const { storage, calls } = rig({ nodes: [N1], handler: (c, n) => (c.method === 'HEAD' && !c.headers.Authorization && status !== 401 ? new Response(null, { status }) : base(c, n)) })
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'unreachable' })
    status = 429
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'unreachable' })
    status = 401
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'stored' })
    expect(calls.filter((c) => c.method === 'HEAD').length).toBe(3)
  })

  it('carries revocations and resets before the first request, and acknowledges on 200, 201 and 409', async () => {
    const g1 = grant('n1.example.net', ['upload', 'get'], NOW - 100, '33'.repeat(16))
    const revocationOther = buildGrant({
      authoritySk, roomId: ROOM, device: getPublicKey(generateSecretKey()), server: 'n1.example.net', scopes: ['get'], grantId: '44'.repeat(16),
      createdAt: NOW - 50, expiration: NOW + 1000, status: 'revoked',
    })
    const reset = buildReset({ authoritySk, roomId: ROOM, server: 'n1.example.net', createdAt: NOW - 200 })
    const answers = [200, 409]
    const base = defaultNode()
    const { storage, calls, receiver, events } = rig({
      nodes: [N1], grants: [g1],
      handler: (c, n) => (c.method === 'POST' ? new Response('{}', { status: answers.shift() ?? 201 }) : base(c, n)),
    })
    receiver.offer(revocationOther)
    receiver.offer(reset)
    await storage.upload(envelope, HASH)
    const posts = calls.filter((c) => c.method === 'POST')
    // Both carried events, then this device's own grant (A2).
    expect(posts.length).toBe(3)
    const first = calls.findIndex((c) => c.method === 'PUT')
    expect(calls.findIndex((c) => c.method === 'POST')).toBeLessThan(first)
    const bodies = posts.map((p) => JSON.parse(p.body as string) as GroupEvent)
    expect(bodies.map((b) => b.id).sort()).toEqual([revocationOther.id, reset.id, g1.id].sort())
    expect(posts.every((p) => p.url === `${N1}/groups/v1/events` && p.headers['Content-Type'] === 'application/json' && !p.headers.Authorization)).toBe(true)
    expect(events.acked).toBe(3)
    expect(receiver.carry('n1.example.net', NOW)).toEqual([])
    expect(receiver.ownToPost('n1.example.net', NOW)).toBeUndefined()
  })

  it('a node that answers a post with anything else leaves the event for the next session', async () => {
    const reset = buildReset({ authoritySk, roomId: ROOM, server: 'n1.example.net', createdAt: NOW - 200 })
    const base = defaultNode()
    const { storage, receiver, events } = rig({
      nodes: [N1], grants: [grant('n1.example.net')],
      handler: (c, n) => (c.method === 'POST' ? new Response(null, { status: 503 }) : base(c, n)),
    })
    receiver.offer(reset)
    expect(await storage.upload(envelope, HASH)).toMatchObject({ status: 'stored' })
    expect(events.acked).toBe(0)
    expect(receiver.carry('n1.example.net', NOW).length).toBe(1)
  })

  it('posts its own grant on first contact unless already acknowledged, and again for a renewal', async () => {
    const first = grant('n1.example.net', ['upload', 'get'], NOW - 100, '55'.repeat(16))
    const r = rig({ nodes: [N1], grants: [first] })
    await r.storage.upload(envelope, HASH)
    expect(r.calls.filter((c) => c.method === 'POST').length).toBe(1)
    // A new session with the acknowledgement persisted does not post it again.
    const again = new GroupStorage({ roomId: ROOM, nodes: () => [N1], deviceSk, receiver: r.receiver, now: () => NOW, fetch: ((u: string, i: RequestInit) => { r.calls.push({ url: String(u), method: i.method ?? 'GET', headers: (i.headers ?? {}) as never, body: i.body }); return defaultNode()(r.calls.at(-1)!, 0) }) as never })
    await again.upload(envelope, HASH)
    expect(r.calls.filter((c) => c.method === 'POST').length).toBe(1)
    // A renewal is a new event id: posted.
    r.receiver.offer(grant('n1.example.net', ['upload', 'get'], NOW - 10, '55'.repeat(16)))
    const third = new GroupStorage({ roomId: ROOM, nodes: () => [N1], deviceSk, receiver: r.receiver, now: () => NOW, fetch: ((u: string, i: RequestInit) => { r.calls.push({ url: String(u), method: i.method ?? 'GET', headers: (i.headers ?? {}) as never, body: i.body }); return defaultNode()(r.calls.at(-1)!, 0) }) as never })
    await third.upload(envelope, HASH)
    expect(r.calls.filter((c) => c.method === 'POST').length).toBe(2)
  })
})

describe('a 403', () => {
  const notGranted = () => new Response(null, { status: 403, headers: { 'x-reason': 'not-granted' } })

  it('posts the grant once and retries once with the same token', async () => {
    const base = defaultNode()
    let puts = 0
    // The node has not heard of the grant until it is posted again.
    let heard = 0
    const r = rig({
      nodes: [N1],
      handler: (c, n) => {
        if (c.method === 'POST') { heard++; return new Response(null, { status: 201 }) }
        if (c.method === 'PUT') { puts++; if (puts === 1) return notGranted() }
        return base(c, n)
      },
    })
    // Pretend the node already acknowledged the grant at first contact, so only the 403 rule posts it.
    r.receiver.acknowledge('n1.example.net', [...r.receiver.grantsFor('n1.example.net', NOW)][0]!.event.id)
    const result = await r.storage.upload(envelope, HASH)
    expect(result).toMatchObject({ status: 'stored' })
    expect(puts).toBe(2)
    expect(heard).toBe(1)
    const tokens = r.calls.filter((c) => c.method === 'PUT').map((c) => c.headers.Authorization)
    expect(tokens[0]).toBe(tokens[1])
  })

  it('a second 403 moves on to the next node and never loops', async () => {
    const base = defaultNode()
    const r = rig({
      handler: (c, n) => (c.method === 'PUT' && new URL(c.url).hostname === 'n1.example.net' ? notGranted() : base(c, n)),
    })
    const result = await r.storage.upload(envelope, HASH)
    expect(result.status === 'stored' && result.base).toBe(N2)
    expect(r.calls.filter((c) => c.method === 'PUT' && c.url.startsWith(N1)).length).toBe(2)
    // One post at first contact (A2) plus one for the 403 rule: no more.
    expect(r.calls.filter((c) => c.method === 'POST' && c.url.startsWith(N1)).length).toBe(2)
  })

  it('every node refusing a device that holds grants is held refused, and the keeper is asked again', async () => {
    const base = defaultNode()
    const r = rig({ handler: (c, n) => (c.method === 'PUT' ? notGranted() : base(c, n)) })
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'refused' })
    expect(r.events.noGrant).toBe(1)
  })

  it('reads move on after a 403 and say refused when every node did', async () => {
    const base = defaultNode()
    const r = rig({ handler: (c, n) => (c.method === 'GET' ? notGranted() : base(c, n)) })
    await expect(r.storage.get(HASH)).rejects.toMatchObject({ reason: 'refused' })
    expect(r.events.noGrant).toBe(1)
  })
})

describe('the clock', () => {
  it('a 401 future or expired whose Date is two minutes off calls onClockWrong, stops, and holds', async () => {
    const base = defaultNode()
    const date = new Date((NOW + 120) * 1000).toUTCString()
    const r = rig({
      nodes: [N1],
      handler: (c, n) => (c.method === 'PUT' ? new Response(null, { status: 401, headers: { 'x-reason': 'future', date } }) : base(c, n)),
    })
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'clock', detail: GROUP_STORAGE_MESSAGES.clock })
    expect(r.events.clock).toEqual([['n1.example.net', 120]])
    // It does not keep trying until the page reloads.
    const calls = r.calls.length
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ reason: 'clock' })
    await expect(r.storage.get(HASH)).rejects.toMatchObject({ reason: 'clock' })
    expect(r.calls.length).toBe(calls)
  })

  it('a 401 whose Date agrees with the clock is just a refusal', async () => {
    const base = defaultNode()
    const date = new Date(NOW * 1000).toUTCString()
    const r = rig({
      nodes: [N1],
      handler: (c, n) => (c.method === 'PUT' ? new Response(null, { status: 401, headers: { 'x-reason': 'expired', date } }) : base(c, n)),
    })
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'refused' })
    expect(r.events.clock).toEqual([])
  })
})

describe('reading', () => {
  it('tries the preferred node first, then the list in order without repeats, and a 404 moves on', async () => {
    const base = defaultNode()
    const r = rig({ handler: (c, n) => (c.method === 'GET' && new URL(c.url).hostname !== 'n3.example.net' ? new Response(null, { status: 404, headers: { 'x-reason': 'absent' } }) : base(c, n)) })
    const blob = await r.storage.get(HASH, { prefer: N2 })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(envelope)
    expect(hosts(r.calls.filter((c) => c.method === 'GET'))).toEqual(['GET https://n2.example.net:8443', 'GET https://n1.example.net', 'GET https://n3.example.net'])
  })

  it('fails only after every candidate, saying none of them can be reached', async () => {
    const r = rig({ handler: (c, n) => (c.method === 'GET' ? new Response(null, { status: 404 }) : defaultNode()(c, n)) })
    const error = await r.storage.get(HASH).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GroupStorageError)
    expect((error as GroupStorageError).message).toBe(GROUP_STORAGE_MESSAGES.absent)
    expect(r.calls.filter((c) => c.method === 'GET').length).toBe(3)
  })

  it('refuses a file bigger than the cap, by its length header or its size', async () => {
    const big = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? new Response(envelope, { status: 200, headers: { 'content-length': '999999' } }) : defaultNode()(c, n)) })
    await expect(big.storage.get(HASH, { maxBytes: 100 })).rejects.toBeInstanceOf(GroupStorageError)
    const sized = rig({ nodes: [N1] })
    await expect(sized.storage.get(HASH, { maxBytes: 5 })).rejects.toBeInstanceOf(GroupStorageError)
  })

  it('a range read makes three requests with one signed token, and a fourth after the margin signs a new one', async () => {
    let clock = NOW
    const r = rig({ nodes: [N1], over: { now: () => clock } })
    const parts = [] as Uint8Array[]
    for (const [a, b] of [[0, 6], [7, 13], [14, 20]] as const) parts.push(await r.storage.getRange(HASH, a, b))
    expect(new Uint8Array(Buffer.concat(parts))).toEqual(envelope)
    const gets = r.calls.filter((c) => c.method === 'GET')
    expect(gets.length).toBe(3)
    expect(new Set(gets.map((c) => c.headers.Authorization)).size).toBe(1)
    expect(gets.map((c) => c.headers.Range)).toEqual(['bytes=0-6', 'bytes=7-13', 'bytes=14-20'])
    // Still good with more than the margin left.
    clock = NOW + GROUP_GET_TOKEN_SECONDS - GROUP_TOKEN_REUSE_MARGIN_SECONDS - 5
    await r.storage.getRange(HASH, 0, 0)
    expect(new Set(r.calls.filter((c) => c.method === 'GET').map((c) => c.headers.Authorization)).size).toBe(1)
    clock = NOW + GROUP_GET_TOKEN_SECONDS - GROUP_TOKEN_REUSE_MARGIN_SECONDS + 1
    await r.storage.getRange(HASH, 0, 0)
    expect(new Set(r.calls.filter((c) => c.method === 'GET').map((c) => c.headers.Authorization)).size).toBe(2)
  })

  it('a range answered with the wrong number of bytes is refused', async () => {
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? new Response(envelope.slice(0, 2), { status: 206 }) : defaultNode()(c, n)) })
    await expect(r.storage.getRange(HASH, 0, 9)).rejects.toBeInstanceOf(GroupStorageError)
  })

  it('a read with no grant for get asks the keeper', async () => {
    const r = rig({ grants: [grant('n1.example.net', ['upload'])], nodes: [N1] })
    await expect(r.storage.get(HASH)).rejects.toMatchObject({ reason: 'no-grant' })
    expect(r.events.noGrant).toBe(1)
  })
})

describe('head', () => {
  it('200 is present, 404 absent, 403 unconfirmed, the rest failed; a base the room does not list is failed', async () => {
    const answer = (status: number) => rig({ nodes: [N1], handler: (c, n) => (c.method === 'HEAD' && c.headers.Authorization ? new Response(null, { status, headers: status === 403 ? { 'x-reason': 'not-granted' } : {} }) : defaultNode()(c, n)) })
    expect(await answer(200).storage.head(N1, HASH)).toBe('present')
    expect(await answer(404).storage.head(N1, HASH)).toBe('absent')
    expect(await answer(403).storage.head(N1, HASH)).toBe('unconfirmed')
    expect(await answer(500).storage.head(N1, HASH)).toBe('failed')
    const r = rig({ nodes: [N1] })
    expect(await r.storage.head('https://elsewhere.example.net', HASH)).toBe('failed')
    expect(r.calls.some((c) => c.url.startsWith('https://elsewhere'))).toBe(false)
  })

  it('with no get grant it cannot look, which is not the node being down', async () => {
    const r = rig({ nodes: [N1], grants: [grant('n1.example.net', ['delete'])] })
    expect(await r.storage.head(N1, HASH)).toBe('unconfirmed')
    expect(r.calls).toEqual([])
  })
})

describe('what is never done', () => {
  it('no token is ever in a URL, and nothing goes to an origin the room does not list', async () => {
    const r = rig()
    await r.storage.upload(envelope, HASH)
    await r.storage.get(HASH)
    await r.storage.getRange(HASH, 0, 3)
    await r.storage.head(N1, HASH)
    const listed = new Set([N1, N2, N3].map((n) => new URL(n).origin))
    for (const c of r.calls) {
      const u = new URL(c.url)
      expect(listed.has(u.origin), c.url).toBe(true)
      expect(u.search, c.url).toBe('')
      expect(u.hash, c.url).toBe('')
      expect(c.url).not.toMatch(/Nostr|eyJ|authorization/i)
    }
  })

  it('skips a listed base it cannot parse or that is not canonical, rather than guess', async () => {
    const r = rig({ nodes: ['https://N1.example.net/', 'not a url', N1] })
    const result = await r.storage.upload(envelope, HASH)
    expect(result.status === 'stored' && result.base).toBe(N1)
  })

  it('requests carry no credentials, referrer or cache, and refuse redirects', async () => {
    const seen: RequestInit[] = []
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => base(c, n) })
    const original = (r.storage as unknown as { constructor: typeof GroupStorage }).constructor
    void original
    const wrapped = new GroupStorage({
      roomId: ROOM, nodes: () => [N1], deviceSk, receiver: r.receiver, now: () => NOW,
      fetch: ((u: string, i: RequestInit) => { seen.push(i); return Promise.resolve(base({ url: String(u), method: i.method ?? 'GET', headers: (i.headers ?? {}) as never, body: i.body }, 0)) }) as never,
    })
    await wrapped.upload(envelope, HASH)
    expect(seen.length).toBeGreaterThan(0)
    for (const i of seen) {
      expect(i).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
      // Only the unauthenticated probe may look at a redirect; anything carrying a token refuses to follow one.
      expect(i.redirect).toBe(new Headers(i.headers).get('authorization') === null && i.method === 'HEAD' ? 'manual' : 'error')
    }
  })
})

describe('deleteGroupBlob', () => {
  const target = `${N1}/${HASH}`
  const signed = (over: { target?: string; server?: string; hash?: string } = {}): Event =>
    finalizeEvent(buildGroupToken('delete', over.hash ?? HASH, over.server ?? 'n1.example.net', NOW, undefined, over.target ?? target), deviceSk)
  const answers = (...order: (number | 'down')[]) => {
    const seen: Call[] = []
    const fetchFn = (async (u: string, i: RequestInit) => {
      seen.push({ url: String(u), method: i.method ?? 'GET', headers: (i.headers ?? {}) as never })
      const next = order.shift()
      if (next === 'down' || next === undefined) throw new TypeError('down')
      return new Response(null, { status: next })
    }) as unknown as typeof fetch
    return { fetchFn, seen }
  }

  it('sends the stored single-use token on a DELETE to the hash url', async () => {
    const { fetchFn, seen } = answers(200, 404)
    const auth = signed()
    expect(await deleteGroupBlob(target, auth, { fetch: fetchFn })).toEqual({ status: 'deleted' })
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: target })
    expect(decodeToken(seen[0]!.headers.Authorization!)).toEqual(JSON.parse(JSON.stringify(auth)))
    expect(seen[1]).toMatchObject({ method: 'HEAD', url: target })
    expect(seen[1]!.headers.Authorization).toBeUndefined()
  })

  it('without confirm: HEAD 404 or 410 is deleted, 2xx is kept, 401 is deleted but not confirmed', async () => {
    for (const head of [404, 410]) expect(await deleteGroupBlob(target, signed(), { fetch: answers(204, head).fetchFn }), String(head)).toEqual({ status: 'deleted' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(200, 200).fetchFn })).toEqual({ status: 'kept', detail: 'n1.example.net still serves the file.' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(200, 401).fetchFn })).toEqual({
      status: 'deleted', detail: 'deleted on n1.example.net, not confirmed (this device can no longer read there)',
    })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(200, 500).fetchFn })).toMatchObject({ status: 'failed' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(200, 'down').fetchFn })).toMatchObject({ status: 'failed' })
  })

  it('DELETE 404 goes on; 409 is failed, holding the file again; anything else is failed', async () => {
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(404, 404).fetchFn })).toEqual({ status: 'deleted' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(409).fetchFn })).toEqual({ status: 'failed', detail: 'n1.example.net holds the file again.' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(403).fetchFn })).toMatchObject({ status: 'failed', detail: expect.stringContaining('403') })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers(500).fetchFn })).toMatchObject({ status: 'failed' })
    expect(await deleteGroupBlob(target, signed(), { fetch: answers('down').fetchFn })).toEqual({ status: 'failed', detail: 'Could not reach n1.example.net.' })
  })

  it('with confirm: absent is deleted, present is kept, unconfirmed is deleted and says so, failed is failed; no unauthenticated HEAD is sent', async () => {
    const run = async (outcome: 'present' | 'absent' | 'unconfirmed' | 'failed') => {
      const { fetchFn, seen } = answers(200)
      const result = await deleteGroupBlob(target, signed(), { fetch: fetchFn, confirm: async (url, sha) => { expect([url, sha]).toEqual([target, HASH]); return outcome } })
      expect(seen.length).toBe(1)
      return result
    }
    expect(await run('absent')).toEqual({ status: 'deleted' })
    expect(await run('present')).toMatchObject({ status: 'kept' })
    expect(await run('unconfirmed')).toEqual({ status: 'deleted', detail: 'deleted on n1.example.net, not confirmed (this device can no longer read there)' })
    expect(await run('failed')).toMatchObject({ status: 'failed' })
  })

  it('refuses a token that was not made for this url, hash or host, or whose signature is wrong, before sending anything', async () => {
    const { fetchFn, seen } = answers(200, 404)
    const other = `https://n2.example.net:8443/${HASH}`
    expect((await deleteGroupBlob(other, signed(), { fetch: fetchFn })).status).toBe('failed')
    expect((await deleteGroupBlob(target, signed({ target: other }), { fetch: fetchFn })).status).toBe('failed')
    expect((await deleteGroupBlob(target, signed({ hash: 'e'.repeat(64) }), { fetch: fetchFn })).status).toBe('failed')
    expect((await deleteGroupBlob(target, { ...signed(), content: 'tampered' }, { fetch: fetchFn })).status).toBe('failed')
    expect((await deleteGroupBlob(`${N1}/not-a-hash`, signed(), { fetch: fetchFn })).status).toBe('failed')
    expect(seen).toEqual([])
  })

  it('works for a node under a base path, where the target is that exact url', async () => {
    const url = `${N3}/${HASH}`
    const auth = finalizeEvent(buildGroupToken('delete', HASH, 'n3.example.net', NOW, undefined, url), deviceSk)
    expect(await deleteGroupBlob(url, auth, { fetch: answers(200, 404).fetchFn })).toEqual({ status: 'deleted' })
  })
})


/** A body that never ends, counting how much of it was asked for. */
function endless(counter: { pulled: number; cancelled: boolean }, chunk = 16384): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    // Yields to the event loop between chunks, as a network does: a stream that never lets timers run could not be aborted by anything.
    async pull(controller) { await new Promise((r) => setTimeout(r, 0)); counter.pulled += chunk; controller.enqueue(new Uint8Array(chunk)) },
    cancel() { counter.cancelled = true },
  })
}

describe('bounded reads', () => {
  it('get stops a node that never ends at maxBytes, cancelling its stream, and tries the next node', async () => {
    const counter = { pulled: 0, cancelled: false }
    const base = defaultNode()
    const r = rig({ handler: (c, n) => (c.method === 'GET' && new URL(c.url).hostname === 'n1.example.net' ? new Response(endless(counter), { status: 200 }) : base(c, n)) })
    const blob = await r.storage.get(HASH, { maxBytes: 100_000 })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(envelope)
    expect(counter.cancelled).toBe(true)
    // A little read-ahead is fine; the whole offer is not.
    expect(counter.pulled).toBeLessThan(1_000_000)
  })

  it('get with only an endless node fails refused, not out of memory', async () => {
    const counter = { pulled: 0, cancelled: false }
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? new Response(endless(counter), { status: 200 }) : base(c, n)) })
    await expect(r.storage.get(HASH, { maxBytes: 50_000 })).rejects.toMatchObject({ reason: 'refused', message: 'The file is bigger than this app will take.' })
    expect(counter.cancelled).toBe(true)
    expect(counter.pulled).toBeLessThan(1_000_000)
  })

  /** A body that sends `sent` bytes and then breaks off, as a reset connection does. */
  const breaksOff = (sent: number): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(envelope.slice(0, sent)); setTimeout(() => controller.error(new TypeError('terminated')), 5) },
  }), { status: 200 })

  it('a download that breaks off partway is not "bigger than this app will take": it is a node not answering', async () => {
    const base = defaultNode()
    const alone = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? breaksOff(5) : base(c, n)) })
    const error = await alone.storage.get(HASH).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GroupStorageError)
    expect((error as GroupStorageError).message).not.toMatch(/bigger/)
    expect((error as GroupStorageError).reason).toBe('absent')
    // Another node is tried, and gives the file.
    const two = rig({ nodes: [N1, N2], handler: (c, n) => (c.method === 'GET' && new URL(c.url).hostname === 'n1.example.net' ? breaksOff(5) : base(c, n)) })
    expect(new Uint8Array(await (await two.storage.get(HASH)).arrayBuffer())).toEqual(envelope)
    // A range that breaks off is the same.
    const range = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? new Response(new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(envelope.slice(0, 2)); setTimeout(() => ctl.error(new TypeError('terminated')), 5) } }), { status: 206 }) : base(c, n)) })
    await expect(range.storage.getRange(HASH, 0, 9)).rejects.toMatchObject({ reason: 'absent' })
    // An endless descriptor is still a refusal, and a descriptor that breaks off is a node not answering.
    const broken = rig({ nodes: [N1], handler: (c, n) => (c.method === 'PUT' ? new Response(new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new TextEncoder().encode('{"sha')); setTimeout(() => ctl.error(new TypeError('terminated')), 5) } }), { status: 201 }) : base(c, n)) })
    expect(await broken.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'unreachable' })
  })

  it('getRange stops a node that sends more than the range asked for', async () => {
    const counter = { pulled: 0, cancelled: false }
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' ? new Response(endless(counter), { status: 206 }) : base(c, n)) })
    await expect(r.storage.getRange(HASH, 0, 9)).rejects.toMatchObject({ reason: 'refused' })
    expect(counter.cancelled).toBe(true)
    expect(counter.pulled).toBeLessThan(100_000)
  })

  it('a node that answers an upload with an endless descriptor is refused, not read to the end', async () => {
    const counter = { pulled: 0, cancelled: false }
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'PUT' ? new Response(endless(counter), { status: 201 }) : base(c, n)) })
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'refused' })
    expect(counter.cancelled).toBe(true)
    expect(counter.pulled).toBeLessThan(2_000_000)
  })
})

describe('a call of its own can be cancelled', () => {
  const hung = (base: Handler): Handler => (c, n) => (c.method === 'PUT'
    ? new Promise<Response>((_, reject) => c.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    : base(c, n))

  it('aborting one upload leaves the instance usable, and the next call goes through', async () => {
    const base = defaultNode()
    let silent = true
    const r = rig({ nodes: [N1], handler: (c, n) => (silent ? hung(base)(c, n) : base(c, n)) })
    const controller = new AbortController()
    const pending = r.storage.upload(envelope, HASH, { signal: controller.signal }).then(() => 'done', (e: Error) => e.message)
    await new Promise((res) => setTimeout(res, 40))
    controller.abort()
    expect(await pending).toBe('The upload was cancelled.')
    silent = false
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'stored' })
  })

  it('an already aborted call does nothing, and one slow node does not hold the others', async () => {
    const r = rig()
    const done = new AbortController()
    done.abort()
    await expect(r.storage.upload(envelope, HASH, { signal: done.signal })).rejects.toThrow('cancelled')
    await expect(r.storage.get(HASH, { signal: done.signal })).rejects.toThrow('cancelled')
    await expect(r.storage.getRange(HASH, 0, 3, { signal: done.signal })).rejects.toThrow('cancelled')
    expect(r.calls).toEqual([])
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'stored' })
  })

  it('aborting a read stops it mid-body, and the instance still reads afterwards', async () => {
    const base = defaultNode()
    const counter = { pulled: 0, cancelled: false }
    let endlessNode = true
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'GET' && endlessNode ? new Response(endless(counter), { status: 200 }) : base(c, n)) })
    const controller = new AbortController()
    const pending = r.storage.get(HASH, { signal: controller.signal, maxBytes: 1e12 }).then(() => 'done', (e: Error) => e.message)
    await new Promise((res) => setTimeout(res, 30))
    controller.abort()
    expect(await pending).toBe('The read was cancelled.')
    expect(counter.cancelled).toBe(true)
    endlessNode = false
    expect(new Uint8Array(await (await r.storage.get(HASH)).arrayBuffer())).toEqual(envelope)
  })

  it('head takes a signal of its own', async () => {
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => (c.method === 'HEAD' && c.headers.Authorization ? new Promise<Response>((_, rej) => c.signal?.addEventListener('abort', () => rej(new Error('aborted')))) : base(c, n)) })
    const controller = new AbortController()
    const pending = r.storage.head(N1, HASH, { signal: controller.signal })
    await new Promise((res) => setTimeout(res, 30))
    controller.abort()
    expect(await pending).toBe('failed')
  })

  it('the instance signal still ends every call', async () => {
    const instance = new AbortController()
    const base = defaultNode()
    const r = rig({ nodes: [N1], over: { signal: instance.signal }, handler: hung(base) })
    const pending = r.storage.upload(envelope, HASH).then(() => 'done', (e: Error) => e.message)
    await new Promise((res) => setTimeout(res, 30))
    instance.abort()
    expect(await pending).toBe('The upload was cancelled.')
  })
})

describe('head is a first contact like any other', () => {
  it('probes first, carries what it holds, and sends no token to an open node', async () => {
    const open = rig({ nodes: [N1], handler: () => new Response(null, { status: 200 }) })
    expect(await open.storage.head(N1, HASH)).toBe('failed')
    expect(open.calls.length).toBe(1)
    expect(open.calls[0]!.headers.Authorization).toBeUndefined()
    expect(open.events.open).toEqual(['n1.example.net'])

    const closed = rig({ nodes: [N1] })
    expect(await closed.storage.head(N1, HASH)).toBe('present')
    expect(closed.calls.map((c) => c.method)).toEqual(['HEAD', 'POST', 'HEAD'])
    expect(closed.calls[0]!.headers.Authorization).toBeUndefined()
    expect(closed.calls[2]!.headers.Authorization).toMatch(/^Nostr /)
  })

  it('a node that does not answer the probe is failed, with no token sent', async () => {
    const r = rig({ nodes: [N1], handler: () => { throw new TypeError('down') } })
    expect(await r.storage.head(N1, HASH)).toBe('failed')
    expect(r.calls.every((c) => !c.headers.Authorization)).toBe(true)
  })
})

describe('every listed node open', () => {
  it('is its own outcome on later calls, with its own text, and never asks the keeper for a grant', async () => {
    const r = rig({ nodes: [N1, N2], handler: () => new Response(null, { status: 404 }) })
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'node-open' })
    expect(r.events.open).toEqual(['n1.example.net', 'n2.example.net'])
    const again = await r.storage.upload(envelope, HASH)
    expect(again).toMatchObject({ status: 'held', reason: 'node-open', detail: GROUP_STORAGE_MESSAGES['node-open'] })
    expect(GROUP_STORAGE_MESSAGES['node-open']).toContain('giving files to anyone who asks')
    await expect(r.storage.get(HASH)).rejects.toMatchObject({ reason: 'node-open', message: GROUP_STORAGE_MESSAGES['node-open'] })
    expect(r.events.noGrant).toBe(0)
    expect(r.events.open.length).toBe(2)
  })

  it('a mix of an open node and one without a grant is still no grant, and the keeper is asked', async () => {
    const r = rig({ nodes: [N1, N2], grants: [grant('n1.example.net')], handler: () => new Response(null, { status: 200 }) })
    // The call that finds n1 open: n2 has no grant, so what is left to do is ask the keeper for one.
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'no-grant' })
    expect(r.events.noGrant).toBe(1)
    // And on every later call, for uploads and reads alike.
    expect(await r.storage.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'no-grant', detail: GROUP_STORAGE_MESSAGES['no-grant'] })
    await expect(r.storage.get(HASH)).rejects.toMatchObject({ reason: 'no-grant' })
    expect(r.events.noGrant).toBe(3)
    expect(r.events.open).toEqual(['n1.example.net'])
  })
})

describe('a redirecting node', () => {
  it('is open on the probe (3xx or opaque redirect), and the probe alone does not refuse redirects', async () => {
    for (const make of [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/' } }), () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' })]) {
      const seen: RequestInit[] = []
      const r = rig({ nodes: [N1], handler: () => make() })
      const wrapped = new GroupStorage({ roomId: ROOM, nodes: () => [N1], deviceSk, receiver: r.receiver, now: () => NOW, onNodeOpen: (s) => r.events.open.push(s), fetch: ((u: string, i: RequestInit) => { seen.push(i); return Promise.resolve(make()) }) as never })
      expect(await wrapped.upload(envelope, HASH)).toMatchObject({ status: 'held', reason: 'node-open' })
      expect(seen.length).toBe(1)
      expect(seen[0]!.redirect).toBe('manual')
      expect(r.events.open).toEqual(['n1.example.net'])
    }
  })

  it('every authenticated request still refuses a redirect', async () => {
    const seen: RequestInit[] = []
    const base = defaultNode()
    const r = rig({ nodes: [N1], handler: (c, n) => base(c, n) })
    const wrapped = new GroupStorage({ roomId: ROOM, nodes: () => [N1], deviceSk, receiver: r.receiver, now: () => NOW, fetch: ((u: string, i: RequestInit) => { seen.push(i); return Promise.resolve(base({ url: String(u), method: i.method ?? 'GET', headers: (i.headers ?? {}) as never }, 0)) }) as never })
    await wrapped.upload(envelope, HASH)
    await wrapped.get(HASH)
    await wrapped.head(N1, HASH)
    const authed = seen.filter((i) => new Headers(i.headers).get('authorization') !== null)
    expect(authed.length).toBeGreaterThan(2)
    expect(authed.every((i) => i.redirect === 'error')).toBe(true)
  })
})
