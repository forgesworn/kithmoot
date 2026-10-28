import { afterEach, expect, it, vi } from 'vitest'
import type { RoomSession, ParticipantView } from '../../src/session.js'
import type { RoomDescriptor } from '../../src/types.js'
import { SpryRoom } from './spry-room.js'

afterEach(() => vi.useRealTimers())

it('uses a pairing loaded from the account after the room has already opened', async () => {
  const endpoint = 'https://relay.example:3744'
  const session = { roomId: 'generated-room', call: undefined, descriptor: {}, onDescriptor: () => () => {},
    onChange: () => () => {}, publishDescriptor: async () => {} } as unknown as RoomSession
  const paths: string[] = [], apply = vi.fn()
  const fetcher: typeof fetch = async url => {
    paths.push(String(url))
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    if (String(url).endsWith('/v1/grants')) return Response.json({ v: 1, endpoint, token: 'a'.repeat(43), expiresAt: expiresAt + 86400 })
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  const broker = new SpryRoom(session, undefined, apply, fetcher)
  try {
    broker.setPairing({ v: 1, endpoint, id: 'c'.repeat(43), secretKey: '01'.repeat(32) })
    await broker.prepare()
    expect(paths).toContain(endpoint + '/v1/grants')
    expect(paths).toContain(endpoint + '/v1/credentials')
    expect(apply).toHaveBeenCalled()
  } finally { broker.close() }
})

it('uses an offer received during joining and renews without the paired participant', async () => {
  vi.useFakeTimers()
  const endpoint = 'https://relay.example:3744'
  const offer = { v: 1 as const, endpoint, token: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  let change: (views: ParticipantView[]) => void = () => {}
  const publish = vi.fn(async () => {})
  const session = { roomId: 'generated-room', call: 'generated-call', descriptor: { spry: offer },
    onDescriptor: (cb: (d: RoomDescriptor) => void) => { cb({ spry: offer } as RoomDescriptor); return () => {} },
    onChange: (cb: typeof change) => { change = cb; return () => {} }, publishDescriptor: publish,
  } as unknown as RoomSession
  const apply = vi.fn(), retained = vi.fn()
  let requests = 0
  const fetcher: typeof fetch = async url => {
    expect(String(url)).toBe(endpoint + '/v1/credentials')
    requests++
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  const broker = new SpryRoom(session, undefined, apply, fetcher, new Uint8Array(32).fill(1), undefined, retained)
  try {
    await broker.prepare()
    expect(requests).toBe(1)
    expect(apply).toHaveBeenCalledTimes(1)
    const roster = [{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[]
    change(roster)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i++) change(roster)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(240000)
    expect(requests).toBe(2)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(retained).toHaveBeenCalled()
    broker.close()
    await vi.advanceTimersByTimeAsync(300000)
    expect(requests).toBe(2)
  } finally { broker.close() }
})

it('uses shared room access when this device’s paired node cannot relay', async () => {
  vi.useFakeTimers()
  const endpoint = 'https://shared.example:3744'
  const offer = { v: 1 as const, endpoint, token: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  const session = { roomId: 'generated-room', call: undefined, descriptor: { spry: offer },
    onDescriptor: (cb: (d: RoomDescriptor) => void) => { cb({ spry: offer } as RoomDescriptor); return () => {} },
    onChange: () => () => {}, publishDescriptor: async () => {},
  } as unknown as RoomSession
  const apply = vi.fn(), paths: string[] = []
  const fetcher: typeof fetch = async url => {
    paths.push(String(url))
    if (String(url).startsWith('https://offline.example')) return new Response('', { status: 503 })
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    return Response.json({ urls: ['turn:shared.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  const broker = new SpryRoom(session, { v: 1, endpoint: 'https://offline.example:3744', id: 'b'.repeat(43), secretKey: '01'.repeat(32) }, apply, fetcher)
  try {
    await broker.prepare()
    expect(paths).toContain('https://offline.example:3744/v1/grants')
    expect(paths).toContain(endpoint + '/v1/credentials')
    expect(apply).toHaveBeenCalledWith([expect.objectContaining({ urls: ['turn:shared.example:3478?transport=udp'] })])
  } finally { broker.close() }
})

// ---------------------------------------------------------------------------
// Room-grant sealing: registrar, vouching, retry and the share choice.
// ---------------------------------------------------------------------------
import { getPublicKey } from 'nostr-tools/pure'
import { spryDevicePublicKey } from '../../src/spry-key.js'
import { SHARED_RELAY_UNAVAILABLE } from '../../src/spry.js'
import type { SpryRosterEntry } from '../../src/session.js'
import { SPRY_GRANT_HEADROOM, SPRY_UNSUPPORTED_MS } from './spry-room.js'

const ENDPOINT = 'https://relay.example'
const TOKEN = 't'.repeat(43)
const key = (n: number) => getPublicKey(new Uint8Array(32).fill(n))
const deviceSk = new Uint8Array(32).fill(200)
const OWN = spryDevicePublicKey(deviceSk)

interface FakeNode { posts: { path: string; body: Record<string, unknown>; signer: string }[]; sealed: boolean; refuse: Set<string>; status: Partial<Record<string, number[]>> }
function node(): { state: FakeNode; fetcher: typeof fetch } {
  const state: FakeNode = { posts: [], sealed: false, refuse: new Set(), status: {} }
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(String(options!.body))
    const signer = JSON.parse(atob((options!.headers as Record<string, string>).Authorization.slice(6))).pubkey
    state.posts.push({ path, body, signer })
    const forced = state.status[path]?.shift()
    if (forced) return Response.json({ error: 'forced' }, { status: forced })
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    if (path === '/v1/grants') return Response.json({ v: 1, endpoint: ENDPOINT, token: TOKEN, expiresAt: expiresAt + 86400 })
    if (path === '/v1/grants/devices') { if (body.seal) state.sealed = true; return Response.json({ v: 1, sealed: state.sealed, enforced: state.sealed, devices: 1 }) }
    if (path === '/v1/grants/vouch') return Response.json({ v: 1, added: body.add.length })
    if (path === '/v1/grants/remove') return Response.json({ removed: true })
    if (state.refuse.has(signer)) return Response.json({ error: 'Call access has expired.' }, { status: 403 })
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  return { state, fetcher }
}

function room(rows: SpryRosterEntry[], extra: Partial<{ call: { id: string }; descriptor: RoomDescriptor }> = {}) {
  let change: (views: ParticipantView[]) => void = () => {}
  let descriptorListener: (d: RoomDescriptor) => void = () => {}
  const removed = new Set<string>()
  const published: RoomDescriptor[] = []
  const session = {
    roomId: 'generated-room', participant: 'me', device: getPublicKey(deviceSk), call: extra.call, descriptor: extra.descriptor ?? {}, removed,
    spryRoster: () => rows.filter(row => !removed.has(row.participant)),
    onDescriptor: (cb: typeof descriptorListener) => { descriptorListener = cb; if (extra.descriptor?.spry) cb(extra.descriptor); return () => {} },
    onChange: (cb: typeof change) => { change = cb; return () => {} },
    publishDescriptor: async (d: RoomDescriptor) => { published.push(d) },
  }
  return { session: session as unknown as RoomSession, rows, removed, published, set: session,
    change: () => change(rows.map(row => ({ participant: row.participant, devices: [row.device], tracks: [] })) as ParticipantView[]),
    descriptor: (d: RoomDescriptor) => descriptorListener(d) }
}
const pair = { v: 1 as const, endpoint: ENDPOINT, id: 'c'.repeat(43), secretKey: '03'.repeat(32) }
const me: SpryRosterEntry = { device: 'my-device', participant: 'me', spryKey: OWN, agent: false }
const devices = (state: FakeNode) => state.posts.filter(post => post.path === '/v1/grants/devices').map(post => post.body)

it('registers its own key before the first redemption, then present members, sealing only once no old client is present', async () => {
  vi.useFakeTimers()
  const old: SpryRosterEntry = { device: 'old-device', participant: 'old', agent: false }
  const bot: SpryRosterEntry = { device: 'bot-device', participant: 'bot', agent: true }
  const r = room([me, { device: 'guest-device', participant: 'guest', spryKey: key(1), agent: false }, old, bot])
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk)
  try {
    await broker.prepare()
    const order = state.posts.map(post => post.path)
    expect(order.indexOf('/v1/grants/devices')).toBeLessThan(order.indexOf('/v1/credentials'))
    expect(devices(state)).toEqual([{ v: 1, pairing: pair.id, grant: TOKEN, add: [OWN, key(1)], remove: [], revision: expect.any(Number) }])
    expect(state.posts.find(post => post.path === '/v1/grants/devices')!.signer).toBe(getPublicKey(Uint8Array.from(Buffer.from(pair.secretKey, 'hex'))))
    // The old client leaves: the next roster change seals, in a request of its own.
    r.rows.splice(r.rows.indexOf(old), 1)
    r.change()
    await vi.advanceTimersByTimeAsync(1100)
    expect(devices(state).at(-1)).toEqual({ v: 1, pairing: pair.id, grant: TOKEN, add: [], remove: [], seal: true, revision: expect.any(Number) })
    const sent = devices(state).length
    r.change(); await vi.advanceTimersByTimeAsync(31_000)
    expect(devices(state).length, 'nothing more to say once sealed').toBe(sent)
  } finally { broker.close() }
})

it('removes a removed participant\'s keys in a request of its own, never a device that merely left', async () => {
  vi.useFakeTimers()
  const r = room([me, { device: 'g1', participant: 'guest', spryKey: key(1), agent: false }, { device: 'l1', participant: 'leaver', spryKey: key(2), agent: false }])
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk)
  try {
    await broker.prepare()
    r.rows.splice(2, 1) // the leaver's device lapses
    r.removed.add('guest')
    r.change()
    await vi.advanceTimersByTimeAsync(1100)
    const removals = devices(state).filter(body => (body.remove as string[]).length)
    expect(removals).toEqual([{ v: 1, pairing: pair.id, grant: TOKEN, add: [], remove: [key(1)], revision: expect.any(Number) }])
    expect(JSON.stringify(devices(state))).not.toMatch(new RegExp(`"remove":\\[[^\\]]*${key(2)}`))
  } finally { broker.close() }
})

it('registers at most two keys per participant and stops adding others near the grant\'s limit', async () => {
  const churn = Array.from({ length: 5 }, (_, i) => ({ device: `c${i}`, participant: 'churner', spryKey: key(10 + i), agent: false }))
  const r = room([me, ...churn])
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk)
  try {
    await broker.prepare()
    expect(devices(state)[0]!.add).toEqual([OWN, key(10), key(11)])
  } finally { broker.close() }
  const crowd = Array.from({ length: 40 }, (_, i) => ({ device: `p${i}`, participant: `p${i}`, spryKey: key(30 + i), agent: false }))
  const full = node()
  full.fetcher = (async (url, options) => {
    const answer = await node().fetcher(url, options)
    if (String(url).endsWith('/v1/grants/devices')) { full.state.posts.push({ path: '/v1/grants/devices', body: JSON.parse(String(options!.body)), signer: '' }); return Response.json({ v: 1, sealed: false, enforced: false, devices: SPRY_GRANT_HEADROOM }) }
    return answer
  }) as typeof fetch
  const second = new SpryRoom(room([me, ...crowd]).session, pair, vi.fn(), full.fetcher, deviceSk)
  try {
    await second.prepare()
    // First request: own key plus 31 others; the node then reports it is near full.
    expect(devices(full.state).map(body => (body.add as string[]).length).filter(Boolean)).toEqual([32])
  } finally { second.close() }
})

it('decides the seal again whenever an answer says the grant is not sealed', async () => {
  vi.useFakeTimers()
  const r = room([me])
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk)
  try {
    await broker.prepare()
    expect(devices(state).filter(body => body.seal)).toHaveLength(1)
    // The node lost the seal (rolled back, or the grant was re-created).
    state.sealed = false
    r.rows.push({ device: 'g', participant: 'guest', spryKey: key(1), agent: false })
    r.change(); await vi.advanceTimersByTimeAsync(1100)
    r.change(); await vi.advanceTimersByTimeAsync(31_000)
    expect(devices(state).filter(body => body.seal)).toHaveLength(2)
  } finally { broker.close() }
})

it('retries a stale revision once and stops asking a node without the paths for an hour', async () => {
  vi.useFakeTimers()
  const r = room([me])
  const { state, fetcher } = node()
  state.status['/v1/grants/devices'] = [409]
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk)
  try {
    await broker.prepare()
    const [first, second] = devices(state)
    expect(second!.revision as number).toBeGreaterThan(first!.revision as number)
    expect(second!.add).toEqual([OWN])
  } finally { broker.close() }
  const missing = node()
  missing.state.status['/v1/grants/devices'] = [404]
  const quiet = new SpryRoom(room([me]).session, pair, vi.fn(), missing.fetcher, deviceSk)
  try {
    await quiet.prepare()
    expect(missing.state.posts.some(post => post.path === '/v1/credentials'), 'a node without the paths still relays').toBe(true)
    await vi.advanceTimersByTimeAsync(SPRY_UNSUPPORTED_MS - 60_000)
    expect(devices(missing.state)).toHaveLength(1)
  } finally { quiet.close() }
})

it('asks for no grant where it does not share, and still uses a relay someone else shared', async () => {
  const offer = { v: 1 as const, endpoint: 'https://shared.example', token: 's'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  const r = room([me], { descriptor: { spry: offer } as RoomDescriptor })
  const posts: string[] = []
  const fetcher: typeof fetch = async (url, options) => { posts.push(String(url)); return node().fetcher(String(url).replace('shared.example', 'relay.example'), options).then(async res => {
    if (!String(url).endsWith('/v1/credentials')) return res
    const body = await res.json(); return Response.json({ ...body, urls: ['turn:shared.example:3478?transport=udp'] })
  }) }
  const saved = { v: 1 as const, endpoint: ENDPOINT, token: TOKEN, expiresAt: offer.expiresAt }
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk, saved, () => {}, { share: false })
  try {
    await broker.prepare()
    expect(posts.some(url => url.startsWith(ENDPOINT)), 'nothing to this device\'s own node').toBe(false)
    expect(posts).toContain('https://shared.example/v1/credentials')
    await broker.publish()
    expect(r.published.at(-1)?.spry?.token).toBe(offer.token)
  } finally { broker.close() }
})

it('turns sharing on with one tap, and off again withdraws the grant', async () => {
  const r = room([me])
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, pair, vi.fn(), fetcher, deviceSk, undefined, () => {}, { share: false })
  try {
    await broker.prepare()
    expect(state.posts).toEqual([])
    await broker.setShare(true)
    await broker.refresh()
    expect(state.posts.map(post => post.path)).toEqual(expect.arrayContaining(['/v1/grants', '/v1/grants/devices', '/v1/credentials']))
    expect(r.published.at(-1)?.spry?.token).toBe(TOKEN)
    const count = r.published.length
    expect(await broker.setShare(false)).toBe(true)
    expect(state.posts.at(-1)).toMatchObject({ path: '/v1/grants/remove', body: { pairing: pair.id, grant: TOKEN } })
    await broker.publish()
    expect(r.published.length, 'the withdrawn offer is not published again').toBe(count)
    r.descriptor({ spry: { v: 1, endpoint: ENDPOINT, token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 3600 } } as RoomDescriptor)
    await broker.publish()
    expect(r.published.length, 'nor taken back from an old descriptor').toBe(count)
  } finally { broker.close() }
})

it('vouches once, after a delay, for a device that joins the call it is on', async () => {
  vi.useFakeTimers()
  const offer = { v: 1 as const, endpoint: ENDPOINT, token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  const call = { id: 'c'.repeat(32) }
  const r = room([{ ...me, call: call.id }], { call, descriptor: { spry: offer } as RoomDescriptor })
  const { state, fetcher } = node()
  const broker = new SpryRoom(r.session, undefined, vi.fn(), fetcher, deviceSk, undefined, () => {}, { jitter: () => 2000 })
  try {
    await broker.prepare()
    r.rows.push({ device: 'newcomer', participant: 'n', spryKey: key(5), agent: false, call: call.id },
      { device: 'lurker', participant: 'l', spryKey: key(6), agent: false })
    r.change()
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.posts.filter(post => post.path === '/v1/grants/vouch')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(600)
    r.change(); await vi.advanceTimersByTimeAsync(3000)
    const vouches = state.posts.filter(post => post.path === '/v1/grants/vouch')
    expect(vouches).toEqual([{ path: '/v1/grants/vouch', body: { v: 1, grant: TOKEN, add: [key(5)] }, signer: OWN }])
  } finally { broker.close() }
})

it('does not vouch without a fresh redemption of its own', async () => {
  vi.useFakeTimers()
  const offer = { v: 1 as const, endpoint: ENDPOINT, token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  const call = { id: 'c'.repeat(32) }
  const r = room([{ ...me, call: call.id }, { device: 'newcomer', participant: 'n', spryKey: key(5), agent: false, call: call.id }], { call, descriptor: { spry: offer } as RoomDescriptor })
  const { state, fetcher } = node()
  state.refuse.add(OWN)
  const broker = new SpryRoom(r.session, undefined, vi.fn(), fetcher, deviceSk, undefined, () => {}, { jitter: () => 10 })
  try {
    await broker.prepare().catch(() => {})
    r.change(); await vi.advanceTimersByTimeAsync(100)
    expect(state.posts.filter(post => post.path === '/v1/grants/vouch')).toHaveLength(0)
  } finally { broker.close() }
})

it('retries a refused redemption at 3, 10 and 30 seconds, and a patient call waits for the first two', async () => {
  vi.useFakeTimers()
  const offer = { v: 1 as const, endpoint: ENDPOINT, token: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  const r = room([me], { descriptor: { spry: offer } as RoomDescriptor })
  const { state, fetcher } = node()
  state.refuse.add(OWN)
  const broker = new SpryRoom(r.session, undefined, vi.fn(), fetcher, deviceSk)
  const at = () => state.posts.filter(post => post.path === '/v1/credentials').length
  try {
    const error = await broker.prepare().catch(e => e)
    expect(error.message).toBe(SHARED_RELAY_UNAVAILABLE)
    expect(at()).toBe(1)
    await vi.advanceTimersByTimeAsync(3000); expect(at()).toBe(2)
    await vi.advanceTimersByTimeAsync(10000); expect(at()).toBe(3)
    await vi.advanceTimersByTimeAsync(30000); expect(at()).toBeGreaterThanOrEqual(4)
  } finally { broker.close() }

  const patient = node()
  patient.state.refuse.add(OWN)
  const apply = vi.fn()
  const second = new SpryRoom(room([me], { descriptor: { spry: offer } as RoomDescriptor }).session, undefined, apply, patient.fetcher, deviceSk)
  try {
    const ready = second.prepare(true)
    await vi.advanceTimersByTimeAsync(2000)
    patient.state.refuse.clear() // the owner's app has registered this device
    await vi.advanceTimersByTimeAsync(2000)
    await ready
    expect(apply).toHaveBeenCalled()
  } finally { second.close() }
})
