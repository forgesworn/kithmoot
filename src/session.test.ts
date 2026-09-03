import { describe, it, expect, vi } from 'vitest'
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
import type { RelayTransport } from './relay-pool.js'

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

  /**
   * Regression, and the one that mattered: a call where nobody could see or
   * hear anybody.
   *
   * The mesh does not exist until `join()` builds it, and `onRemoteTrack`
   * used to forward the subscription straight to it - so a listener that
   * subscribed FIRST was handed a no-op unsubscribe and silently dropped.
   * Every test above subscribes after joining and so never saw it; the app
   * subscribes before, which is the natural order (wire up the handlers, then
   * go on the network) and the only order with no window for a track to
   * arrive unheard. Measured in a real browser on 29 August 2026: media
   * negotiated, frames decoded at 20fps, and not one <video> or <audio>
   * element ever reached the page.
   *
   * Subscribing before join is therefore the case under test, deliberately.
   */
  it('delivers remote tracks to a listener that subscribed before join', async () => {
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

    // Before join, exactly as app/src/main.ts does it.
    const received: { participant: string; device: string }[] = []
    const unsub = local.onRemoteTrack((t) => received.push({ participant: t.participant, device: t.device }))

    const remoteSk = generateSecretKey()
    const remote = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(remoteSk),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })

    await local.join([], {})
    await remote.join([], {})

    expect(factory.instances).toHaveLength(1)
    factory.instances[0]!.ontrack?.({ track: {} as MediaStreamTrack })

    expect(received).toHaveLength(1)
    expect(received[0]!.participant).toBe(getPublicKey(remoteSk))

    // And the handle it returned has to be a real one, not the no-op stand-in.
    unsub()
    factory.instances[0]!.ontrack?.({ track: {} as MediaStreamTrack })
    expect(received).toHaveLength(1)
  })

  /**
   * BUG: the person who started the room could see and hear whoever joined,
   * and the joiner could see and hear nobody.
   *
   * Everybody already in a room answers an arrival by opening a connection to
   * it and offering, the instant the announcement reaches them. The mesh is
   * what hears that offer, and `join()` used to build it only after
   * `#publishEntry` resolved - which, on a real relay pool, is after every
   * relay has acknowledged the announcement: a whole round trip after it was
   * broadcast. A signal is an ephemeral event, delivered to whoever is
   * subscribed when it arrives and kept for nobody, so the host's offer - the
   * one carrying the host's camera and microphone - went to a subscription
   * that did not exist yet. The joiner's own offer came later and was
   * answered, which is why the call came up one way.
   *
   * `SimTransport` acknowledges synchronously, so the window did not exist in
   * any unit test. This transport acknowledges the way nostr-tools does: the
   * relay has the event at once, and the publisher hears about it a turn
   * later.
   */
  it('BUG: hears an offer sent the moment its announcement lands, before the relay has acknowledged it', async () => {
    const relay = new SimRelay()
    const lateAck = (inner: RelayTransport): RelayTransport => ({
      async publish(event) {
        await inner.publish(event)
        await new Promise((r) => setTimeout(r, 0))
      },
      subscribe: (filters, onEvent) => inner.subscribe(filters, onEvent),
      close: () => inner.close(),
    })

    // The real clock on both sides, deliberately: a signal is stamped by
    // `wrapSignal` with the real time and refused by `unwrapSignal` if it is
    // more than `SIGNAL_MAX_AGE_SECONDS` from the session's own clock, so a
    // session on the file's fixed `now` never hears a signal at all.

    // The host: in the room first, with a camera to send.
    const factoryHost = createFakeFactory()
    const host = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      factory: factoryHost,
      announceJitterMs: 0,
    })
    await host.join([{ trackId: 'cam', role: 'camera' }], {})
    host.publishTracks([{} as MediaStreamTrack])

    const factoryJoiner = createFakeFactory()
    const joiner = new RoomSession({
      transport: lateAck(new SimTransport(relay)),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      factory: factoryJoiner,
      announceJitterMs: 0,
    })
    await joiner.join([], {})
    await settle()

    // The host offered the instant it heard the joiner. The joiner must have
    // heard that offer and answered it - not sat waiting for a roster reply
    // to open a connection the host had already opened.
    expect(factoryJoiner.instances, 'the joiner never opened a connection to the host').toHaveLength(1)
    const joinerMethods = factoryJoiner.instances[0]!.calls.map((c) => c.method)
    expect(joinerMethods, "the host's offer was sent before the joiner was listening, and lost").toContain('setRemoteDescription')
    expect(joinerMethods).toContain('createAnswer')

    // And the answer reached the host, which is the whole of "both ways".
    const hostMethods = factoryHost.instances[0]!.calls.map((c) => c.method)
    expect(hostMethods, "the joiner's answer never reached the host").toContain('setRemoteDescription')

    host.leave()
    joiner.leave()
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

  it('takes a device that says goodbye out of the room at once, not after the presence timeout', async () => {
    // Jitsi removes a tile the moment somebody hangs up. Waiting out
    // PRESENCE_TTL_SECONDS is not just slow to look at: every other device
    // spends that time escalating its route ladder - a volunteer, a
    // forwarder, then TURN - chasing a device that has gone.
    const relay = new SimRelay()
    const a = room(now, relay)
    const b = room(now, relay)
    await a.join([{ trackId: 'mic', role: 'mic' }], { mic: NOW })
    await b.join([], {})
    await settle()
    expect(b.participants().map((v) => v.participant)).toContain(a.participant)

    a.leave()
    await settle()

    expect(b.participants().map((v) => v.participant)).not.toContain(a.participant)
  })

  it('does not let an entry delivered late, from before the goodbye, bring a departed device back', async () => {
    // Three relays deliver in three orders. A heartbeat that left the device
    // before its farewell can arrive at somebody after it, and if that
    // resurrected the device it would sit in the room for the whole
    // presence timeout, exactly as if nobody had said goodbye at all.
    const relay = new SimRelay()
    const a = room(now, relay)
    const b = room(now, relay)
    await a.join([], {})
    await b.join([], {})
    await settle()
    const earlier = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === a.device)
    expect(earlier.length).toBeGreaterThan(0)

    a.leave()
    await settle()
    expect(b.participants().map((v) => v.participant)).not.toContain(a.participant)

    for (const stale of earlier) relay.publish(stale)
    await settle()
    expect(b.participants().map((v) => v.participant)).not.toContain(a.participant)
  })

  it('treats a device that left and came back as an arrival, and answers it', async () => {
    let t = NOW
    const clock = () => t
    const relay = new SimRelay()
    const deviceSk = generateSecretKey()
    const identity = localIdentity(generateSecretKey())
    const first = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity,
      deviceSk,
      now: clock,
      announceJitterMs: 0,
    })
    const b = room(clock, relay)
    await first.join([], {})
    await b.join([], {})
    await settle()
    first.leave()
    await settle()
    expect(b.participants().map((v) => v.participant)).not.toContain(first.participant)

    // Later, the same device on the same key comes back.
    t += 30
    const second = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity,
      deviceSk,
      now: clock,
      announceJitterMs: 0,
    })
    const before = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === b.device).length
    await second.join([], {})
    await settle()

    expect(b.participants().map((v) => v.participant)).toContain(second.participant)
    // b answered the arrival, so the newcomer learns b is here.
    const after = relay.published.filter((e) => e.kind === KINDS.ROSTER && e.pubkey === b.device).length
    expect(after).toBe(before + 1)
    expect(second.participants().map((v) => v.participant)).toContain(b.participant)
    second.leave()
    b.leave()
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

