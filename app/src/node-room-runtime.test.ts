import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { readNodeRoom, signNodeRoom, encodeNodeJoinRequest, decodeNodeJoinAnswer, verifyNodeRoomGrant } from '@forgesworn/fold-kit/node-room'
import { buildGrant } from '../../src/group-grants.js'
import { deriveRoom } from '../../src/room.js'
import { localIdentity } from '../../src/identity.js'
import { createDeviceCredential } from '../../src/credential.js'
import { beginNodeJoin, openNodeKeeperAdmissions } from '../../src/node-admission.js'
import { memoryDeviceStore } from './device-store.js'
import { askBrowserNodeRoom, createBrowserNodeRoom, openBrowserNodeRoom } from './node-room-runtime.js'
import { NODE_ROOM_PREFIX, adoptExistingNodeDeviceKey, loadNodeRoom, type BrowserNodeRoom } from './node-rooms.js'

vi.mock('../../src/kithmoot-node.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/kithmoot-node.js')>(),
  nodeRoomTransport: () => ({ close: vi.fn(), probe: vi.fn(async () => {}), reconnect: vi.fn() }),
}))
vi.mock('../../src/node-admission.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/node-admission.js')>(),
  beginNodeJoin: vi.fn(),
}))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function retainedPass(existing = true) {
  const at = 1_900_000_000, secret = generateSecretKey(), authoritySk = generateSecretKey(), deviceSk = generateSecretKey()
  const account = localIdentity(generateSecretKey()), room = deriveRoom(secret).roomId
  const node = readNodeRoom(signNodeRoom({ authoritySk, room, origin: 'https://node.example',
    serviceKey: getPublicKey(generateSecretKey()), now: at, ...(existing ? { existing: { destruct: false } } : { endsAt: at + 7200 }) }), at)!
  const credential = await createDeviceCredential({ identity: account, devicePubkey: getPublicKey(deviceSk), roomId: room,
    now: () => at, expiresAt: at + 3600 })
  const grant = buildGrant({ authoritySk, roomId: room, device: getPublicKey(deviceSk), server: 'node.example',
    scopes: ['turn', 'relay-read', 'relay-write'], grantId: '02'.repeat(16), createdAt: at, expiration: at + 7200 })
  const store = memoryDeviceStore()
  if (existing) adoptExistingNodeDeviceKey(store, node, account.pubkey, deviceSk)
  const signer = { pubkey: account.pubkey, signEvent: vi.fn(async () => { throw Error('nip46-sign_event-timeout') }) }
  const answer = { secret: secret.slice(), grant, epochHint: 0, persistent: true as const, epoch: 0 as const,
    destruct: false, relays: [node.relay], storage: [] as [], node }
  vi.mocked(beginNodeJoin).mockReset().mockReturnValue({ requestId: '03'.repeat(16), expiresAt: at + 600,
    result: Promise.resolve(answer), cancel: vi.fn() })
  return { at, account, room, node, store, deviceSk, credential, signer, grant, answer, authoritySk, secret }
}

