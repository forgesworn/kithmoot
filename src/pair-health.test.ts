/**
 * Per-slot pair health: step S7 of the call reliability design, §3.4's
 * measuring half.
 *
 * Every case here is about telling three things apart that a browser does
 * not distinguish for you: a slot nobody is sending in, a slot somebody is
 * sending in that is arriving, and a slot somebody is sending in that is
 * not. The third is the whole product problem - "I can see you, you cannot
 * see me" - and no property on an `RTCPeerConnection` says it. Counters do.
 */

import { describe, it, expect } from 'vitest'
import { PairHealth, SLOT_DEAD_MS, SLOT_GRACE_MS, HEALTH_SAMPLE_MS, RTCP_DEAD_MS } from './pair-health.js'
import type { PairHealthSample, SlotVerdict } from './pair-health.js'
import { FakeRTCPeerConnection, FakeRtcLink, fakeTrack } from '../test/fake-rtc.js'
import type { FakeConnectionOptions, FakeRtpTransceiver } from '../test/fake-rtc.js'
import { testClock } from '../test/slot-pair.js'
import type { TrackRole } from './types.js'

/** §3.1's fixed order, which is what makes a mid a slot name. */
const SLOTS: [TrackRole, 'audio' | 'video'][] = [
  ['mic', 'audio'],
  ['camera', 'video'],
  ['screen', 'video'],
  ['screen-audio', 'audio'],
]
const SLOT_MAP: Record<string, TrackRole> = { '0': 'mic', '1': 'camera', '2': 'screen', '3': 'screen-audio' }

function midOf(role: TrackRole): string {
  return String(SLOTS.findIndex(([r]) => r === role))
}

interface Harness {
  /** The side being judged. */
  a: FakeRTCPeerConnection
  /** The far end. */
  b: FakeRTCPeerConnection
  link: FakeRtcLink
  health: PairHealth
  clock: ReturnType<typeof testClock>
  samples: PairHealthSample[]
  /** What the far end's roster advert claims is live. */
  advertised: Set<TrackRole>
  /** Move both clocks forward, sampling once per interval, with or without
   *  media actually flowing. */
  run(ms: number, flowing?: boolean): Promise<void>
  verdict(role: TrackRole): SlotVerdict
  rtcpVerdict(role: TrackRole): SlotVerdict
  transceiver(side: 'a' | 'b', role: TrackRole): FakeRtpTransceiver
}

/**
 * Two connections with four bound slots and real counters between them.
 *
 * `FakeRtcLink` is what makes this worth writing: per slot and per
 * direction, a counter advances only while a track is attached on the
 * sending side and the negotiated direction carries it, so "the camera
 * stopped" is expressed by a `replaceTrack(null)` rather than by a test
 * setting a flag that says the answer.
 */
async function harness(
  opts: { sending?: TrackRole[]; receiving?: TrackRole[]; connection?: FakeConnectionOptions } = {},
): Promise<Harness> {
  const sending = opts.sending ?? ['mic', 'camera']
  const receiving = opts.receiving ?? ['mic', 'camera']
  const a = new FakeRTCPeerConnection(opts.connection)
  const b = new FakeRTCPeerConnection(opts.connection)
  for (const [role, kind] of SLOTS) {
    const transceiver = a.addTransceiver(kind, { direction: 'sendrecv' })
    if (sending.includes(role)) await transceiver.sender.replaceTrack(fakeTrack(kind, `${role}-a`))
  }
  const link = new FakeRtcLink(a, b, {
    onRemoteOffer: (answerer) => {
      // Amendment A1: the answerer binds what the offer created.
      for (const [role, kind] of SLOTS) {
        const transceiver = answerer.transceiverByMid(midOf(role))
        if (!transceiver) continue
        transceiver.direction = 'sendrecv'
        if (receiving.includes(role)) void transceiver.sender.replaceTrack(fakeTrack(kind, `${role}-b`))
      }
    },
  })
  await link.negotiate()

  const clock = testClock()
  const advertised = new Set<TrackRole>(receiving)
  const samples: PairHealthSample[] = []
  const health = new PairHealth({
    connection: () => a,
    slots: () => SLOT_MAP,
    advertised: () => [...advertised],
    onSample: (sample) => samples.push(sample),
    clock,
  })
  health.reset(clock.now())

  const h: Harness = {
    a,
    b,
    link,
    health,
    clock,
    samples,
    advertised,
    async run(ms, flowing = true) {
      for (let elapsed = 0; elapsed < ms; elapsed += HEALTH_SAMPLE_MS) {
        if (flowing) link.tick(HEALTH_SAMPLE_MS / 1000)
        clock.advance(HEALTH_SAMPLE_MS)
        await health.sample()
      }
    },
    verdict: (role) => h.samples.at(-1)!.slots.find((s) => s.role === role)!.inbound,
    rtcpVerdict: (role) => h.samples.at(-1)!.slots.find((s) => s.role === role)!.rtcp,
    transceiver: (side, role) => (side === 'a' ? a : b).transceiverByMid(midOf(role))!,
  }
  return h
}

