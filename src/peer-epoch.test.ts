import { describe, it, expect } from 'vitest'
import { Peer } from './peer.js'
import { decideOffer, nextGeneration } from './peer-generation.js'
import { SlotPair, slotTrack, settle, POLITE, IMPOLITE } from '../test/slot-pair.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import type { SignalBody } from './signal.js'

/**
 * H2: the two ends of a pair disagreeing about which connection they are on.
 *
 * Nothing on the profile-1 wire can say which session an offer belongs to, so
 * a side that rebuilt and a side that did not both believe they are talking to
 * each other while every description is rejected. A generation is the missing
 * sentence, and these are the rules that make convergence a property of the
 * numbering rather than of who happened to be quickest.
 */
describe('generations', () => {
  it('drops an older generation and answers it with exactly one sync', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic')])
    await settle()
    expect(pair.polite.generation).toBe(1)

    // Force this side up to generation 3, as a rebuild would.
    await pair.polite.handleSignal(stale({ gen: 3, conn: 'cc'.repeat(8), slots: SLOTS, seq: 1 }))
    await settle(12)
    expect(pair.polite.generation).toBe(3)

    const live = pair.live('polite')
    const before = live.calls.filter((c) => c.method === 'setRemoteDescription').length
    const mark = pair.sent.length
    // Two signals from a generation that no longer exists, inside the rate
    // limit window.
    await pair.polite.handleSignal(stale({ gen: 1, conn: 'dd'.repeat(8), slots: SLOTS, seq: 1 }))
    await pair.polite.handleSignal(stale({ gen: 1, conn: 'dd'.repeat(8), slots: SLOTS, seq: 2 }))
    await settle()

    expect(pair.since(mark, 'sync')).toHaveLength(1)
    expect(pair.since(mark, 'sync')[0]!.body.gen).toBe(3)
    expect(pair.since(mark, 'offer', 'answer')).toEqual([])
    // Nothing was applied to the connection this side is actually on.
    expect(live.calls.filter((c) => c.method === 'setRemoteDescription')).toHaveLength(before)
    pair.close()
  })

  it('adopts a newer generation, and the abandoned one asks for nothing more', async () => {
    const pair = new SlotPair()
    // Nothing answers, so the offer is queued and a retransmission is armed.
    pair.cut = () => true
    await pair.polite.start([slotTrack('mic')])
    await settle()
    const abandoned = pair.live('polite')
    expect(pair.polite.queueDepth).toBe(1)

    pair.cut = () => false
    const mark = pair.sent.length
    await pair.polite.handleSignal(stale({ gen: 4, conn: 'cc'.repeat(8), slots: SLOTS, seq: 1, tier: 'turn' }))
    await settle(12)

    expect(pair.polite.generation).toBe(4)
    expect(abandoned.closed).toBe(true)
    expect(pair.since(mark, 'answer')).toHaveLength(1)
    expect(pair.since(mark, 'answer')[0]!.body.gen).toBe(4)
    // The far end's rung is adopted with its generation, so the two are not
    // left chasing each other round the ladder.
    expect(pair.live('polite').context?.tier).toBe('turn')

    // Every timer the old generation armed is gone with it: the whole of the
    // retransmission schedule passes and nothing is asked for again.
    const quiet = pair.sent.length
    pair.clock.advance(60_000)
    await settle()
    expect(pair.since(quiet, 'offer')).toEqual([])
    pair.close()
  })

  it('converges on one connection when both sides open a generation at once', async () => {
    const pair = new SlotPair()
    await Promise.all([pair.polite.start([slotTrack('mic')]), pair.impolite.start([slotTrack('camera')])])
    await settle(16)

    // The impolite side keeps the connection it opened; the polite side threw
    // its own away and answered - amendment A1, because a rollback would not
    // have released the four transceivers it had already created.
    expect(pair.connections('impolite').filter((pc) => !pc.closed)).toHaveLength(1)
    expect(pair.connections('polite').filter((pc) => !pc.closed)).toHaveLength(1)
    expect(pair.connections('polite').filter((pc) => pc.closed)).toHaveLength(1)
    expect(pair.polite.generation).toBe(1)
    expect(pair.impolite.generation).toBe(1)
    expect(pair.live('impolite').signalingState).toBe('stable')
    expect(pair.live('polite').signalingState).toBe('stable')
    pair.close()
  })

  it('never lets a rebuild offer reach the connection it replaced', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic')])
    await settle()
    await pair.connect()
    const first = pair.live('polite')
    const firstConn = pair.polite.connectionId

    // Our generation, from a connection we have never heard of, with nothing
    // outstanding to explain it: a protocol error, and the repair is to go up.
    await pair.polite.handleSignal(stale({ gen: 1, conn: 'ff'.repeat(8), sdp: 'strange-offer', seq: 7 }))
    await settle(12)

    expect(pair.polite.generation).toBe(2)
    expect(pair.polite.connectionId).not.toBe(firstConn)
    expect(first.closed).toBe(true)
    const rebuilt = pair.sent.filter((s) => s.body.type === 'offer' && s.body.gen === 2)
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]!.body.conn).toBe(pair.polite.connectionId)
    expect(rebuilt[0]!.body.slots).toBeDefined()
    // The connection that was replaced was handed nothing after it closed.
    expect(first.calls.filter((c) => c.method === 'setRemoteDescription')).toHaveLength(1)
    pair.close()
  })

  it('carries gen and conn on every signal it sends', async () => {
    const pair = new SlotPair()
    await pair.polite.start([slotTrack('mic')])
    await settle()
    await pair.connect()

    expect(pair.sent.length).toBeGreaterThan(2)
    for (const { body } of pair.sent) {
      expect(body.gen, body.type).toBe(1)
      expect(body.conn, body.type).toMatch(/^[0-9a-f]{16}$/)
    }
    pair.close()
  })

  it('rebuilds above both sides\' highest generation, never reusing a number', () => {
    expect(nextGeneration(1, 0)).toBe(2)
    expect(nextGeneration(1, 7)).toBe(8)
    expect(nextGeneration(9, 3)).toBe(10)
  })
})