it('moves an existing member using its current signed room pass while the account signer is unavailable', async () => {
  const f = await retainedPass()
  // Replace only the transport: exercise the real request/answer crypto,
  // membership inspection and keeper-signed grant with the retained pass.
  vi.mocked(beginNodeJoin).mockImplementation(options => {
    const request = encodeNodeJoinRequest({ ...options, now: f.at })
    const result = (async () => {
      const keeper = await openNodeKeeperAdmissions({ node: f.node, authoritySk: f.authoritySk, roomSecret: f.secret,
        keeperParticipant: getPublicKey(generateSecretKey()), initialMembers: [f.account.pubkey], epochHint: () => 0,
        store: { load: async () => undefined, save: async () => {} }, now: () => f.at,
        fetcher: async () => new Response(JSON.stringify({ accepted: true }), { headers: { 'content-type': 'application/json' } }) })
      try {
        const inspected = keeper.inspect(request.event)
        expect(inspected?.known).toBe(true)
        expect(inspected?.request.credential).toEqual(JSON.parse(JSON.stringify(f.credential)))
        const event = await keeper.admit(request.event)
        const answer = decodeNodeJoinAnswer({ node: f.node, deviceSk: f.deviceSk, event,
          requestId: request.requestId, requestExpiresAt: request.expiresAt, now: f.at })
        if (!answer || answer === 'denied') throw Error('Existing membership was not admitted')
        return answer
      } finally { keeper.close() }
    })()
    return { requestId: request.requestId, expiresAt: request.expiresAt, result, cancel: vi.fn() }
  })
  const options = { now: () => f.at, existing: { deviceSk: f.deviceSk, credential: f.credential } }
  const state = await askBrowserNodeRoom(f.store, f.node, f.signer, options)
  expect(f.signer.signEvent).not.toHaveBeenCalled()
  expect(beginNodeJoin).toHaveBeenCalledWith(expect.objectContaining({ credential: f.credential, deviceSk: f.deviceSk }))
  expect(state.deviceSk).toEqual(f.deviceSk)
  expect(state.participant).toBe(f.account.pubkey)
  expect(verifyNodeRoomGrant(state.grant, f.node, getPublicKey(f.deviceSk), f.at)).toBe(true)
  expect(loadNodeRoom(f.store, f.account.pubkey, f.room, f.at)?.deviceSk).toEqual(f.deviceSk)
})

it.each(['expired', 'participant', 'room', 'device', 'signature', 'new node'] as const)('refuses a retained pass with a mismatched %s', async mismatch => {
  const f = await retainedPass(mismatch !== 'new node')
  let credential = f.credential
  if (mismatch === 'signature') credential = { ...credential, content: 'changed after signing' }
  else if (mismatch !== 'new node') credential = await createDeviceCredential({
    identity: mismatch === 'participant' ? localIdentity(generateSecretKey()) : f.account,
    devicePubkey: mismatch === 'device' ? getPublicKey(generateSecretKey()) : getPublicKey(f.deviceSk),
    roomId: mismatch === 'room' ? getPublicKey(generateSecretKey()) : f.room,
    now: () => mismatch === 'expired' ? f.at - 7200 : f.at,
    expiresAt: mismatch === 'expired' ? f.at - 1 : f.at + 3600,
  })
  const before = f.store.keys().map(key => [key, f.store.get(key)])
  await expect(askBrowserNodeRoom(f.store, f.node, f.signer, {
    now: () => f.at, existing: { deviceSk: f.deviceSk, credential },
  })).rejects.toThrow('This room pass does not authorise')
  expect(f.signer.signEvent).not.toHaveBeenCalled()
  expect(beginNodeJoin).not.toHaveBeenCalled()
  expect(f.store.keys().map(key => [key, f.store.get(key)])).toEqual(before)
})

it('still requires the account signer for a new node invitation', async () => {
  const f = await retainedPass(false)
  await expect(askBrowserNodeRoom(f.store, f.node, f.signer, { now: () => f.at })).rejects.toThrow('nip46-sign_event-timeout')
  expect(f.signer.signEvent).toHaveBeenCalledOnce()
  expect(beginNodeJoin).not.toHaveBeenCalled()
})

it('does not save retained admission after the original room changes', async () => {
  const f = await retainedPass()
  let current = true
  vi.mocked(beginNodeJoin).mockReturnValue({ requestId: '04'.repeat(16), expiresAt: f.at + 600, cancel: vi.fn(),
    result: Promise.resolve().then(() => { current = false; return f.answer }) })
  await expect(askBrowserNodeRoom(f.store, f.node, f.signer, {
    now: () => f.at, allowed: () => current, existing: { deviceSk: f.deviceSk, credential: f.credential },
  })).rejects.toThrow('The room changed before admission')
  expect(loadNodeRoom(f.store, f.account.pubkey, f.room, f.at)).toBeUndefined()
  expect(f.answer.secret.every(byte => byte === 0)).toBe(true)
  expect(f.signer.signEvent).not.toHaveBeenCalled()
})

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
