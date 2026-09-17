import { describe, it, expect } from 'vitest'
import { SLOT_ORDER, SlotSet, inferRoles, supportsSlots } from './peer-slots.js'
import { SlotPair, slotTrack, settle } from '../test/slot-pair.js'
import { FakeRTCPeerConnection } from '../test/fake-rtc.js'
import type { SignalBody } from './signal.js'

/**
 * D1: fixed media slots. Every one of these pins a failure that was measured
 * in a browser, not a preference - see section 7 of the call reliability
 * spec, which maps each of them to the thing it stops happening.
 */
describe('fixed media slots', () => {
  it('opens exactly four sendrecv slots, in order, and names them on the offer', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic'), slotTrack('camera')])
    await settle()

    const pc = pair.live('polite')
    const transceivers = pc.getTransceivers()
    expect(transceivers).toHaveLength(4)
    expect(transceivers.map((t) => t.kind)).toEqual(['audio', 'video', 'video', 'audio'])

    const offer = pair.sent.find((s) => s.body.type === 'offer')!.body
    expect(offer.gen).toBe(1)
    expect(offer.conn).toMatch(/^[0-9a-f]{16}$/)
    expect(offer.slots).toEqual({ '0': 'mic', '1': 'camera', '2': 'screen', '3': 'screen-audio' })
    pair.close()
  })

  it('the answerer binds the offer\'s slots and creates none of its own', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic')])
    await settle()

    const answerer = pair.live('impolite')
    // A1: four transceivers of its own could not have associated with the
    // offerer's m-lines, and the browser would have offered four more.
    expect(answerer.calls.filter((c) => c.method === 'addTransceiver')).toHaveLength(0)
    expect(answerer.getTransceivers()).toHaveLength(4)
    expect(pair.sent.filter((s) => s.body.type === 'answer')).toHaveLength(1)
    pair.close()
  })

  it('a camera, mic, share or screen-audio change produces no signalling at all', async () => {
    const pair = new SlotPair()
    const mic = slotTrack('mic')
    const camera = slotTrack('camera')
    const screen = slotTrack('screen')
    const screenAudio = slotTrack('screen-audio')
    await pair.polite.start([mic])
    await settle()
    await pair.impolite.start([mic])
    await settle()
    await pair.connect()

    const mark = pair.sent.length
    await pair.polite.start([mic, camera])
    await pair.polite.start([mic, camera, screen, screenAudio])
    await pair.polite.start([camera])
    await pair.polite.start([])
    await pair.impolite.start([mic, camera])
    await settle()

    expect(pair.since(mark, 'offer', 'answer')).toEqual([])
    const swaps = pair.live('polite').calls.filter((c) => c.method === 'replaceTrack')
    expect(swaps.length).toBeGreaterThan(0)
    pair.close()
  })

  it('keeps the m-line count at four over twenty camera toggles', async () => {
    const pair = new SlotPair()
    const mic = slotTrack('mic')
    const camera = slotTrack('camera')
    await pair.polite.start([mic])
    await settle()
    await pair.connect()

    const mark = pair.sent.length
    for (let i = 0; i < 20; i++) {
      await pair.polite.start([mic, camera])
      await pair.polite.start([mic])
    }
    await settle()

    // The whole of H1's root cause: under profile 1 every one of these forty
    // toggles cost an m-line, an offer and an answer, and one lost answer in
    // forty left the pair blind for the rest of the call.
    expect(pair.since(mark, 'offer', 'answer')).toEqual([])
    expect(pair.live('polite').getTransceivers()).toHaveLength(4)
    expect(pair.live('impolite').getTransceivers()).toHaveLength(4)
    pair.close()
  })

  it('swapping the mic pipeline\'s track is a replaceTrack, not a negotiation', async () => {
    const pair = new SlotPair()
    const raw = slotTrack('mic', 'raw')
    const processed = slotTrack('mic', 'processed')
    await pair.polite.start([raw])
    await settle()
    await pair.connect()

    const mark = pair.sent.length
    await pair.polite.start([processed])
    await settle()

    expect(pair.since(mark, 'offer', 'answer')).toEqual([])
    expect(pair.polite.slotState('mic')).toBe('sending')
    pair.close()
  })

  it('a refused audience holds null in every slot, so no RTP leaves for them', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic'), slotTrack('camera')])
    await settle()
    await pair.connect()

    const mark = pair.sent.length
    // What `Mesh.#tracksFor` hands a participant the audience rule refuses.
    await pair.polite.start([])
    await settle()

    expect(pair.since(mark, 'offer', 'answer')).toEqual([])
    for (const role of SLOT_ORDER) expect(pair.polite.slotState(role)).toBe('idle')
    for (const transceiver of pair.live('polite').getTransceivers()) {
      expect(transceiver.sender.track).toBeNull()
    }
    pair.close()
  })

  it('leaves exactly four m-lines each side when both open a generation at once', async () => {
    const pair = new SlotPair()
    // Glare: both sides have media and both offer before either has heard the
    // other. Without A1 the polite side would roll back, keep the four
    // transceivers it opened, and the browser would offer four more.
    await Promise.all([pair.polite.start([slotTrack('mic')]), pair.impolite.start([slotTrack('mic')])])
    await settle(16)

    expect(pair.live('polite').getTransceivers()).toHaveLength(4)
    expect(pair.live('impolite').getTransceivers()).toHaveLength(4)
    expect(pair.polite.generation).toBe(1)
    expect(pair.impolite.generation).toBe(1)
    pair.close()
  })

  it('never raises negotiationneeded for a media change', async () => {
    const pair = new SlotPair()
    const mic = slotTrack('mic')
    await pair.polite.start([mic])
    await settle()
    await pair.connect()
    await pair.polite.start([mic, slotTrack('camera')])
    await pair.polite.start([])
    await settle()

    expect(pair.polite.unexpectedNegotiations).toBe(0)
    expect(pair.impolite.unexpectedNegotiations).toBe(0)
    pair.close()
  })

  it('resolves a received track\'s role from the transceiver mid', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic'), slotTrack('screen')])
    await settle()
    await pair.connect()

    // Four tracks, one per slot, whether or not anything is in it: a
    // receiving m-line raises `ontrack` at `setRemoteDescription` and an idle
    // slot is still a receiving m-line. Every one of them is labelled, which
    // is the point - the app is told the role instead of guessing it from a
    // track id that never matches the sender's, in either engine.
    const seen = pair.tracks.get('impolite')!
    expect(seen.map((t) => t.role).sort()).toEqual(['camera', 'mic', 'screen', 'screen-audio'])
    pair.close()
  })
})

