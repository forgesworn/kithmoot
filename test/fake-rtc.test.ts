import { describe, it, expect } from 'vitest'
import {
  FakeRTCPeerConnection,
  FakeRtcLink,
  fakeTrack,
  trackState,
  parseFakeSdp,
  type FakeConnectionOptions,
  type FakeRtpTransceiver,
} from './fake-rtc.js'

/** The fixed slot order of the call-reliability spec, section 3.1. */
const SLOTS: ['audio' | 'video', string][] = [
  ['audio', 'mic'],
  ['video', 'camera'],
  ['video', 'screen'],
  ['audio', 'screen-audio'],
]

function openSlots(pc: FakeRTCPeerConnection): FakeRtpTransceiver[] {
  return SLOTS.map(([kind]) => pc.addTransceiver(kind, { direction: 'sendrecv' }))
}

/** What the answerer is required to do by amendment A1: bind the transceivers
 *  the remote offer created, rather than opening its own. */
function bindSlots(pc: FakeRTCPeerConnection, tracks: Partial<Record<string, MediaStreamTrack>> = {}): void {
  for (const [index, [, role]] of SLOTS.entries()) {
    const transceiver = pc.transceiverByMid(String(index))
    if (!transceiver) continue
    transceiver.direction = 'sendrecv'
    const track = tracks[role]
    if (track) void transceiver.sender.replaceTrack(track)
  }
}

function linked(options: FakeConnectionOptions = {}) {
  const a = new FakeRTCPeerConnection(options)
  const b = new FakeRTCPeerConnection(options)
  openSlots(a)
  return { a, b, link: new FakeRtcLink(a, b, { onRemoteOffer: (answerer) => bindSlots(answerer) }) }
}

describe('fake-rtc: slots and negotiation', () => {
  it('assigns a mid to every slot at setLocalDescription, and not before', async () => {
    const pc = new FakeRTCPeerConnection()
    const slots = openSlots(pc)
    expect(slots.map((t) => t.mid)).toEqual([null, null, null, null])

    const offer = await pc.createOffer()
    expect(slots.map((t) => t.mid), 'createOffer alone must not associate').toEqual([null, null, null, null])

    await pc.setLocalDescription(offer)
    expect(slots.map((t) => t.mid)).toEqual(['0', '1', '2', '3'])
    expect(parseFakeSdp(offer.sdp)!.map((m) => m.kind)).toEqual(['audio', 'video', 'video', 'audio'])
  })

  it('both ends agree on the mid of every slot', async () => {
    const { a, b, link } = linked()
    await link.negotiate()
    expect(a.getTransceivers().map((t) => t.mid)).toEqual(['0', '1', '2', '3'])
    expect(b.getTransceivers().map((t) => t.mid)).toEqual(['0', '1', '2', '3'])
    expect(b.getTransceivers().map((t) => t.kind)).toEqual(['audio', 'video', 'video', 'audio'])
  })

  it('an offer and an answer plus one candidate each way reaches connected', async () => {
    const { a, b, link } = linked()
    expect(a.connectionState).toBe('new')
    await link.negotiate()
    expect(a.connectionState).toBe('connected')
    expect(b.connectionState).toBe('connected')
    expect(a.signalingState).toBe('stable')
    expect(b.signalingState).toBe('stable')
    expect(a.getTransceivers().every((t) => t.currentDirection === 'sendrecv')).toBe(true)
  })

  it('replaceTrack swaps a slot with no renegotiation and no new m-line', async () => {
    const { a, link } = linked()
    await link.negotiate()
    let renegotiations = 0
    a.onnegotiationneeded = () => {
      renegotiations += 1
    }
    const before = a.getTransceivers().length
    await a.transceiverByMid('1')!.sender.replaceTrack(fakeTrack('video', 'cam-1'))
    await a.transceiverByMid('1')!.sender.replaceTrack(fakeTrack('video', 'cam-2'))
    await a.transceiverByMid('1')!.sender.replaceTrack(null)
    expect(renegotiations).toBe(0)
    expect(a.getTransceivers()).toHaveLength(before)
    expect(a.calls.filter((c) => c.method === 'createOffer')).toHaveLength(1)
  })

  it('currentDirection follows what the two ends actually agreed', async () => {
    const a = new FakeRTCPeerConnection()
    const b = new FakeRTCPeerConnection()
    a.addTransceiver('video', { direction: 'sendonly' })
    const link = new FakeRtcLink(a, b)
    await link.negotiate()
    expect(a.transceiverByMid('0')!.currentDirection).toBe('sendonly')
    expect(b.transceiverByMid('0')!.currentDirection).toBe('recvonly')
  })

  it('a stopped slot reports currentDirection stopped, which the H5 filter looks for', async () => {
    const { a, link } = linked()
    await link.negotiate()
    const slot = a.transceiverByMid('2')!
    slot.stop()
    expect(slot.currentDirection).toBe('stopped')
  })

  it('every addTrack toggle costs another m-line, which is H1 in one line', async () => {
    const pc = new FakeRTCPeerConnection({ structuredSdp: true })
    const first = fakeTrack('video', 'cam-1')
    const sender = pc.addTrack(first)
    expect(pc.getTransceivers()).toHaveLength(1)
    pc.removeTrack(sender)
    pc.addTrack(fakeTrack('video', 'cam-2'))
    expect(pc.getTransceivers(), 'a re-added camera cannot reuse the m-line it left behind').toHaveLength(2)
  })

  it('BUG: a real removeTrack empties the caller\'s sender, and Peer reads it afterwards', async () => {
    // The faithful mode is what every browser does. `Peer.#start` calls
    // `removeTrack(sender)` and then `this.#addedTracks.delete(sender.track)`
    // to forget what it dropped - by which point a real `sender.track` is
    // already null, so the track stays in `#addedTracks` and the same track
    // object coming back is never re-added. Masked in the app because a
    // camera toggle mints a new track, not masked for a pipeline swap that
    // restores one. Recorded here so S9 has the case; the fixture defaults to
    // the compatible behaviour so the existing peer tests are untouched.
    const faithful = new FakeRTCPeerConnection({ nullTrackOnRemove: true })
    const camera = fakeTrack('video', 'cam-1')
    const sender = faithful.addTrack(camera)
    faithful.removeTrack(sender)
    expect(sender.track, 'a browser nulls it synchronously').toBeNull()

    const compatible = new FakeRTCPeerConnection()
    const other = fakeTrack('video', 'cam-2')
    const kept = compatible.addTrack(other)
    compatible.removeTrack(kept)
    expect(kept.track, 'this fixture leaves the detached object alone').toBe(other)
    expect(compatible.getTransceivers()[0]!.sender.track, 'the slot still stops sending').toBeNull()
  })

  it('an answerer that opens its own slots doubles the m-line count, which is why A1 exists', async () => {
    const a = new FakeRTCPeerConnection()
    const b = new FakeRTCPeerConnection()
    openSlots(a)
    // The mistake: four transceivers on the answering side too. JSEP will not
    // associate them with the offerer's m-lines, so four more are created.
    openSlots(b)
    const link = new FakeRtcLink(a, b)
    await link.negotiate()
    expect(b.getTransceivers()).toHaveLength(8)
    expect(a.getTransceivers(), 'and the offerer now has four m-lines it never asked for').toHaveLength(8)
  })
})