describe('the glare and adoption table of 3.3', () => {
  const base = {
    incomingGen: 2,
    currentGen: 2,
    incomingConn: 'aa'.repeat(8),
    boundConn: 'aa'.repeat(8),
    outstanding: 'none' as const,
    polite: true,
    opensGeneration: false,
  }

  it('drops an older generation with a sync', () => {
    expect(decideOffer({ ...base, incomingGen: 1 })).toEqual({ do: 'sync' })
  })

  it('adopts a newer generation whatever this side was doing', () => {
    expect(decideOffer({ ...base, incomingGen: 5 })).toEqual({ do: 'adopt', gen: 5 })
    expect(decideOffer({ ...base, incomingGen: 5, outstanding: 'opening' })).toEqual({ do: 'adopt', gen: 5 })
  })

  it('negotiates inside the generation on the connection it already knows', () => {
    expect(decideOffer(base)).toEqual({ do: 'negotiate' })
  })

  it('has the impolite side ignore glare and the polite side give way', () => {
    const glare = { ...base, outstanding: 'opening' as const, opensGeneration: true }
    expect(decideOffer({ ...glare, polite: false })).toEqual({ do: 'ignore' })
    expect(decideOffer(glare)).toEqual({ do: 'rebuild-connection' })
  })

  it('rolls back rather than rebuilding when the glare is inside a generation', () => {
    // Nothing was created for an in-generation offer, so A1's reason to
    // discard the connection object does not apply and a rollback keeps a
    // connection that is carrying media.
    expect(decideOffer({ ...base, outstanding: 'in-generation' })).toEqual({ do: 'rollback' })
  })

  it('treats an unknown connection at our own generation as a protocol error', () => {
    expect(decideOffer({ ...base, incomingConn: 'ff'.repeat(8) })).toEqual({ do: 'rebuild-generation', gen: 3 })
  })
})

describe('profile-1 peers are untouched', () => {
  it('still negotiates track by track, with no generation on the wire', async () => {
    const factory = createFakeFactory()
    const sent: SignalBody[] = []
    const peer = new Peer({
      factory,
      localDevice: POLITE,
      remoteDevice: IMPOLITE,
      onSignal: (body) => sent.push(body),
      onTrack: () => {},
    })
    await peer.start([{} as MediaStreamTrack])
    factory.instances[0]!.onnegotiationneeded?.()
    await settle()

    expect(sent.filter((b) => b.type === 'offer')).toHaveLength(1)
    for (const body of sent) {
      expect(body.gen).toBeUndefined()
      expect(body.conn).toBeUndefined()
      expect(body.slots).toBeUndefined()
    }
    peer.close()
  })
})

const SLOTS: Record<string, 'mic' | 'camera' | 'screen' | 'screen-audio'> = {
  '0': 'mic',
  '1': 'camera',
  '2': 'screen',
  '3': 'screen-audio',
}

/** A signal as a far end on some other generation would have sent it. The
 *  SDP is written the way the fixture writes one, so the connection under
 *  test applies it rather than treating it as opaque. */
function stale(fields: Partial<SignalBody> & { gen: number; conn: string }): SignalBody {
  const sdp = fields.sdp ?? remoteOffer()
  return { type: 'offer', roomId: '', sdp, seq: 1, ...fields }
}

/** Four m-lines in slot order, mids 0..3, as an opener writes them. */
function remoteOffer(): string {
  const lines = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2 3']
  const kinds = ['audio', 'video', 'video', 'audio']
  kinds.forEach((kind, index) => {
    lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF 111`, 'c=IN IP4 0.0.0.0', `a=mid:${index}`, 'a=sendrecv')
  })
  return lines.join('\n') + '\n'
}
