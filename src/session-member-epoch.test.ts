// Member epoch catch-up, through `RoomSession`: a device that missed a rekey
// while the authority is offline is brought up to date by a current member,
// and checks what it is handed against the authority's own signed rekeys.
// See `member-epoch.ts` and fold-kit's docs/member-epoch-catch-up.md.
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { EpochUnreachableError, RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { deriveEpoch, encodeRekeyEvent, generateEpochSecret } from './epoch.js'
import type { RekeyNotice } from './epoch.js'
import { MEMBER_EPOCH_KINDS, readRekeyEvidence, requestMemberEpoch } from './member-epoch.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(23)
const { roomId, roomKey } = deriveRoom(SECRET)

/** Lets scheduled re-announces, rekeys and grants run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
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
    epochRequestTimeoutMs: 15_000,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

describe('member epoch catch-up', () => {
  it('with the authority offline, a device at epoch 0 recovers epoch 1 from a member, and nothing names that member', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    await keeper.rekey({ authoritySk })
    await settle()
    expect(alice.epoch).toBe(1)

    // The rekey carries the commitment that lets a member vouch for epoch 1.
    const rekey = relay.published.find((e) => e.kind === KINDS.ROOM_REKEY)!
    const evidence = readRekeyEvidence(rekey, { roomId, authority, previous: { epoch: 0, id: '', key: roomKey } })
    expect(evidence?.commit).toMatch(/^[0-9a-f]{64}$/)

    // The authority goes away. Nothing in this test answers kind 20468.
    await keeper.leave()

    const moved: RekeyNotice[] = []
    const bob = member(relay, 'Bob', authority, { onEpoch: (n) => moved.push(n) })
    await bob.join([], {})
    await settle()
    expect(bob.epoch).toBe(1)
    expect(bob.epochKeys().key).toEqual(alice.epochKeys().key)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ epoch: 1, catchUp: true })
    expect(alice.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Bob'])
    expect(bob.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Bob'])

    // Bob never said anything under epoch 0.
    const bobsEntries = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === bob.device)
    expect(bobsEntries.length).toBeGreaterThan(0)
    expect(bobsEntries.every((e) => e.tags[0]![1] !== roomId)).toBe(true)

    // The grant came from a one-time key, not Alice's device.
    const grants = relay.published.filter((e) => e.kind === MEMBER_EPOCH_KINDS.GRANT)
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every((e) => e.pubkey !== alice.device && e.pubkey !== alice.participant)).toBe(true)

    // And Bob, now in step, answers for the room too: Carol catches up from
    // whichever of them is first.
    await alice.leave()
    const carol = member(relay, 'Carol', authority)
    await carol.join([], {})
    await settle()
    expect(carol.epoch).toBe(1)
    await bob.leave()
    await carol.leave()
  }, 60_000)

  it('a device two epochs behind reads the epoch a member grant carried it past, and is told of no gap', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    const carolIdentity = localIdentity(generateSecretKey())
    const carolDevice = generateSecretKey()
    const carol = member(relay, 'Carol', authority, { identity: carolIdentity, deviceSk: carolDevice })
    await keeper.join([], {})
    await alice.join([], {})
    await carol.join([], {})
    await settle()
    // Carol goes, so neither rekey is sealed to her device.
    await carol.leave()
    await settle()
    await keeper.rekey({ authoritySk })
    await settle()
    await alice.chat.send('in epoch 1')
    await keeper.rekey({ authoritySk })
    await settle()
    await alice.chat.send('in epoch 2')
    await settle()
    await keeper.leave()

    const back = member(relay, 'Carol', authority, { identity: carolIdentity, deviceSk: carolDevice })
    await back.join([], {})
    await until(() => back.chat.messages().length === 2, 10_000)
    expect(back.epoch).toBe(2)
    expect(back.chat.messages().map((m) => m.text).sort()).toEqual(['in epoch 1', 'in epoch 2'])
    expect(back.epochGaps()).toEqual([])
    await alice.leave()
    await back.leave()
  }, 60_000)

  it('a removed member is handed nothing by a member desk', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    const bobIdentity = localIdentity(generateSecretKey())
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    await keeper.rekey({ authoritySk, removed: [bobIdentity.pubkey] })
    await settle()
    await keeper.leave()
    expect(alice.epoch).toBe(1)
    expect(alice.removed.has(bobIdentity.pubkey)).toBe(true)

    // Bob still holds the link, so he can make a well-formed member request
    // with a valid credential and admission proof. Alice's desk declines.
    const bobDeviceSk = generateSecretKey()
    const credential = await createDeviceCredential({
      identity: bobIdentity,
      devicePubkey: getPublicKey(bobDeviceSk),
      roomId,
      expiresAt: NOW + 3_600,
      now,
    })
    await expect(requestMemberEpoch({
      transport: new SimTransport(relay),
      roomId,
      authority,
      deviceSk: bobDeviceSk,
      roomKey,
      credential,
      current: deriveEpoch({ epoch: 0, secret: SECRET }),
      now,
      retryMs: 500,
      timeoutMs: 2_500,
    })).rejects.toThrow(/no current member/)
    expect(relay.published.filter((e) => e.kind === MEMBER_EPOCH_KINDS.REQUEST && e.pubkey === getPublicKey(bobDeviceSk)).length).toBeGreaterThan(0)
    expect(relay.published.filter((e) => e.kind === MEMBER_EPOCH_KINDS.GRANT)).toEqual([])

    // And a RoomSession for Bob refuses itself from the rekey alone, without asking.
    const bob = member(relay, 'Bob', authority, { identity: bobIdentity })
    await expect(bob.join([], {})).rejects.toThrow(/removed/)
    expect(relay.published.filter((e) => e.kind === MEMBER_EPOCH_KINDS.GRANT)).toEqual([])
    await alice.leave()
  }, 60_000)

  it('joining a room nobody can bring this device into fails as unreachable, not refused', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    await keeper.join([], {})
    await keeper.rekey({ authoritySk })
    await keeper.leave()
    const bob = member(relay, 'Bob', authority, { epochRequestTimeoutMs: 300 })
    await expect(bob.join([], {})).rejects.toBeInstanceOf(EpochUnreachableError)
    expect(bob.awaitingEpoch).toBe(false)
  }, 30_000)

  it('a live session that falls behind says so, keeps asking, and clears once a member answers', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const waiting: boolean[] = []
    const bob = member(relay, 'Bob', authority, { epochRequestTimeoutMs: 300, onEpochWaiting: (w: boolean) => waiting.push(w) })
    await bob.join([], {})
    await settle()
    expect(bob.awaitingEpoch).toBe(false)

    // The authority rekeys without Bob (it did not see him) and goes.
    const next = { epoch: 1, secret: generateEpochSecret() }
    await new SimTransport(relay).publish(encodeRekeyEvent({
      roomId,
      authoritySk,
      current: deriveEpoch({ epoch: 0, secret: SECRET }),
      next,
      recipients: [],
      removed: [],
      commit: true,
      now: NOW,
    }))
    await until(() => bob.awaitingEpoch, 10_000)
    expect(waiting).toEqual([true])
    expect(bob.epoch).toBe(0)

    // A member that holds epoch 1 comes online; Bob's next attempt finds it.
    const alice = member(relay, 'Alice', authority, { epoch: next, expectedEpoch: 1 })
    await alice.join([], {})
    await until(() => bob.epoch === 1, 20_000)
    expect(bob.awaitingEpoch).toBe(false)
    expect(waiting).toEqual([true, false])
    await settle()
    expect(alice.participants().map((v) => v.name).sort()).toEqual(['Alice', 'Bob'])
    await alice.leave()
    await bob.leave()
  }, 60_000)
})
