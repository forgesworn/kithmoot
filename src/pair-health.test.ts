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
import { PairHealth, PairLadder, SLOT_DEAD_MS, SLOT_GRACE_MS, HEALTH_SAMPLE_MS, RTCP_DEAD_MS, HEALTH_REPORT_MS } from './pair-health.js'
import type { LadderAction, PairHealthSample, SlotVerdict } from './pair-health.js'
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

// ---------------------------------------------------------------------------
// The ladder (S8)
// ---------------------------------------------------------------------------

/** A sample with only the fields the ladder reads, so a case can state the
 *  situation it is about rather than arrange a connection that produces it. */
function say(
  at: number,
  what: {
    dead?: TrackRole[]
    transportOk?: boolean
    allDead?: boolean
    unreceived?: TrackRole[]
    rtcpOk?: boolean
  },
): PairHealthSample {
  const slots = SLOTS.map(([role]) => ({
    role,
    mid: midOf(role),
    advertised: true,
    inbound: (what.dead ?? []).includes(role) ? ('dead' as const) : ('ok' as const),
    rtcp: (what.unreceived ?? []).includes(role) ? ('dead' as const) : what.rtcpOk === false ? ('idle' as const) : ('ok' as const),
    // The ladder is handed `transportOk` directly, so this only has to be
    // consistent with it rather than drive it.
    progressed: !(what.dead ?? []).includes(role) && what.transportOk !== false,
  }))
  return {
    at,
    slots,
    deadSlots: what.dead ?? [],
    transportOk: what.transportOk ?? true,
    allDead: what.allDead ?? false,
    unreceivedSlots: what.unreceived ?? [],
  }
}

function ladder(tier: 'direct' | 'turn' = 'direct') {
  const actions: LadderAction[] = []
  const steps = new PairLadder({ tier: () => tier, onAction: (a) => actions.push(a) })
  return { steps, actions }
}

describe('one dead slot on a healthy transport', () => {
  it('tells the far end and does nothing else', () => {
    const { steps, actions } = ladder()
    steps.observe(say(0, { dead: ['camera'] }))
    expect(actions).toEqual([{ do: 'health', dead: ['camera'] }])
    expect(steps.state, 'a rebuild for one slot would cost everybody the pair').toBe('healthy')
  })

  it('does not say it again every two seconds, but does when the answer changes', () => {
    const { steps, actions } = ladder()
    steps.observe(say(0, { dead: ['camera'] }))
    steps.observe(say(2_000, { dead: ['camera'] }))
    steps.observe(say(4_000, { dead: ['camera'] }))
    expect(actions).toHaveLength(1)

    // The microphone goes too: a different report, worth sending at once.
    steps.observe(say(6_000, { dead: ['camera', 'mic'] }))
    expect(actions.at(-1)).toEqual({ do: 'health', dead: ['camera', 'mic'] })

    // And the same report again, once the window is up.
    steps.observe(say(6_000 + HEALTH_REPORT_MS, { dead: ['camera', 'mic'] }))
    expect(actions).toHaveLength(3)
  })

  it('says nothing about slots when the transport itself is down', () => {
    // The far end would not receive the report either, and the pair has a
    // much bigger problem than one slot.
    const { steps, actions } = ladder()
    steps.observe(say(0, { dead: ['camera', 'mic'], transportOk: false, allDead: true }))
    expect(actions).toEqual([{ do: 'restart-ice' }])
  })
})

