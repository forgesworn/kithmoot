import { expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import { createRoomInvitation } from '../../src/invitation.js'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { dmPolicy, localPeerCrypt } from '../../src/dm.js'
import { contactInvitationRumor, wrapContactInvitation, type ContactInvitationIdentity } from '../../src/contact-invitation.js'
import { memoryDeviceStore } from './device-store.js'
import { ContactInbox } from './contact-inbox.js'

const now = 1_800_000_000
function identity(): ContactInvitationIdentity {
  const key = generateSecretKey()
  return { pubkey: getPublicKey(key), ...localPeerCrypt(key), signEvent: async event => finalizeEvent(event, key) }
}
function room(a: string, b: string) {
  const { invitation } = createRoomInvitation(true), { roomId } = deriveRoom(generateRoomSecret())
  return { room: roomId, link: encodeRoomLink('https://kithmoot.example/j/', { invitation, relays: ['wss://relay.example'], iceUrls: [], policy: dmPolicy(a, b) }) }
}
function fixture(who = identity(), store = memoryDeviceStore()) {
  let current = true, allowed = true, blocked = false, reject = false, released = false
  let receive: Parameters<RelayTransport['subscribe']>[1] = () => {}
  const published: string[] = []
  const transport: RelayTransport = { publish: async () => {}, close: () => {}, subscribe: (_filters, fn) => { receive = fn; return () => { receive = () => {} } } }
  const inbox = new ContactInbox({ identity: who, store, transport, acquire: async () => () => { released = true },
    pool: () => ({ ...transport, publishGuarded: async (event, guard) => {
      if (!guard()) throw new Error('Not authorised')
      published.push(event.id)
      if (reject) throw new Error('Relay did not acknowledge')
    } }), current: () => current, allowed: () => allowed, blocked: () => blocked, changed: () => {}, now: () => now })
  return { inbox, who, store, published, receive: (event: Parameters<typeof receive>[0]) => receive(event),
    reject: (value: boolean) => { reject = value }, allowed: (value: boolean) => { allowed = value }, blocked: () => { blocked = true },
    stop: () => { current = false; inbox.close() }, released: () => released }
}

it('retains exact failed envelopes encrypted, restores them and only clears after acknowledgement', async () => {
  const f = fixture(), peer = identity(), r = room(f.who.pubkey, peer.pubkey)
  await f.inbox.open()
  await f.inbox.enqueue(peer.pubkey, r.room, r.link, ['wss://relay.example'], ['wss://relay.example'])
  const raw = f.store.get(f.inbox.key)!
  expect(raw).not.toContain(r.link)
  expect(raw).not.toContain(peer.pubkey)
  f.reject(true); await f.inbox.retry()
  expect(f.inbox.snapshot().pending).toHaveLength(2)
  const failedId = f.published[0]
  f.stop(); await vi.waitFor(() => expect(f.released()).toBe(true))
  const restored = fixture(f.who, f.store)
  await restored.inbox.open(); await restored.inbox.retry()
  expect(restored.published[0]).toBe(failedId)
  expect(restored.inbox.snapshot().pending).toEqual([])
  restored.stop()
})

it('receives and deduplicates an offline invitation without joining its room, and persists dismissal', async () => {
  const f = fixture(), sender = identity(), r = room(sender.pubkey, f.who.pubkey)
  const rumor = contactInvitationRumor(sender.pubkey, f.who.pubkey, r.room, r.link, now)
  const event = await wrapContactInvitation(rumor, sender, f.who.pubkey, now, () => true)
  await f.inbox.open(); f.receive(event); f.receive(event)
  await vi.waitFor(() => expect(f.inbox.snapshot().invitations).toHaveLength(1))
  expect(f.published).toEqual([])
  await f.inbox.dismiss(rumor.id)
  f.stop(); await vi.waitFor(() => expect(f.released()).toBe(true))
  const restored = fixture(f.who, f.store); await restored.inbox.open(); restored.receive(event)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(restored.inbox.snapshot().invitations).toEqual([])
  restored.stop()
})

it('holds pending invitations after grant withdrawal, and hides blocked senders', async () => {
  const f = fixture(), peer = identity(), r = room(f.who.pubkey, peer.pubkey)
  await f.inbox.open(); await f.inbox.enqueue(peer.pubkey, r.room, r.link, ['wss://relay.example'], ['wss://relay.example'])
  f.allowed(false); await f.inbox.retry()
  expect(f.published).toEqual([])
  expect(f.inbox.snapshot().pending).toHaveLength(2)
  f.blocked(); expect(f.inbox.snapshot().invitations).toEqual([])
  f.stop()
})

it('does not publish an invitation when its durable write fails', async () => {
  const store = memoryDeviceStore(), f = fixture(identity(), store), peer = identity(), r = room(f.who.pubkey, peer.pubkey)
  await f.inbox.open()
  store.set = () => { throw new Error('Disk full') }
  await expect(f.inbox.enqueue(peer.pubkey, r.room, r.link, ['wss://relay.example'], ['wss://relay.example'])).rejects.toThrow('Disk full')
  await f.inbox.retry(); expect(f.published).toEqual([])
  f.stop()
})

it('forgetting a conversation cancels pending writes and does not resurrect its invitation after restart', async () => {
  const f = fixture(), peer = identity(), r = room(f.who.pubkey, peer.pubkey)
  await f.inbox.open()
  await f.inbox.enqueue(peer.pubkey, r.room, r.link, ['wss://relay.example'], ['wss://relay.example'])
  await f.inbox.forgetRoom(r.room)
  await f.inbox.retry()
  expect(f.published).toEqual([])
  expect(f.inbox.snapshot().invitations).toEqual([])
  f.stop(); await vi.waitFor(() => expect(f.released()).toBe(true))
  const restored = fixture(f.who, f.store); await restored.inbox.open()
  expect(restored.inbox.snapshot().invitations).toEqual([])
  expect(restored.inbox.snapshot().pending).toEqual([])
  restored.stop()
})
