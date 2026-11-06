import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom, signNodeClosure, readNodeClosure } from '@forgesworn/fold-kit/node-room'
import { buildGrant, buildReset, parseGroupEvent } from './group-grants.js'
import { localIdentity, type UnsignedEvent } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { RECONNECT_JITTER_MS } from './relay-pool.js'
import { spryHash } from './spry.js'
import type { PeerContext } from './peer.js'
import { Peer } from './peer.js'
import { SlotPeer } from './slot-peer.js'
import { FakeRTCPeerConnection, fakeTrack } from '../test/fake-rtc.js'
import { enrolNodeRoom, nodeTurnCredentials, queryNodeAccess, postNodeGrant, parseKithmootNodePairingLink, claimKithmootNode, nodeRoomTransport,
  nodeCallFactory, nodeKeeperInbox, queryKithmootNodeStatus, assertNodeRoomTransport, assertNodeCallFactory, type NodeDeviceAccess } from './kithmoot-node.js'

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
describe('node TURN route gathering', () => {
  async function setup() {
    const f = fixture({ udpTcp: 34790, tls: 53499 }); let issued = 0
    const fetcher = vi.fn(async () => response(f.login(NOW, String(++issued).padStart(24, '0')))) as unknown as typeof fetch
    class Connection extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; iceGatheringState = 'new'
      localDescription: RTCSessionDescriptionInit | null | undefined
      restartIce = vi.fn()
      setConfiguration = vi.fn((configuration: RTCConfiguration) => { this.configuration = configuration })
      constructor(public configuration: RTCConfiguration) { super() }
      fire(type: string, fields: object = {}) { this.dispatchEvent(Object.assign(new globalThis.Event(type), fields)) }
      gather() { this.iceGatheringState = 'gathering'; this.fire('icegatheringstatechange') }
      exhausted() { this.iceGatheringState = 'complete'; this.fire('icegatheringstatechange') }
      close() { this.signalingState = 'closed' }
    }
    const contexts = [{ tier: 'turn' as const, remoteDevice: 'ab'.repeat(32) }, { tier: 'turn' as const, remoteDevice: 'cd'.repeat(32) }]
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Connection as unknown as typeof RTCPeerConnection })
    const create = (index = 0) => managed.factory(contexts[index]) as unknown as Connection
    const urls = (peer: Connection) => peer.configuration.iceServers![0]!.urls
    return { ...f, managed, create, urls, fetcher }
  }

  it('bounds retiring media by its original login even after all-peer credential renewal', async () => {
    vi.useFakeTimers(); const f = fixture(); let clock = NOW, ticks = 0, issued = 0
    class Connection extends EventTarget {
      signalingState = 'stable'; connectionState = 'connected'
      constructor(_: RTCConfiguration) { super() }
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, {
      fetcher: (async () => response(f.login(clock, String(++issued).padStart(24, '0')))) as typeof fetch,
      now: () => clock, monotonic: () => ticks, rebuildPeers: () => true,
      PeerConnection: Connection as unknown as typeof RTCPeerConnection,
    })
    try {
      const old = managed.factory()
      clock += 295; ticks = 295_000; await managed.reconnect()
      const current = managed.factory(); managed.factory.onRetiring!(old)
      await vi.advanceTimersByTimeAsync(4_999); expect(old.signalingState).toBe('stable')
      clock += 5; ticks += 5_000; await vi.advanceTimersByTimeAsync(1)
      expect(old.signalingState).toBe('closed'); expect(current.signalingState).toBe('stable')
    } finally { managed.close() }
  })
  it.each(['new', 'connecting', 'disconnected', 'failed'])('releases retired %s transports before starting replacements', async state => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const old = f.create(); old.connectionState = state
      f.managed.factory.onRetiring!(old as unknown as ReturnType<typeof f.managed.factory>)
      expect(old.signalingState).toBe('closed')
      expect(f.fetcher).toHaveBeenCalledTimes(1)
    } finally { f.managed.close() }
  })
  it('keeps a failed three-peer rebuild inside the replacement connection budget', async () => {
    vi.useFakeTimers(); const f = fixture(), active = new Set<Connection>()
    class Connection extends EventTarget {
      signalingState = 'stable'; connectionState = 'disconnected'
      constructor(readonly configuration: RTCConfiguration) {
        super()
        if (active.size >= 4) throw Error('TURN quota: three current transports and one replacement')
        active.add(this)
      }
      close() { this.signalingState = 'closed'; active.delete(this) }
    }
    const fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Connection as unknown as typeof RTCPeerConnection })
    try {
      const old = Array.from({ length: 3 }, () => managed.factory())
      expect(active.size).toBe(3)
      expect(() => {
        for (const peer of old) { managed.factory.onRetiring!(peer); managed.factory() }
      }).not.toThrow()
      expect(active.size).toBe(3)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { managed.close() }
    expect(active.size).toBe(0)
  })
  it('gathers one UDP route per peer rather than allocating all four advertised routes', async () => {
    const f = await setup()
    try {
      expect(f.node.turnUrls).toHaveLength(4)
      for (let index = 0; index < 4; index++) expect(f.urls(f.create())).toEqual([f.node.turnUrls.find(url => url.endsWith('transport=udp'))])
    } finally { f.managed.close() }
  })
  it('falls back to TLS 443 when UDP gathering stalls, without restarting a healthy peer', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const blocked = f.create(), healthy = f.create(1), oldLogin = blocked.configuration.iceServers![0]!.username
      blocked.gather(); healthy.gather(); healthy.fire('icecandidate', { candidate: { type: 'relay' } })
      await vi.advanceTimersByTimeAsync(4000)
      expect(f.urls(blocked)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
      expect(blocked.configuration.iceServers![0]!.username).not.toBe(oldLogin)
      expect(blocked.restartIce).toHaveBeenCalledTimes(1)
      expect(healthy.restartIce).not.toHaveBeenCalled(); expect(healthy.setConfiguration).not.toHaveBeenCalled()
      expect(f.fetcher).toHaveBeenCalledTimes(2)
    } finally { f.managed.close() }
  })
  it('tries remaining pinned routes once and stops after all transports are unreachable', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create()
      const expected = [f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url)), f.node.turnUrls.find(url => /^turns:.*:53499\?/.test(url)), f.node.turnUrls.find(url => /^turn:.*transport=tcp$/.test(url))]
      for (const url of expected) {
        peer.gather(); peer.fire('icecandidateerror', { errorCode: 701 }); peer.exhausted(); await vi.advanceTimersByTimeAsync(4000)
        expect(f.urls(peer)).toEqual([url])
      }
      peer.gather(); peer.fire('icecandidateerror', { errorCode: 701 }); peer.exhausted(); await vi.advanceTimersByTimeAsync(20000)
      expect(f.fetcher).toHaveBeenCalledTimes(4); expect(peer.restartIce).toHaveBeenCalledTimes(3)
      expect(peer.configuration.iceTransportPolicy).toBe('relay')
    } finally { f.managed.close() }
  })
  it('falls back when a gathered route fails its checks and ignores errors from the old URL', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(), udp = f.urls(peer) as string[]
      peer.gather(); peer.fire('icecandidate', { candidate: { type: 'relay' } })
      await vi.advanceTimersByTimeAsync(5000); expect(f.fetcher).toHaveBeenCalledTimes(1)
      peer.connectionState = 'failed'; peer.fire('connectionstatechange'); await vi.advanceTimersByTimeAsync(0)
      expect(f.urls(peer)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
      peer.gather(); peer.fire('icecandidateerror', { errorCode: 701, url: udp[0] })
      peer.fire('icecandidate', { candidate: { type: 'relay' } })
      await vi.advanceTimersByTimeAsync(5000); expect(f.fetcher).toHaveBeenCalledTimes(2)
      expect(f.urls(f.create(1))).toEqual(f.urls(peer))
      await f.managed.reconnect()
      expect(f.urls(peer)).toEqual(udp)
    } finally { f.managed.close() }
  })
  it('keeps a connected route through an empty later gathering round', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(), route = f.urls(peer)
      peer.gather(); peer.fire('icecandidate', { candidate: { type: 'relay' } })
      peer.connectionState = 'connected'; peer.fire('connectionstatechange')
      peer.gather(); peer.exhausted(); await vi.advanceTimersByTimeAsync(5000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
      expect(f.urls(f.create(1))).toEqual(route)
    } finally { f.managed.close() }
  })
  it('does not spend a route on an abandoned local offer', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create()
      peer.gather(); peer.localDescription = null; peer.exhausted()
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
      peer.localDescription = { type: 'offer', sdp: 'v=0\r\n' }
      peer.gather(); peer.exhausted(); await vi.advanceTimersByTimeAsync(4000)
      expect(f.fetcher).toHaveBeenCalledTimes(2)
      expect(f.urls(peer)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
    } finally { f.managed.close() }
  })
  it('repairs one failed pair on the relay route another pair is using', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const probe = f.create(); probe.gather(); await vi.advanceTimersByTimeAsync(4000)
      const tls = f.urls(probe); probe.close()
      const healthy = f.create(1), failed = f.create()
      for (const peer of [healthy, failed]) { peer.gather(); peer.fire('icecandidate', { candidate: { type: 'relay' } }) }
      healthy.connectionState = 'connected'; healthy.fire('connectionstatechange')
      failed.connectionState = 'failed'; failed.fire('connectionstatechange')
      await vi.advanceTimersByTimeAsync(0)
      expect(f.urls(failed)).toEqual(tls); expect(f.urls(f.create())).toEqual(tls)
      expect(f.fetcher).toHaveBeenCalledTimes(3); expect(failed.restartIce).toHaveBeenCalledTimes(1)
      expect(healthy.restartIce).not.toHaveBeenCalled(); expect(healthy.setConfiguration).not.toHaveBeenCalled()
    } finally { f.managed.close() }
  })
  it.each(['empty gathering', 'failed checks'])('retries an established route before changing transports, then permits %s fallback', async reason => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peers = [f.create(), f.create(1)], route = f.urls(peers[0]!)
      for (const peer of peers) {
        peer.gather(); peer.fire('icecandidate', { candidate: { type: 'relay' } })
        peer.connectionState = 'connected'; peer.fire('connectionstatechange')
      }
      for (const peer of peers) peer.connectionState = 'failed'
      for (const peer of peers) peer.fire('connectionstatechange')
      await vi.advanceTimersByTimeAsync(0)
      for (const peer of peers) { expect(f.urls(peer)).toEqual(route); expect(peer.restartIce).toHaveBeenCalledTimes(1) }
      expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.urls(f.create())).toEqual(route)
      // The fresh repair can still discover a genuinely blocked route.
      peers[0]!.gather()
      if (reason === 'empty gathering') { peers[0]!.exhausted(); await vi.advanceTimersByTimeAsync(4000) }
      else {
        peers[0]!.fire('icecandidate', { candidate: { type: 'relay' } })
        peers[0]!.fire('connectionstatechange'); await vi.advanceTimersByTimeAsync(0)
      }
      expect(f.urls(peers[0]!)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
      expect(f.fetcher).toHaveBeenCalledTimes(3)
    } finally { f.managed.close() }
  })
  it('coalesces two blocked peers onto the same fallback instead of skipping TLS 443', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      let release!: (response: Response) => void
      vi.mocked(f.fetcher).mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
      const peers = [f.create(), f.create(1)]
      for (const peer of peers) { peer.gather(); peer.fire('icecandidateerror', { errorCode: 701 }); peer.exhausted() }
      await vi.advanceTimersByTimeAsync(4000)
      expect(f.fetcher).toHaveBeenCalledTimes(2)
      release(response(f.login(NOW, '02'.repeat(12)))); await vi.advanceTimersByTimeAsync(0)
      for (const peer of peers) expect(f.urls(peer)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
    } finally { f.managed.close() }
  })
  it('keeps a URL whose IPv4 relay candidate follows an address-family error', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(); peer.gather(); peer.fire('icecandidateerror', { errorCode: 701 })
      await vi.advanceTimersByTimeAsync(100)
      peer.fire('icecandidate', { candidate: { type: 'relay' } }); peer.exhausted()
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
    } finally { f.managed.close() }
  })
  it('falls back when a browser with UDP disabled reports only gathering complete', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(); peer.exhausted(); await vi.advanceTimersByTimeAsync(4000)
      expect(f.urls(peer)).toEqual([f.node.turnUrls.find(url => /^turns:.*:443\?/.test(url))])
      expect(peer.restartIce).toHaveBeenCalledTimes(1)
    } finally { f.managed.close() }
  })
  it('lets a replacement gathering round finish after an empty rollback round', async () => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(); peer.gather(); peer.exhausted()
      await vi.advanceTimersByTimeAsync(100)
      peer.gather(); peer.fire('icecandidate', { candidate: { type: 'relay' } }); peer.exhausted()
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
    } finally { f.managed.close() }
  })
  it.each([401, 403, 486, 508])('does not treat TURN refusal %s as a blocked route', async code => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(); peer.gather(); peer.fire('icecandidateerror', { errorCode: code })
      await vi.advanceTimersByTimeAsync(10000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
    } finally { f.managed.close() }
  })
  it.each(['closed', 'retiring', 'stopped'])('cancels route fallback for a %s peer', async state => {
    vi.useFakeTimers(); const f = await setup()
    try {
      const peer = f.create(); peer.gather()
      if (state === 'closed') peer.close()
      else if (state === 'retiring') f.managed.factory.onRetiring!(peer as unknown as ReturnType<typeof f.managed.factory>)
      else f.managed.close()
      await vi.advanceTimersByTimeAsync(10000)
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(peer.restartIce).not.toHaveBeenCalled()
    } finally { f.managed.close() }
  })
})
describe('pinned KithMoot node client', () => {
  it('probes and replaces an idle silent authenticated socket without waiting for a publish', async () => {
    const f = fixture(), server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    let connections = 0, eoses = 0, silenceFirst = false
    const proofs: Event[] = []
    server.on('connection', socket => {
      const first = ++connections === 1
      let authenticated = false
      socket.send(JSON.stringify(['AUTH', 'node-probe-fixture']))
      socket.on('message', bytes => {
        if (first && silenceFirst) return
        const frame = JSON.parse(bytes.toString())
        if (frame[0] === 'AUTH') {
          const event = frame[1] as Event; proofs.push(event)
          authenticated = verifyEventUncached(event) && event.pubkey === f.identity.pubkey && JSON.stringify(event.tags) === JSON.stringify([
            ['relay', f.node.relay], ['challenge', 'node-probe-fixture'], ['room', f.room], ['mode', 'room'],
          ])
          socket.send(JSON.stringify(['OK', event.id, authenticated, '']))
        } else if (frame[0] === 'REQ' && authenticated) {
          eoses++; socket.send(JSON.stringify(['EOSE', frame[1]]))
        }
      })
    })
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    class Socket extends NodeWebSocket { constructor(_: string) { super(`ws://127.0.0.1:${port}`) } }
    const transport = nodeRoomTransport(f.node, f.identity, 'room', { now: () => NOW, websocketImplementation: Socket as unknown as typeof globalThis.WebSocket })
    let initialEose!: () => void
    const initiallyReady = new Promise<void>(resolve => { initialEose = resolve })
    const unsubscribe = transport.subscribe([{ kinds: [20462] }], () => {}, initialEose)
    try {
      await initiallyReady
      silenceFirst = true
      const realNow = Date.now.bind(Date)
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6000)
      await transport.probe()
      // A failed socket deliberately spreads redials across the full jitter
      // window. Observe that bound, including time for the local handshake.
      await vi.waitFor(() => expect(connections).toBeGreaterThan(1), { timeout: RECONNECT_JITTER_MS + 2000 })
      await vi.waitFor(() => expect(eoses).toBeGreaterThan(1))
      expect(proofs.length).toBeGreaterThan(1)
      expect(proofs.every(event => event.pubkey === f.identity.pubkey && event.tags.some(tag => tag[0] === 'room' && tag[1] === f.room))).toBe(true)
    } finally {
      unsubscribe(); transport.close()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15000)
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
      expect(peer.configuration.iceServers?.[0]?.urls).toEqual([f.node.turnUrls[0]])
      managed.close(); expect(peer.signalingState).toBe('closed')
      expect(() => managed.factory()).toThrow()
    } finally { managed.close() }
  })
  it('replaces allocations through the protocol owner after installing a new login', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW
    const fetcher = vi.fn(async () => response(f.login(clock))) as unknown as typeof fetch
    class Peer {
      signalingState = 'stable'; restartIce = vi.fn(); setConfiguration = vi.fn()
      readonly allocationUsername: string
      constructor(configuration: RTCConfiguration) { this.allocationUsername = configuration.iceServers![0]!.username! }
      close() { this.signalingState = 'closed' }
    }
    let peer: Peer
    const rebuildPeers = vi.fn(() => { peer.close(); peer = managed.factory() as unknown as Peer; return true })
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => clock, PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers })
    try {
      peer = managed.factory() as unknown as Peer
      const first = peer
      clock += 240; await vi.advanceTimersByTimeAsync(240000)
      expect(rebuildPeers).toHaveBeenCalledTimes(1)
      expect(first.signalingState).toBe('closed')
      expect(peer!.allocationUsername).not.toBe(first.allocationUsername)
      expect(first.restartIce).not.toHaveBeenCalled(); expect(first.setConfiguration).not.toHaveBeenCalled()
      const second = peer!
      await managed.reconnect()
      expect(rebuildPeers).toHaveBeenCalledTimes(2)
      expect(second.signalingState).toBe('closed'); expect(peer!).not.toBe(second)
      managed.close(); await managed.reconnect(); expect(rebuildPeers).toHaveBeenCalledTimes(2)
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
    const rebuildPeers = vi.fn(() => true)
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => clock, allowed: () => allowed, rebuildPeers,
      PeerConnection: Peer as unknown as typeof RTCPeerConnection })
    try {
      const peer = managed.factory() as unknown as Peer
      clock += 240; await vi.advanceTimersByTimeAsync(240000); expect(calls).toBe(2)
      allowed = false; release(response(f.login(clock))); await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(peer.signalingState).toBe('closed')); expect(peer.restartIce).not.toHaveBeenCalled()
      expect(rebuildPeers).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300000); expect(calls).toBe(2)
    } finally { managed.close() }
  })
  it('keeps an admitted call through a temporary server failure and retries credential renewal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, issued = 0
    const fetcher = vi.fn(async () => ++issued === 2
      ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }) : response(f.login(clock))) as unknown as typeof fetch
    class Peer { signalingState = 'stable'; restartIce = vi.fn(); setConfiguration = vi.fn(); close() { this.signalingState = 'closed' } }
    const unavailable = vi.fn()
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => clock,
      PeerConnection: Peer as unknown as typeof RTCPeerConnection, onUnavailable: unavailable })
    try {
      const peer = managed.factory() as unknown as Peer
      clock += 240; await vi.advanceTimersByTimeAsync(240000)
      expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unavailable', status: 503 }))
      expect(peer.signalingState).toBe('stable')
      clock += 5; await vi.advanceTimersByTimeAsync(5000)
      expect(issued).toBe(3); expect(peer.restartIce).toHaveBeenCalledTimes(1)
    } finally { managed.close() }
  })
  it('restarts retained relay peers after a network change even when the node returns the same login', async () => {
    const f = fixture(), fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch
    class Peer { signalingState = 'stable'; restartIce = vi.fn(); setConfiguration = vi.fn(); close() { this.signalingState = 'closed' } }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Peer as unknown as typeof RTCPeerConnection })
    try {
      const peer = managed.factory() as unknown as Peer
      await Promise.all([managed.reconnect(), managed.reconnect()])
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(peer.restartIce).toHaveBeenCalledTimes(1)
      expect(peer.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceTransportPolicy: 'relay' }))
      managed.close(); await managed.reconnect()
      expect(fetcher).toHaveBeenCalledTimes(2); expect(peer.signalingState).toBe('closed')
    } finally { managed.close() }
  })
  it('registers each native peer with its remote context while keeping the node factory pinned', async () => {
    const f = fixture(), onPeer = vi.fn(), fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch
    class Peer { signalingState = 'stable'; constructor(public configuration: RTCConfiguration) {} close() { this.signalingState = 'closed' } }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Peer as unknown as typeof RTCPeerConnection, onPeer })
    try {
      const context = { tier: 'turn' as const, remoteDevice: 'ab'.repeat(32) }
      const peer = managed.factory(context)
      expect(onPeer).toHaveBeenCalledExactlyOnceWith(peer, context)
      expect(() => assertNodeCallFactory(managed.factory, f.node, f.identity.pubkey)).not.toThrow()
      expect((peer as unknown as Peer).configuration.iceTransportPolicy).toBe('relay')
    } finally { managed.close() }
  })
  it.each(['legacy', 'slots'] as const)('defers the %s native restart until fresh node credentials arrive', async profile => {
    for (const rebuild of [false, true]) {
      const f = fixture(), connections: Connection[] = [], restartLogins: string[] = []
      let calls = 0, release!: (value: Response) => void
      const fetcher = vi.fn(async () => ++calls === 1 ? response(f.login()) : new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
      class Connection extends FakeRTCPeerConnection {
        readonly events = new EventTarget()
        constructor(public configuration: RTCConfiguration) { super(); connections.push(this) }
        addEventListener(type: string, listener: EventListener) { this.events.addEventListener(type, listener) }
        setConfiguration(value: RTCConfiguration) { this.configuration = value }
        override restartIce() { restartLogins.push(this.configuration.iceServers![0]!.username!); super.restartIce() }
        override setConnectionState(state: RTCPeerConnectionState) {
          this.connectionState = state
          this.events.dispatchEvent(new globalThis.Event('connectionstatechange'))
          this.onconnectionstatechange?.()
        }
        override close() { this.signalingState = 'closed'; super.close() }
      }
      let subject: Peer | SlotPeer
      const owner = vi.fn(() => { if (rebuild) subject.close(); return rebuild })
      const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
        { fetcher, now: () => NOW, PeerConnection: Connection as unknown as typeof RTCPeerConnection, rebuildPeers: owner })
      const options = { factory: managed.factory, localDevice: f.identity.pubkey, remoteDevice: 'ab'.repeat(32),
        context: { tier: 'turn' as const, remoteDevice: 'ab'.repeat(32) }, onSignal: () => {}, onTrack: () => {} }
      subject = profile === 'slots' ? new SlotPeer(options) : new Peer(options)
      try {
        await subject.start([fakeTrack('audio')])
        const connection = connections[0]!
        connection.setConnectionState('connected')
        // Both listeners run as in a browser: the node starts an asynchronous
        // refresh, then the generic peer sees failure on that same connection.
        connection.setConnectionState('failed')
        await vi.waitFor(() => expect(calls).toBe(2))
        expect(restartLogins, 'the generic restart used the old login while its replacement was pending').toEqual([])
        release(response(f.login(NOW, '02'.repeat(12))))
        await vi.waitFor(() => expect(owner).toHaveBeenCalledTimes(1))
        if (rebuild) expect(restartLogins).toEqual([])
        else await vi.waitFor(() => expect(restartLogins).toEqual([f.login(NOW, '02'.repeat(12)).username]))
        expect(calls).toBe(2)
      } finally { subject.close(); managed.close() }
    }
  })

  it('sends a fixed-slot restart offer when TURN gathering falls back before a connection failure', async () => {
    vi.useFakeTimers()
    const f = fixture(); let connection!: Connection, calls = 0
    const fetcher = vi.fn(async () => response(f.login(NOW, String(++calls).padStart(24, '0')))) as unknown as typeof fetch
    class Connection extends FakeRTCPeerConnection {
      readonly events = new EventTarget()
      iceGatheringState: RTCIceGatheringState = 'new'
      constructor(public configuration: RTCConfiguration) { super(); connection = this }
      addEventListener(type: string, listener: EventListener) { this.events.addEventListener(type, listener) }
      setConfiguration(value: RTCConfiguration) { this.configuration = value }
      override close() { this.signalingState = 'closed'; super.close() }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Connection as unknown as typeof RTCPeerConnection })
    const subject = new SlotPeer({ factory: managed.factory, localDevice: f.identity.pubkey, remoteDevice: 'ab'.repeat(32),
      context: { tier: 'turn', remoteDevice: 'ab'.repeat(32) }, onSignal: () => {}, onTrack: () => {} })
    try {
      await subject.start([fakeTrack('audio')])
      const offer = vi.spyOn(connection, 'createOffer')
      connection.iceGatheringState = 'complete'
      connection.events.dispatchEvent(new globalThis.Event('icegatheringstatechange'))
      await vi.advanceTimersByTimeAsync(4000)
      await vi.waitFor(() => expect(calls).toBe(2))
      await vi.waitFor(() => expect(offer).toHaveBeenCalled())
      expect(connection.configuration.iceServers![0]!.urls).toEqual([f.node.turnUrls[3]])
    } finally { subject.close(); managed.close() }
  })

  it('gives only the failed participant a fresh login and keeps the original rotation deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW
    const fetcher = vi.fn(async () => response(f.login(clock))) as unknown as typeof fetch
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(); setConfiguration = vi.fn()
      constructor(readonly configuration: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const contexts = [{ tier: 'turn' as const, remoteDevice: 'ab'.repeat(32) }, { tier: 'turn' as const, remoteDevice: 'cd'.repeat(32) }]
    const live = new Map<string, Peer>()
    const rebuild = vi.fn((context?: PeerContext) => {
      for (const target of contexts) if (!context || context.remoteDevice === target.remoteDevice) {
        live.get(target.remoteDevice)?.close()
        live.set(target.remoteDevice, managed.factory(target) as unknown as Peer)
      }
      return true
    })
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => clock, PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild })
    try {
      for (const context of contexts) { const peer = managed.factory(context) as unknown as Peer; live.set(context.remoteDevice, peer); peer.state('connected') }
      const failed = live.get(contexts[0]!.remoteDevice)!, healthy = live.get(contexts[1]!.remoteDevice)!
      clock += 100; await vi.advanceTimersByTimeAsync(100000)
      failed.state('disconnected'); await vi.advanceTimersByTimeAsync(0)
      expect(rebuild).toHaveBeenCalledExactlyOnceWith(contexts[0])
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(failed.signalingState).toBe('closed'); expect(healthy.signalingState).toBe('stable')
      expect(live.get(contexts[1]!.remoteDevice)).toBe(healthy)
      expect(live.get(contexts[0]!.remoteDevice)?.configuration.iceServers?.[0]?.username).not.toBe(failed.configuration.iceServers?.[0]?.username)
      clock += 140; await vi.advanceTimersByTimeAsync(140000)
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(rebuild).toHaveBeenLastCalledWith()
      expect(healthy.signalingState).toBe('closed')
      // A login close to expiry needs a global rotation, even when only one
      // participant reported failure. No allocation may outlive its login.
      const nearExpiry = live.get(contexts[0]!.remoteDevice)!
      nearExpiry.state('connected'); clock += 241
      nearExpiry.state('disconnected'); await vi.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(4)
      expect(rebuild).toHaveBeenLastCalledWith()
    } finally { managed.close() }
  })
  it('retries a single-pair refresh without restarting healthy peers or extending their original expiry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, ticks = 0, calls = 0
    const fetcher = vi.fn(async () => {
      calls++
      if (calls === 2) return new Response('{}', { status: 503 })
      if (calls >= 4) return new Promise<Response>(() => {})
      return response(f.login(clock))
    }) as unknown as typeof fetch
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(); setConfiguration = vi.fn()
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const context = { tier: 'turn' as const, remoteDevice: 'ab'.repeat(32) }, rebuild = vi.fn(() => true)
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => clock, monotonic: () => ticks, PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild })
    try {
      const failed = managed.factory(context) as unknown as Peer, healthy = managed.factory({ tier: 'turn', remoteDevice: 'cd'.repeat(32) }) as unknown as Peer
      failed.state('connected'); healthy.state('connected')
      clock += 100; ticks = 100000; await vi.advanceTimersByTimeAsync(100000)
      failed.state('disconnected'); await vi.advanceTimersByTimeAsync(0); expect(rebuild).not.toHaveBeenCalled()
      clock += 5; ticks = 105000; await vi.advanceTimersByTimeAsync(5000)
      expect(rebuild).toHaveBeenCalledExactlyOnceWith(context); expect(healthy.signalingState).toBe('stable')
      clock += 135; ticks = 240000; await vi.advanceTimersByTimeAsync(135000); expect(calls).toBe(4)
      clock += 60; ticks = 300000; await vi.advanceTimersByTimeAsync(60000)
      expect(healthy.signalingState).toBe('closed'); expect(failed.signalingState).toBe('closed')
      expect(rebuild).toHaveBeenCalledTimes(1)
    } finally { managed.close() }
  })
  it('ignores recovery from retired media while still closing it immediately on withdrawal', async () => {
    const f = fixture(); let allowed = true
    const fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch, rebuild = vi.fn(() => true)
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => NOW, allowed: () => allowed,
      PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild })
    try {
      const retired = managed.factory(), current = managed.factory()
      const old = retired as unknown as Peer, next = current as unknown as Peer
      old.state('connected'); next.state('connected')
      managed.factory.onRetiring!(retired)
      old.state('disconnected'); old.state('failed')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(1); expect(rebuild).not.toHaveBeenCalled()
      expect(old.signalingState).toBe('stable')
      allowed = false; await managed.reconnect()
      expect(old.signalingState).toBe('closed'); expect(next.signalingState).toBe('closed')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { managed.close() }
  })

  it('shares one refresh between two failed participants while a third stays connected', async () => {
    const f = fixture(); let calls = 0, release!: (value: Response) => void
    const fetcher = vi.fn(async () => ++calls === 1 ? response(f.login()) : new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(); setConfiguration = vi.fn()
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const contexts = ['ab', 'cd', 'ef'].map(value => ({ tier: 'turn' as const, remoteDevice: value.repeat(32) })), rebuild = vi.fn(() => true)
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild })
    try {
      const peers = contexts.map(context => managed.factory(context) as unknown as Peer)
      for (const peer of peers) peer.state('connected')
      peers[0]!.state('disconnected'); peers[1]!.state('disconnected')
      await vi.waitFor(() => expect(calls).toBe(2)); release(response(f.login()))
      await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2))
      expect(rebuild).toHaveBeenNthCalledWith(1, contexts[0]); expect(rebuild).toHaveBeenNthCalledWith(2, contexts[1])
      expect(peers[2]!.signalingState).toBe('stable'); expect(peers[2]!.restartIce).not.toHaveBeenCalled(); expect(calls).toBe(2)
    } finally { managed.close() }
  })
  it('carries a peer failure into an in-flight scheduled renewal even when the login is unchanged', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000)
    const f = fixture(); let clock = NOW, calls = 0, release!: (value: Response) => void
    const fetcher = vi.fn(async () => ++calls === 1 ? response(f.login()) : new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(); setConfiguration = vi.fn()
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const rebuild = vi.fn(() => true), recovering = vi.fn()
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => clock, PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild, onRecovering: recovering })
    try {
      const peer = managed.factory({ tier: 'turn', remoteDevice: 'ab'.repeat(32) }) as unknown as Peer
      peer.state('connected'); clock += 240; await vi.advanceTimersByTimeAsync(240000)
      peer.state('disconnected'); release(response(f.login())); await vi.advanceTimersByTimeAsync(0)
      expect(recovering).toHaveBeenCalledTimes(1)
      expect(rebuild).toHaveBeenCalledExactlyOnceWith()
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally { managed.close() }
  })
  it('cannot rebuild a failed pair after its recovery observer withdraws access', async () => {
    const f = fixture(); let allowed = true
    const fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch, rebuild = vi.fn(() => true)
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(); setConfiguration = vi.fn()
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access, { fetcher, now: () => NOW, allowed: () => allowed,
      PeerConnection: Peer as unknown as typeof RTCPeerConnection, rebuildPeers: rebuild, onRecovering: () => { allowed = false } })
    try {
      const peer = managed.factory({ tier: 'turn', remoteDevice: 'ab'.repeat(32) }) as unknown as Peer
      peer.state('connected'); peer.state('disconnected')
      expect(peer.signalingState).toBe('closed'); expect(rebuild).not.toHaveBeenCalled(); expect(peer.restartIce).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(1); expect(() => managed.factory()).toThrow()
    } finally { managed.close() }
  })
  it('does not restart another peer for a peer which never connected and recovers each established failure only once', async () => {
    const f = fixture(), fetcher = vi.fn(async () => response(f.login())) as unknown as typeof fetch
    const order: string[] = [], recovering = vi.fn(() => { order.push('signalling') })
    class Peer extends EventTarget {
      signalingState = 'stable'; connectionState = 'new'; restartIce = vi.fn(() => { order.push('ice') }); setConfiguration = vi.fn()
      constructor(_: RTCConfiguration) { super() }
      state(value: string) { this.connectionState = value; this.dispatchEvent(new globalThis.Event('connectionstatechange')) }
      close() { this.signalingState = 'closed' }
    }
    const managed = await nodeCallFactory(f.node, f.identity, async () => f.access,
      { fetcher, now: () => NOW, PeerConnection: Peer as unknown as typeof RTCPeerConnection, onRecovering: recovering })
    try {
      const healthy = managed.factory() as unknown as Peer, other = managed.factory() as unknown as Peer
      healthy.state('connected'); other.state('failed'); await new Promise(resolve => setTimeout(resolve, 0))
      expect(fetcher).toHaveBeenCalledTimes(1); expect(healthy.restartIce).not.toHaveBeenCalled()
      expect(recovering).not.toHaveBeenCalled()
      healthy.state('disconnected'); await vi.waitFor(() => expect(healthy.restartIce).toHaveBeenCalledTimes(1))
      expect(order[0]).toBe('signalling'); expect(order.slice(1)).toEqual(['ice'])
      expect(other.restartIce).not.toHaveBeenCalled()
      healthy.state('failed'); await new Promise(resolve => setTimeout(resolve, 0)); expect(fetcher).toHaveBeenCalledTimes(2)
      expect(recovering).toHaveBeenCalledTimes(1)
      healthy.state('connected'); healthy.state('disconnected'); await vi.waitFor(() => expect(healthy.restartIce).toHaveBeenCalledTimes(2))
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(recovering).toHaveBeenCalledTimes(2)
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
