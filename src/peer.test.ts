import { describe, it, expect } from 'vitest'
import { Peer, MAX_PENDING_CANDIDATES } from './peer.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import type { SignalBody } from './signal.js'

const LOW = 'a'.repeat(64)
const HIGH = 'b'.repeat(64)

function fakeTrack(): MediaStreamTrack {
  return {} as MediaStreamTrack
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

  it('start() creates an offer, sets it locally, and emits it via onSignal', async () => {
    const factory = createFakeFactory()
    const signals: SignalBody[] = []
    const track = fakeTrack()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: (b) => signals.push(b), onTrack: () => {} })

    await peer.start([track])

    const pc = factory.instances[0]!
    expect(pc.tracks).toEqual([track])
    expect(pc.calls.map((c) => c.method)).toEqual(['addTrack', 'createOffer', 'setLocalDescription'])
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'offer', sdp: pc.localDescription?.sdp })
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

    // Both sides offer simultaneously - the mesh scenario that makes glare possible.
    await polite.start([])
    await impolite.start([])

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

  it('closes itself when the underlying connection reports it has failed', async () => {
    const factory = createFakeFactory()
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, onSignal: () => {}, onTrack: () => {} })
    await peer.start([])

    const pc = factory.instances[0]!
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(pc.closed).toBe(true)
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

    const offering = peer.start([])
    const incoming = peer.handleSignal({ type: 'offer', roomId: 'room', sdp: 'remote-offer-sdp' })
    await Promise.all([offering, incoming])

    const pc = factory.instances[0]!
    const methods = pc.calls.map((c) => c.method)
    // Our own offer completes first, then the incoming one is dealt with -
    // never half of each.
    expect(methods.slice(0, 2)).toEqual(['createOffer', 'setLocalDescription'])
    expect(signals[0]).toMatchObject({ type: 'offer' })
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
    await peer.start([])
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
