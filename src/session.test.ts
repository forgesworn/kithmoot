import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { RoomSession } from './session.js'
import type { PrimaryRoomSessionOptions } from './session.js'
import { issueKindredProof } from './access.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'
import { decodeRosterEvent } from './roster.js'
import { PRESENCE_TTL_SECONDS } from './session.js'

const NOW = 1_800_000_000
/** The room every test in this file joins - a kindred proof is minted for one
 *  room, so a proof and the session that carries it must name the same one. */
const ROOM_ID = deriveRoom(new Uint8Array(32).fill(11)).roomId
const now = () => NOW

function secret() {
  return new Uint8Array(32).fill(11)
}

/** Lets scheduled re-announces run. Everything in SimRelay is synchronous,
 *  so a few macrotasks past a zero jitter is enough - no arbitrary sleeps. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('RoomSession', () => {
  it('groups two devices of one participant into a single view', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)

    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: phoneSk,
      now,
      announceJitterMs: 0,
    })
    const laptop = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: laptopSk,
      now,
      announceJitterMs: 0,
    })
    const observer = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })

    // The observer joins LAST, which is the order the README's manual
    // procedure actually uses and the direction the roster used not to
    // work in at all.
    await phone.join([{ trackId: 'cam', role: 'camera' }, { trackId: 'mic', role: 'mic' }], { mic: NOW })
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})
    await observer.join([], {})
    await settle()

    const views = observer.participants()
    const mine = views.find((v) => v.participant === participant)

    expect(mine).toBeDefined()
    expect(mine!.devices.sort()).toEqual([getPublicKey(phoneSk), getPublicKey(laptopSk)].sort())
    expect(mine!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'mic', 'screen'])
  })

  it('reports two participants as two views, not four devices', async () => {
    const relay = new SimRelay()
    const alice = generateSecretKey()
    const bob = generateSecretKey()

    const sessions = [
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(alice), deviceSk: generateSecretKey(), now, announceJitterMs: 0 }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(alice), deviceSk: generateSecretKey(), now, announceJitterMs: 0 }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(bob), deviceSk: generateSecretKey(), now, announceJitterMs: 0 }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(bob), deviceSk: generateSecretKey(), now, announceJitterMs: 0 }),
    ]
    const observerSk = generateSecretKey()
    const observerParticipant = getPublicKey(observerSk)
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(observerSk), deviceSk: generateSecretKey(), now, announceJitterMs: 0 })
    // Again asserted from the LAST device to arrive, not the first.
    for (const s of sessions) await s.join([], {})
    await observer.join([], {})
    await settle()

    // Capture the observer's own pubkey before asserting, and filter against
    // that - not a freshly generated key, which would never match anything
    // and let this assertion pass no matter what participants() returned.
    const others = observer.participants().filter((v) => v.participant !== observerParticipant)
    expect(others).toHaveLength(2)
    expect(others.filter((v) => v.participant === getPublicKey(alice))).toHaveLength(1)
    expect(others.filter((v) => v.participant === getPublicKey(bob))).toHaveLength(1)
  })

  it('resolves the mic to exactly one device', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(participantSk), deviceSk: phoneSk, now, announceJitterMs: 0 })
    const laptop = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(participantSk), deviceSk: laptopSk, now, announceJitterMs: 0 })
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), now, announceJitterMs: 0 })

    // Observer LAST: a mic claim has to survive the re-announce that tells a
    // late arrival about a device, not just the first announcement.
    await phone.join([], { mic: NOW })
    await laptop.join([], { mic: NOW + 10 })
    await observer.join([], {})
    await settle()

    const view = observer.participants().find((v) => v.participant === getPublicKey(participantSk))
    expect(view!.mic).toBe(getPublicKey(laptopSk))
  })

  it('ignores roster events from a different room', async () => {
    const relay = new SimRelay()
    // The other room goes first, so the observer is the late arrival - the
    // one case where a re-announce could plausibly hand it somebody else's
    // room.
    const otherRoom = new RoomSession({
      transport: new SimTransport(relay),
      secret: new Uint8Array(32).fill(99),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await otherRoom.join([], {})

    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), now, announceJitterMs: 0 })
    await observer.join([], {})
    await settle()

    expect(observer.participants()).toHaveLength(1)
  })

  it('notifies subscribers when the roster changes', async () => {
    const relay = new SimRelay()
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), now, announceJitterMs: 0 })
    const counts: number[] = []
    observer.onChange((views) => counts.push(views.length))
    await observer.join([], {})

    const joiner = new RoomSession({ transport: new SimTransport(relay), secret: secret(), identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), now, announceJitterMs: 0 })
    const joinerCounts: number[] = []
    joiner.onChange((views) => joinerCounts.push(views.length))
    await joiner.join([], {})
    await settle()

    // Both directions: the sitting device is told about the arrival, and the
    // arriving device is told about the sitting one.
    expect(counts.at(-1)).toBe(2)
    expect(joinerCounts.at(-1)).toBe(2)
  })
})

describe('RoomSession access policy', () => {
  it('refuses to join a kith-gated room when the joiner carries no kindred proof', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      policy: { tier: 'kith', admitted: [getPublicKey(hostSk)] },
    })

    await expect(session.join([], {})).rejects.toThrow('no kindred proof')
    expect(relay.published).toHaveLength(0)
  })

  it('admits a joiner carrying a valid kindred proof to a kith-gated room', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)
    const proof = issueKindredProof({ hostSk, participant, tier: 'kith', roomId: ROOM_ID, expiresAt: NOW + 3600 })

    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      now,
      policy: { tier: 'kith', admitted: [getPublicKey(hostSk)] },
      proof,
    })

    await expect(session.join([], {})).resolves.toBeUndefined()
    expect(relay.published).toHaveLength(1)
  })
})

describe('RoomSession media', () => {
  it('publishes tracks to every remote device but never to its own other devices', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()

    const factoryA = createFakeFactory()

    const a = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      now,
      factory: factoryA,
    })
    // A second device of the SAME participant - must never get a peer.
    const b = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })
    // A different participant entirely - must get a peer.
    const stranger = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })

    await a.join([], {})
    await b.join([], {})
    await stranger.join([], {})

    // Exactly one peer: for the stranger's device. None for our own second device.
    expect(factoryA.instances).toHaveLength(1)

    const track = {} as MediaStreamTrack
    a.publishTracks([track])
    // `Peer` queues every negotiation step, so a track handed to a
    // synchronous `publishTracks` reaches the connection a turn later.
    await settle()

    expect(factoryA.instances[0]!.tracks).toContain(track)
  })

  it('surfaces remote tracks grouped by participant, not by device', async () => {
    const relay = new SimRelay()
    const factory = createFakeFactory()

    const local = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      factory,
    })

    const remoteParticipantSk = generateSecretKey()
    const remoteParticipant = getPublicKey(remoteParticipantSk)
    const remoteA = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(remoteParticipantSk),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })
    const remoteB = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(remoteParticipantSk),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })

    await local.join([], {})
    await remoteA.join([], {})
    await remoteB.join([], {})

    const received: { participant: string; device: string }[] = []
    local.onRemoteTrack((t) => received.push({ participant: t.participant, device: t.device }))

    expect(factory.instances).toHaveLength(2)
    factory.instances[0]!.ontrack?.({ track: {} as MediaStreamTrack })
    factory.instances[1]!.ontrack?.({ track: {} as MediaStreamTrack })

    expect(received).toHaveLength(2)
    expect(received.every((r) => r.participant === remoteParticipant)).toBe(true)
  })

  it('is safe to call publishTracks and onRemoteTrack when no factory was supplied', async () => {
    const relay = new SimRelay()
    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
    })
    await session.join([], {})

    expect(() => session.publishTracks([{} as MediaStreamTrack])).not.toThrow()
    const unsub = session.onRemoteTrack(() => {})
    expect(() => unsub()).not.toThrow()
  })
})

describe('RoomSession chat', () => {
  it('exposes a chat log that round-trips a message between two sessions', async () => {
    const relay = new SimRelay()
    const a = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
    })
    const b = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
    })

    await a.join([], {})
    await b.join([], {})

    await a.chat.send('hello')

    expect(b.chat.messages().map((m) => m.text)).toEqual(['hello'])
  })
})

describe('RoomSession device credentials', () => {
  it('joins with a pre-issued credential and no participant key at all', async () => {
    const relay = new SimRelay()
    // The participant key stays on the laptop. The phone is handed a
    // room-scoped, expiring credential and nothing else - which is what
    // "a device never holds the participant key" has to mean in code.
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)
    const laptopSk = generateSecretKey()
    const phoneSk = generateSecretKey()

    const { roomId } = deriveRoom(secret())
    const credential = await createDeviceCredential({
      identity: localIdentity(participantSk),
      devicePubkey: getPublicKey(phoneSk),
      roomId,
      expiresAt: NOW + 3600,
    })

    const observer = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    const laptop = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: laptopSk,
      now,
      announceJitterMs: 0,
    })
    const phone = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      credential,
      deviceSk: phoneSk,
      now,
      announceJitterMs: 0,
    })

    // Observer LAST again: a credential-only device has to be visible to
    // someone who was not listening when it announced.
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})
    await phone.join([{ trackId: 'cam', role: 'camera' }], {})
    await observer.join([], {})
    await settle()

    expect(phone.participant).toBe(participant)
    // And the credential-only device sees the room it joined, not an empty one.
    expect(phone.participants()).toHaveLength(2)

    const view = observer.participants().find((v) => v.participant === participant)
    expect(view!.devices.sort()).toEqual([getPublicKey(laptopSk), getPublicKey(phoneSk)].sort())
    expect(view!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'screen'])
  })

  it('refuses a credential that names a different device', async () => {
    const { roomId } = deriveRoom(secret())
    const credential = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(generateSecretKey()),
      roomId,
      expiresAt: NOW + 3600,
    })
    expect(
      () =>
        new RoomSession({
          transport: new SimTransport(new SimRelay()),
          secret: secret(),
          credential,
          deviceSk: generateSecretKey(),
          now,
        }),
    ).toThrow('names a different device')
  })

  it('refuses a credential minted for a different room', async () => {
    const phoneSk = generateSecretKey()
    const credential = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(phoneSk),
      roomId: deriveRoom(new Uint8Array(32).fill(77)).roomId,
      expiresAt: NOW + 3600,
    })
    expect(
      () =>
        new RoomSession({
          transport: new SimTransport(new SimRelay()),
          secret: secret(),
          credential,
          deviceSk: phoneSk,
          now,
        }),
    ).toThrow('wrong room')
  })

  it('refuses an expired credential', async () => {
    const phoneSk = generateSecretKey()
    const { roomId } = deriveRoom(secret())
    const credential = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(phoneSk),
      roomId,
      expiresAt: NOW - 1,
    })
    expect(
      () =>
        new RoomSession({
          transport: new SimTransport(new SimRelay()),
          secret: secret(),
          credential,
          deviceSk: phoneSk,
          now,
        }),
    ).toThrow('expired')
  })

  it('lets a primary device issue a credential, and refuses to on a secondary', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const laptopSk = generateSecretKey()
    const phoneSk = generateSecretKey()

    const laptop = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: laptopSk,
      now,
    })
    const issued = await laptop.issueDeviceCredential(getPublicKey(phoneSk))
    expect(issued.pubkey).toBe(getPublicKey(participantSk))

    const phone = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      credential: issued,
      deviceSk: phoneSk,
      now,
    })
    // A device without the participant key cannot mint credentials, which
    // is the whole point of not shipping the key to it.
    await expect(phone.issueDeviceCredential(getPublicKey(generateSecretKey()))).rejects.toThrow(
      'cannot sign for the participant',
    )
  })
})

describe('RoomSession roster announce and respond', () => {
  function session(relay: SimRelay) {
    return new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
  }

  it('lets a session that joins SECOND see the session that joined first', async () => {
    // The roster rides an ephemeral kind, which relays do not store, and
    // join() publishes exactly once - so without a response from the devices
    // already present, a late joiner subscribes to a room that appears
    // empty and never opens a peer to anyone. The room works in one
    // direction only, and every existing roster assertion in this suite is
    // made by the session that joined FIRST, which is why it was invisible.
    const relay = new SimRelay()
    const first = session(relay)
    const second = session(relay)

    await first.join([{ trackId: 'scr', role: 'screen' }], {})
    await second.join([], {})
    await settle()

    expect(second.participants()).toHaveLength(2)
    expect(second.participants().flatMap((v) => v.tracks).map((t) => t.role)).toEqual(['screen'])
  })

  it('gets every joiner to a complete roster whatever order they arrive in', async () => {
    const relay = new SimRelay()
    const sessions = [session(relay), session(relay), session(relay), session(relay)]

    for (const s of sessions) {
      await s.join([], {})
      await settle()
    }
    await settle()

    for (const s of sessions) expect(s.participants()).toHaveLength(4)
  })

  it('answers an arrival without touching off a cascade of answers', async () => {
    const relay = new SimRelay()
    const rosterEvents = () => relay.published.filter((e) => e.kind === KINDS.ROSTER).length

    const a = session(relay)
    const b = session(relay)
    const c = session(relay)

    await a.join([], {})
    await settle()
    await b.join([], {})
    await settle()
    await c.join([], {})
    await settle()

    // Three announces, plus one response per device already present when
    // each later device arrived: 3 + (1 + 2) = 6. A response that itself
    // provoked responses would not stop here - it would not stop at all.
    expect(rosterEvents()).toBe(6)

    // And the room is quiet afterwards.
    const settled = rosterEvents()
    await settle()
    expect(rosterEvents()).toBe(settled)
  })

  it('does not answer a device it already knows about', async () => {
    const relay = new SimRelay()
    const a = session(relay)
    const b = session(relay)

    await a.join([], {})
    await b.join([], {})
    await settle()
    const quiet = relay.published.filter((e) => e.kind === KINDS.ROSTER).length

    // b re-announcing its own presence is not a new arrival to a, so it
    // must not be answered.
    await b.announce()
    await settle()

    expect(relay.published.filter((e) => e.kind === KINDS.ROSTER).length).toBe(quiet + 1)
  })

  it('stops re-announcing once the session has left', async () => {
    const relay = new SimRelay()
    const a = session(relay)
    const b = session(relay)

    await a.join([], {})
    await b.join([], {})
    a.leave()
    await settle()

    // Two joins plus a's farewell. a had scheduled a response to b's arrival
    // and then left; a departed session must not publish anything beyond the
    // farewell itself.
    expect(relay.published.filter((e) => e.kind === KINDS.ROSTER)).toHaveLength(3)
  })
})

describe('RoomSession member-side access gating', () => {
  function gated(relay: SimRelay, policy: { tier: 'kith'; admitted: string[] }, proof?: ReturnType<typeof issueKindredProof>, participantSk = generateSecretKey()) {
    return new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
      policy,
      proof,
    })
  }

  it('refuses to render a member who joined a gated room without a proof', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }

    const memberSk = generateSecretKey()
    const member = gated(
      relay,
      policy,
      issueKindredProof({ hostSk, participant: getPublicKey(memberSk), tier: 'kith', roomId: ROOM_ID, expiresAt: NOW + 3600 }),
      memberSk,
    )
    await member.join([], {})

    // A modified client - or simply one constructed without the policy -
    // skips the local self-check entirely and publishes a roster entry.
    // Nothing about the room stops it doing that, so every other member has
    // to decide for itself whether to render them.
    const gatecrasher = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await gatecrasher.join([], {})
    await settle()

    expect(member.participants().map((v) => v.participant)).toEqual([member.participant])
  })

  it('renders a member whose proof satisfies the gate', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }

    const aSk = generateSecretKey()
    const bSk = generateSecretKey()
    const a = gated(relay, policy, issueKindredProof({ hostSk, participant: getPublicKey(aSk), tier: 'kith', roomId: ROOM_ID, expiresAt: NOW + 3600 }), aSk)
    const b = gated(relay, policy, issueKindredProof({ hostSk, participant: getPublicKey(bSk), tier: 'kin', roomId: ROOM_ID, expiresAt: NOW + 3600 }), bSk)

    await a.join([], {})
    await b.join([], {})
    await settle()

    // Each renders the other, and neither drops its own entry on its own gate.
    expect(a.participants()).toHaveLength(2)
    expect(b.participants()).toHaveLength(2)
  })

  it('refuses a member whose proof came from an issuer the room does not trust', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const strangerSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }

    const memberSk = generateSecretKey()
    const member = gated(relay, policy, issueKindredProof({ hostSk, participant: getPublicKey(memberSk), tier: 'kith', roomId: ROOM_ID, expiresAt: NOW + 3600 }), memberSk)
    await member.join([], {})

    // The gatecrasher believes its own policy names a trusted issuer, so its
    // local self-check passes. The room disagrees, and the room is what counts.
    const crasherSk = generateSecretKey()
    const crasher = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(crasherSk),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
      policy: { tier: 'kith', admitted: [getPublicKey(strangerSk)] },
      proof: issueKindredProof({ hostSk: strangerSk, participant: getPublicKey(crasherSk), tier: 'kith', roomId: ROOM_ID, expiresAt: NOW + 3600 }),
    })
    await crasher.join([], {})
    await settle()

    expect(member.participants()).toHaveLength(1)
  })
})

describe('RoomSession presence lifetime', () => {
  function room(clock: () => number, relay: SimRelay, timing?: Partial<{ heartbeatIntervalMs: number; presenceTtlSeconds: number; sweepIntervalMs: number }>) {
    return new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now: clock,
      announceJitterMs: 0,
      ...(timing ? { timing } : {}),
    })
  }

  it('BUG (M3): drops a device that has stopped announcing once its presence lapses', async () => {
    // Presence is live state. Without eviction a device that closed its
    // laptop an hour ago is still listed, still shown, and still holds a
    // `Mesh` peer connection that will never connect.
    const relay = new SimRelay()
    let clock = NOW
    const mine = room(() => clock, relay)
    const theirs = room(() => clock, relay)

    await mine.join([], {})
    await theirs.join([], {})
    await settle()
    expect(mine.participants()).toHaveLength(2)

    // They go quiet, and time passes.
    theirs.leave()
    clock = NOW + PRESENCE_TTL_SECONDS + 1

    expect(mine.participants()).toHaveLength(1)
    expect(mine.participants()[0]!.participant).toBe(mine.participant)
    mine.leave()
  })

  it('BUG (M3): drops a device whose credential has expired since it announced', async () => {
    const relay = new SimRelay()
    let clock = NOW
    const mine = room(() => clock, relay)
    const theirs = room(() => clock, relay)

    await mine.join([], {})
    await theirs.join([], {})
    await settle()
    expect(mine.participants()).toHaveLength(2)

    // Far enough ahead that the credential minted at join has lapsed, but
    // with the entry itself refreshed, so it is the credential doing the
    // work and not the presence timeout.
    clock = NOW + 13 * 60 * 60
    await theirs.announce()
    await settle()

    expect(mine.participants()).toHaveLength(1)
    mine.leave()
  })

  it('keeps announcing on a heartbeat, so nobody times it out mid-call', async () => {
    const relay = new SimRelay()
    const mine = room(now, relay, { heartbeatIntervalMs: 5, sweepIntervalMs: 5 })

    await mine.join([], {})
    const afterJoin = relay.published.filter((e) => e.kind === KINDS.ROSTER).length

    await new Promise((r) => setTimeout(r, 40))
    const afterWaiting = relay.published.filter((e) => e.kind === KINDS.ROSTER).length

    expect(afterWaiting).toBeGreaterThan(afterJoin)
    mine.leave()
  })

  it('BUG (M3): says goodbye on leave, so the microphone is released at once', async () => {
    // The wire format has no departure message, so the last thing a device
    // says is an entry claiming nothing - which frees a singular role without
    // waiting out the presence timeout.
    const relay = new SimRelay()
    const mine = room(now, relay)

    await mine.join([{ trackId: 'mic', role: 'mic' }], { mic: NOW })
    await settle()
    mine.leave()
    await settle()

    const roster = relay.published.filter((e) => e.kind === KINDS.ROSTER)
    const farewell = decodeRosterEvent(roster[roster.length - 1]!, {
      roomId: mine.roomId,
      roomKey: deriveRoom(secret()).roomKey,
      now: NOW,
    })
    expect(farewell).not.toBeNull()
    expect(farewell!.claims).toEqual({})
    expect(farewell!.tracks).toEqual([])
  })
})

/**
 * The room's forwarder list, and what the session does with it.
 *
 * The descriptor is where a room says which forwarders it may promote to. It
 * is encrypted to the room key, so a relay - and a forwarder - sees only the
 * room id, and it is signed by a credentialled device, so a stranger cannot
 * repoint a room's bandwidth at a machine of their choosing.
 */