describe('every advertised slot dead', () => {
  it('walks restart, rebuild, tier, rest - and no faster than the rung allows', () => {
    const { steps, actions } = ladder()
    const dead = (at: number) => steps.observe(say(at, { allDead: true, transportOk: false, dead: ['mic', 'camera'] }))

    dead(0)
    expect(actions).toEqual([{ do: 'restart-ice' }])
    expect(steps.state).toBe('restarting')

    // Eight seconds on the direct rung, and not a sample sooner.
    dead(6_000)
    expect(actions, 'gave up on the ICE restart early').toHaveLength(1)
    dead(8_000)
    expect(actions.at(-1)).toEqual({ do: 'rebuild' })
    expect(steps.state).toBe('rebuilding')

    // Twelve more for the rebuild.
    dead(18_000)
    expect(actions).toHaveLength(2)
    dead(20_000)
    expect(actions.at(-1)).toEqual({ do: 'next-tier' })
    expect(steps.state).toBe('changing-tier')

    dead(32_000)
    expect(actions.at(-1)).toEqual({ do: 'rest' })
    expect(steps.state).toBe('resting')

    // And then it stops asking: the rest is the controller's, and a ladder
    // that kept emitting would rebuild the pair it is meant to be leaving
    // alone.
    dead(60_000)
    expect(actions).toHaveLength(4)
  })

  it('gives the TURN rung longer, because a restart there needs a fresh allocation', () => {
    const { steps, actions } = ladder('turn')
    const dead = (at: number) => steps.observe(say(at, { allDead: true, transportOk: false }))
    dead(0)
    dead(8_000)
    expect(actions, 'TURN was judged on the direct rung\'s clock').toHaveLength(1)
    dead(12_000)
    expect(actions.at(-1)).toEqual({ do: 'rebuild' })
  })

  it('stops after three rebuilds in a minute and rests instead', () => {
    // §9's mitigation for rebuild storms: a network that is simply bad must
    // not be answered with a rebuild every twenty seconds for ever.
    const { steps, actions } = ladder()
    let at = 0
    for (let round = 0; round < 3; round++) {
      steps.observe(say(at, { allDead: true, transportOk: false }))
      at += 8_000
      steps.observe(say(at, { allDead: true, transportOk: false }))
      // The pair comes back, briefly, which is what makes this a storm
      // rather than one long outage.
      at += 2_000
      steps.observe(say(at, {}))
      at += 2_000
    }
    expect(actions.filter((a) => a.do === 'rebuild')).toHaveLength(3)

    steps.observe(say(at, { allDead: true, transportOk: false }))
    steps.observe(say(at + 8_000, { allDead: true, transportOk: false }))
    expect(actions.at(-1)).toEqual({ do: 'rest' })
  })

  it('goes back to healthy the moment media returns', () => {
    const { steps, actions } = ladder()
    steps.observe(say(0, { allDead: true, transportOk: false }))
    expect(steps.state).toBe('restarting')
    steps.observe(say(2_000, {}))
    expect(steps.state).toBe('healthy')
    // And the next fault starts from the top rather than from where the last
    // one had got to.
    steps.observe(say(4_000, { allDead: true, transportOk: false }))
    expect(actions.at(-1)).toEqual({ do: 'restart-ice' })
  })
})

describe('the RTCP backstop', () => {
  it('walks the same ladder when nothing we send is getting through', () => {
    // The far end is profile 1, or the current Android build: it cannot heal
    // itself, so the only side that can is this one. The sampler has already
    // applied the fourteen second threshold; what reaches here is its
    // verdict.
    const { steps, actions } = ladder()
    steps.observe(say(0, { unreceived: ['mic', 'camera'], rtcpOk: false }))
    expect(actions).toEqual([{ do: 'restart-ice' }])
  })

  it('leaves the pair alone while any slot is still getting through', () => {
    const { steps, actions } = ladder()
    // The camera is not being received, the microphone is. That is one slot,
    // and one slot is not the transport.
    const sample = say(0, { unreceived: ['camera'] })
    sample.slots.find((s) => s.role === 'mic')!.rtcp = 'ok'
    steps.observe(sample)
    expect(actions).toEqual([])
  })
})

describe('an incoming higher generation', () => {
  it('resets the ladder, so the pair the far end just rebuilt is left alone', () => {
    const { steps, actions } = ladder()
    steps.observe(say(0, { allDead: true, transportOk: false }))
    steps.observe(say(8_000, { allDead: true, transportOk: false }))
    expect(steps.state).toBe('rebuilding')

    // The far end rebuilt first. Everything measured so far is about a
    // connection neither side has any more.
    steps.reset()
    expect(steps.state).toBe('healthy')

    steps.observe(say(10_000, { allDead: true, transportOk: false }))
    expect(actions.at(-1), 'the new connection was torn down on the old one\'s evidence').toEqual({ do: 'restart-ice' })
  })
})

