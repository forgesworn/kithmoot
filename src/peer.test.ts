import { describe, it, expect, vi } from 'vitest'
import { Peer, MAX_PENDING_CANDIDATES } from './peer.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import type { SignalBody } from './signal.js'

const LOW = 'a'.repeat(64)
const HIGH = 'b'.repeat(64)

function fakeTrack(): MediaStreamTrack {
  return {} as MediaStreamTrack
}

/** Lets the peer's operation queue drain. Every negotiation step is queued,
 *  so anything triggered by a callback lands a few turns later. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('Peer', () => {
  it('decides politeness by comparing device pubkeys, and the two sides disagree', () => {
    const factory = createFakeFactory()
    const low = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const high = new Peer({ factory, localDevice: HIGH, remoteDevice: LOW, onSignal: () => {}, onTrack: () => {} })

    expect(low.polite).toBe(true)
    expect(high.polite).toBe(false)
  })

  it('BUG: politeness must still be opposite when a device pubkey reaches Peer in a different case on each side', () => {
    // Two real devices, X and Y. X's own pubkey is always its own canonical
    // lower-case form. Y's pubkey, as it happens to have reached X's side of
    // the connection (say, decoded off a roster entry Y itself published),
    // is the same identifier but in upper case - nothing on the wire
    // enforces a single case. `hexEquals` would treat these as the same
    // device; the politeness tiebreak uses `<`, which does not.
    //
    // If both sides land on the same politeness because of a case
    // difference like this, both offer at once, neither backs off, and the
    // connection wedges permanently - the exact glare deadlock perfect
    // negotiation exists to prevent. So this must always come out opposite,
    // regardless of case.
    const deviceX = 'a'.repeat(64)
    const deviceYLower = 'b'.repeat(64)
    const deviceYAsSeenByX = 'B'.repeat(64) // the same device, differently cased

    const xSide = new Peer({
      factory: createFakeFactory(),
      localDevice: deviceX,
      remoteDevice: deviceYAsSeenByX,
      onSignal: () => {},
      onTrack: () => {},
    })
    const ySide = new Peer({
      factory: createFakeFactory(),
      localDevice: deviceYLower,
      remoteDevice: deviceX,
      onSignal: () => {},
      onTrack: () => {},
    })

    expect(xSide.polite).toBe(!ySide.polite)
  })

  it('start() attaches the track, and the offer that follows is emitted via onSignal', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const track = fakeTrack()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    // Attaching the track is what makes the connection ask to negotiate, and
    // that request is what produces the offer - one trigger, not two. The
    // offer therefore lands a turn after `start()` resolves.
    await peer.start([track])
    await settle()

    const pc = factory.instances[0]!
    expect(pc.tracks).toEqual([track])
    expect(pc.calls.map((c) => c.method)).toEqual(['addTrack', 'createOffer', 'setLocalDescription'])
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'offer', sdp: pc.localDescription?.sdp })
  })

  /**
   * Somebody who joins with their camera and microphone off - which is how
   * most people join most calls - must not send an offer with nothing in it.
   *
   * `createOffer()` on a connection with no transceivers produces an offer
   * with no m-lines: nothing to negotiate, no ICE, and a connection that
   * never comes up. Measured in a browser on 29 August 2026, that is exactly
   * what happened - both sides ended `closed`, the sender's transceivers
   * `stopped`, and the route ladder escalated a connection that was never
   * going to work through assist and forwarder to TURN. The room then stayed
   * broken after the person turned their camera back on, because the peers
   * had already been closed and were never rebuilt.
   *
   * Saying nothing is the right answer: the other side has media, so the
   * other side offers, and this one answers and receives.
   */
  it('does not offer when it has nothing to send', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.start([])

    expect(factory.instances[0]!.calls.map((c) => c.method)).toEqual([])
    expect(signals, 'an offer with no m-lines negotiates nothing').toEqual([])
  })

  /**
   * The other half of perfect negotiation.
   *
   * The polite side resolves glare by rolling its own offer back and
   * answering the incoming one. Its tracks are still attached and still
   * unnegotiated, and the design assumes the connection will say so and be
   * re-offered. Nothing was listening, so those tracks were lost for the
   * life of the call - which in a browser looked like a person with a
   * microphone and no camera never seeing anybody else's video.
   */
  it('offers again when the connection says negotiation is needed', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.start([fakeTrack()])
    await settle()
    expect(signals).toHaveLength(1)

    // The answer lands, so the connection is idle again - which is the only
    // state a fresh offer belongs in.
    const pc = factory.instances[0]!
    await peer.handleSignal({ type: 'answer', roomId: 'room', sdp: 'answer-sdp' })
    expect(pc.signalingState).toBe('stable')

    pc.onnegotiationneeded?.()
    await settle()

    expect(signals, 'a rolled-back offer is never made again').toHaveLength(2)
    expect(signals[1]).toMatchObject({ type: 'offer' })
  })

  it('does not offer into a negotiation that is already under way', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.start([fakeTrack()])
    await settle()
    const pc = factory.instances[0]!
    // Mid-negotiation: the offer is out and its answer has not arrived, so
    // attaching the track has already left the connection busy.
    expect(pc.signalingState).toBe('have-local-offer')
    pc.onnegotiationneeded?.()
    await settle()

    // A real connection re-reports the change on the way back to `stable`,
    // so skipping this one loses nothing.
    expect(signals).toHaveLength(1)
  })

  /**
   * BUG: two people who both turn a camera and a microphone on could
   * neither see nor hear each other, for the whole call.
   *
   * `negotiationneeded` is delivered as a queued task, so it routinely
   * describes a moment that has already passed: the flag goes up while the
   * connection is `stable`, and by delivery our own `addTrack` offer has
   * already moved it to `have-local-offer`. The handler skipped that - but
   * it skipped it from INSIDE the operations queue, which is a different
   * question asked at a different time. By the time the queued check ran,
   * the glare that arrived in between had been resolved: rolled back,
   * answered, back at `stable`. So the check passed and the stale event
   * became a real, extra offer.
   *
   * That offer is not free. It opens a second negotiation on a connection
   * whose ICE and DTLS are already up, and `connectionState` does not report
   * `connected` while one is outstanding - so `Mesh`'s route timer times out
   * a rung that is carrying media, tears the peer down and escalates towards
   * TURN, over and over. The one-sided case hid it completely: with only one
   * side publishing there is no glare, nothing to roll back, and the room
   * worked perfectly.
   */
  it('BUG: a negotiationneeded raised mid-negotiation must not become an offer once the glare is resolved', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    // The polite side: the one that rolls its own offer back and answers.
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.start([fakeTrack()])
    await settle()
    const pc = factory.instances[0]!
    expect(pc.signalingState).toBe('have-local-offer')
    expect(signals).toHaveLength(1)

    // The glare: the far end offered at the same instant, so this side is
    // about to roll back and answer instead. Deliberately not awaited yet -
    // it is queued, and what happens next has to land behind it, which is
    // the ordering a relay subscription and an event task produce between
    // them.
    const glare = peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'their-offer' })

    // The stale event: raised while the connection is busy with our own
    // offer, which is exactly when a browser delivers one it queued a moment
    // earlier. By the time anything queued here runs, the glare above will
    // have been resolved and the connection will be back at `stable`.
    pc.onnegotiationneeded?.()

    await glare
    await settle()

    expect(pc.signalingState).toBe('stable')
    expect(
      signals.map((s) => s.type),
      'the stale negotiationneeded re-opened a negotiation on a connection that had just settled',
    ).toEqual(['offer', 'answer'])
  })

  /**
   * Turning a camera off has to actually stop sending it.
   *
   * `start()` only ever added tracks, so a device that stopped its camera
   * left the sender in place and simply went quiet. The far end is not told
   * anything by silence: its track never ends and never mutes, so the last
   * frame it decoded stays on screen. Measured in a browser, somebody who
   * turned their camera off was still sitting on the other person's screen
   * frozen mid-gesture, and turning it back on arrived as a SECOND picture
   * beside the stale one.
   *
   * Removing the sender is what makes "off" mean off. The re-offer that has
   * to follow comes from `onnegotiationneeded`.
   */
  it('stops sending a track that is no longer published', async () => {
    const factory = createFakeFactory()
    const camera = fakeTrack()
    const mic = fakeTrack()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })

    await peer.start([camera, mic])
    const pc = factory.instances[0]!
    expect(pc.tracks).toEqual([camera, mic])

    // The camera goes off: the caller republishes what is left.
    await peer.start([mic])

    expect(pc.tracks, 'the camera is still being sent').toEqual([mic])
    expect(pc.calls.filter((c) => c.method === 'removeTrack')).toHaveLength(1)
  })

  it('re-adds a track that comes back after being turned off', async () => {
    const factory = createFakeFactory()
    const camera = fakeTrack()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })

    await peer.start([camera])
    await peer.start([])
    // A camera turned back on is a brand new track, but the same one coming
    // back must work too - `#addedTracks` has to forget what it removed.
    await peer.start([camera])

    expect(factory.instances[0]!.tracks).toEqual([camera])
  })

  it('answers an incoming offer when there is no outgoing offer pending', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })

    const pc = factory.instances[0]!
    expect(pc.calls.map((c) => c.method)).toEqual(['setRemoteDescription', 'createAnswer', 'setLocalDescription'])
    expect(pc.calls[0]?.args[0]).toMatchObject({ type: 'offer', sdp: 'remote-offer-sdp' })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'answer', sdp: pc.localDescription?.sdp })
  })

  it('applies an incoming ICE candidate once the remote description is set', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 4400 typ host', sdpMid: '0', sdpMLineIndex: 0 }

    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })
    await peer.handleSignal({ type: 'ice', roomId: 'room', candidate: JSON.stringify(candidate) })

    const pc = factory.instances[0]!
    const applied = pc.calls.find((c) => c.method === 'addIceCandidate')
    expect(applied?.args[0]).toEqual(candidate)
  })

  it('forwards a track the fake connection reports via ontrack', async () => {
    const factory = createFakeFactory()
    const tracks: MediaStreamTrack[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: (t) => tracks.push(t) })
    await peer.start([])

    const pc = factory.instances[0]!
    const remoteTrack = fakeTrack()
    pc.ontrack?.({ track: remoteTrack })

    expect(tracks).toEqual([remoteTrack])
  })

  it('buffers ICE candidates that arrive before the remote description, and applies them afterwards', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 4400 typ host', sdpMid: '0', sdpMLineIndex: 0 }

    // Trickle ICE routinely delivers candidates before the description they
    // belong to. They must not be dropped on the floor.
    await peer.handleSignal({ type: 'ice', roomId: 'room', candidate: JSON.stringify(candidate) })

    const pc = factory.instances[0]!
    expect(pc.calls.filter((c) => c.method === 'addIceCandidate')).toHaveLength(0)

    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })

    const methods = pc.calls.map((c) => c.method)
    expect(methods.indexOf('addIceCandidate')).toBeGreaterThan(methods.indexOf('setRemoteDescription'))
    expect(pc.calls.find((c) => c.method === 'addIceCandidate')?.args[0]).toEqual(candidate)
  })

  it('glare: the polite peer rolls back and answers, the impolite peer ignores the incoming offer', async () => {
    const factoryLow = createFakeFactory()
    const factoryHigh = createFakeFactory()
    const signalsFromLow: SignalBody[] = []
    const signalsFromHigh: SignalBody[] = []

    // LOW < HIGH, so the LOW-local peer is polite and the HIGH-local peer is not.
    const polite = new Peer({
      factory: factoryLow,
      localDevice: LOW,
      remoteDevice: HIGH,
      onSignal: (b) => signalsFromLow.push(b),
      onTrack: () => {},
    })
    const impolite = new Peer({
      factory: factoryHigh,
      localDevice: HIGH,
      remoteDevice: LOW,
      onSignal: (b) => signalsFromHigh.push(b),
      onTrack: () => {},
    })
    expect(polite.polite).toBe(true)
    expect(impolite.polite).toBe(false)

    // Both sides offer simultaneously - the mesh scenario that makes glare
    // possible. Attaching a track is what asks for the offer, so both have
    // to settle before either offer exists to deliver.
    await polite.start([fakeTrack()])
    await impolite.start([fakeTrack()])
    await settle()

    const offerFromImpolite = signalsFromHigh[0]!
    const offerFromPolite = signalsFromLow[0]!

    // Deliver each side's offer to the other, as if they crossed on the wire.
    await polite.handleSignal(offerFromImpolite)
    await impolite.handleSignal(offerFromPolite)

    const politePc = factoryLow.instances[0]!
    const impolitePc = factoryHigh.instances[0]!

    // The polite side gives up its own offer and answers the one it received.
    const rollback = politePc.calls.find((c) => c.method === 'setLocalDescription' && (c.args[0] as { type?: string } | undefined)?.type === 'rollback')
    expect(rollback).toBeDefined()
    expect(politePc.calls.map((c) => c.method)).toContain('createAnswer')
    expect(signalsFromLow.filter((s) => s.type === 'answer')).toHaveLength(1)

    // The impolite side ignores the incoming offer entirely: no rollback, no answer.
    expect(impolitePc.calls.some((c) => c.method === 'setRemoteDescription')).toBe(false)
    expect(impolitePc.calls.some((c) => c.method === 'createAnswer')).toBe(false)
    expect(signalsFromHigh.filter((s) => s.type === 'answer')).toHaveLength(0)
  })

  describe('an offer that goes unanswered', () => {
    // The signalling channel is an ephemeral event on a public relay: it
    // reaches whoever is subscribed when it arrives and nobody later. An
    // offer sent a moment before the far end is listening is gone, and only
    // the offerer can tell - by the silence.
    const offers = (signals: SignalBody[]) => signals.filter((s) => s.type === 'offer')
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    it('is sent again, unchanged, a bounded number of times', async () => {
      const factory = createFakeFactory()
      const signals: SignalBody[] = []
      const peer = new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: (b) => signals.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 5, max: 2 },
      })
      await peer.start([fakeTrack()])
      await settle()
      expect(offers(signals)).toHaveLength(1)

      // Two more and then no more: a peer that never answers is the route
      // ladder's problem, not something to be asked for ever. The arrival is
      // waited for; the silence after it still needs a window to elapse.
      await vi.waitFor(() => expect(offers(signals).length).toBeGreaterThanOrEqual(3))
      await wait(60)
      expect(offers(signals)).toHaveLength(3)
      const sdps = new Set(offers(signals).map((s) => s.sdp))
      expect(sdps.size, 'a re-sent offer must be the same offer, not a new negotiation').toBe(1)
      // The same offer, which is to say the one the connection is still
      // holding - not a fresh createOffer.
      expect(factory.instances[0]!.calls.filter((c) => c.method === 'createOffer')).toHaveLength(1)
      peer.close()
    })

    it('stops being re-sent once it is answered', async () => {
      const factory = createFakeFactory()
      const signals: SignalBody[] = []
      const peer = new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: (b) => signals.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 10, max: 2 },
      })
      await peer.start([fakeTrack()])
      await settle()
      await peer.handleSignal({ type: 'answer', roomId: '', sdp: 'their-answer' })

      await wait(40)
      expect(offers(signals)).toHaveLength(1)
      peer.close()
    })

    it('is not re-sent after the polite side has rolled it back', async () => {
      const factory = createFakeFactory()
      const signals: SignalBody[] = []
      // LOW < HIGH: this side is polite.
      const peer = new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: (b) => signals.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 10, max: 2 },
      })
      await peer.start([fakeTrack()])
      await settle()
      // Glare: the far end's offer wins, ours is rolled back and answered.
      await peer.handleSignal({ type: 'offer', roomId: '', sdp: 'their-offer' })
      expect(signals.filter((s) => s.type === 'answer')).toHaveLength(1)

      await wait(40)
      expect(offers(signals), 'an offer we gave up on came back from a timer').toHaveLength(1)
      peer.close()
    })

    it('is not re-sent after close()', async () => {
      const factory = createFakeFactory()
      const signals: SignalBody[] = []
      const peer = new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: (b) => signals.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 5, max: 2 },
      })
      await peer.start([fakeTrack()])
      await settle()
      peer.close()

      await wait(30)
      expect(offers(signals)).toHaveLength(1)
    })

    /**
     * BUG: two people in a room, one of whom could see and hear the other,
     * and the other of whom could not.
     *
     * The impolite side's offer was lost on the way - sent a moment before
     * the far end was subscribed. The polite side, with media of its own,
     * offered in turn; the impolite side ignored that, as perfect negotiation
     * says it must while its own offer is outstanding, and then waited for an
     * answer to an offer nobody had. Neither side could move. Re-sending is
     * what breaks it: the polite side hears the offer it should have had,
     * rolls its own back and answers, and the answer carries its media too.
     */
    it('BUG: a lost offer from the impolite side no longer deadlocks the pair', async () => {
      const factoryPolite = createFakeFactory()
      const factoryImpolite = createFakeFactory()
      const fromPolite: SignalBody[] = []
      const fromImpolite: SignalBody[] = []
      const polite = new Peer({
        factory: factoryPolite,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: (b) => fromPolite.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 10, max: 2 },
      })
      const impolite = new Peer({
        factory: factoryImpolite,
        localDevice: HIGH,
        remoteDevice: LOW,
        onSignal: (b) => fromImpolite.push(b),
        onTrack: () => {},
        offerRetry: { intervalMs: 10, max: 2 },
      })

      // The impolite side offers first, and the offer goes nowhere.
      await impolite.start([fakeTrack()])
      await settle()
      expect(offers(fromImpolite)).toHaveLength(1)

      // The polite side, none the wiser, offers - and that one arrives.
      await polite.start([fakeTrack()])
      await settle()
      await impolite.handleSignal(offers(fromPolite)[0]!)
      // Ignored, as it should be: the impolite side's own offer stands.
      expect(factoryImpolite.instances[0]!.calls.some((c) => c.method === 'setRemoteDescription')).toBe(false)

      // Now the wire works again, and the re-sent offer gets through.
      await vi.waitFor(() => expect(offers(fromImpolite).length).toBeGreaterThan(1))
      await polite.handleSignal(offers(fromImpolite)[1]!)

      const politePc = factoryPolite.instances[0]!
      expect(politePc.calls.some((c) => c.method === 'setLocalDescription' && (c.args[0] as { type?: string })?.type === 'rollback')).toBe(true)
      const answer = fromPolite.find((s) => s.type === 'answer')
      expect(answer, 'the polite side never answered the re-sent offer').toBeDefined()

      await impolite.handleSignal(answer!)
      expect(factoryImpolite.instances[0]!.signalingState).toBe('stable')
      expect(politePc.signalingState).toBe('stable')

      // Answered, so the timer has nothing left to do.
      const sentSoFar = offers(fromImpolite).length
      await wait(40)
      expect(offers(fromImpolite)).toHaveLength(sentSoFar)
      polite.close()
      impolite.close()
    })
  })

  it('closes itself when the underlying connection reports it has failed', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    await peer.start([])

    const pc = factory.instances[0]!
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(pc.closed).toBe(true)
  })

  it('reports every connection state change to its caller, and still closes on a failure', async () => {
    // The mesh has to know when a connection actually came up, not merely
    // that it was asked to. Promotion to a forwarder turns on it: the direct
    // peers a room falls back to must stay open until the forwarder is
    // genuinely connected, and `connected` is the only honest signal for
    // that. `Peer` owns `onconnectionstatechange` on the connection, so a
    // caller cannot simply read it off the connection itself.
    const factory = createFakeFactory()
    const states: RTCPeerConnectionState[] = []
    const peer = new Peer({
      factory,
      localDevice: LOW,
      remoteDevice: HIGH,
      onSignal: () => {},
      onTrack: () => {},
      onConnectionState: (state) => states.push(state),
    })
    await peer.start([])

    const pc = factory.instances[0]!
    pc.connectionState = 'connected'
    pc.onconnectionstatechange?.()
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()
    // One restart is tried first - see below - so the failure that closes
    // the peer is the one after it.
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(states).toEqual(['connected', 'failed'])
    expect(pc.closed).toBe(true)
  })

  describe('riding out a network blip', () => {
    // A phone crossing from Wi-Fi to mobile, a laptop lid, a router hiccup:
    // ICE reports `disconnected`, and a few seconds later `failed`. Jitsi
    // and Signal survive it by restarting ICE on the connection they have.
    // Tearing the peer down and walking the route ladder instead costs the
    // pair a volunteer, then a forwarder, then TURN - for a path that would
    // have come back on its own.
    function connected(opts: { graceMs?: number; timeoutMs?: number } = {}) {
      const factory = createFakeFactory()
      const states: RTCPeerConnectionState[] = []
      const peer = new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: () => {},
        onTrack: () => {},
        onConnectionState: (state) => states.push(state),
        iceRestart: opts,
      })
      const pc = factory.instances[0]!
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
      return { peer, pc, states }
    }
    const restarts = (pc: { calls: { method: string }[] }) => pc.calls.filter((c) => c.method === 'restartIce').length

    it('restarts ICE after a grace period when a connected peer reports disconnected', async () => {
      const { pc, states } = connected({ graceMs: 5, timeoutMs: 1000 })
      pc.connectionState = 'disconnected'
      pc.onconnectionstatechange?.()
      // Not yet: most disconnections heal themselves inside the grace.
      expect(restarts(pc)).toBe(0)
      await vi.waitFor(() => expect(restarts(pc)).toBe(1))
      expect(pc.closed).toBe(false)
      expect(states).toEqual(['connected', 'disconnected'])
    })

    it('does not restart when the disconnection heals inside the grace', async () => {
      const { pc } = connected({ graceMs: 20, timeoutMs: 1000 })
      pc.connectionState = 'disconnected'
      pc.onconnectionstatechange?.()
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
      // Twice the grace, deliberately: the claim is that no restart happens,
      // and only an elapsed window can show that. Waiting for a condition
      // would return at once and prove nothing.
      await new Promise((r) => setTimeout(r, 40))

      expect(restarts(pc)).toBe(0)
    })

    it('gives a connected peer that fails one restart before reporting the failure', () => {
      const { pc, states } = connected({ timeoutMs: 1000 })
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()

      expect(restarts(pc)).toBe(1)
      expect(pc.closed).toBe(false)
      // The caller has not been told it failed, because it has not - yet.
      expect(states).toEqual(['connected'])
    })

    it('reports the failure and closes when the restart does not bring it back', async () => {
      const { pc, states } = connected({ timeoutMs: 5 })
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()
      await vi.waitFor(() => expect(states).toEqual(['connected', 'failed']))
      expect(pc.closed).toBe(true)
      expect(restarts(pc)).toBe(1)
    })

    it('restarts once per episode: a second failure after a restart is final', () => {
      const { pc, states } = connected({ timeoutMs: 1000 })
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()

      expect(restarts(pc)).toBe(1)
      expect(states).toEqual(['connected', 'failed'])
      expect(pc.closed).toBe(true)
    })

    it('is allowed another restart once the connection has come back', () => {
      const { pc } = connected({ timeoutMs: 1000 })
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()

      expect(restarts(pc)).toBe(2)
      expect(pc.closed).toBe(false)
    })

    it('never restarts a connection that has not come up: the route ladder owns that', () => {
      const factory = createFakeFactory()
      const states: RTCPeerConnectionState[] = []
      new Peer({
        factory,
        localDevice: LOW,
        remoteDevice: HIGH,
        onSignal: () => {},
        onTrack: () => {},
        onConnectionState: (state) => states.push(state),
        iceRestart: { timeoutMs: 1000 },
      })
      const pc = factory.instances[0]!
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()

      expect(restarts(pc)).toBe(0)
      expect(states).toEqual(['failed'])
      expect(pc.closed).toBe(true)
    })

    it('fails as it always did on a connection that cannot restart', () => {
      const { pc, states } = connected({ timeoutMs: 1000 })
      // Shadow the prototype's method: a double without one.
      ;(pc as { restartIce?: () => void }).restartIce = undefined
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()

      expect(states).toEqual(['connected', 'failed'])
      expect(pc.closed).toBe(true)
    })
  })

  it('BUG (I3): a buffered candidate that the connection rejects must not prevent the answer', async () => {
    // The routine trickle-ICE case the buffer exists for: a candidate turns up
    // before the description it belongs to, is held, and is stale or malformed
    // by the time it is drained. Rethrowing there abandons the offer handler
    // after setRemoteDescription - no answer is ever created, the mesh swallows
    // the rejection at its subscription boundary, and the connection wedges
    // silently. One bad candidate must cost one candidate, not the call.
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 4400 typ host', sdpMid: '0', sdpMLineIndex: 0 }

    await peer.handleSignal({ type: 'ice', roomId: 'room', candidate: JSON.stringify(candidate) })
    factory.instances[0]!.rejectIceCandidates = true

    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })

    const pc = factory.instances[0]!
    expect(pc.calls.map((c) => c.method)).toContain('addIceCandidate')
    expect(pc.calls.map((c) => c.method)).toContain('createAnswer')
    expect(signals.filter((s) => s.type === 'answer')).toHaveLength(1)
  })

  it('BUG (I6): two offers arriving in one tick must be handled one at a time, not interleaved', async () => {
    // Without an operations queue each inbound signal starts its own async
    // chain, and every one of them reads #makingOffer, #ignoreOffer and
    // #hasRemoteDescription across await points. Two offers landing together
    // therefore both see a stable connection, both apply a remote description,
    // and the answer emitted for the first one is generated against the
    // second one's description.
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    const pc = factory.instances[0]!
    const release = pc.block()
    const first = peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'offer-A' })
    const second = peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'offer-B' })
    release()
    await Promise.all([first, second])

    // Each offer is applied and answered before the next one is touched.
    const methods = pc.calls.map((c) => c.method)
    for (let i = 0; i < methods.length - 1; i++) {
      if (methods[i] === 'setRemoteDescription') {
        expect(methods[i + 1]).not.toBe('setRemoteDescription')
      }
    }
    expect(methods.filter((m) => m === 'setRemoteDescription')).toHaveLength(2)
  })

  it('BUG (I6): an offer arriving while start() is mid-flight must not be judged against a half-built state', async () => {
    // start() sets #makingOffer before its first await and clears it in a
    // finally; an offer that arrives inside that window decides collision,
    // politeness and rollback from a state the other chain is still writing.
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    const offering = peer.start([fakeTrack()])
    const incoming = peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })
    await Promise.all([offering, incoming])
    await settle()

    const pc = factory.instances[0]!
    // Attaching a track is not a negotiation step - what is under test here
    // is the order of the negotiation itself.
    const methods = pc.calls.map((c) => c.method).filter((m) => m !== 'addTrack')

    // Each negotiation runs to completion before the next one starts: an
    // answer is never generated against a description that arrived after the
    // offer it answers. Which one goes first is not the point and is not
    // asserted - attaching a track asks the connection to negotiate rather
    // than offering on the spot, so the arrival is simply dealt with first
    // and this side's own change is offered after it.
    for (let i = 0; i < methods.length - 1; i++) {
      if (methods[i] === 'setRemoteDescription') {
        expect(methods[i + 1], 'two descriptions applied back to back').not.toBe('setRemoteDescription')
      }
    }
    expect(methods, 'the arrival was never answered').toContain('createAnswer')
    expect(methods, "this side's own change was never offered").toContain('createOffer')
    expect(signals.map((sig) => sig.type)).toEqual(['answer', 'offer'])
  })

  it('BUG (I7): a rollback clears the remote description, so later candidates are buffered again', async () => {
    // #hasRemoteDescription is a one-way latch. Once the polite side rolls
    // its own offer back it is renegotiating, and candidates arriving for the
    // description that has not landed yet belong to that new description -
    // they must be held, not applied against the previous one.
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 4400 typ host', sdpMid: '0', sdpMLineIndex: 0 }

    // A first negotiation completes, so a remote description is in place.
    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-1' })

    // Now both sides re-offer at once. The polite side rolls back - and the
    // incoming description then fails to apply, which leaves the connection
    // renegotiating with no current remote description at all.
    await peer.start([fakeTrack()])
    factory.instances[0]!.failNextSetRemoteDescription = true
    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-2' }).catch(() => {})

    const pc = factory.instances[0]!
    const before = pc.calls.filter((c) => c.method === 'addIceCandidate').length
    await peer.handleSignal({ type: 'ice', roomId: 'room', candidate: JSON.stringify(candidate) })
    expect(pc.calls.filter((c) => c.method === 'addIceCandidate')).toHaveLength(before)

    // Held, not dropped: the next description that does apply drains it.
    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-3' })
    expect(pc.calls.filter((c) => c.method === 'addIceCandidate').length).toBe(before + 1)
  })

  it('BUG (I5): the pending-candidate buffer is bounded', async () => {
    // A peer that never sends a description can otherwise trickle candidates
    // into an unbounded array for as long as the room is open.
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    const candidate = (n: number) => JSON.stringify({ candidate: `candidate:${n}`, sdpMid: '0', sdpMLineIndex: 0 })

    for (let i = 0; i < MAX_PENDING_CANDIDATES + 20; i++) {
      await peer.handleSignal({ type: 'ice', roomId: 'room', candidate: candidate(i) })
    }
    await peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })

    const pc = factory.instances[0]!
    const applied = pc.calls.filter((c) => c.method === 'addIceCandidate')
    expect(applied).toHaveLength(MAX_PENDING_CANDIDATES)
    // The oldest are the ones dropped: the newest candidates are the ones
    // most likely still to work.
    expect((applied[0]!.args[0] as { candidate: string }).candidate).toBe('candidate:20')
  })

  it('close() is idempotent', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    await peer.start([])

    peer.close()
    peer.close()

    const pc = factory.instances[0]!
    expect(pc.calls.filter((c) => c.method === 'close')).toHaveLength(1)
  })
})