describe('RoomSession and forwarders', () => {
  const FORWARDER = getPublicKey(generateSecretKey())
  const REPLACEMENT = getPublicKey(generateSecretKey())

  function build(opts: Partial<PrimaryRoomSessionOptions> = {}) {
    const relay = new SimRelay()
    const factory = createFakeFactory()
    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      factory,
      now,
      announceJitterMs: 0,
      // Two peers at 600 kbps against a 1 Mbps uplink is already past it.
      uplink: () => ({ uplinkBps: 1_000_000, perPeerBps: 600_000 }),
      ...opts,
    })
    return { relay, factory, session }
  }

  /**
   * Put `count` other people in the room, each on their own device.
   *
   * Two is enough to promote, and that is the point rather than a shortcut:
   * promotion is decided on capacity, so at 600 kbps each against a 1 Mbps
   * uplink two people already exceed it. A test that needed a dozen people
   * would be testing a headcount rule, which is exactly the rule this does
   * not have.
   */
  async function fill(relay: SimRelay, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const other = new RoomSession({
        transport: new SimTransport(relay),
        secret: secret(),
        identity: localIdentity(generateSecretKey()),
        deviceSk: generateSecretKey(),
        now,
        announceJitterMs: 0,
      })
      await other.join([], {})
    }
    await settle()
  }

  it('stays a mesh when the room names no forwarder', async () => {
    const { relay, session } = build()
    await session.join([], {})
    await fill(relay, 2)
    expect(session.forwarding).toBe('off')
    session.leave()
  })

  it('promotes to a forwarder the room descriptor names', async () => {
    const { relay, session } = build({ forwarders: [{ url: 'wss://forward.example', pubkey: FORWARDER }] })
    await session.join([], {})
    await fill(relay, 2)
    expect(session.forwarding).toBe('trying')
    expect(session.forwarderDevice).toBe(FORWARDER)
    session.leave()
  })

  it('picks up a forwarder list published to the room after it joined', async () => {
    const { relay, session } = build()
    await session.join([], {})
    await fill(relay, 2)
    expect(session.forwarding).toBe('off')

    // Another member publishes the room's descriptor. Nothing about the room
    // is public: only the room id is on the wire.
    const publisher = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await publisher.join([], {})
    await publisher.publishDescriptor({ forwarders: [{ url: 'wss://forward.example', pubkey: FORWARDER }] })
    await settle()

    expect(session.forwarding).toBe('trying')
    expect(session.forwarderDevice).toBe(FORWARDER)
    publisher.leave()
    session.leave()
  })

  it('ignores a descriptor for a room it is not in', async () => {
    const { relay, session } = build()
    await session.join([], {})
    await fill(relay, 2)

    const outsider = new RoomSession({
      transport: new SimTransport(relay),
      secret: new Uint8Array(32).fill(12),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await outsider.join([], {})
    await outsider.publishDescriptor({ forwarders: [{ url: 'wss://hostile.example', pubkey: FORWARDER }] })
    await settle()

    expect(session.forwarding).toBe('off')
    outsider.leave()
    session.leave()
  })

  it('takes the newest descriptor, not the last one to arrive', async () => {
    const { relay, session } = build()
    await session.join([], {})
    await fill(relay, 2)

    const publisher = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await publisher.join([], {})
    await publisher.publishDescriptor({
      forwarders: [{ url: 'wss://forward.example', pubkey: REPLACEMENT }],
      updatedAt: NOW,
    })
    await settle()
    expect(session.forwarderDevice).toBe(REPLACEMENT)

    // An older descriptor turning up late must not undo it.
    await publisher.publishDescriptor({
      forwarders: [{ url: 'wss://forward.example', pubkey: FORWARDER }],
      updatedAt: NOW - 60,
    })
    await settle()
    expect(session.forwarderDevice).toBe(REPLACEMENT)
    publisher.leave()
    session.leave()
  })

  it('publishes a descriptor that carries the forwarders and no key', async () => {
    const { relay, session } = build()
    await session.join([], {})
    await session.publishDescriptor({ forwarders: [{ url: 'wss://forward.example', pubkey: FORWARDER }] })

    const event = relay.published.find((e) => e.kind === KINDS.DESCRIPTOR)
    expect(event).toBeDefined()
    // Only the room id is readable on the wire.
    expect(event!.tags).toEqual([['d', ROOM_ID]])
    const { roomKey } = deriveRoom(secret())
    const raw = JSON.stringify(event)
    expect(raw).not.toContain(FORWARDER)
    expect(raw).not.toContain(Array.from(roomKey, (b) => b.toString(16).padStart(2, '0')).join(''))
    session.leave()
  })

  it('refuses to publish a descriptor before joining', async () => {
    const { session } = build()
    await expect(session.publishDescriptor({ forwarders: [] })).rejects.toThrow(/join/)
  })
})
