import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { hostRoomEpoch } from './epoch.js'
import type { RekeyNotice } from './epoch.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(21)

/** Lets scheduled re-announces, rekeys and epoch grants run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function member(relay: SimRelay, name: string, authority?: string, extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}) {
  const identity = localIdentity(generateSecretKey())
  const session = new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity,
    deviceSk: generateSecretKey(),
    name,
    now,
    announceJitterMs: 0,
    authority,
    epochSettleMs: 0,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
  return session
}

describe('room epochs', () => {
  it('a rekey removes one member: the other still reads the chat, the removed one cannot, and history stays', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const epochs: RekeyNotice[] = []
    const keeper = member(relay, 'Keeper', authority, { onEpoch: (n) => epochs.push(n) })
    const alice = member(relay, 'Alice', authority)
    const bob = member(relay, 'Bob', authority)
    await keeper.join([], {})
    await alice.join([], {})
    await bob.join([], {})
    await settle()
    expect(keeper.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Bob', 'Keeper'])

    await bob.chat.send('before')
    await settle()
    expect(alice.chat.messages().map((m) => m.text)).toEqual(['before'])

    const admin = getPublicKey(generateSecretKey())
    const notice = await keeper.rekey({ authoritySk, removed: [bob.participant], by: admin })
    await settle()
    expect(notice.epoch).toBe(1)
    expect(epochs.map((n) => n.epoch)).toEqual([1])
    expect(keeper.epoch).toBe(1)
    expect(alice.epoch).toBe(1)
    expect(bob.epoch).toBe(0)
    expect(keeper.removed.has(bob.participant)).toBe(true)
    expect(alice.removed.has(bob.participant)).toBe(true)
    // Bob is gone from everybody's roster at once, not on the timeout.
    expect(keeper.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Keeper'])
    expect(alice.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Keeper'])

    // After: Alice and the keeper talk; Bob reads none of it.
    await alice.chat.send('after')
    await keeper.chat.send('welcome to epoch 1')
    await settle()
    // Sorted: the clock is pinned, so every message lands in the same
    // second and the order is a tie broken on a random id.
    expect(alice.chat.messages().map((m) => m.text).sort()).toEqual(['after', 'before', 'welcome to epoch 1'])
    expect(keeper.chat.messages().map((m) => m.text).sort()).toEqual(['after', 'before', 'welcome to epoch 1'])
    expect(bob.chat.messages().map((m) => m.text)).toEqual(['before'])

    // And what Bob says under the old key reaches nobody who moved on.
    await bob.chat.send('anybody there?')
    await settle()
    expect(alice.chat.messages().map((m) => m.text).sort()).toEqual(['after', 'before', 'welcome to epoch 1'])
    // Nor does his roster entry: he cannot get back in by announcing.
    await bob.announce()
    await settle()
    expect(alice.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Keeper'])

    // The wire says only that the room moved: the room id, a number, the
    // authority's key.
    const rekey = relay.published.find((e) => e.kind === KINDS.ROOM_REKEY)!
    expect(rekey.pubkey).toBe(authority)
    expect(rekey.tags).toEqual([
      ['d', keeper.roomId],
      ['epoch', '1'],
    ])
    expect(rekey.content).not.toContain(bob.participant)
    expect(rekey.content).not.toContain(admin)
  })

  it('the removed member is told so, with who did it', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    let removed: { epoch: number; by?: string } | undefined
    const bob = member(relay, 'Bob', authority, { onRemoved: (n) => (removed = n) })
    await keeper.join([], {})
    await bob.join([], {})
    await settle()
    const admin = getPublicKey(generateSecretKey())
    await keeper.rekey({ authoritySk, removed: [bob.participant], by: admin })
    await settle()
    expect(removed).toEqual({ epoch: 1, by: admin })
  })

  it('every derived thing moves: the channels, the descriptor, the roster', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    const bob = member(relay, 'Bob', authority)
    await keeper.join([], {})
    await alice.join([], {})
    await bob.join([], {})
    await settle()
    // Open before anybody speaks; the simulator replays nothing.
    keeper.channel('agents')
    alice.channel('agents')
    bob.channel('agents')
    await keeper.rekey({ authoritySk, removed: [bob.participant] })
    await settle()
    await alice.channel('agents').send('psst')
    await keeper.publishDescriptor({ forwarders: [{ url: 'wss://fwd.example' }] })
    await settle()
    expect(keeper.channel('agents').messages().map((m) => m.text)).toEqual(['psst'])
    expect(bob.channel('agents').messages()).toEqual([])
    expect(alice.descriptor?.forwarders).toEqual([{ url: 'wss://fwd.example' }])
    expect(bob.descriptor).toBeUndefined()
    // Everything under the new epoch rides a different `d` than the room id.
    const { roomId } = deriveRoom(SECRET)
    const after = relay.published.filter((e) => e.created_at >= NOW && (e.kind === KINDS.CHAT || e.kind === KINDS.DESCRIPTOR))
    const newEpoch = after.filter((e) => e.tags[0]![1] !== roomId)
    expect(newEpoch.length).toBeGreaterThan(0)
    expect(alice.epochKeys().id).not.toBe(roomId)
  })

  it('a member that missed the rekey is handed the epoch by the desk, on proof of who it is; a removed one is refused', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const bobIdentity = localIdentity(generateSecretKey())
    await keeper.join([], {})
    await settle()
    await keeper.rekey({ authoritySk, removed: [bobIdentity.pubkey] })
    await settle()
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId: keeper.roomId,
      authoritySk,
      current: () => keeper.currentEpoch(),
      removed: () => keeper.removed,
      now,
    })

    // Carol arrives with nothing but the room secret and the authority's
    // pubkey: told nothing about the epoch, she reads the replayed rekey,
    // cannot open it, asks, and lands in epoch 1.
    const carol = member(relay, 'Carol', authority)
    await carol.join([], {})
    await settle()
    expect(carol.epoch).toBe(1)
    expect(carol.removed.has(bobIdentity.pubkey)).toBe(true)
    expect(keeper.participants().map((v) => v.name).sort()).toEqual(['Carol', 'Keeper'])
    // Nothing of Carol's was ever said under epoch 0.
    const { roomId } = deriveRoom(SECRET)
    const carolsEntries = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === carol.device)
    expect(carolsEntries.length).toBeGreaterThan(0)
    expect(carolsEntries.every((e) => e.tags[0]![1] !== roomId)).toBe(true)

    // Dave was told by his responder that the room is at epoch 1, and asks
    // without waiting for anything.
    const dave = member(relay, 'Dave', authority, { expectedEpoch: 1, epochSettleMs: 10_000 })
    await dave.join([], {})
    await settle()
    expect(dave.epoch).toBe(1)

    // Bob, removed, is refused, and his join fails saying so.
    let told: { epoch: number; by?: string } | undefined
    const bob = member(relay, 'Bob', authority, { identity: bobIdentity, onRemoved: (n) => (told = n) })
    await expect(bob.join([], {})).rejects.toThrow(/removed/)
    expect(told).toBeDefined()
    expect(keeper.participants().map((v) => v.name).sort()).toEqual(['Carol', 'Dave', 'Keeper'])
    desk.close()
  })

  it('a session with no authority stays where it joined, which is what a legacy link gets', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const legacy = member(relay, 'Legacy')
    await keeper.join([], {})
    await legacy.join([], {})
    await settle()
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    expect(keeper.epoch).toBe(1)
    expect(legacy.epoch).toBe(0)
    // Only the authority can rekey.
    await expect(legacy.rekey({ authoritySk: generateSecretKey() })).resolves.toBeDefined()
    await expect(keeper.rekey({ authoritySk: generateSecretKey() })).rejects.toThrow(/authority/)
  })

  it('closing seals the secret to nobody and every member is told', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    let closedBy: { epoch: number; by?: string } | undefined
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority, { onClosed: (n) => (closedBy = n) })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    const admin = getPublicKey(generateSecretKey())
    await keeper.rekey({ authoritySk, closed: true, by: admin })
    await settle()
    expect(keeper.closed).toBe(true)
    expect(alice.closed).toBe(true)
    expect(closedBy).toEqual({ epoch: 1, by: admin })
    await expect(keeper.rekey({ authoritySk })).rejects.toThrow(/closed/)
  })

  it('a reopened keeper refuses the participants it removed before the roster says a word', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const bob = member(relay, 'Bob', authority)
    await bob.join([], {})
    const keeper = member(relay, 'Keeper', authority)
    keeper.forgetParticipants([bob.participant])
    await keeper.join([], {})
    await settle()
    expect(keeper.participants().map((v) => v.name)).toEqual(['Keeper'])
  })
})