describe('RoomSession display names', () => {
  function named(relay: SimRelay, name: string | undefined, participantSk = generateSecretKey()) {
    return new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      name,
      now,
      announceJitterMs: 0,
    })
  }

  it('carries a name to everyone else in the room', async () => {
    const relay = new SimRelay()
    const robin = named(relay, 'Robin')
    const observer = named(relay, 'Observer')

    await robin.join([], {})
    await observer.join([], {})
    await settle()

    const view = observer.participants().find((v) => v.participant === robin.participant)
    expect(view!.name).toBe('Robin')
  })

  it('leaves a participant with no name unnamed, rather than inventing one', async () => {
    const relay = new SimRelay()
    const anonymous = named(relay, undefined)
    const observer = named(relay, 'Observer')

    await anonymous.join([], {})
    await observer.join([], {})
    await settle()

    const view = observer.participants().find((v) => v.participant === anonymous.participant)
    expect(view!.name).toBeUndefined()
  })

  it('keeps two participants who typed the same name distinguishable', async () => {
    const relay = new SimRelay()
    const one = named(relay, 'Robin')
    const two = named(relay, 'Robin')
    const observer = named(relay, 'Observer')

    await one.join([], {})
    await two.join([], {})
    await observer.join([], {})
    await settle()

    const robins = observer.participants().filter((v) => v.name === 'Robin')
    expect(robins).toHaveLength(2)
    // The name is the same; the identity is not, and that is what a
    // renderer has to show alongside it.
    expect(new Set(robins.map((v) => v.participant)).size).toBe(2)
    expect(one.participant).not.toBe(two.participant)
  })

  it('neutralises a name before it ever reaches a caller', async () => {
    const relay = new SimRelay()
    // Typed straight into the join field by somebody trying it on.
    const hostile = named(relay, '‮nerrad\n(you)')
    const observer = named(relay, 'Observer')

    await hostile.join([], {})
    await observer.join([], {})
    await settle()

    const view = observer.participants().find((v) => v.participant === hostile.participant)
    expect(view!.name).toBe('nerrad (you)')
    expect(view!.name).not.toMatch(/\p{C}/u)
  })

  it('shows one name for a person on two devices, not two', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const phone = named(relay, 'Robin', participantSk)
    const laptop = named(relay, 'Robin', participantSk)
    const observer = named(relay, 'Observer')

    await phone.join([], {})
    await laptop.join([], {})
    await observer.join([], {})
    await settle()

    const views = observer.participants().filter((v) => v.participant === getPublicKey(participantSk))
    expect(views).toHaveLength(1)
    expect(views[0].name).toBe('Robin')
    expect(views[0].devices).toHaveLength(2)
  })
})

