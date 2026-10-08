import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { HISTORY_WINDOW_SECONDS, encodeRekeyEvent, generateEpochSecret, hostRoomEpoch } from './epoch.js'
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
  it('joins after rekey replay completes without the fixed settling delay', async () => {
    const relay = new SimRelay({ replay: true })
    const authority = getPublicKey(generateSecretKey())
    const room = member(relay, 'Returning', authority, { epochSettleMs: 10_000 })
    try {
      await Promise.race([
        room.join([], {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('replay completion did not release joining')), 1_000).unref()),
      ])
      expect(room.participants().some(p => p.name === 'Returning')).toBe(true)
    } finally { await room.leave() }
  })

  it('keeps the settling budget when a transport cannot confirm replay completion', async () => {
    const relay = new SimRelay()
    class SilentReplay extends SimTransport {
      override subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void {
        return super.subscribe(filters, onEvent)
      }
    }
    const room = member(relay, 'Returning', getPublicKey(generateSecretKey()), {
      transport: new SilentReplay(relay), epochSettleMs: 60,
    })
    let joined = false
    try {
      const opening = room.join([], {}).then(() => { joined = true })
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(joined).toBe(false)
      await opening
      expect(joined).toBe(true)
    } finally { await room.leave() }
  })

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
    const carol = member(relay, 'Carol', authority, { identity: carolIdentity, epochSettleMs: 10_000, onEpoch: notice => caughtUp.push(notice) })
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

  it('a closing rekey that self-destructs tells every member so, and an open rekey cannot', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const heard: { epoch: number; by?: string; destruct?: true }[] = []
    const keeper = member(relay, 'Keeper', authority, { onClosed: (n) => heard.push(n) })
    const alice = member(relay, 'Alice', authority, { onClosed: (n) => heard.push(n) })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    await expect(keeper.rekey({ authoritySk, removed: [], destruct: true })).rejects.toThrow(/closing/)
    const notice = await keeper.rekey({ authoritySk, closed: true, destruct: true })
    await settle()
    expect(notice.destruct).toBe(true)
    expect(alice.closed).toBe(true)
    expect(heard).toEqual([{ epoch: 1, destruct: true }, { epoch: 1, destruct: true }])
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

describe('scheduled rekeys and the history window', () => {
  it('a scheduled rekey moves a member on, and its notice says it was scheduled', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const notices: RekeyNotice[] = []
    const alice = member(relay, 'Alice', authority, { onEpoch: (n) => notices.push(n) })
    await alice.join([], {})
    await settle()
    // What a keeper on a schedule publishes: nobody removed, marked.
    await new SimTransport(relay).publish(encodeRekeyEvent({
      roomId: alice.roomId,
      authoritySk,
      current: alice.epochKeys(),
      next: { epoch: 1, secret: generateEpochSecret() },
      recipients: [alice.device],
      removed: [],
      commit: true,
      scheduled: true,
      now: NOW,
    }))
    await settle()
    expect(alice.epoch).toBe(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ epoch: 1, removed: [], closed: false, scheduled: true })
    expect(notices[0]!.catchUp).toBeUndefined()
  })

  it('the authority hands a device the window, a newcomer reads it, and a device reopened with what it kept needs no replay', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    let t = NOW
    const clock = () => t
    const keeper = member(relay, 'Keeper', authority, { now: clock })
    const alice = member(relay, 'Alice', authority, { now: clock })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    await alice.chat.send('in epoch 0')
    for (const epoch of [1, 2, 3]) {
      // Steps inside the presence window, so the keeper still seals to Alice.
      t = NOW + epoch * 10
      await keeper.rekey({ authoritySk })
      await settle()
      await alice.chat.send(`in epoch ${epoch}`)
    }
    await settle()
    expect(alice.epoch).toBe(3)

    // Each epoch left, newest first, from when the room left it; epoch 0
    // with the room secret.
    const left = (s: RoomSession) => s.pastSecrets().map((e) => [e.epoch, e.leftAt])
    expect(left(keeper)).toEqual([[2, NOW + 30], [1, NOW + 20], [0, NOW + 10]])
    expect(left(alice)).toEqual(left(keeper))
    expect(keeper.pastSecrets().at(-1)!.secret).toEqual(SECRET)
    expect(alice.pastSecrets().map((e) => e.secret)).toEqual(keeper.pastSecrets().map((e) => e.secret))

    // The relays have let every rekey go. A newcomer, told the room is at
    // epoch 3, asks the authority, whose grant carries the window: the
    // epochs between arrive with when the room left each.
    for (let i = relay.published.length - 1; i >= 0; i--) if (relay.published[i]!.kind === KINDS.ROOM_REKEY) relay.published.splice(i, 1)
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId: keeper.roomId,
      authoritySk,
      roomKey: deriveRoom(SECRET).roomKey,
      current: () => keeper.currentEpoch(),
      removed: () => keeper.removed,
      past: () => keeper.pastSecrets(),
      now: clock,
    })
    t = NOW + 40
    const dave = member(relay, 'Dave', authority, { now: clock, expectedEpoch: 3 })
    await dave.join([], {})
    await settle()
    expect(dave.epoch).toBe(3)
    expect(dave.chat.messages().map((m) => m.text).sort()).toEqual(['in epoch 0', 'in epoch 1', 'in epoch 2', 'in epoch 3'])
    // Epochs 1 and 2 as the authority said; epoch 0, which no grant
    // carries, from when Dave left it.
    expect(left(dave)).toEqual([[2, NOW + 30], [1, NOW + 20], [0, NOW + 40]])
    expect(dave.epochGaps()).toEqual([])
    desk.close()

    // Alice opens the room again with what she kept: in epoch 3 at once,
    // with no rekey on any relay, no seal key and nobody to ask, and
    // reading all four epochs.
    const again = member(relay, 'Alice', authority, { now: clock, epoch: alice.currentEpoch(), pastEpochs: alice.pastSecrets() })
    expect(again.epoch).toBe(3)
    expect(left(again)).toEqual(left(alice))
    await again.join([], {})
    await settle()
    expect(again.epoch).toBe(3)
    expect(again.awaitingEpoch).toBe(false)
    expect(again.chat.messages().map((m) => m.text).sort()).toEqual(['in epoch 0', 'in epoch 1', 'in epoch 2', 'in epoch 3'])

    // A month on, what has left the window is not taken up, and nothing at
    // or above the epoch it opens in is.
    t = NOW + 15 + HISTORY_WINDOW_SECONDS
    const later = member(relay, 'Alice', authority, {
      now: clock,
      epoch: alice.currentEpoch(),
      pastEpochs: [...alice.pastSecrets(), { epoch: 3, secret: generateEpochSecret(), leftAt: t }],
    })
    expect(left(later)).toEqual([[2, NOW + 30], [1, NOW + 20]])
  })
})
