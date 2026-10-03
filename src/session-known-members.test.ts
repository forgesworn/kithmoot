// The known-members gate (#207), through `RoomSession`: once a room has
// removed somebody, its epoch goes only to participants it knows. A removed
// person back under a fresh key is not handed the room by any member, while
// a member who was merely offline through the removal still is.
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { EpochUnreachableError, RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { deriveEpoch, hostRoomEpoch } from './epoch.js'
import { readRekeyEvidence } from './member-epoch.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(41)
const { roomId, roomKey } = deriveRoom(SECRET)

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function member(relay: SimRelay, name: string, authority: string, extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}) {
  return new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(),
    name,
    now,
    announceJitterMs: 0,
    authority,
    epochSettleMs: 0,
    memberEpochJitterMs: 0,
    epochRequestTimeoutMs: 1_500,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

/** A room at epoch 1 whose authority removed Mallory, with Dave, who was
 *  in the room before but offline for the removal, and the authority gone. */
async function roomAfterRemoval(relay: SimRelay) {
  const authoritySk = generateSecretKey()
  const authority = getPublicKey(authoritySk)
  const asked: string[] = []
  const keeper = member(relay, 'Keeper', authority)
  const alice = member(relay, 'Alice', authority, { onUnknownAsking: (a) => asked.push(a.participant) })
  const mallory = localIdentity(generateSecretKey())
  const dave = localIdentity(generateSecretKey())
  const malloryNow = member(relay, 'Mallory', authority, { identity: mallory })
  const daveThen = member(relay, 'Dave', authority, { identity: dave })
  for (const s of [keeper, alice, malloryNow, daveThen]) await s.join([], {})
  await settle()
  await daveThen.leave()
  await settle()
  await keeper.rekey({ authoritySk, removed: [mallory.pubkey] })
  await settle()
  expect(alice.epoch).toBe(1)
  await keeper.leave()
  await malloryNow.leave()
  return { authoritySk, authority, keeper, alice, mallory, dave, asked }
}

describe('the known-members gate', () => {
  it('the rekey lists everybody the authority has seen, offline ones too, and not the removed', async () => {
    const relay = new SimRelay({ replay: true })
    const { authority, keeper, alice, mallory, dave } = await roomAfterRemoval(relay)
    const rekey = relay.published.find((e) => e.kind === KINDS.ROOM_REKEY)!
    const evidence = readRekeyEvidence(rekey, { roomId, authority, previous: deriveEpoch({ epoch: 0, secret: SECRET }) })
    expect(evidence?.members).toContain(dave.pubkey)
    expect(evidence?.members).toContain(alice.participant)
    expect(evidence?.members).toContain(keeper.participant)
    expect(evidence?.members).not.toContain(mallory.pubkey)
    // A member read the list from the rekey it followed.
    expect(alice.knows(dave.pubkey)).toBe(true)
    expect(alice.knows(mallory.pubkey)).toBe(false)
    await alice.leave()
  }, 30_000)

  it('a removed person back under a fresh key is not handed the room, and a member is asked about them', async () => {
    const relay = new SimRelay({ replay: true })
    const { authority, alice, asked } = await roomAfterRemoval(relay)
    const fresh = localIdentity(generateSecretKey())
    const back = member(relay, 'Not Mallory', authority, { identity: fresh, expectedEpoch: 1 })
    await expect(back.join([], {})).rejects.toBeInstanceOf(EpochUnreachableError)
    expect(back.epoch).toBe(0)
    expect(asked).toEqual([fresh.pubkey])
    await back.leave()
    await alice.leave()
  }, 30_000)

  it('somebody a member lets in is handed the room on their next try', async () => {
    const relay = new SimRelay({ replay: true })
    const { authority, alice } = await roomAfterRemoval(relay)
    const newcomer = localIdentity(generateSecretKey())
    const first = member(relay, 'Newcomer', authority, { identity: newcomer, expectedEpoch: 1 })
    await expect(first.join([], {})).rejects.toBeInstanceOf(EpochUnreachableError)
    await first.leave()
    alice.letIn(newcomer.pubkey)
    const second = member(relay, 'Newcomer', authority, { identity: newcomer, expectedEpoch: 1 })
    await second.join([], {})
    await settle()
    expect(second.epoch).toBe(1)
    await second.leave()
    await alice.leave()
  }, 30_000)

  it('a member who was offline through the removal comes back on a new device without asking anybody', async () => {
    const relay = new SimRelay({ replay: true })
    const { authority, keeper, alice, mallory, dave, asked } = await roomAfterRemoval(relay)
    const daveNow = member(relay, 'Dave', authority, { identity: dave, expectedEpoch: 1 })
    await daveNow.join([], {})
    await settle()
    expect(daveNow.epoch).toBe(1)
    expect(asked).toEqual([])
    // The member grant carried the authority's list, so Dave's own desk
    // knows who the room knows: the keeper, gone from the roster, and not
    // the removed.
    expect(daveNow.knows(keeper.participant)).toBe(true)
    expect(daveNow.knows(mallory.pubkey)).toBe(false)
    await daveNow.leave()
    await alice.leave()
  }, 30_000)

  it('the authority\'s answer that it does not know somebody reads as waiting to be let in, not as removed', async () => {
    const relay = new SimRelay({ replay: true })
    const { authoritySk, authority, alice, mallory } = await roomAfterRemoval(relay)
    await alice.leave()
    // What a keeper runs, with the gate: nobody but Alice is known.
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId,
      authoritySk,
      roomKey,
      current: () => ({ epoch: 1, secret: new Uint8Array(32).fill(1) }),
      removed: () => new Set([mallory.pubkey]),
      known: (p) => p === alice.participant,
      now,
    })
    let removed = false
    const fresh = member(relay, 'Fresh', authority, { expectedEpoch: 1, onRemoved: () => { removed = true } })
    const err = await fresh.join([], {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EpochUnreachableError)
    expect((err as EpochUnreachableError).unknown).toBe(true)
    expect(removed).toBe(false)
    desk.close()
    await fresh.leave()
  }, 30_000)
})