describe('RoomSession presence is judged by this device, not by the sender', () => {
  function room(clock: () => number, relay: SimRelay, over: Partial<PrimaryRoomSessionOptions> = {}) {
    return new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now: clock,
      announceJitterMs: 0,
      ...over,
    })
  }

  it('BUG: keeps a device whose clock runs a little slow, rather than evicting it between heartbeats', async () => {
    // A phone a minute behind stamps every entry a minute in the past.
    // Judged on that stamp against the presence window it lapsed fifteen
    // seconds after every heartbeat: evicted at the next sweep, its peer
    // closed, its tile torn down - and re-admitted as a stranger on its
    // next heartbeat. Video that "kept dropping" on a clock that was
    // merely wrong. Heard-from time is what presence is judged by now.
    const relay = new SimRelay()
    let clock = NOW
    const mine = room(() => clock, relay)
    const slow = room(() => clock - 60, relay)

    await mine.join([], {})
    await slow.join([], {})
    await settle()
    expect(mine.participants().map((v) => v.participant)).toContain(slow.participant)

    // Twenty seconds on, with nothing said: on the old rule this entry was
    // already eighty seconds old and gone.
    clock = NOW + 20
    expect(mine.participants().map((v) => v.participant)).toContain(slow.participant)
    mine.leave()
    slow.leave()
  })

  it('refuses an entry stamped before the presence window, which is what a relay replaying the roster delivers', async () => {
    // Every relay this project has been pointed at keeps the "ephemeral"
    // roster kind and replays the last few dozen entries to a new
    // subscriber: the final heartbeat of every device that died without a
    // farewell. Admitted, each one is a ghost with a peer connection and a
    // tile for the whole timeout.
    const relay = new SimRelay()
    let clock = NOW
    const mine = room(() => clock, relay)
    const ghost = room(() => clock, relay)
    await ghost.join([], {})
    const announcement = relay.published.filter((e) => e.kind === KINDS.ROSTER).at(-1)!
    // The ghost dies. Its farewell goes to a room nobody is in yet, which
    // is what a crash looks like to whoever joins later; its announcement
    // sits on the relay.
    await ghost.leave()
    clock = NOW + PRESENCE_TTL_SECONDS + 30
    await mine.join([], {})
    // The simulator does not replay, so deliver the stored entry again the
    // way a replaying relay would.
    relay.publish(announcement)
    await settle()
    expect(mine.participants().map((v) => v.participant)).not.toContain(ghost.participant)
    // And a device this far behind is refused rather than admitted and
    // evicted every sweep: the same rule, stated as a price.
    const far = room(() => clock - PRESENCE_TTL_SECONDS - 10, relay)
    await far.join([], {})
    await settle()
    expect(mine.participants().map((v) => v.participant)).not.toContain(far.participant)
    mine.leave()
    far.leave()
  })

  it('still lapses a slow-clocked device once it really has gone quiet', async () => {
    const relay = new SimRelay()
    let clock = NOW
    const mine = room(() => clock, relay)
    const slow = room(() => clock - 30, relay)

    await mine.join([], {})
    await slow.join([], {})
    await settle()
    expect(mine.participants()).toHaveLength(2)

    // It goes quiet without a goodbye, and the window passes.
    clock = NOW + PRESENCE_TTL_SECONDS + 1
    expect(mine.participants()).toHaveLength(1)
    mine.leave()
    slow.leave()
  })

  it('BUG: keeps a device whose media is still flowing when its heartbeats stop arriving', async () => {
    // A tab in the background has its timers throttled. A relay drops its
    // socket. Through both the peer connection carries on - and the room
    // used to close it anyway, on the strength of a heartbeat that had not
    // come through a third party's relay, tearing down a working call.
    const relay = new SimRelay()
    let clock = NOW
    const factory = createFakeFactory()
    const mine = room(() => clock, relay, { factory })
    const theirs = room(() => clock, relay)

    await mine.join([], {})
    await theirs.join([{ trackId: 'cam', role: 'camera' }], {})
    await settle()
    const pc = factory.to(theirs.device)
    expect(pc).toBeDefined()
    pc!.connectionState = 'connected'
    pc!.onconnectionstatechange?.()
    expect(mine.routes.get(theirs.device)?.connected).toBe(true)

    // Their heartbeats stop reaching us, but the connection is up.
    clock = NOW + PRESENCE_TTL_SECONDS + 1
    expect(mine.participants().map((v) => v.participant)).toContain(theirs.participant)
    clock = NOW + 3 * PRESENCE_TTL_SECONDS
    expect(mine.participants().map((v) => v.participant)).toContain(theirs.participant)

    // The connection itself goes. ICE says so, the ladder runs out, and the
    // ordinary timeout takes over.
    pc!.connectionState = 'failed'
    pc!.onconnectionstatechange?.()
    await settle()
    const turn = factory.to(theirs.device)
    expect(turn).toBeDefined()
    turn!.connectionState = 'failed'
    turn!.onconnectionstatechange?.()
    await settle()
    expect(mine.routes.get(theirs.device)?.connected).toBe(false)
    clock = NOW + 4 * PRESENCE_TTL_SECONDS + 1
    expect(mine.participants().map((v) => v.participant)).not.toContain(theirs.participant)
    mine.leave()
    theirs.leave()
  })
})

