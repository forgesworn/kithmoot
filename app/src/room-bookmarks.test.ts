import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import type { SignetSigner } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import { encodeJoinUrl, generateRoomSecret, deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { knownRooms, rememberRoom, type KnownRoom } from './rooms-store.js'
import { bytesToHex } from '@noble/hashes/utils'
import { RoomBookmarks, accountRoomStore, type BookmarkAdmissions } from './room-bookmarks.js'

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

function harness(identity = signer(), store = memoryDeviceStore(), admissions?: BookmarkAdmissions) {
  const events: Event[] = []
  let incoming: ((event: Event) => void) | undefined
  let finished: (() => void) | undefined
  const relay: RelayTransport = {
    publish: vi.fn(async event => { events.push(event) }),
    subscribe: (_filters, callback, eose) => { incoming = callback; finished = eose; return () => { incoming = undefined; finished = undefined } },
    close: vi.fn(),
  }
  const status = vi.fn()
  const library = new RoomBookmarks(store, identity, relay, vi.fn(), status, admissions)
  library.start()
  return { library, store, events, relay, status, identity, incoming: (event: Event) => incoming?.(event), eose: () => finished?.() }
}

async function saved(h: ReturnType<typeof harness>, expected = 1) {
  await vi.waitFor(() => expect(h.events).toHaveLength(expected))
}

/** A device's kept group memberships, as the app keeps them: room id to secret. */
function kept(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial))
  const admissions: BookmarkAdmissions = {
    current: room => held.get(room.roomId),
    adopt: vi.fn((room, secret) => { if (!held.has(room.roomId)) held.set(room.roomId, secret) }),
  }
  return { held, admissions }
}