describe('SlotSet', () => {
  it('refuses a slot map until every slot has a mid', () => {
    const pc = new FakeRTCPeerConnection()
    const slots = SlotSet.open(pc)
    expect(slots.map()).toBeNull()
  })

  it('binds only the mids the offer named, and says how many it found', async () => {
    const opener = new FakeRTCPeerConnection()
    const opened = SlotSet.open(opener)
    await opener.setLocalDescription(await opener.createOffer())
    const map = opened.map()!

    const answerer = new FakeRTCPeerConnection()
    await answerer.setRemoteDescription(opener.localDescription!)
    const bound = SlotSet.bind(answerer, map)
    expect(bound.size).toBe(4)
    for (const [mid, role] of Object.entries(map)) expect(bound.roleOf(mid)).toBe(role)
    // Widened before `createAnswer`, which is the only window there is: an
    // answer can only ever narrow what the offer proposed.
    for (const transceiver of answerer.getTransceivers()) expect(transceiver.direction).toBe('sendrecv')
  })

  it('reports a slot whose replaceTrack was rejected rather than pretending it sent', async () => {
    const pc = new FakeRTCPeerConnection()
    const slots = SlotSet.open(pc)
    await pc.setLocalDescription(await pc.createOffer())
    pc.getTransceivers()[0]!.sender.failReplaceTrack = true
    const broken = await slots.apply([slotTrack('mic')], () => 'mic')
    expect(broken).toEqual(['mic'])
    expect(slots.state('mic')).toBe('broken')
  })

  it('infers roles from kind and order for a caller that has not been taught to say', () => {
    const mic = slotTrack('mic')
    const camera = slotTrack('camera')
    const screen = slotTrack('screen')
    const roles = inferRoles([mic, camera, screen])
    expect(roles.get(mic)).toBe('mic')
    expect(roles.get(camera)).toBe('camera')
    expect(roles.get(screen)).toBe('screen')
  })

  it('knows a connection that cannot carry slots at all', () => {
    const bare = { addTrack() {} } as unknown as Parameters<typeof supportsSlots>[0]
    expect(supportsSlots(bare)).toBe(false)
    expect(supportsSlots(new FakeRTCPeerConnection())).toBe(true)
  })
})

describe('profile-1 interop', () => {
  it('stands aside for a far end that has reloaded into an old build', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic')])
    await settle()

    // What an old web client or the current Android build sends: no `gen`,
    // no `conn`, no slot map.
    const legacy: SignalBody = { type: 'offer', roomId: '', sdp: 'legacy-offer' }
    await pair.polite.handleSignal(legacy)
    await settle()

    expect(pair.downgrades.map((d) => d.body)).toEqual([legacy])
    // And it stops: everything it would say from here names a connection the
    // far end has never heard of.
    const mark = pair.sent.length
    await pair.polite.start([slotTrack('camera')])
    await settle()
    expect(pair.since(mark)).toEqual([])
    pair.close()
  })
})
