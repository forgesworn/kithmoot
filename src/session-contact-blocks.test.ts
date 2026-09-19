import { expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
const now = () => 1800000000
const secret = new Uint8Array(32).fill(32)
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
it('applies a new block to an open media peer, main chat and side-channel ingress and display', async () => {
  const relay = new SimRelay(), factory = createFakeFactory(), blocked = new Set<string>()
  const alice = new RoomSession({ transport: new SimTransport(relay), secret, identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(), now, announceJitterMs: 0, factory, isBlocked: key => blocked.has(key) })
  const bob = new RoomSession({ transport: new SimTransport(relay), secret, identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(), now, announceJitterMs: 0, factory: createFakeFactory() })
  try {
    await alice.join([], {}); await bob.join([], {}); await settle()
    expect(alice.participants().some(person => person.participant === bob.participant)).toBe(true)
    expect(factory.instances.some(peer => !peer.closed)).toBe(true)
    const side = alice.channel('signet-checks-v1'), changes = vi.fn()
    side.onChange(changes)
    await bob.chat.send('before block'); await bob.channel('signet-checks-v1').send('before side'); await settle()
    expect(alice.chat.messages()).toHaveLength(1); expect(side.messages()).toHaveLength(1)
    blocked.add(bob.participant); alice.refreshContactPolicy(); await settle()
    expect(alice.participants().map(person => person.participant)).toEqual([alice.participant])
    expect(factory.instances.every(peer => peer.closed)).toBe(true)
    expect(alice.chat.messages()).toEqual([]); expect(side.messages()).toEqual([])
    expect(changes.mock.lastCall?.[0]).toEqual([])
    await bob.chat.send('blocked ingress'); await bob.channel('signet-checks-v1').send('blocked side'); await settle()
    expect(alice.chat.messages()).toEqual([]); expect(side.messages()).toEqual([])
    blocked.clear(); alice.refreshContactPolicy()
    expect(alice.chat.messages().map(message => message.text)).toEqual(['before block'])
    expect(side.messages().map(message => message.text)).toEqual(['before side'])
  } finally { await alice.leave(); await bob.leave(); relay.close() }
})
it('fails closed on a broken policy callback without hiding the local participant', async () => {
  const relay = new SimRelay()
  const alice = new RoomSession({ transport: new SimTransport(relay), secret, identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(), now, announceJitterMs: 0, isBlocked: () => { throw new Error('cache unreadable') } })
  const bob = new RoomSession({ transport: new SimTransport(relay), secret, identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(), now, announceJitterMs: 0 })
  try {
    await alice.join([], {}); await bob.join([], {}); await settle()
    await bob.chat.send('cannot trust a failed cache'); await settle()
    expect(alice.participants().map(person => person.participant)).toEqual([alice.participant])
    expect(alice.chat.messages()).toEqual([])
  } finally { await alice.leave(); await bob.leave(); relay.close() }
})