describe('fake-rtc: m-line order enforcement', () => {
  it('accepts a re-offer that keeps the m-line order', async () => {
    const { a, b, link } = linked()
    await link.negotiate()
    const again = await a.createOffer()
    await a.setLocalDescription(again)
    await expect(b.setRemoteDescription(a.localDescription!)).resolves.toBeUndefined()
  })

  it('rejects an offer from a rebuilt connection whose m-lines are in a different order', async () => {
    const { b, link } = linked()
    await link.negotiate()

    // A rebuild at gen+1: a brand new connection object, slots opened in a
    // different order because a share was running this time.
    const rebuilt = new FakeRTCPeerConnection()
    rebuilt.addTransceiver('video')
    rebuilt.addTransceiver('audio')
    rebuilt.addTransceiver('video')
    rebuilt.addTransceiver('audio')
    const offer = await rebuilt.createOffer()
    await rebuilt.setLocalDescription(offer)

    await expect(b.setRemoteDescription(rebuilt.localDescription!)).rejects.toThrow(/order of m-lines/)
  })

  it('rejects an offer with fewer m-lines than the session already has', async () => {
    const { b, link } = linked()
    await link.negotiate()
    const shrunk = new FakeRTCPeerConnection()
    shrunk.addTransceiver('audio')
    shrunk.addTransceiver('video')
    await shrunk.setLocalDescription(await shrunk.createOffer())
    await expect(b.setRemoteDescription(shrunk.localDescription!)).rejects.toThrow(/m-lines removed/)
  })

  it('leaves an opaque SDP alone, so the older negotiation tests are untouched', async () => {
    const pc = new FakeRTCPeerConnection()
    await pc.setRemoteDescription({ type: 'offer', sdp: 'remote-offer-sdp' })
    expect(pc.signalingState).toBe('have-remote-offer')
    expect(pc.getTransceivers()).toHaveLength(0)
    const offer = await pc.createOffer()
    expect(offer.sdp).toMatch(/^offer-sdp-\d+$/)
  })
})

