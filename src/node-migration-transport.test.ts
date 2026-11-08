import { expect, it } from 'vitest'
import { WebSocket as Socket, WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom } from '@forgesworn/fold-kit/node-room'
import { localIdentity } from './identity.js'
import { nodeRoomTransport } from './kithmoot-node.js'
import { nodeMigrationHistoryTarget, copyNodeMigrationHistory } from './node-migration-history.js'
import { verifyEventUncached } from './verify.js'

it('copies unchanged history through the authenticated existing-room connection and keeps strict expiry checks', async () => {
  const now = 1_900_000_000, authoritySk = generateSecretKey(), deviceSk = generateSecretKey()
  const identity = localIdentity(deviceSk), room = '09'.repeat(32), serviceKey = getPublicKey(generateSecretKey())
  const make = (existing = false) => readNodeRoom(signNodeRoom({ authoritySk, room, serviceKey, origin: 'https://node.example', now,
    ...(existing ? { existing: { destruct: false } } : {}) }), now)!
  const node = make(true), server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const history = new Map<string, Event>(), authentication: Event[] = []
  server.on('connection', socket => {
    let allowed = false
    socket.send(JSON.stringify(['AUTH', 'migration-history-fixture']))
    socket.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame[0] === 'AUTH') {
        const event = frame[1] as Event
        allowed = verifyEventUncached(event) && event.pubkey === identity.pubkey && JSON.stringify(event.tags) === JSON.stringify([
          ['relay', node.relay], ['challenge', 'migration-history-fixture'], ['room', room], ['mode', 'room'],
        ])
        authentication.push(event); socket.send(JSON.stringify(['OK', event.id, allowed, '']))
      } else if (allowed && frame[0] === 'EVENT') {
        const event = frame[1] as Event; history.set(event.id, event)
        socket.send(JSON.stringify(['OK', event.id, true, '']))
      } else if (allowed && frame[0] === 'REQ') {
        for (const event of history.values()) if (frame.slice(2).some((filter: { ids?: string[] }) => !filter.ids || filter.ids.includes(event.id))) {
          socket.send(JSON.stringify(['EVENT', frame[1], event]))
        }
        socket.send(JSON.stringify(['EOSE', frame[1]]))
      }
    })
  })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  class LocalSocket extends Socket { constructor(_: string) { super(`ws://127.0.0.1:${port}`) } }
  const options = { now: () => now, websocketImplementation: LocalSocket as unknown as typeof WebSocket }
  const transport = nodeRoomTransport(node, identity, 'room', options)
  const strict = nodeRoomTransport(make(), identity, 'room', options)
  const ask = nodeRoomTransport(node, localIdentity(authoritySk), 'ask', options)
  const event = finalizeEvent({ kind: 1460, created_at: now - 100, tags: [], content: 'original encrypted history' }, generateSecretKey())
  try {
    const proof = await copyNodeMigrationHistory({ snapshots: [{ complete: true, entries: [{ event }] }],
      target: nodeMigrationHistoryTarget(node, identity.pubkey, transport), accept: () => true, now: () => now, current: () => true })
    expect(proof.events).toBe(1); expect(history.get(event.id)).toEqual(JSON.parse(JSON.stringify(event)))
    expect(authentication).toHaveLength(1)
    await expect(strict.publish(event)).rejects.toThrow()
    await expect(ask.publish(event)).rejects.toThrow()
    const duplicate = finalizeEvent({ kind: 1460, created_at: now, content: 'bad', tags: [['expiration', String(now + 100)], ['expiration', String(now + 100)]] }, deviceSk)
    await expect(transport.publish(duplicate)).rejects.toThrow()
    expect(() => nodeMigrationHistoryTarget(node, identity.pubkey, strict)).toThrow('pinned')
  } finally {
    transport.close(); strict.close(); ask.close()
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 20_000)