function roomWithSecret(name = 'Private chat') {
  const secret = generateRoomSecret()
  const r: KnownRoom = { roomId: deriveRoom(secret).roomId, name,
    link: encodeJoinUrl('https://example.test/j/', secret, ['wss://relay.example']),
    openedAt: Math.floor(Date.now() / 1000), readAt: 0, keep: true }
  return { r, secret: bytesToHex(secret) }
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

  describe('group admission', () => {
    it('carries the room secret beside the room, encrypted, and opens it on a second device', async () => {
      const { r, secret } = roomWithSecret()
      const first = kept({ [r.roomId]: secret })
      const a = harness(signer(), memoryDeviceStore(), first.admissions)
      a.library.save(r)
      await saved(a)
      expect(JSON.stringify(a.events[0])).not.toContain(secret)
      const value = JSON.parse(await a.identity.nip44!.decrypt(a.identity.pubkey, a.events[0].content))
      expect(value.admission).toEqual({ secret })
      expect(value.room.admission).toBeUndefined()
      const second = kept()
      const b = harness(a.identity, memoryDeviceStore(), second.admissions)
      await b.library.receive(a.events[0])
      expect(second.held.get(r.roomId)).toBe(secret)
      a.library.close(); b.library.close()
    })

    it('does not replace a membership the device already keeps', async () => {
      const { r, secret } = roomWithSecret()
      const a = harness(signer(), memoryDeviceStore(), kept({ [r.roomId]: secret }).admissions)
      a.library.save(r)
      await saved(a)
      const own = kept({ [r.roomId]: 'a'.repeat(64) })
      const b = harness(a.identity, memoryDeviceStore(), own.admissions)
      await b.library.receive(a.events[0])
      expect(own.held.get(r.roomId)).toBe('a'.repeat(64))
      a.library.close(); b.library.close()
    })

    it('ignores a secret that is not the room\'s own, but still lists the room', async () => {
      const { r } = roomWithSecret()
      const wrong = bytesToHex(generateRoomSecret())
      const a = harness(signer(), memoryDeviceStore(), kept({ [r.roomId]: wrong }).admissions)
      a.library.save(r)
      await saved(a)
      const second = kept()
      const b = harness(a.identity, memoryDeviceStore(), second.admissions)
      await b.library.receive(a.events[0])
      expect(second.held.size).toBe(0)
      expect(knownRooms(b.library.rooms).map(x => x.name)).toEqual(['Private chat'])
      a.library.close(); b.library.close()
    })

    it('leaves a bookmark without a secret alone, and keeps a secret a save from a device without one would drop', async () => {
      const { r, secret } = roomWithSecret()
      const plain = harness(signer(), memoryDeviceStore(), kept().admissions)
      plain.library.save(r)
      await saved(plain)
      const nothing = kept()
      const b = harness(plain.identity, memoryDeviceStore(), nothing.admissions)
      await b.library.receive(plain.events[0])
      expect(nothing.admissions.adopt).not.toHaveBeenCalled()
      const a = harness(signer(), memoryDeviceStore(), kept({ [r.roomId]: secret }).admissions)
      a.library.save(r)
      await saved(a)
      // A device with no secret of its own renames the room: the record keeps the one it holds.
      const c = harness(a.identity, memoryDeviceStore(), kept().admissions)
      await c.library.receive(a.events[0])
      c.library.save({ ...r, name: 'Renamed' })
      await vi.waitFor(() => expect(c.events).toHaveLength(1))
      const value = JSON.parse(await c.identity.nip44!.decrypt(c.identity.pubkey, c.events[0].content))
      expect(value.room.name).toBe('Renamed')
      expect(value.admission).toEqual({ secret })
      plain.library.close(); a.library.close(); b.library.close(); c.library.close()
    })

    it('saves again when a room gains a secret it was bookmarked without', async () => {
      const { r, secret } = roomWithSecret()
      const mine = kept()
      const a = harness(signer(), memoryDeviceStore(), mine.admissions)
      a.library.save(r)
      await saved(a)
      mine.held.set(r.roomId, secret)
      a.library.save(r)
      await saved(a, 2)
      const value = JSON.parse(await a.identity.nip44!.decrypt(a.identity.pubkey, a.events[1].content))
      expect(value.admission).toEqual({ secret })
      a.library.close()
    })
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

  it('keeps a save confirmed while a relay armed before it finishes the lookup late', async () => {
    const a = harness()
    a.library.save(room())
    await vi.waitFor(() => expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('accepted by a relay')))
    // The lookup was armed at sign-in, before the save. A relay reconnecting
    // can answer it seconds later; it must not undo what the person just saw.
    a.eose()
    expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('accepted by a relay'))
    a.library.close()
  })

  it('still reports a lookup that finishes after a fresh retry with nothing pending', async () => {
    const a = harness()
    a.library.save(room())
    await vi.waitFor(() => expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('accepted by a relay')))
    await a.library.retry()
    a.eose()
    expect(a.status).toHaveBeenLastCalledWith(expect.stringContaining('Relay lookup finished'))
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

  it('asks the signer once for a bookmark however many relays deliver it', async () => {
    const sk = generateSecretKey()
    const a = harness(signer(sk))
    a.library.save(room())
    await saved(a)
    const s = signer(sk)
    const decrypt = vi.fn(s.nip44!.decrypt)
    const b = harness({ ...s, nip44: { ...s.nip44!, decrypt } })
    await Promise.all([0, 1, 2, 3].map(() => b.library.receive(a.events[0])))
    expect(decrypt).toHaveBeenCalledOnce()
    expect(knownRooms(b.library.rooms)).toHaveLength(1)
    a.library.close(); b.library.close()
  })

  it('decrypts many bookmarks a few at a time, each once', async () => {
    const sk = generateSecretKey()
    const a = harness(signer(sk))
    for (let i = 0; i < 8; i++) a.library.save(room(`Room ${i}`))
    await saved(a, 8)
    const s = signer(sk)
    let calls = 0, active = 0, peak = 0
    const decrypt = async (peer: string, ciphertext: string) => {
      calls++; peak = Math.max(peak, ++active)
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await s.nip44!.decrypt(peer, ciphertext) } finally { active-- }
    }
    const b = harness({ ...s, nip44: { ...s.nip44!, decrypt } })
    await Promise.all(a.events.flatMap(event => [0, 1, 2, 3].map(() => b.library.receive(event))))
    expect(calls).toBe(8)
    expect(peak).toBeLessThanOrEqual(3)
    expect(knownRooms(b.library.rooms)).toHaveLength(8)
    a.library.close(); b.library.close()
  })

  it('stops asking a signer that refuses, until the person retries', async () => {
    const sk = generateSecretKey()
    const a = harness(signer(sk))
    for (let i = 0; i < 8; i++) a.library.save(room(`Room ${i}`))
    await saved(a, 8)
    const s = signer(sk)
    const decrypt = vi.fn(async () => { throw new Error('rejected by signer policy') })
    const b = harness({ ...s, nip44: { ...s.nip44!, decrypt } })
    await Promise.all(a.events.map(event => b.library.receive(event)))
    // Bounded by the refusal limit plus what was already in flight, not one
    // request per bookmark per relay.
    const first = decrypt.mock.calls.length
    expect(first).toBeLessThan(8)
    expect(b.status).toHaveBeenCalledWith(expect.stringContaining('refused to decrypt'))
    await Promise.all(a.events.map(event => b.library.receive(event)))
    expect(decrypt.mock.calls.length).toBe(first)
    await b.library.retry()
    await Promise.all(a.events.map(event => b.library.receive(event)))
    expect(decrypt.mock.calls.length).toBeGreaterThan(first)
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