describe('reading the other direction on an engine that says less', () => {
  it('BUG: never-readable RTCP is idle, not the far end receiving nothing', async () => {
    // No `mid` on `outbound-rtp`, no sender-scoped report, no
    // `remote-inbound-rtp` at all: this side simply cannot tell. Read as
    // `dead` it is a healthy call that restarts ICE and then rebuilds itself
    // every fourteen seconds for the length of the call.
    const h = await harness({ connection: { omitStatsMid: true, omitRemoteInbound: true } })
    await h.run(SLOT_GRACE_MS + RTCP_DEAD_MS + HEALTH_SAMPLE_MS * 4)

    expect(h.verdict('mic'), 'inbound is arriving, so this pair is fine').toBe('ok')
    expect(h.rtcpVerdict('mic'), 'cannot tell was read as bad news').toBe('idle')
    expect(h.samples.at(-1)!.unreceivedSlots).toEqual([])
  })

  it('finds the far end\'s receiver report through the sender where mid is missing', async () => {
    // Same engine, except it does report `remote-inbound-rtp`. The sender's
    // own scoped report is the only way to reach it, because without `mid`
    // there is nothing to match the outbound stream to a slot.
    const h = await harness({ connection: { omitStatsMid: true } })
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 4)

    expect(h.rtcpVerdict('mic'), 'the sender-scoped fallback was never reached').toBe('ok')
    expect(h.rtcpVerdict('camera')).toBe('ok')
    expect(h.samples.at(-1)!.unreceivedSlots).toEqual([])
  })

  it('still calls it dead once reports were arriving and stopped', async () => {
    // The distinction that matters: "never observed" is idle, "observed and
    // then stopped" is the fault the RTCP backstop exists for.
    const h = await harness({ connection: { omitStatsMid: true } })
    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS * 2)
    expect(h.rtcpVerdict('mic')).toBe('ok')

    // Media keeps arriving; nothing acknowledges what we send any more.
    for (let elapsed = 0; elapsed < RTCP_DEAD_MS + HEALTH_SAMPLE_MS * 2; elapsed += HEALTH_SAMPLE_MS) {
      for (const role of ['mic', 'camera'] as const) h.a.scriptStats(midOf(role), { packetsReceived: 50, framesDecoded: 30 })
      h.a.advanceStatsClock(HEALTH_SAMPLE_MS)
      h.clock.advance(HEALTH_SAMPLE_MS)
      await h.health.sample()
    }

    expect(h.rtcpVerdict('mic')).toBe('dead')
    expect(h.samples.at(-1)!.unreceivedSlots).toEqual(['mic', 'camera'])
  })
})

describe('what "the transport is fine" means', () => {
  it('BUG: is a counter that moved, not a clock that has not run out', async () => {
    // A slot that has never delivered anything reads `ok` for the whole of
    // its first dead window, because `ok` only means "not silent long
    // enough yet". A ladder that took that for recovery would forget it was
    // mid-rebuild every time the grace started again - which is a pair that
    // restarts and rebuilds for ever and never changes rung.
    const h = await harness({ receiving: [] })
    h.advertised.add('mic')
    h.advertised.add('camera')

    await h.run(SLOT_GRACE_MS + HEALTH_SAMPLE_MS, false)
    expect(h.verdict('mic'), 'nothing has been silent long enough to be called dead').toBe('ok')
    expect(h.samples.at(-1)!.transportOk, 'nothing has ever arrived on this pair').toBe(false)
    expect(h.samples.at(-1)!.slots.every((slot) => !slot.progressed)).toBe(true)
  })

  it('is true while packets are actually moving', async () => {
    const h = await harness()
    await h.run(HEALTH_SAMPLE_MS * 2)
    expect(h.samples.at(-1)!.transportOk).toBe(true)
    expect(h.samples.at(-1)!.slots.find((s) => s.role === 'mic')!.progressed).toBe(true)
    expect(h.samples.at(-1)!.slots.find((s) => s.role === 'screen')!.progressed, 'an idle slot has not progressed').toBe(false)
  })
})