describe('RoomSession credential renewal', () => {
  it('BUG: a primary device re-mints its credential before it lapses, so a standing room does not lose it at twelve hours', async () => {
    // A credential is minted once, at join, and lasts twelve hours. A room
    // meant to stay open for days used to evict every member at that mark:
    // heartbeats still arrived and were refused, because the proof inside
    // them had expired.
    vi.useFakeTimers()
    try {
      const relay = new SimRelay()
      let clock = NOW
      const mine = new RoomSession({
        transport: new SimTransport(relay),
        secret: secret(),
        identity: localIdentity(generateSecretKey()),
        deviceSk: generateSecretKey(),
        now: () => clock,
        announceJitterMs: 0,
        timing: { credentialTtlSeconds: 100, heartbeatIntervalMs: 1_000_000, sweepIntervalMs: 1_000_000 },
      })
      await mine.join([], {})
      const first = mine.credential
      expect(first).toBeDefined()

      clock = NOW + 50
      await vi.advanceTimersByTimeAsync(50_000)
      const second = mine.credential
      expect(second).toBeDefined()
      expect(second!.id).not.toBe(first!.id)
      const expiry = (c: typeof first) => Number(c!.tags.find((t) => t[0] === 'expiration')?.[1])
      expect(expiry(second)).toBeGreaterThan(expiry(first))

      // And it was restated under the new one, as an answer, not an arrival.
      const roster = relay.published.filter((e) => e.kind === KINDS.ROSTER)
      const latest = decodeRosterEvent(roster[roster.length - 1]!, {
        roomId: mine.roomId,
        roomKey: deriveRoom(secret()).roomKey,
        now: clock,
      })
      expect(latest?.credential.id).toBe(second!.id)
      expect(latest?.reply).toBe(true)

      // Chat goes out under the new credential too.
      await mine.chat.send('still here')
      const chat = relay.published.filter((e) => e.kind === KINDS.CHAT)
      expect(chat).toHaveLength(1)
      mine.leave()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not renew on a secondary device, which cannot sign for its participant', async () => {
    vi.useFakeTimers()
    try {
      const relay = new SimRelay()
      const participantSk = generateSecretKey()
      const deviceSk = generateSecretKey()
      const credential = await createDeviceCredential({
        identity: localIdentity(participantSk),
        devicePubkey: getPublicKey(deviceSk),
        roomId: ROOM_ID,
        expiresAt: NOW + 100,
        now,
      })
      const secondary = new RoomSession({
        transport: new SimTransport(relay),
        secret: secret(),
        credential,
        deviceSk,
        now,
        announceJitterMs: 0,
        timing: { credentialTtlSeconds: 100, heartbeatIntervalMs: 1_000_000, sweepIntervalMs: 1_000_000 },
      })
      await secondary.join([], {})
      await vi.advanceTimersByTimeAsync(80_000)
      expect(secondary.credential?.id).toBe(credential.id)
      secondary.leave()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RoomSession.advertise', () => {
  it('BUG: a track turned on after joining reaches the roster, so everybody else sees it advertised', async () => {
    const relay = new SimRelay()
    const mine = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    const theirs = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await mine.join([], {})
    await theirs.join([], {})
    await settle()
    const view = () => theirs.participants().find((v) => v.participant === mine.participant)
    expect(view()?.tracks).toEqual([])

    await mine.advertise([{ trackId: 'abc', role: 'camera' }, { trackId: 'def', role: 'mic' }], { mic: NOW })
    await settle()
    expect(view()?.tracks.map((t) => t.trackId)).toEqual(['abc', 'def'])
    expect(view()?.mic).toBe(mine.device)

    // As an answer, so the room does not re-announce at it.
    const roster = relay.published.filter((e) => e.kind === KINDS.ROSTER)
    const latest = decodeRosterEvent(roster[roster.length - 1]!, {
      roomId: mine.roomId,
      roomKey: deriveRoom(secret()).roomKey,
      now: NOW,
    })
    expect(latest?.reply).toBe(true)
    mine.leave()
    theirs.leave()
  })
})

describe('agents in the roster', () => {
  it('shows a device that declares itself an agent as one, on the participant it belongs to', async () => {
    const relay = new SimRelay()
    const person = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    const agent = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
      name: 'Ada',
      agent: true,
    })
    await person.join([], {})
    await agent.join([], {})
    await settle()
    const views = person.participants()
    expect(views.find((v) => v.participant === agent.participant)?.agent).toBe(true)
    expect(views.find((v) => v.participant === person.participant)?.agent).toBeUndefined()
    person.leave()
    agent.leave()
  })

  it('opens a named channel beside the main chat, which every member can read', async () => {
    const relay = new SimRelay()
    const make = (agent?: true) =>
      new RoomSession({
        transport: new SimTransport(relay),
        secret: secret(),
        identity: localIdentity(generateSecretKey()),
        deviceSk: generateSecretKey(),
        now,
        announceJitterMs: 0,
        ...(agent ? { agent } : {}),
      })
    const person = make()
    const a = make(true)
    const b = make(true)
    await person.join([], {})
    await a.join([], {})
    await b.join([], {})
    await settle()
    // Opened before anybody speaks: the simulator, like a real relay for an
    // ephemeral kind, replays nothing, and the point here is who can hear,
    // not what a late subscriber is sent.
    b.channel('agents')
    person.channel('agents')

    await a.channel('agents').send('I will take the research')
    await b.channel('agents').send('then I will draft')
    await a.chat.send('hello people')
    await settle()

    // The agents hear each other on the channel, the main chat is untouched,
    // and the person can read the channel too.
    // Sorted: the fixed test clock stamps both the same second, and a tie
    // breaks on the random message id.
    const said = (log: { messages(): { text: string }[] }) => log.messages().map((m) => m.text).sort()
    expect(said(b.channel('agents'))).toEqual(['I will take the research', 'then I will draft'])
    expect(said(person.chat)).toEqual(['hello people'])
    expect(said(person.channel('agents'))).toEqual(['I will take the research', 'then I will draft'])
    // The same log comes back for the same name.
    expect(person.channel('agents')).toBe(person.channel('agents'))
    person.leave()
    a.leave()
    b.leave()
  })
})
