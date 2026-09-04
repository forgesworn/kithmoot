import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import type { SignetSigner } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import { encodeJoinUrl, generateRoomSecret, deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { knownRooms, rememberRoom, type KnownRoom } from './rooms-store.js'
import { RoomBookmarks, accountRoomStore } from './room-bookmarks.js'

function signer(sk = generateSecretKey()): SignetSigner {
  const pubkey = getPublicKey(sk)
  return { pubkey, method: 'nip07', capabilities: { canSignEvents: true, hasNip44: true },
    signEvent: vi.fn(async template => finalizeEvent(template, sk)), close: async () => {},
    nip44: {
      encrypt: async (peer, plaintext) => encrypt(plaintext, getConversationKey(sk, peer)),
      decrypt: async (peer, ciphertext) => decrypt(ciphertext, getConversationKey(sk, peer)),
    },
  }
}

function room(name = 'Private room'): KnownRoom {
  const secret = generateRoomSecret()
  return { roomId: deriveRoom(secret).roomId, name,
    link: encodeJoinUrl('https://example.test/j/', secret, ['wss://relay.example']),
    openedAt: Math.floor(Date.now() / 1000), readAt: 123, keep: true }
}

function harness(identity = signer(), store = memoryDeviceStore()) {
  const events: Event[] = []
  let incoming: ((event: Event) => void) | undefined
  const relay: RelayTransport = {
    publish: vi.fn(async event => { events.push(event) }),
    subscribe: (_filters, callback) => { incoming = callback; return () => { incoming = undefined } },
    close: vi.fn(),
  }
  const status = vi.fn()
  const library = new RoomBookmarks(store, identity, relay, vi.fn(), status)
  library.start()
  return { library, store, events, relay, status, identity, incoming: (event: Event) => incoming?.(event) }
}

async function saved(h: ReturnType<typeof harness>, expected = 1) {
  await vi.waitFor(() => expect(h.events).toHaveLength(expected))
}

describe('private Nostr room bookmarks', () => {
  it('encrypts names, ids and links to self; does not sync device state', async () => {
    const h = harness()
    const r = room()
    h.library.save(r)
    await saved(h)
    const event = h.events[0]
    for (const privateValue of [r.name!, r.roomId, r.link]) expect(JSON.stringify(event)).not.toContain(privateValue)
    const value = JSON.parse(await h.identity.nip44!.decrypt(h.identity.pubkey, event.content))
    expect(value.room).toMatchObject({ name: r.name, link: r.link, readAt: 0 })
    expect(value.room.keep).toBeUndefined()
    expect(event.pubkey).toBe(h.identity.pubkey)
    h.library.close()
  })

  it('restores on an independent device and keeps visitor and other accounts separate', async () => {
    const a = harness()
    const b = harness(a.identity)
    const r = room()
    rememberRoom(b.store, room('Visitor history'))
    a.library.save(r)
    await saved(a)
    await b.library.receive(a.events[0])
    expect(knownRooms(b.library.rooms).map(r => r.name)).toEqual(['Private room'])
    expect(knownRooms(b.store).map(r => r.name)).toEqual(['Visitor history'])
    expect(knownRooms(accountRoomStore(b.store, signer().pubkey))).toEqual([])
    expect(b.events).toEqual([])
    a.library.close(); b.library.close()
  })

  it('merges different rooms saved concurrently without replacing either list', async () => {
    const a = harness()
    const b = harness(a.identity)
    a.library.save(room('First'))
    b.library.save(room('Second'))
    await saved(a); await saved(b)
    await a.library.receive(b.events[0]); await b.library.receive(a.events[0])
    expect(knownRooms(a.library.rooms).map(r => r.name).sort()).toEqual(['First', 'Second'])
    expect(knownRooms(b.library.rooms).map(r => r.name).sort()).toEqual(['First', 'Second'])
    a.library.close(); b.library.close()
  })

  it('removes across devices, survives replay and restores tombstones after reload', async () => {
    const a = harness()
    const r = room()
    a.library.save(r)
    await saved(a)
    a.library.remove(r.roomId)
    await saved(a, 2)
    expect(a.events[1].created_at).toBeGreaterThan(a.events[0].created_at)
    expect(a.events[1].tags).toEqual(a.events[0].tags)
    const b = harness(a.identity)
    await b.library.receive(a.events[1]); await b.library.receive(a.events[0])
    expect(knownRooms(b.library.rooms)).toEqual([])
    b.library.close()
    const reloaded = harness(a.identity, b.store)
    await reloaded.library.receive(a.events[0])
    expect(knownRooms(reloaded.library.rooms)).toEqual([])
    a.library.close(); reloaded.library.close()
  })

  it('resolves simultaneous same-room edits using the same winner a NIP-01 relay retains', async () => {
    const a = harness()
    const original = room('Original')
    a.library.save(original)
    await saved(a)
    const b = harness(a.identity)
    await b.library.receive(a.events[0])
    const clock = vi.spyOn(Date, 'now').mockReturnValue(a.events[0].created_at * 1000)
    try {
      a.library.save({ ...original, name: 'Edit A' })
      b.library.save({ ...original, name: 'Edit B' })
      await saved(a, 2); await saved(b)
      expect(a.events[1].created_at).toBe(b.events[0].created_at)
      await a.library.receive(b.events[0]); await b.library.receive(a.events[1])
      const winner = a.events[1].id < b.events[0].id ? 'Edit A' : 'Edit B'
      expect(knownRooms(a.library.rooms)[0].name).toBe(winner)
      expect(knownRooms(b.library.rooms)[0].name).toBe(winner)
    } finally { clock.mockRestore(); a.library.close(); b.library.close() }
  })

  it('refreshes lookup without claiming a write was accepted when there is nothing to retry', async () => {
    const a = harness()
    await a.library.retry()
    expect(a.events).toEqual([])
    expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('Looking for'))
    a.library.close()
  })

  it('retries the identical signed event after an ambiguous acknowledgement, even after reload', async () => {
    const a = harness()
    const attempted: Event[] = []
    vi.mocked(a.relay.publish).mockImplementation(async e => { attempted.push(e); throw new Error('lost ack') })
    a.library.save(room())
    await vi.waitFor(() => expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('not confirmed')))
    expect(knownRooms(a.library.rooms)).toHaveLength(1)
    a.library.close()
    const restored = harness(a.identity, a.store)
    await restored.library.retry()
    expect(JSON.stringify(restored.events[0])).toEqual(JSON.stringify(attempted[0]))
    expect(a.identity.signEvent).toHaveBeenCalledTimes(1)
    restored.library.close()
  })

  it('retains a denied signing request for an explicit retry', async () => {
    const a = harness()
    vi.mocked(a.identity.signEvent).mockRejectedValueOnce(new Error('denied'))
    a.library.save(room())
    await vi.waitFor(() => expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('not confirmed')))
    expect(a.events).toEqual([])
    await a.library.retry()
    expect(a.events).toHaveLength(1)
    a.library.close()
  })

  it('never publishes plaintext when the signer cannot encrypt', async () => {
    const identity = signer()
    delete identity.nip44
    const a = harness(identity)
    a.library.save(room())
    await a.library.retry()
    expect(a.events).toEqual([])
    expect(identity.signEvent).not.toHaveBeenCalled()
    expect(knownRooms(a.library.rooms)).toHaveLength(1)
    expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('browser only'))
    a.library.close()
  })

  it('rejects foreign signatures, tampered events and unreadable ciphertext', async () => {
    const a = harness()
    a.library.save(room())
    await saved(a)
    const b = harness(a.identity)
    await b.library.receive({ ...a.events[0], content: 'plaintext room' })
    const other = signer()
    await b.library.receive(await other.signEvent({ ...a.events[0] }))
    await b.library.receive(await a.identity.signEvent({ ...a.events[0], content: 'not ciphertext' }))
    expect(knownRooms(b.library.rooms)).toEqual([])
    a.library.close(); b.library.close()
  })

  it('stops pending encryption and incoming decryptions from crossing sign-out', async () => {
    const a = harness()
    let release!: (value: string) => void
    a.identity.nip44!.encrypt = () => new Promise(resolve => { release = resolve })
    a.library.save(room())
    a.library.close()
    release('ciphertext')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(a.events).toEqual([])
    expect(a.identity.signEvent).not.toHaveBeenCalled()
    expect(a.relay.close).toHaveBeenCalledOnce()
  })
})
