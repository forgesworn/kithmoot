import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { readNodeRoom, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { buildGrant } from '../../src/group-grants.js'
import { deriveRoom } from '../../src/room.js'
import { localIdentity } from '../../src/identity.js'
import { memoryDeviceStore } from './device-store.js'
import { createBrowserNodeRoom, openBrowserNodeRoom } from './node-room-runtime.js'
import { NODE_ROOM_PREFIX, loadNodeRoom, type BrowserNodeRoom } from './node-rooms.js'

vi.mock('../../src/kithmoot-node.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/kithmoot-node.js')>(),
  nodeRoomTransport: () => ({ close: vi.fn(), probe: vi.fn(async () => {}), reconnect: vi.fn() }),
}))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function admitted() {
  vi.useFakeTimers()
  const at = 1_900_000_000, secret = generateSecretKey(), authoritySk = generateSecretKey(), deviceSk = generateSecretKey()
  const room = deriveRoom(secret).roomId, node = readNodeRoom(signNodeRoom({ authoritySk, room, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), now: at }), at)!
  const grant = buildGrant({ authoritySk, roomId: room, device: getPublicKey(deviceSk), server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: at, expiration: at + 7200 })
  const state: BrowserNodeRoom = { node, secret, deviceSk, grant, participant: getPublicKey(generateSecretKey()), phase: 'active', epochHint: 0, startsAt: at }
  const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/credentials')
    ? reply({ urls: node.turnUrls, username: `${at + 300}:${'01'.repeat(12)}`, credential: 'A'.repeat(27) + '=', expiresAt: at + 300, accessExpiresAt: at + 7200 })
    : reply({ state: 'active', event: grant, offer: { v: 1, endpoint: node.origin, token: 'A'.repeat(43), expiresAt: at + 7200 } })) as unknown as typeof fetch
  vi.stubGlobal('RTCPeerConnection', class {})
  const options = { fetcher, now: () => at, ask: async () => false, settled: vi.fn(), blocked: () => false, withdrawn: vi.fn(), unavailable: vi.fn(), available: vi.fn() }
  return { store: memoryDeviceStore(), state, options, fetcher: vi.mocked(fetcher) }
}

it('finishes an admitted browser join after one temporary initial access failure', async () => {
  const f = admitted()
  f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const joining = openBrowserNodeRoom(f.store, f.state, f.options)
  const checked = expect(joining).resolves.toMatchObject({ state: f.state })
  await vi.advanceTimersByTimeAsync(1000)
  await checked
  const runtime = await joining
  try {
    expect(runtime.allowed()).toBe(true)
    expect(f.options.unavailable).toHaveBeenCalledTimes(1)
    expect(f.options.available).toHaveBeenCalledTimes(1)
    expect(f.options.withdrawn).not.toHaveBeenCalled()
  } finally { runtime.close() }
})

it('retries a transport timeout with a new signed proof', async () => {
  const f = admitted()
  f.fetcher.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
  const joining = openBrowserNodeRoom(f.store, f.state, f.options)
  await vi.advanceTimersByTimeAsync(500)
  const runtime = await joining
  try {
    const proofs = f.fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
    expect(proofs[0]).not.toBe(proofs[1])
    expect(runtime.allowed()).toBe(true)
  } finally { runtime.close() }
})

it('recovers a temporary first TURN login failure after admission was checked', async () => {
  const f = admitted(), normal = f.fetcher.getMockImplementation()!
  let logins = 0
  f.fetcher.mockImplementation(async (...args) => String(args[0]).endsWith('/credentials') && logins++ === 0
    ? new Response('{}', { status: 503 }) : normal(...args))
  const joining = openBrowserNodeRoom(f.store, f.state, f.options)
  await vi.advanceTimersByTimeAsync(500)
  const runtime = await joining
  try { expect(logins).toBe(2); expect(runtime.allowed()).toBe(true) } finally { runtime.close() }
})

it.each([401, 403, 400])('does not retry an initial HTTP %s refusal', async status => {
  const f = admitted()
  f.fetcher.mockResolvedValue(new Response('{}', { status }))
  await expect(openBrowserNodeRoom(f.store, f.state, f.options)).rejects.toMatchObject({ reason: 'refused', status })
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(f.options.withdrawn).not.toHaveBeenCalled()
})

it('does not retry invalid access data', async () => {
  const f = admitted()
  f.fetcher.mockResolvedValue(new Response('{}'))
  await expect(openBrowserNodeRoom(f.store, f.state, f.options)).rejects.toMatchObject({ reason: 'invalid' })
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})

it('bounds startup retries when the node stays unavailable', async () => {
  const f = admitted()
  f.fetcher.mockImplementation(async () => new Response('{}', { status: 503 }))
  const checked = expect(openBrowserNodeRoom(f.store, f.state, f.options)).rejects.toMatchObject({ reason: 'unavailable' })
  await vi.advanceTimersByTimeAsync(2000)
  await checked
  expect(f.fetcher).toHaveBeenCalledTimes(3)
})

it('cancels a delayed startup retry immediately on abort', async () => {
  const f = admitted(), controller = new AbortController()
  f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const checked = expect(openBrowserNodeRoom(f.store, f.state, { ...f.options, signal: controller.signal })).rejects.toMatchObject({ reason: 'refused' })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await checked
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})

it('cannot resume a join after navigation changes its allowed guard', async () => {
  const f = admitted(); let allowed = true
  f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const checked = expect(openBrowserNodeRoom(f.store, f.state, { ...f.options, allowed: () => allowed })).rejects.toMatchObject({ reason: 'refused' })
  await vi.advanceTimersByTimeAsync(0)
  allowed = false
  await vi.advanceTimersByTimeAsync(1000)
  await checked
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})

it('saves keeper custody and the recovery link before enrolment and retains them on a lost or refused response', async () => {
  const store = memoryDeviceStore(), owner = localIdentity(generateSecretKey()), at = 1_900_000_000
  const pair = { v: 1 as const, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), owner: owner.pubkey }
  let room = '', prepared = false
  const fetcher = vi.fn(async () => {
    expect(prepared).toBe(true)
    const key = store.keys().find(key => key.startsWith(NODE_ROOM_PREFIX))!
    room = key.split('.').at(-1)!
    expect(loadNodeRoom(store, owner.pubkey, room, at)).toMatchObject({ phase: 'creating', participant: owner.pubkey })
    return new Response('{}', { status: 503 })
  }) as unknown as typeof fetch
  await expect(createBrowserNodeRoom(store, pair, owner, { now: () => at, fetcher, prepared: state => {
    expect(loadNodeRoom(store, owner.pubkey, state.node.room, at)?.secret).toEqual(state.secret); prepared = true
  } })).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const held = loadNodeRoom(store, owner.pubkey, room, at)!
  expect(held.phase).toBe('creating'); expect(held.authoritySk).toHaveLength(32); expect(held.grant).toBeUndefined()
})