describe('what one slot is doing', () => {
  it('reads an advertised, delivering slot as ok and an unadvertised one as idle', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)

    expect(h.verdict('mic')).toBe('ok')
    expect(h.verdict('camera')).toBe('ok')
    // Nobody's screen is on. That is not a fault, and a design that called it
    // one would report two dead slots for everybody on every call.
    expect(h.verdict('screen')).toBe('idle')
    expect(h.verdict('screen-audio')).toBe('idle')
    expect(h.samples.at(-1)!.deadSlots).toEqual([])
    expect(h.samples.at(-1)!.transportOk).toBe(true)
  })

  it('judges audio on packets and video on decoded frames', async () => {
    // A video stream can keep receiving packets it cannot decode, which is
    // exactly the frozen picture H5 reproduced. Counting packets there would
    // call a frozen tile healthy.
    const h = await harness()
    await h.run(HEALTH_SAMPLE_MS * 2)
    const mic = h.samples.at(-1)!.slots.find((s) => s.role === 'mic')!
    const camera = h.samples.at(-1)!.slots.find((s) => s.role === 'camera')!
    // Four link ticks: fifty packets and thirty frames apiece.
    expect(mic.counter, 'audio is judged on packetsReceived').toBe(200)
    expect(camera.counter, 'video is judged on framesDecoded').toBe(120)
  })

  it('stays quiet inside the grace, and only then starts the clock', async () => {
    // Nothing flows at all: no track anywhere, and the far end says both
    // slots are live. Before the grace is up that is an ordinary connection
    // that has not started delivering; after it, it is a fault.
    const h = await harness({ receiving: [] })
    h.advertised.add('mic')
    h.advertised.add('camera')

    await h.run(SLOT_GRACE_MS - HEALTH_SAMPLE_MS, false)
    expect(h.verdict('mic'), 'a slot was judged before it had a chance to key').toBe('idle')

    await h.run(HEALTH_SAMPLE_MS * 2, false)
    expect(h.verdict('mic'), 'the grace is over, so the dead clock is running').toBe('ok')

    await h.run(SLOT_DEAD_MS, false)
    expect(h.verdict('mic')).toBe('dead')
    expect(h.samples.at(-1)!.allDead, 'every advertised slot is dead, so it is the transport').toBe(true)
  })

  it('notices a slot that stops delivering while the rest of the pair is fine', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)
    expect(h.verdict('camera')).toBe('ok')

    // The far end's camera slot goes quiet without a word - no
    // renegotiation, no `muted`, nothing on the wire at all, which is
    // precisely what `replaceTrack(null)` looks like from here.
    await h.transceiver('b', 'camera').sender.replaceTrack(null)

    await h.run(SLOT_DEAD_MS - HEALTH_SAMPLE_MS)
    expect(h.verdict('camera'), 'called dead before its six seconds were up').toBe('ok')

    await h.run(HEALTH_SAMPLE_MS * 2)
    expect(h.verdict('camera')).toBe('dead')
    expect(h.verdict('mic'), 'the microphone is still arriving, so the transport is fine').toBe('ok')
    expect(h.samples.at(-1)!.deadSlots).toEqual(['camera'])
    expect(h.samples.at(-1)!.transportOk).toBe(true)
    expect(h.samples.at(-1)!.allDead).toBe(false)
  })

  it('a slot the far end stops advertising becomes idle rather than dead', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS)
    await h.transceiver('b', 'camera').sender.replaceTrack(null)
    h.advertised.delete('camera')

    await h.run(SLOT_DEAD_MS + HEALTH_SAMPLE_MS * 2)
    expect(h.verdict('camera')).toBe('idle')
    expect(h.samples.at(-1)!.deadSlots).toEqual([])
  })
})

