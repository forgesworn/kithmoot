import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { WebSocket, WebSocketServer } from 'ws'
import { signNodeRoom, readNodeRoom, encodeNodeJoinRequest, decodeNodeJoinAnswer } from '@forgesworn/fold-kit/node-room'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { deriveRoom } from './room.js'
import { parseGroupEvent } from './group-grants.js'
import { beginNodeJoin, openNodeKeeperAdmissions, type NodeKeeperSnapshot } from './node-admission.js'
import type { RoomPolicy } from './types.js'

const NOW = 1_900_000_000
async function fixture(endsAt?: number, existing: boolean | ((keeper: string, guest: string) => RoomPolicy) = false) {
  const authoritySk = generateSecretKey(), roomSecret = generateSecretKey(), keeper = localIdentity(generateSecretKey()), guest = localIdentity(generateSecretKey())
  const policy = typeof existing === 'function' ? existing(keeper.pubkey, guest.pubkey) : undefined
  const node = readNodeRoom(signNodeRoom({ authoritySk, room: deriveRoom(roomSecret).roomId, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), now: NOW, ...(existing ? { existing: { destruct: false, ...(policy ? { policy } : {}) } } : {}), ...(endsAt === undefined ? {} : { endsAt }) }), NOW)!
  let saved: NodeKeeperSnapshot | undefined, failSave = false, failPost = false, clock = NOW
  const posts: Event[] = [], accepted = new Map<string, Event>(), onGrant = vi.fn(async () => {})
  const store = { load: async () => structuredClone(saved), save: vi.fn(async (value: NodeKeeperSnapshot) => { if (failSave) throw Error('disk'); saved = structuredClone(value) }) }
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const event = JSON.parse(String(init?.body)) as Event
    // The exact signed event must already have been atomically saved.
    if (!event.tags.some(t => t[0] === 'status' && t[1] === 'revoked')) expect(saved?.grants.some(r => r.event.id === event.id)).toBe(true)
    posts.push(event)
    const parsed = parseGroupEvent(event)
    if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture grant')
    const previous = accepted.get(parsed.parsed.grantId)
    if (previous && previous.id !== event.id && parsed.parsed.status === 'active') {
      const old = parseGroupEvent(previous)
      if (!old.ok || old.parsed.type !== 'grant') throw Error('fixture previous grant')
      if (parsed.parsed.expiration <= old.parsed.expiration) return new Response(JSON.stringify({ error: 'renewal-must-extend' }), { status: 409 })
    }
    accepted.set(parsed.parsed.grantId, event)
    if (failPost) throw Error('lost acknowledgement')
    return new Response(JSON.stringify({ accepted: true }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const options = { node, authoritySk, roomSecret, keeperParticipant: keeper.pubkey, epochHint: () => 3, store, fetcher, now: () => clock, onGrant }
  const ask = async (participant = guest, deviceSk = generateSecretKey()) => {
    const credential = await createDeviceCredential({ identity: participant, devicePubkey: getPublicKey(deviceSk), roomId: node.room, now: () => clock, expiresAt: clock + 86400 })
    return { ...encodeNodeJoinRequest({ node, deviceSk, credential, now: clock }), deviceSk, credential }
  }
  return { options, node, guest, keeper, roomSecret, store, posts, fetcher, onGrant, ask,
    saved: () => structuredClone(saved), failSave: () => { failSave = true }, failPost: (value: boolean) => { failPost = value }, advance: (seconds: number) => { clock += seconds } }
}
describe('keeper node admission journal', () => {
  it('takes a guest through the pinned ask door over real WebSockets without a bearer welcome', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options), request = await f.ask()
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }), urls: string[] = [], failures: unknown[] = []
    let asked = 0
    server.on('connection', socket => {
      let authenticated = false, subscription = ''
      socket.send(JSON.stringify(['AUTH', 'ask-fixture']))
      socket.on('message', bytes => { void (async () => {
        const frame = JSON.parse(bytes.toString())
        if (frame[0] === 'AUTH') {
          const event = frame[1] as Event
          authenticated = event.pubkey === getPublicKey(request.deviceSk) && JSON.stringify(event.tags) === JSON.stringify([
            ['relay', f.node.relay], ['challenge', 'ask-fixture'], ['room', f.node.room], ['mode', 'ask'],
          ])
          socket.send(JSON.stringify(['OK', event.id, authenticated, '']))
        } else if (frame[0] === 'REQ' && authenticated) {
          subscription = frame[1]; socket.send(JSON.stringify(['EOSE', subscription]))
        } else if (frame[0] === 'EVENT' && authenticated) {
          asked++; expect(frame[1].kind).toBe(1059)
          expect(keeper.inspect(frame[1])?.known).toBe(false)
          socket.send(JSON.stringify(['OK', frame[1].id, true, '']))
          const answer = await keeper.admit(frame[1], true)
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['EVENT', subscription, answer]))
        }
      })().catch(error => failures.push(error)) })
    })
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    class Socket extends WebSocket { constructor(url: string) { urls.push(url); super(`ws://127.0.0.1:${port}`) } }
    const join = beginNodeJoin({ node: f.node, deviceSk: request.deviceSk, credential: request.credential, now: () => NOW,
      websocketImplementation: Socket as unknown as typeof globalThis.WebSocket })
    try {
      const result = await join.result
      expect(result && result !== 'denied' && result.secret).toEqual(f.roomSecret)
      expect(asked).toBe(1); expect(new Set(urls)).toEqual(new Set([f.node.relay])); expect(failures).toEqual([])
      expect(f.posts).toHaveLength(1)
    } finally {
      join.cancel(); keeper.close(); for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('requires explicit admission for an unknown person and answers with the grant only after the desk acknowledges it', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options), request = await f.ask()
    try {
      expect(keeper.inspect(request.event)?.known).toBe(false)
      await expect(keeper.admit(request.event)).rejects.toMatchObject({ reason: 'refused' }); expect(f.posts).toHaveLength(0)
      const answer = await keeper.admit(request.event, true)
      const admission = decodeNodeJoinAnswer({ node: f.node, deviceSk: request.deviceSk, event: answer, requestId: request.requestId, requestExpiresAt: request.expiresAt, now: NOW })
      expect(admission && admission !== 'denied' && admission.secret).toEqual(f.roomSecret)
      expect(admission && admission !== 'denied' && admission.epochHint).toBe(3)
      expect(f.posts).toHaveLength(1); expect(f.onGrant).toHaveBeenCalledTimes(1)
      expect(f.saved()?.grants[0]?.posted).toBe(true)
      expect(keeper.inspect(request.event)?.known).toBe(true)
    } finally { keeper.close() }
  })
  it('recovers an interrupted admission with the same committed grant id after restart', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options), request = await f.ask()
    f.failPost(true)
    await expect(keeper.admit(request.event, true)).rejects.toMatchObject({ reason: 'unavailable' })
    const committed = f.saved()!.grants[0]!.event
    expect(f.saved()?.grants[0]?.posted).toBe(false); expect(f.onGrant).not.toHaveBeenCalled(); keeper.close(); f.failPost(false)
    const restored = await openNodeKeeperAdmissions(f.options)
    try {
      const answer = await restored.admit(request.event)
      expect(decodeNodeJoinAnswer({ node: f.node, deviceSk: request.deviceSk, event: answer, requestId: request.requestId, requestExpiresAt: request.expiresAt, now: NOW })).toBeTruthy()
      expect(f.saved()?.grants).toHaveLength(1); expect(f.posts.map(e => e.id)).toEqual([committed.id, committed.id])
    } finally { restored.close() }
  })
  it('admits at most five devices for a known participant and never readmits a removed person', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options)
    try {
      for (let index = 0; index < 5; index++) await keeper.admit((await f.ask()).event, index === 0 ? true : undefined)
      const sixth = await f.ask()
      await expect(keeper.admit(sixth.event)).rejects.toMatchObject({ reason: 'refused' })
      await keeper.remove(f.guest.pubkey)
      expect(f.posts.filter(e => e.tags.some(t => t[0] === 'status' && t[1] === 'revoked'))).toHaveLength(5)
      expect(keeper.inspect(sixth.event)).toBeNull()
      await expect(keeper.admit(sixth.event, true)).rejects.toMatchObject({ reason: 'refused' })
    } finally { keeper.close() }
    const restored = await openNodeKeeperAdmissions(f.options)
    try { expect(restored.inspect((await f.ask()).event)).toBeNull() } finally { restored.close() }
  })
  it('sends no active grant when storage fails, but still posts all revocations when removal storage fails', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options), request = await f.ask()
    await keeper.admit(request.event, true); f.failSave()
    await expect(keeper.remove(f.guest.pubkey)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.posts).toHaveLength(2); expect(f.posts[1]?.tags).toContainEqual(['status', 'revoked'])
    await expect(keeper.admit((await f.ask(f.keeper)).event, true)).rejects.toMatchObject({ reason: 'refused' }); keeper.close()
    const g = await fixture(), second = await openNodeKeeperAdmissions(g.options); g.failSave()
    try { await expect(second.admit((await g.ask()).event, true)).rejects.toMatchObject({ reason: 'unavailable' }); expect(g.posts).toHaveLength(0) } finally { second.close() }
  })
  it('renews within ten days using the same id and never sends a storage scope', async () => {
    const f = await fixture(), keeper = await openNodeKeeperAdmissions(f.options)
    try {
      await keeper.admit((await f.ask()).event, true); const first = f.saved()!.grants[0]!.event
      f.advance(21 * 86400); await keeper.renew()
      const renewed = f.saved()!.grants[0]!.event, a = parseGroupEvent(first), b = parseGroupEvent(renewed)
      if (!a.ok || a.parsed.type !== 'grant' || !b.ok || b.parsed.type !== 'grant') throw Error('fixture')
      expect(b.parsed.grantId).toBe(a.parsed.grantId); expect(b.parsed.expiration).toBe(NOW + 51 * 86400)
      expect(b.parsed.scopes).toEqual(['turn', 'relay-read', 'relay-write']); expect(b.parsed.bytes).toBeUndefined()
    } finally { keeper.close() }
  })
  it('readmits a returning device after restart with the exact grant capped by the room end', async () => {
    const f = await fixture(NOW + 3 * 3600), keeper = await openNodeKeeperAdmissions(f.options), request = await f.ask()
    await keeper.admit(request.event, true)
    const first = f.saved()!.grants[0]!.event
    keeper.close(); f.advance(60)
    const restored = await openNodeKeeperAdmissions(f.options)
    try {
      const returning = await f.ask(f.guest, request.deviceSk)
      const answer = await restored.admit(returning.event)
      const admission = decodeNodeJoinAnswer({ node: f.node, deviceSk: request.deviceSk, event: answer, requestId: returning.requestId, requestExpiresAt: returning.expiresAt, now: NOW + 60 })
      expect(admission && admission !== 'denied' && admission.grant).toEqual(first)
      expect(f.posts.map(event => event.id)).toEqual([first.id, first.id])
      expect(f.saved()!.grants[0]!.event).toEqual(first)
    } finally { restored.close() }
  })
  it('does not schedule a same-expiry renewal at the room end or operate after the room expires', async () => {
    const f = await fixture(NOW + 3 * 3600), keeper = await openNodeKeeperAdmissions(f.options)
    try {
      await keeper.admit((await f.ask()).event, true)
      const first = f.saved()!.grants[0]!.event
      f.advance(60); await keeper.renew()
      expect(f.posts).toEqual([first]); expect(f.saved()!.grants[0]!.event).toEqual(first)
      f.advance(3 * 3600)
      await expect(keeper.renew()).rejects.toMatchObject({ reason: 'refused' })
      expect(f.posts).toEqual([first])
    } finally { keeper.close() }
  })
  it('keeps a maximum-duration room grant at its signed end throughout the renewal window', async () => {
    const f = await fixture(NOW + 30 * 86400), keeper = await openNodeKeeperAdmissions(f.options)
    try {
      await keeper.admit((await f.ask()).event, true)
      const capped = f.saved()!.grants[0]!.event, parsed = parseGroupEvent(capped)
      expect(parsed.ok && parsed.parsed.type === 'grant' && parsed.parsed.expiration).toBe(NOW + 30 * 86400)
      f.advance(21 * 86400); await keeper.renew()
      f.advance(5 * 86400); await keeper.renew()
      expect(f.posts).toEqual([capped]); expect(f.saved()!.grants[0]!.event).toEqual(capped)
    } finally { keeper.close() }
  })
})

