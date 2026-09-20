/**
 * The per-pair controller, driven end to end rather than through the ladder
 * on its own.
 *
 * `PairLadder` has its own exhaustive cases in `pair-health.test.ts`, and
 * every one of them passed while the pair a controller actually owns could
 * not escalate at all: the controller asks for a rebuild, the rebuild bumps
 * the generation, and the generation check - which exists for the far end
 * rebuilding - threw the ladder's position away. Measured over ten minutes of
 * a dead pair: restart, rebuild, restart, rebuild, twenty-five times, never a
 * change of rung, `summary()` saying healthy throughout. So these drive the
 * controller, because that is the only level at which that bug is visible.
 */

import { describe, it, expect } from 'vitest'
import { PairController } from './pair-controller.js'
import type { LadderState } from './pair-controller.js'
import { FakeRTCPeerConnection } from '../test/fake-rtc.js'
import { testClock } from '../test/slot-pair.js'
import type { SlotPeer } from './slot-peer.js'
import type { RouteTier } from './peer.js'
import type { TrackRole } from './types.js'

const SLOT_MAP: Record<string, TrackRole> = { '0': 'mic', '1': 'camera', '2': 'screen', '3': 'screen-audio' }
const KINDS: ('audio' | 'video')[] = ['audio', 'video', 'video', 'audio']

/** Short enough to drive in milliseconds, in the same proportions as §3.4. */
const FAST = {
  sampleMs: 500,
  graceMs: 1_000,
  deadMs: 1_000,
  rtcpDeadMs: 2_000,
  restartMs: { direct: 2_000, turn: 3_000 },
  rebuildMs: { direct: 3_000, turn: 5_000 },
}

/** Everything the controller reads off a peer, and nothing else. A real
 *  `SlotPeer` would drag a whole negotiation in for a test about timers. */
function stubPeer(pc: FakeRTCPeerConnection, tier: () => RouteTier, log: string[]) {
  let generation = 1
  const peer = {
    get generation() {
      return generation
    },
    get connection() {
      return pc
    },
    get slotMap() {
      return SLOT_MAP
    },
    get tier() {
      return tier()
    },
    get queueDepth() {
      return 0
    },
    get unexpectedNegotiations() {
      return 0
    },
    healStalledNegotiation: () => log.push('restart-ice'),
    rebuild: () => {
      // What `SlotPeer.rebuild` does that matters here: the pair is on a new
      // generation from this moment.
      generation += 1
      log.push('rebuild')
    },
    reportHealth: (rx: Record<string, string>) => log.push(`health:${Object.keys(rx).sort().join(',')}`),
  }
  return peer as unknown as SlotPeer
}

/** A connection that has negotiated four slots and delivers absolutely
 *  nothing - the pair every rung of §3.4's ladder exists for. */
function deadConnection(): FakeRTCPeerConnection {
  const pc = new FakeRTCPeerConnection()
  for (const kind of KINDS) pc.addTransceiver(kind, { direction: 'sendrecv' })
  pc.connectionState = 'connected'
  for (const [index, transceiver] of pc.getTransceivers().entries()) {
    transceiver.mid = String(index)
    transceiver.currentDirection = 'sendrecv'
    transceiver.receiver.track = { id: `remote-${index}`, kind: transceiver.kind } as MediaStreamTrack
  }
  return pc
}

interface Harness {
  controller: PairController
  log: string[]
  clock: ReturnType<typeof testClock>
  tier: RouteTier
  nextTierAsked: number
  restsOver: number
  run(ms: number): Promise<void>
  ladder(): LadderState
}

function harness(opts: { rungLeft?: boolean } = {}): Harness {
  const clock = testClock()
  const log: string[] = []
  const pc = deadConnection()
  const h: Harness = {
    tier: 'direct',
    nextTierAsked: 0,
    restsOver: 0,
    clock,
    log,
    controller: undefined as unknown as PairController,
    async run(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += FAST.sampleMs) {
        clock.advance(FAST.sampleMs)
        // The sampler is async and re-arms in a `finally`, so the next timer
        // does not exist until the microtasks behind this one have run.
        for (let i = 0; i < 12; i++) await Promise.resolve()
      }
    },
    ladder: () => h.controller.summary().ladder,
  }
  h.controller = new PairController({
    device: 'ab'.repeat(32),
    advertised: () => ['mic', 'camera'],
    onNextTier: () => {
      h.nextTierAsked += 1
      log.push('next-tier')
      // The mesh's answer: `direct` has TURN below it, `turn` has nothing.
      if (opts.rungLeft === false || h.tier === 'turn') return false
      h.tier = 'turn'
      return true
    },
    onRestOver: () => {
      h.restsOver += 1
      log.push('rest-over')
    },
    rest: { baseMs: 4_000 },
    health: FAST,
    random: () => 0.5,
    clock,
  })
  h.controller.attach(stubPeer(pc, () => h.tier, log))
  h.controller.connected()
  return h
}

describe('a pair that delivers nothing', () => {
  it('BUG: escalates instead of rebuilding for ever', async () => {
    const h = harness()

    // Step 1, once the grace and the dead window are both past.
    await h.run(4_000)
    expect(h.log).toEqual(['restart-ice'])
    expect(h.ladder()).toBe('restarting')

    // Step 2: the restart did not help.
    await h.run(3_000)
    expect(h.log).toEqual(['restart-ice', 'rebuild'])
    expect(h.ladder(), 'our own rebuild reset the ladder it is a step of').toBe('rebuilding')

    // Step 3, and this is the one that never happened: the rebuild is given
    // its own grace and its own deadline, and then the rung changes.
    await h.run(4_000)
    expect(h.log).toEqual(['restart-ice', 'rebuild', 'next-tier'])
    expect(h.tier).toBe('turn')
    expect(h.ladder()).toBe('changing-tier')

    // And nothing is rebuilt over and over in place of that.
    expect(h.log.filter((entry) => entry === 'rebuild'), 'the pair was rebuilt in a loop').toHaveLength(1)
  })

  it('rests when the mesh says there is no rung left, and then starts again', async () => {
    const h = harness({ rungLeft: false })

    await h.run(11_000)
    expect(h.log.slice(0, 3)).toEqual(['restart-ice', 'rebuild', 'next-tier'])
    expect(h.nextTierAsked).toBe(1)
    expect(h.ladder(), 'a pair with nowhere left to go must rest, not ask again').toBe('resting')
    expect(h.restsOver).toBe(0)

    // The rest is 4s +/- 25%, and this clock's jitter is pinned at the middle.
    await h.run(5_000)
    expect(h.restsOver).toBe(1)
    expect(h.log).toContain('rest-over')
  })

  it('still drops the ladder when the far end is the one that rebuilt', async () => {
    // The other half of the same generation check, and the reason it exists:
    // a higher generation from the far end means our ladder was judging a
    // connection neither side has any more.
    const h = harness()
    await h.run(4_000)
    expect(h.ladder()).toBe('restarting')

    // The far end rebuilds. Nothing local asked for it.
    h.controller.peer!.rebuild()
    h.log.pop()
    await h.run(1_000)
    expect(h.ladder(), 'the new connection was judged on the old one\'s evidence').toBe('healthy')
  })
})
