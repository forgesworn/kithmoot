import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom } from '@forgesworn/fold-kit/node-room'
import { nodeRoomTransport } from './kithmoot-node.js'
import { RoomSession } from './session.js'
import { deriveRoom } from './room.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { verifyEventUncached } from './verify.js'
import { encodeChatEvent } from './chat.js'

afterEach(() => vi.restoreAllMocks())
function fixture(now: () => number) {
  const secret = generateSecretKey(), authoritySk = generateSecretKey(), deviceSk = generateSecretKey()
  const node = readNodeRoom(signNodeRoom({ authoritySk, room: deriveRoom(secret).roomId,
    serviceKey: getPublicKey(generateSecretKey()), origin: 'https://node.example', now: now() }), now())!
  return { secret, authority: node.authority, node, deviceSk, identity: localIdentity(generateSecretKey()), name: 'Keeper', now, announceJitterMs: 0, epochSettleMs: 0 }
}
describe('node room sessions', () => {
  it('rejects an unrelated relay, device, call factory and peer assistance before joining', () => {
    const f = fixture(() => Math.floor(Date.now() / 1000)), transport = nodeRoomTransport(f.node, localIdentity(f.deviceSk), 'room')
    try {
      expect(() => new RoomSession({ ...f, transport: new SimTransport(new SimRelay()) })).toThrow('pinned')
      expect(() => new RoomSession({ ...f, transport, deviceSk: generateSecretKey() })).toThrow('pinned')
      expect(() => new RoomSession({ ...f, transport, factory: createFakeFactory() })).toThrow('relay-only')
      expect(() => new RoomSession({ ...f, transport, peerAssist: true })).toThrow('own call relay')
    } finally { transport.close() }
  })
  it('keeps a retained chat desk inside the sole authenticated relay and advances its expiry after 31 days', async () => {
    let clock = Math.floor(Date.now() / 1000)
    const f = fixture(() => clock), server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const events: Event[] = [], auths: Event[] = [], opened: string[] = []
    server.on('connection', socket => {
      const subscriptions = new Map<string, Filter[]>(), challenge = 'node-session-fixture'
      let authenticated = false
      socket.send(JSON.stringify(['AUTH', challenge]))
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes.toString())
        if (frame[0] === 'AUTH') {
          const event = frame[1] as Event; auths.push(event)
          authenticated = verifyEventUncached(event) && event.pubkey === getPublicKey(f.deviceSk) && JSON.stringify(event.tags) === JSON.stringify([
            ['relay', f.node.relay], ['challenge', challenge], ['room', f.node.room], ['mode', 'room'],
          ])
          socket.send(JSON.stringify(['OK', event.id, authenticated, '']))
        } else if (frame[0] === 'REQ' && authenticated) {
          subscriptions.set(frame[1], frame.slice(2)); socket.send(JSON.stringify(['EOSE', frame[1]]))
        } else if (frame[0] === 'EVENT' && authenticated) {
          const event = frame[1] as Event; events.push(event)
          for (const [id, filters] of subscriptions) if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]))
          socket.send(JSON.stringify(['OK', event.id, true, '']))
        } else if (frame[0] === 'CLOSE') subscriptions.delete(frame[1])
      })
    })
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    // Only the fixture maps the pinned production URL onto a loopback socket.
    class Socket extends WebSocket { constructor(url: string) { opened.push(url); super(`ws://127.0.0.1:${port}`) } }
    const transport = nodeRoomTransport(f.node, localIdentity(f.deviceSk), 'room', { now: () => clock, websocketImplementation: Socket as unknown as typeof globalThis.WebSocket })
    const session = new RoomSession({ ...f, transport })
    vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000)
    try {
      await session.join([], {})
      await session.chat.send('first')
      expect(events.length).toBeGreaterThan(0)
      const before = events.length
      clock += 31 * 86400
      await session.chat.send('later')
      expect(events.length).toBeGreaterThan(before)
      for (const event of events.slice(before)) {
        expect(verifyEventUncached(event)).toBe(true)
        expect(event.tags.filter(t => t[0] === 'expiration')).toEqual([['expiration', String(clock + 30 * 86400)]])
      }
      expect(new Set(opened)).toEqual(new Set([f.node.relay]))
      expect(auths.length).toBeGreaterThan(0)
      expect(session.spryRoster()).toEqual([])
      const attachment = { event: 'ac'.repeat(32), url: `https://blossom.example/${'ab'.repeat(32)}`, sha256: 'cd'.repeat(32),
        key: 'ef'.repeat(32), name: 'fixture.txt', type: 'text/plain', size: 100 }
      await expect(session.chat.send('file', { attachments: [attachment] })).rejects.toThrow('Files are not available')
      await expect(session.channel('notes').send('file', { attachments: [attachment] })).rejects.toThrow('Files are not available')
      const { roomKey } = deriveRoom(f.secret)
      const unsolicited = encodeChatEvent({ id: 'unsolicited', participant: f.identity.pubkey, device: session.device,
        credential: session.credentialFor(session.device)!, text: 'unsolicited share', sentAt: clock, attachments: [attachment] },
      { roomId: session.roomId, roomKey, deviceSk: f.deviceSk, expiresAt: clock + 30 * 86400 })
      roomKey.fill(0); await transport.publish(unsolicited)
      await vi.waitFor(() => expect(session.chat.messages().find(m => m.text === 'unsolicited share')).toBeDefined())
      expect(session.chat.messages().find(m => m.text === 'unsolicited share')?.attachments).toBeUndefined()
      await expect(session.setAssist(() => null)).rejects.toThrow('peer assistance')
      await expect(session.publishDescriptor({ forwarders: [], iceServers: [{ urls: ['stun:outside.example'] }] })).rejects.toThrow('own call relay')
    } finally {
      await session.leave(); transport.close()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
