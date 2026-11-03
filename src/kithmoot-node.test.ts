import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom, signNodeClosure, readNodeClosure } from '@forgesworn/fold-kit/node-room'
import { buildGrant, buildReset, parseGroupEvent } from './group-grants.js'
import { localIdentity, type UnsignedEvent } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { spryHash } from './spry.js'
import { enrolNodeRoom, nodeTurnCredentials, queryNodeAccess, postNodeGrant, parseKithmootNodePairingLink, claimKithmootNode, nodeRoomTransport,
  nodeCallFactory, nodeKeeperInbox, queryKithmootNodeStatus, assertNodeRoomTransport, type NodeDeviceAccess } from './kithmoot-node.js'

const NOW = 1_900_000_000
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function fixture(turnPorts?: { udpTcp: number; tls: number }) {
  const authority = generateSecretKey(), device = generateSecretKey(), room = '01'.repeat(32), identity = localIdentity(device)
  const event = signNodeRoom({ authoritySk: authority, room, serviceKey: getPublicKey(generateSecretKey()), origin: 'https://node.example', now: NOW, turnPorts })
  const node = readNodeRoom(event, NOW)!
  const grant = buildGrant({ authoritySk: authority, roomId: room, device: identity.pubkey, server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'],
    grantId: '01'.repeat(16), createdAt: NOW, expiration: NOW + 7200 })
  const parsed = parseGroupEvent(grant); if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture')
  const access: Extract<NodeDeviceAccess, { state: 'active' }> = { state: 'active', grant: parsed.parsed, offer: { v: 1, endpoint: node.origin, token: 'A'.repeat(43), expiresAt: NOW + 86400 } }
  const login = (now = NOW, label = '01'.repeat(12)) => ({ urls: node.turnUrls, username: `${now + 300}:${label}`, credential: 'A'.repeat(27) + '=', expiresAt: now + 300, accessExpiresAt: NOW + 7200 })
  return { authority, device, room, node, grant, identity, access, login }
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
describe('pinned KithMoot node client', () => {
  it('checks the paired service key on owner status and projects only counts and availability', async () => {
    const f = fixture(), owner = localIdentity(f.authority), pair = { v: 1 as const, owner: owner.pubkey, origin: f.node.origin, serviceKey: f.node.serviceKey }
    const status = { v: 1, serviceKey: pair.serviceKey, version: '0.1.0-rc.1', ready: true, paired: true, rooms: 1, devices: 2, pending: 0,
      turnReady: true, relayReady: true, storeBytes: 2048 }
    const fetcher = vi.fn(async () => response({ ...status, roomsPrivate: ['not exposed'] })) as unknown as typeof fetch
    expect(await queryKithmootNodeStatus(pair, owner, { fetcher, now: () => NOW })).toEqual({ v: 1, version: '0.1.0-rc.1', ready: true, paired: true,
      rooms: 1, devices: 2, pending: 0, turnReady: true, relayReady: true, storeBytes: 2048 })
    for (const change of [{ serviceKey: getPublicKey(generateSecretKey()) }, { rooms: -1 }, { storeBytes: 'unknown' }]) {
      await expect(queryKithmootNodeStatus(pair, owner, { now: () => NOW, fetcher: async () => response({ ...status, ...change }) })).rejects.toMatchObject({ reason: 'invalid' })
    }
  })
  it('keeps the inviter ask inbox separate from a granted device room transport', async () => {
    const f = fixture(), opened = vi.fn()
    class Socket { constructor() { opened() } }
    const options = { now: () => NOW, websocketImplementation: Socket as unknown as typeof WebSocket }
    expect(() => nodeKeeperInbox(f.node, f.identity, options)).toThrow()
    const inbox = nodeKeeperInbox(f.node, localIdentity(f.authority), options)
    try {
      expect(inbox.describe?.()).toEqual([{ url: f.node.relay, read: true, write: true }])
      expect(() => assertNodeRoomTransport(inbox, f.node, getPublicKey(f.authority))).toThrow('pinned')
      await expect(inbox.publish(finalizeEvent({ kind: 1, created_at: NOW, content: 'fixture', tags: [['expiration', String(NOW + 60)]] }, f.authority))).rejects.toMatchObject({ reason: 'invalid' })
      expect(opened).not.toHaveBeenCalled()
    } finally { inbox.close() }
  })
  it('accepts four own-node TURN URLs, including TLS443, with body-bound device proof and no fallback', async () => {
    const f = fixture()
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://node.example/v1/credentials')
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
      const proof = JSON.parse(atob((init!.headers as Record<string, string>).Authorization!.slice(6))) as Event
      expect(verifyEventUncached(proof)).toBe(true); expect(proof.pubkey).toBe(f.identity.pubkey)
      expect(proof.tags.find(t => t[0] === 'u')?.[1]).toBe(String(url))
      expect(proof.tags.find(t => t[0] === 'payload')?.[1]).toBe(spryHash(String(init!.body)))
      return response(f.login())
    }) as unknown as typeof fetch
    expect((await nodeTurnCredentials(f.node, f.access, f.identity, { fetcher, now: () => NOW })).urls).toEqual(f.node.turnUrls)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('refuses foreign hosts, excess lifetime and a login beyond the signed device deadline', async () => {
    const f = fixture()
    for (const change of [{ urls: ['turns:other.example:443?transport=tcp'] }, { expiresAt: NOW + 301, username: `${NOW + 301}:${'01'.repeat(12)}` },
      { accessExpiresAt: NOW + 7201 }, { urls: [...f.node.turnUrls, f.node.turnUrls[0]] }]) {
      const fetcher = vi.fn(async () => response({ ...f.login(), ...change })) as unknown as typeof fetch
      await expect(nodeTurnCredentials(f.node, f.access, f.identity, { fetcher, now: () => NOW })).rejects.toMatchObject({ reason: 'invalid' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('checks issuance lifetime with bounded clock skew and rechecks time after a slow request', async () => {
    const f = fixture()
    const options = (value: unknown) => ({ now: () => NOW, fetcher: vi.fn(async () => response(value)) as unknown as typeof fetch })
    const shifted = (shift: number, lifetime = 300) => ({ ...f.login(NOW + shift), issuedAt: NOW + shift,
      expiresAt: NOW + shift + lifetime, username: `${NOW + shift + lifetime}:${'01'.repeat(12)}` })
    expect((await nodeTurnCredentials(f.node, f.access, f.identity, options(shifted(1)))).expiresAt).toBe(NOW + 301)
    for (const value of [shifted(31), shifted(0, 301), { ...shifted(0), issuedAt: null }])
      await expect(nodeTurnCredentials(f.node, f.access, f.identity, options(value))).rejects.toMatchObject({ reason: 'invalid' })
    let clock = NOW
    const fetcher = vi.fn(async () => { clock += 40; return response(f.login(clock)) }) as unknown as typeof fetch
    expect((await nodeTurnCredentials(f.node, f.access, f.identity, { now: () => clock, fetcher })).expiresAt).toBe(NOW + 340)
  })
  it('does not treat a server refusal or grant reset as a signed room closure', async () => {
    const f = fixture(), reset = buildReset({ authoritySk: f.authority, roomId: f.room, server: 'node.example', createdAt: NOW })
    const options = (value: unknown) => ({ now: () => NOW, fetcher: vi.fn(async () => response(value)) as unknown as typeof fetch })
    await expect(queryNodeAccess(f.node, '01'.repeat(16), f.identity, options({ state: 'closed', proof: null }))).rejects.toMatchObject({ reason: 'invalid' })
    await expect(queryNodeAccess(f.node, '01'.repeat(16), f.identity, options({ state: 'closed', proof: { id: reset.id, sig: reset.sig, createdAt: NOW, operation: 'ab'.repeat(16), expiration: String(NOW + 30 * 86400) } }))).rejects.toMatchObject({ reason: 'invalid' })
    expect((await queryNodeAccess(f.node, '01'.repeat(16), f.identity, options({ state: 'reset', event: reset }))).state).toBe('reset')
    const closure = signNodeClosure({ node: f.node, authoritySk: f.authority, operation: 'ab'.repeat(16), now: NOW })
    expect((await queryNodeAccess(f.node, '01'.repeat(16), f.identity, options({ state: 'closed', proof: readNodeClosure(closure, f.node, NOW) }))).state).toBe('closed')
  })
  it('cancels a late signer before sending and accepts only a fresh restamp on the same signed terms', async () => {
    const f = fixture(), fetcher = vi.fn(async () => response({ accepted: true })) as unknown as typeof fetch
    let allowed = true, release!: (event: Event) => void, template!: UnsignedEvent
    const identity = { pubkey: getPublicKey(f.authority), signEvent: vi.fn((value: UnsignedEvent) => { template = value; return new Promise<Event>(resolve => { release = resolve }) }) }
    const pending = postNodeGrant(f.node, f.grant, identity, { fetcher, now: () => NOW, allowed: () => allowed })
    await vi.waitFor(() => expect(identity.signEvent).toHaveBeenCalled())
    allowed = false; release(finalizeEvent(template, f.authority))
    await expect(pending).rejects.toMatchObject({ reason: 'refused' }); expect(fetcher).not.toHaveBeenCalled()
    await postNodeGrant(f.node, f.grant, { pubkey: identity.pubkey, signEvent: async value => finalizeEvent({ ...value, created_at: NOW - 1 }, f.authority) }, { fetcher, now: () => NOW })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('keeps pairing codes bounded and makes no initial request after consent is withdrawn', async () => {
    const f = fixture(), code = 'A'.repeat(43)
    const fragment = '#kithmoot-node=' + Buffer.from(JSON.stringify({ v: 1, node: f.node.origin, code, expiresAt: NOW + 360 })).toString('base64url')
    const link = parseKithmootNodePairingLink(fragment, NOW)
    expect(link).toEqual({ origin: f.node.origin, code, expiresAt: NOW + 360 })
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(claimKithmootNode(link, f.identity, { fetcher, now: () => NOW, allowed: () => false })).rejects.toMatchObject({ reason: 'refused' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => parseKithmootNodePairingLink(fragment, NOW + 360)).toThrow('expired')
  })
  it('pins the relay, rejects missing expiry and does not permit a public relay override', async () => {
    const f = fixture(), opened = vi.fn()
    class Socket { constructor() { opened() } }
    const transport = nodeRoomTransport(f.node, f.identity, 'room', { now: () => NOW, websocketImplementation: Socket as unknown as typeof WebSocket })
    try {
      expect(transport.describe?.()).toEqual([{ url: f.node.relay, read: true, write: true }])
      expect(() => transport.setRelays?.(['wss://public.example'])).toThrow('node relay')
      expect(() => transport.setAuthentication([])).toThrow('pinned device')
      await expect(transport.query('wss://public.example', [{ kinds: [1] }])).rejects.toMatchObject({ reason: 'refused' })
      await expect(transport.publishQuietly('wss://public.example', f.grant)).rejects.toMatchObject({ reason: 'refused' })
      await expect(transport.publishQuietly(f.node.relay, f.grant)).rejects.toMatchObject({ reason: 'refused' })
      await expect(transport.publishQuietly(f.node.relay, finalizeEvent({ kind: 1, created_at: NOW, content: 'fixture', tags: [] }, f.device))).rejects.toMatchObject({ reason: 'invalid' })
      await expect(transport.publish(finalizeEvent({ kind: 1, created_at: NOW, content: 'fixture', tags: [] }, f.device))).rejects.toMatchObject({ reason: 'invalid' })
      expect(opened).not.toHaveBeenCalled()
    } finally { transport.close() }
  })
  it('rotates credentials on retained connections while preserving relay-only policy, and closes them on withdrawal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, issued = 0
    const fetcher = vi.fn(async () => response(f.login(clock, String(++issued).padStart(24, '0')))) as unknown as typeof fetch
    class Peer {
      signalingState = 'stable'
      restartIce = vi.fn()
      setConfiguration = vi.fn((configuration: RTCConfiguration) => { this.configuration = configuration })
      constructor(public configuration: RTCConfiguration) {}
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => clock, PeerConnection: Peer as unknown as typeof RTCPeerConnection })
    try {
      const peer = managed.factory() as unknown as Peer
      expect(peer.configuration.iceTransportPolicy).toBe('relay')
      clock += 240; await vi.advanceTimersByTimeAsync(240000)
      expect(peer.restartIce).toHaveBeenCalledTimes(1); expect(peer.setConfiguration).toHaveBeenCalledTimes(1)
      expect(peer.configuration.iceTransportPolicy).toBe('relay')
      expect(peer.configuration.iceServers?.[0]?.urls).toEqual(f.node.turnUrls)
      managed.close(); expect(peer.signalingState).toBe('closed')
      expect(() => managed.factory()).toThrow()
    } finally { managed.close() }
  })
  it('closes existing peers when permission is withdrawn while a credential renewal is in flight', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, allowed = true, calls = 0, release!: (value: Response) => void
    const fetcher = vi.fn(async () => ++calls === 1 ? response(f.login()) : new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
    class Peer {
      signalingState = 'stable'
      restartIce = vi.fn(); setConfiguration = vi.fn()
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => clock, allowed: () => allowed,
      PeerConnection: Peer as unknown as typeof RTCPeerConnection })
    try {
      const peer = managed.factory() as unknown as Peer
      clock += 240; await vi.advanceTimersByTimeAsync(240000); expect(calls).toBe(2)
      allowed = false; release(response(f.login(clock))); await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(peer.signalingState).toBe('closed')); expect(peer.restartIce).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300000); expect(calls).toBe(2)
    } finally { managed.close() }
  })
  it('ends a cached call within five monotonic minutes despite clock rollback and a stalled renewal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, ticks = 0, calls = 0, release!: (value: Response) => void
    const fetcher = vi.fn(async () => ++calls === 1 ? response({ ...f.login(NOW + 1), issuedAt: NOW + 1 })
      : new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
    class Peer { signalingState = 'stable'; restartIce = vi.fn(); setConfiguration = vi.fn(); close() { this.signalingState = 'closed' } }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => clock, monotonic: () => ticks, PeerConnection: Peer as unknown as typeof RTCPeerConnection })
    try {
      const peer = managed.factory() as unknown as Peer
      clock += 240; ticks = 240000; await vi.advanceTimersByTimeAsync(240000); expect(calls).toBe(2)
      clock = NOW - 600; ticks = 299000; await vi.advanceTimersByTimeAsync(59000); expect(peer.signalingState).toBe('stable')
      ticks = 300000; await vi.advanceTimersByTimeAsync(1000); expect(peer.signalingState).toBe('closed')
      expect(() => managed.factory()).toThrow()
      release(response(f.login(NOW + 240))); await vi.advanceTimersByTimeAsync(0)
      expect(peer.restartIce).not.toHaveBeenCalled(); expect(peer.signalingState).toBe('closed')
    } finally { managed.close() }
  })

})

it('pins selected ports during owner pairing and accepts credentials only for the keeper-signed port profile', async () => {
  const turnPorts = { udpTcp: 34790, tls: 53499 }, f = fixture(turnPorts)
  const info = { v: 1, profile: 'kithmoot-node/1', origin: f.node.origin, serviceKey: f.node.serviceKey, relay: f.node.relay, calls: 'relay-only', files: 'off', turnPorts }
  const fetcher = vi.fn(async (url: string | URL | Request) => response(String(url).endsWith('/info') ? info : { paired: true })) as unknown as typeof fetch
  const pair = await claimKithmootNode({ origin: f.node.origin, code: 'A'.repeat(43), expiresAt: NOW + 60 }, f.identity, { fetcher, now: () => NOW })
  expect(pair.turnPorts).toEqual(turnPorts)
  expect((await nodeTurnCredentials(f.node, f.access, f.identity, { fetcher: async () => response(f.login()), now: () => NOW })).urls).toEqual(f.node.turnUrls)
  await expect(nodeTurnCredentials(f.node, f.access, f.identity, { fetcher: async () => response({ ...f.login(), urls: fixture().node.turnUrls }), now: () => NOW })).rejects.toMatchObject({ reason: 'invalid' })
  const malformed = vi.fn(async () => response({ ...info, turnPorts: { udpTcp: 443, tls: 53499 } })) as unknown as typeof fetch
  await expect(claimKithmootNode({ origin: f.node.origin, code: 'A'.repeat(43), expiresAt: NOW + 60 }, f.identity, { fetcher: malformed, now: () => NOW })).rejects.toMatchObject({ reason: 'invalid' })
  expect(malformed).toHaveBeenCalledTimes(1)
})

it('refuses room enrolment when its signed port profile differs from the paired node', async () => {
  const f = fixture({ udpTcp: 34790, tls: 53499 }), fetcher = vi.fn(async () => response({ enrolled: true })) as unknown as typeof fetch
  const pair = { v: 1 as const, owner: f.identity.pubkey, origin: f.node.origin, serviceKey: f.node.serviceKey }
  await expect(enrolNodeRoom(pair, f.node, f.identity, { fetcher, now: () => NOW })).rejects.toMatchObject({ reason: 'invalid' })
  expect(fetcher).not.toHaveBeenCalled()
  await enrolNodeRoom({ ...pair, turnPorts: f.node.turnPorts }, f.node, f.identity, { fetcher, now: () => NOW })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