it('migrates only source-admitted devices and never treats a self-signed credential as membership', async () => {
  const f = await fixture(undefined, true), accepted = new Set<string>()
  const keeper = await openNodeKeeperAdmissions({ ...f.options, acceptsExistingDevice: device => accepted.has(device) })
  try {
    const request = await f.ask()
    await expect(keeper.authoriseExistingDevice(request.credential)).rejects.toMatchObject({ reason: 'refused' })
    accepted.add(getPublicKey(request.deviceSk))
    const grant = await keeper.authoriseExistingDevice(request.credential)
    expect(f.posts.some(e => e.id === grant.id)).toBe(true)
    const parsed = parseGroupEvent(grant)
    expect(parsed.ok && parsed.parsed.type === 'grant' && parsed.parsed.device).toBe(getPublicKey(request.deviceSk))
    accepted.clear()
    await expect(keeper.authoriseExistingDevice(request.credential)).rejects.toMatchObject({ reason: 'refused' })
  } finally { keeper.close() }
  const legacy = await fixture(), strict = await openNodeKeeperAdmissions({ ...legacy.options, acceptsExistingDevice: () => true })
  try { await expect(strict.authoriseExistingDevice((await legacy.ask()).credential)).rejects.toMatchObject({ reason: 'refused' }) }
  finally { strict.close() }
})

