import { describe, it, expect } from 'vitest'
import { SLOT_ORDER, SlotSet, inferRoles, supportsSlots } from './peer-slots.js'
import { SlotPair, slotTrack, settle } from '../test/slot-pair.js'
import { FakeRTCPeerConnection, trackState } from '../test/fake-rtc.js'
import { SLOT_REPAIR_MS } from './slot-peer.js'
import type { SignalBody } from './signal.js'
import type { SlotPeerOptions } from './slot-peer.js'
import type { TrackRole } from './types.js'

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

/**
 * The `health` signal on the receiving side: §3.4's row 2.
 *
 * This is the one signal on the wire that asks the recipient to do something
 * to its own media, which makes it the one that has to be read sceptically. A
 * room member is not a trusted party - it is whoever was let in.
 */
describe('a far end reporting one of our slots dead', () => {
  /** A connected pair with both sides sending, and a handle on the polite
   *  side's slot transceivers. */
  async function pair(options: Partial<SlotPeerOptions> = {}) {
    const p = new SlotPair(options)
    await p.polite.start([slotTrack('mic'), slotTrack('camera')])
    await settle()
    await p.impolite.start([slotTrack('mic')])
    await settle()
    await p.connect()
    return p
  }

  /** How many times a slot's track has been swapped out and back in. */
  function replacements(pc: FakeRTCPeerConnection, mid: string): number {
    return pc.calls.filter((c) => c.method === 'replaceTrack' && c.args[0] === mid).length
  }

  it('re-attaches the named slot, and only the named slot', async () => {
    const p = await pair()
    const pc = p.live('polite')
    const before = replacements(pc, '1')

    p.impolite.reportHealth({ camera: 'dead' })
    await settle()

    // Out and back in: two calls, no SDP, no signal.
    expect(replacements(pc, '1') - before).toBe(2)
    expect(replacements(pc, '0'), 'a slot nobody complained about was re-keyed').toBe(0)
    expect(p.since(0, 'offer', 'answer').length, 'a slot repair cost a negotiation').toBe(
      p.sent.filter((s) => s.body.type === 'offer' || s.body.type === 'answer').length,
    )
    p.close()
  })

  it('BUG: will not re-key a slot our own RTCP says is arriving', async () => {
    // Unchecked, one member could re-key a victim's camera encoder every ten
    // seconds for a whole call by simply claiming not to receive it - while
    // the victim's own receiver reports said the opposite throughout.
    let receiving = true
    const p = await pair({ outboundReceived: () => receiving })
    const pc = p.live('polite')

    p.impolite.reportHealth({ camera: 'dead' })
    await settle()
    expect(replacements(pc, '1'), 'a claim our own measurement contradicts was believed').toBe(0)

    // The moment this side can no longer contradict it, the repair happens.
    receiving = false
    p.impolite.reportHealth({ camera: 'dead' })
    await settle()
    expect(replacements(pc, '1')).toBe(2)
    p.close()
  })

  it('repairs at most once per slot per ten seconds', async () => {
    const p = await pair()
    const pc = p.live('polite')

    p.impolite.reportHealth({ camera: 'dead' })
    await settle()
    p.impolite.reportHealth({ camera: 'dead' })
    p.impolite.reportHealth({ camera: 'dead' })
    await settle()
    expect(replacements(pc, '1'), 'a far end with a stuck decoder re-keyed us every time it said so').toBe(2)

    p.clock.advance(SLOT_REPAIR_MS)
    p.impolite.reportHealth({ camera: 'dead' })
    await settle()
    expect(replacements(pc, '1')).toBe(4)
    p.close()
  })

  it('BUG: an empty slot does not spend the repair budget', async () => {
    // Nothing is attached to the screen slot, so there is nothing to
    // re-attach. Stamping it anyway would blind that slot for ten seconds
    // after a share finally started.
    const p = await pair()
    const pc = p.live('polite')

    p.impolite.reportHealth({ screen: 'dead' })
    await settle()
    expect(replacements(pc, '2')).toBe(0)

    await p.polite.start([slotTrack('mic'), slotTrack('camera'), slotTrack('screen')])
    await settle()
    const attached = replacements(pc, '2')
    p.impolite.reportHealth({ screen: 'dead' })
    await settle()
    expect(replacements(pc, '2') - attached, 'the empty slot had spent the budget for the real one').toBe(2)
    p.close()
  })

  it('BUG: asks the application to recover a track that has ended', async () => {
    const recovered: TrackRole[] = []
    const p = await pair({ onSlotRecovery: (role) => recovered.push(role) })
    const pc = p.live('polite')

    // A camera another application took, or a microphone unplugged. Nothing
    // this library owns can replace it.
    trackState(pc.getTransceivers()[1]!.sender.track!).readyState = 'ended'

    p.impolite.reportHealth({ camera: 'dead' })
    await settle()

    expect(recovered, 'an ended track was silently left in its slot').toEqual(['camera'])
    expect(replacements(pc, '1'), 'a dead track was re-attached as though it were live').toBe(0)
    p.close()
  })

  it('rebuilds when the slot itself refuses the track', async () => {
    const p = await pair()
    const pc = p.live('polite')
    const generation = p.polite.generation
    pc.getTransceivers()[1]!.sender.failReplaceTrack = true

    p.impolite.reportHealth({ camera: 'dead' })
    await settle()

    // The one path in §3.1 where a slot change still costs a negotiation.
    expect(p.polite.generation).toBeGreaterThan(generation)
    p.close()
  })
})