describe('mapping a stats report to a slot', () => {
  it('falls back to the receiver\'s own report where the browser omits mid', async () => {
    // Firefox does. A sampler that only read `inbound-rtp.mid` would see an
    // empty report there and call every slot on every Firefox pair dead.
    const h = await harness({ connection: { omitStatsMid: true } })
    const report = await h.a.getStats()
    let sawMid = false
    report.forEach((stat) => {
      if (stat.type === 'inbound-rtp' && stat.mid !== undefined) sawMid = true
    })
    expect(sawMid, 'the fixture was supposed to be hiding mid').toBe(false)

    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)
    expect(h.verdict('mic')).toBe('ok')
    expect(h.samples.at(-1)!.slots.find((s) => s.role === 'mic')!.counter).toBeGreaterThan(0)
  })

  it('reports nothing at all for a connection that cannot be sampled', async () => {
    const health = new PairHealth({
      connection: () => undefined,
      slots: () => SLOT_MAP,
      advertised: () => ['mic'],
    })
    expect(await health.sample()).toBeUndefined()
    expect(health.last).toBeUndefined()
  })

  it('reports nothing before a generation has assigned any mids', async () => {
    const h = await harness()
    const health = new PairHealth({ connection: () => h.a, slots: () => undefined, advertised: () => ['mic'] })
    expect(await health.sample()).toBeUndefined()
  })
})

describe('the other direction, by RTCP', () => {
  it('reads our outbound as received while the far end keeps answering', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)
    expect(h.rtcpVerdict('mic')).toBe('ok')
    expect(h.rtcpVerdict('camera')).toBe('ok')
    // Nothing is attached to the share slots, so there is nothing for the
    // far end to be receiving and nothing to judge.
    expect(h.rtcpVerdict('screen')).toBe('idle')
    expect(h.samples.at(-1)!.unreceivedSlots).toEqual([])
  })

  it('calls our outbound unreceived once the reports stop advancing, at twice the receiver\'s threshold', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)

    // Media keeps arriving - this side is fine - but nothing acknowledges
    // what we send any more. That is the far end that cannot heal itself:
    // profile 1, or the current Android build.
    const silent = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += HEALTH_SAMPLE_MS) {
        for (const role of ['mic', 'camera'] as const) {
          h.a.scriptStats(midOf(role), { packetsReceived: 50, framesDecoded: 30 })
        }
        h.a.advanceStatsClock(HEALTH_SAMPLE_MS)
        h.clock.advance(HEALTH_SAMPLE_MS)
        await h.health.sample()
      }
    }

    await silent(RTCP_DEAD_MS - HEALTH_SAMPLE_MS * 2)
    expect(h.rtcpVerdict('mic'), 'the sender acted before the far end had its own chance').toBe('ok')
    expect(h.verdict('mic'), 'inbound is still arriving, so the transport is not the problem').toBe('ok')

    await silent(HEALTH_SAMPLE_MS * 3)
    expect(h.rtcpVerdict('mic')).toBe('dead')
    expect(h.samples.at(-1)!.unreceivedSlots).toEqual(['mic', 'camera'])
    expect(h.samples.at(-1)!.deadSlots, 'a live inbound must never be reported dead').toEqual([])
  })
})

describe('the two second sampler', () => {
  it('samples on its own clock, and stops when it is told to', async () => {
    const h = await harness()
    expect(h.samples).toHaveLength(0)

    h.health.start()
    for (let i = 0; i < 3; i++) {
      h.clock.advance(HEALTH_SAMPLE_MS)
      await settleMicrotasks()
    }
    expect(h.samples).toHaveLength(3)
    expect(h.samples.map((s) => s.at)).toEqual([HEALTH_SAMPLE_MS, HEALTH_SAMPLE_MS * 2, HEALTH_SAMPLE_MS * 3])

    h.health.stop()
    h.clock.advance(HEALTH_SAMPLE_MS * 5)
    await settleMicrotasks()
    expect(h.samples, 'a stopped sampler kept sampling').toHaveLength(3)
  })

  it('starts every slot\'s grace again when the connection is replaced', async () => {
    const h = await harness()
    await h.run(SLOT_GRACE_MS + SLOT_DEAD_MS + HEALTH_SAMPLE_MS * 2, false)
    expect(h.verdict('mic'), 'nothing ever flowed, so this slot is dead').toBe('dead')

    // A rebuild: same pair, new connection, nothing delivered yet. Carrying
    // the old connection's silence across would condemn the new one on its
    // first sample.
    h.health.reset(h.clock.now())
    await h.run(HEALTH_SAMPLE_MS * 2, false)
    expect(h.verdict('mic')).toBe('idle')
  })
})

async function settleMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