describe('fake-rtc: stats', () => {
  it('counters advance only while a track is attached and the direction carries it', async () => {
    const { a, b, link } = linked()
    const mic = fakeTrack('audio', 'mic-1')
    const camera = fakeTrack('video', 'cam-1')
    await link.negotiate()
    await a.transceiverByMid('0')!.sender.replaceTrack(mic)
    await a.transceiverByMid('1')!.sender.replaceTrack(camera)

    link.tick(3)
    const report = await b.getStats()
    const inbound = (mid: string) => report.get(`inbound-${mid}`) as Record<string, number>
    expect(inbound('0').packetsReceived).toBe(150)
    expect(inbound('1').framesDecoded).toBe(90)
    expect(inbound('2').packetsReceived, 'an empty screen slot receives nothing').toBe(0)
    expect(inbound('3').packetsReceived).toBe(0)

    // Camera off is one replaceTrack, and the packets stop with no
    // renegotiation anywhere.
    await a.transceiverByMid('1')!.sender.replaceTrack(null)
    link.tick(3)
    const after = (await b.getStats()).get('inbound-1') as Record<string, number>
    expect(after.framesDecoded).toBe(90)
    expect(((await b.getStats()).get('inbound-0') as Record<string, number>).packetsReceived).toBe(300)
  })

  it('nothing moves while the transport is down', async () => {
    const { a, b, link } = linked()
    await link.negotiate()
    await a.transceiverByMid('0')!.sender.replaceTrack(fakeTrack('audio', 'mic-1'))
    link.tick()
    link.disconnect()
    link.tick(5)
    expect(((await b.getStats()).get('inbound-0') as Record<string, number>).packetsReceived).toBe(50)
  })

  it('reports outbound and remote-inbound only for slots that are sending', async () => {
    const { a, link } = linked()
    await link.negotiate()
    await a.transceiverByMid('0')!.sender.replaceTrack(fakeTrack('audio', 'mic-1'))
    link.tick(2)
    const report = await a.getStats()
    expect([...report.values()].filter((s) => s.type === 'outbound-rtp')).toHaveLength(1)
    const remote = [...report.values()].find((s) => s.type === 'remote-inbound-rtp') as Record<string, number>
    expect(remote.roundTripTimeMeasurements).toBe(2)
    expect(report.get('outbound-2'), 'an empty slot has no outbound-rtp at all').toBeUndefined()
  })

  it('scripted counters need no link at all', async () => {
    const { a, link } = linked()
    await link.negotiate()
    a.scriptStats('1', { packetsReceived: 249 })
    expect(a.statsFor('1').inbound.packetsReceived).toBe(249)
    expect(((await a.getStats()).get('inbound-1') as Record<string, number>).packetsReceived).toBe(249)
  })
})

describe('fake-rtc: receiver identity', () => {
  it('Chromium shape: the receiver track id is the sender\'s, and replaceTrack does not move it', async () => {
    const { a, b, link } = linked({ receiverTrackIds: 'msid' })
    await a.getTransceivers()[1]!.sender.replaceTrack(fakeTrack('video', 'cam-first'))
    await link.negotiate()
    const received = b.transceiverByMid('1')!.receiver.track!
    expect(trackState(received).id).toBe('cam-first')
    await a.transceiverByMid('1')!.sender.replaceTrack(fakeTrack('video', 'cam-second'))
    expect(trackState(b.transceiverByMid('1')!.receiver.track!).id, 'a=msid is fixed at negotiation').toBe('cam-first')
  })

  it('Firefox shape: the receiver mints its own id, which never matches an advert', async () => {
    const { a, b, link } = linked({ receiverTrackIds: 'local' })
    await a.getTransceivers()[1]!.sender.replaceTrack(fakeTrack('video', 'cam-first'))
    await link.negotiate()
    expect(trackState(b.transceiverByMid('1')!.receiver.track!).id).not.toBe('cam-first')
  })

  it('a remote track starts muted and unmutes when packets actually arrive', async () => {
    const { a, b, link } = linked()
    await link.negotiate()
    expect(trackState(b.transceiverByMid('0')!.receiver.track!).muted).toBe(true)
    await a.transceiverByMid('0')!.sender.replaceTrack(fakeTrack('audio', 'mic-1'))
    link.tick()
    expect(trackState(b.transceiverByMid('0')!.receiver.track!).muted).toBe(false)
  })
})
