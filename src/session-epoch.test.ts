import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { encodeRekeyEvent, generateEpochSecret, hostRoomEpoch } from './epoch.js'
import type { RekeyNotice } from './epoch.js'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { EpochConflict, EpochGap } from './session.js'
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

/**
 * A relay connection that can lag and go deaf. `hold` keeps what this
 * device publishes back until `release`, the way a slow relay acknowledges
 * late; `deaf` drops what the relay delivers, the way a device that is
 * away hears nothing.
 */
class LaggyTransport extends SimTransport {
  hold = false
  deaf = false
  readonly held: Event[] = []
  readonly #relay: SimRelay

  constructor(relay: SimRelay) {
    super(relay)
    this.#relay = relay
  }

  override async publish(event: Event): Promise<void> {
    if (this.hold) this.held.push(event)
    else await super.publish(event)
  }

  override subscribe(filters: Filter[], onEvent: (event: Event) => void, onEose?: () => void): () => void {
    return super.subscribe(filters, (event) => { if (!this.deaf) onEvent(event) }, onEose)
  }

  release(): void {
    this.hold = false
    for (const event of this.held.splice(0)) this.#relay.publish(event)
  }
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
    expect(notice.catchUp).toBeUndefined()
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
    // Carol and Dave come in on the link after the removal: whoever lets
    // them in makes them known, and the desk then hands them the epoch
    // (#207). Somebody the room never let in is the next test's business.
    const carolIdentity = localIdentity(generateSecretKey())
    const daveIdentity = localIdentity(generateSecretKey())
    keeper.letIn(carolIdentity.pubkey)
    keeper.letIn(daveIdentity.pubkey)
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId: keeper.roomId,
      authoritySk,
      roomKey: deriveRoom(SECRET).roomKey,
      current: () => keeper.currentEpoch(),
      removed: () => keeper.removed,
      known: (p) => keeper.knows(p),
      now,
    })

    // Carol arrives with nothing but the room secret and the authority's
    // pubkey: told nothing about the epoch, she reads the replayed rekey,
    // cannot open it, asks, and lands in epoch 1.
    const caughtUp: RekeyNotice[] = []
    const carol = member(relay, 'Carol', authority, { identity: carolIdentity, onEpoch: notice => caughtUp.push(notice) })
    await carol.join([], {})
    await settle()
    expect(carol.epoch).toBe(1)
    expect(carol.removed.has(bobIdentity.pubkey)).toBe(true)
    expect(caughtUp).toHaveLength(1)
    expect(caughtUp[0]).toMatchObject({ epoch: 1, removed: [bobIdentity.pubkey], catchUp: true })
    expect(keeper.participants().map((v) => v.name).sort()).toEqual(['Carol', 'Keeper'])
    // Nothing of Carol's was ever said under epoch 0.
    const { roomId } = deriveRoom(SECRET)
    const carolsEntries = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === carol.device)
    expect(carolsEntries.length).toBeGreaterThan(0)
    expect(carolsEntries.every((e) => e.tags[0]![1] !== roomId)).toBe(true)

    // Dave was told by his responder that the room is at epoch 1, and asks
    // without waiting for anything.
    const dave = member(relay, 'Dave', authority, { identity: daveIdentity, expectedEpoch: 1, epochSettleMs: 10_000 })
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

  it('a message published under the epoch just left, late, is still heard by those who moved on', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const laggy = new LaggyTransport(relay)
    const alice = member(relay, 'Alice', authority, { transport: laggy })
    const bob = member(relay, 'Bob', authority)
    await keeper.join([], {})
    await alice.join([], {})
    await bob.join([], {})
    await settle()

    // Alice speaks in epoch 0, but her relay is slow to take it; the rekey
    // lands first, and only then does her message reach the relay.
    laggy.hold = true
    await alice.chat.send('said just before the rekey')
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    expect(bob.epoch).toBe(1)
    laggy.release()
    await settle()
    expect(bob.chat.messages().map((m) => m.text)).toEqual(['said just before the rekey'])
    expect(keeper.chat.messages().map((m) => m.text)).toEqual(['said just before the rekey'])
  })

  it('what a removed member publishes under the old key is refused, however it is dated', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const laggy = new LaggyTransport(relay)
    const bob = member(relay, 'Bob', authority, { transport: laggy })
    await keeper.join([], {})
    await bob.join([], {})
    await settle()

    // Signed while Bob was still a member, published after his removal:
    // indistinguishable from a late message, and still not heard.
    laggy.hold = true
    await bob.chat.send('held back until after my removal')
    await keeper.rekey({ authoritySk, removed: [bob.participant] })
    await settle()
    laggy.release()
    await bob.chat.send('and this one after')
    await settle()
    expect(keeper.chat.messages()).toEqual([])
  })

  it('a device coming back through several rekeys reads what was said in the epochs between', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    const carolIdentity = localIdentity(generateSecretKey())
    const carolDevice = generateSecretKey()
    const away = new LaggyTransport(relay)
    // Kept as the device key is kept: her copies of the rekeys are sealed to them.
    const sealKeys: Uint8Array[] = []
    const carol = member(relay, 'Carol', authority, {
      identity: carolIdentity,
      deviceSk: carolDevice,
      transport: away,
      onCredential: (_credential, sealSk) => { if (sealSk) sealKeys.push(sealSk) },
    })
    await keeper.join([], {})
    await alice.join([], {})
    await carol.join([], {})
    await settle()

    // Carol goes quiet without saying goodbye, so every rekey is still
    // sealed to her device; she just hears none of them.
    away.deaf = true
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    await alice.chat.send('in epoch 1')
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    await alice.chat.send('in epoch 2')
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    await alice.chat.send('in epoch 3')
    await settle()
    expect(carol.epoch).toBe(0)

    // She opens the room again: the relay replays three rekeys, she
    // applies them in a row, and the epochs she passed through are read.
    const gaps: EpochGap[] = []
    const back = member(relay, 'Carol', authority, { identity: carolIdentity, deviceSk: carolDevice, sealKeys, onEpochGap: (gap) => gaps.push(gap) })
    await back.join([], {})
    await settle()
    expect(back.epoch).toBe(3)
    expect(back.chat.messages().map((m) => m.text).sort()).toEqual(['in epoch 1', 'in epoch 2', 'in epoch 3'])
    expect(gaps).toEqual([])
    expect(back.epochGaps()).toEqual([])
  })

  it('a device whose rekey the relays lost is caught up by the desk and told what it cannot read', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const carolIdentity = localIdentity(generateSecretKey())
    const carolDevice = generateSecretKey()
    const away = new LaggyTransport(relay)
    // Kept as the device key is kept: her copies of the rekeys are sealed to them.
    const sealKeys: Uint8Array[] = []
    const carol = member(relay, 'Carol', authority, {
      identity: carolIdentity,
      deviceSk: carolDevice,
      transport: away,
      onCredential: (_credential, sealSk) => { if (sealSk) sealKeys.push(sealSk) },
    })
    await keeper.join([], {})
    await carol.join([], {})
    await settle()
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    expect(carol.epoch).toBe(1)

    away.deaf = true
    await keeper.rekey({ authoritySk, removed: [] })
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    // The relay lets epoch 2's rekey go, as real relays let events go
    // within days. Epoch 3's is sealed under epoch 2's key, so Carol can
    // no longer follow the chain on her own.
    const lost = relay.published.findIndex((e) => e.kind === KINDS.ROOM_REKEY && e.tags.some((t) => t[0] === 'epoch' && t[1] === '2'))
    relay.published.splice(lost, 1)
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId: keeper.roomId,
      authoritySk,
      roomKey: deriveRoom(SECRET).roomKey,
      current: () => keeper.currentEpoch(),
      removed: () => keeper.removed,
      now,
    })

    const back = member(relay, 'Carol', authority, { identity: carolIdentity, deviceSk: carolDevice, sealKeys })
    await back.join([], {})
    await settle()
    expect(back.epoch).toBe(3)
    expect(back.epochGaps()).toEqual([{ from: 1, to: 3, at: NOW }])
    desk.close()
  })

  it('two different rekeys for one epoch are reported, and the authority\'s own echo is not', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeperConflicts: EpochConflict[] = []
    const keeper = member(relay, 'Keeper', authority, { onEpochConflict: (c) => keeperConflicts.push(c) })
    const conflicts: EpochConflict[] = []
    const alice = member(relay, 'Alice', authority, { onEpochConflict: (c) => conflicts.push(c) })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    const epoch0 = keeper.epochKeys()

    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    expect(keeperConflicts).toEqual([])
    expect(keeper.epochConflicts()).toEqual([])
    const first = relay.published.find((e) => e.kind === KINDS.ROOM_REKEY)!

    // The same key, rekeying from a second tab that had not seen the first.
    const second = encodeRekeyEvent({
      roomId: keeper.roomId,
      authoritySk,
      current: epoch0,
      next: { epoch: 1, secret: generateEpochSecret() },
      recipients: [alice.device],
      removed: [],
      now: NOW,
    })
    await new SimTransport(relay).publish(second)
    await new SimTransport(relay).publish(second)
    await settle()
    expect(conflicts).toEqual([{ epoch: 1, kept: first.id, other: second.id }])
    expect(alice.epochConflicts()).toEqual(conflicts)
    expect(keeperConflicts).toEqual([{ epoch: 1, kept: first.id, other: second.id }])
    // Neither side is abandoned on arrival order: Alice stays where she was.
    expect(alice.epoch).toBe(1)
    expect(alice.epochKeys().key).toEqual(keeper.epochKeys().key)
  })
})