describe('members a moved room already has', () => {
  it('lets in a member a members-only room names without asking, and nobody it does not name', async () => {
    const f = await fixture(undefined, (keeper, guest) => ({ tier: 'open', members: [keeper, guest] }))
    const keeper = await openNodeKeeperAdmissions(f.options)
    try {
      const request = await f.ask()
      expect(keeper.inspect(request.event)?.known).toBe(true)
      const answer = await keeper.admit(request.event)
      expect(decodeNodeJoinAnswer({ node: f.node, deviceSk: request.deviceSk, event: answer, requestId: request.requestId, requestExpiresAt: request.expiresAt, now: NOW })).toBeTruthy()
      const stranger = await f.ask(localIdentity(generateSecretKey()))
      expect(keeper.inspect(stranger.event)).toBeNull()
      await expect(keeper.admit(stranger.event, true)).rejects.toMatchObject({ reason: 'refused' })
    } finally { keeper.close() }
  })

  it('keeps members learned from the room for a later keeper, and never learns a removed person', async () => {
    const f = await fixture(undefined, true), removed = localIdentity(generateSecretKey())
    const keeper = await openNodeKeeperAdmissions(f.options)
    try {
      const request = await f.ask()
      expect(keeper.inspect(request.event)?.known).toBe(false)
      await keeper.learnMembers([f.guest.pubkey, removed.pubkey])
      expect(keeper.inspect(request.event)?.known).toBe(true)
      await keeper.remove(removed.pubkey)
      await keeper.learnMembers([removed.pubkey, 'not a key'])
      expect(keeper.inspect((await f.ask(removed)).event)).toBeNull()
    } finally { keeper.close() }
    const later = await openNodeKeeperAdmissions(f.options)
    try {
      const request = await f.ask()
      expect(later.inspect(request.event)?.known).toBe(true)
      await later.admit(request.event)
      expect(f.saved()!.members).not.toContain('not a key')
    } finally { later.close() }
  })
})
