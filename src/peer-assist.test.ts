import { describe, it, expect } from 'vitest'
import {
  ASSIST_STREAMS_PER_PAIR,
  MAX_ASSISTED_PAIRS,
  assistCostBps,
  assistDecision,
  assistPairKey,
  assistSlots,
  buildAssistOffer,
  rankAssistants,
  sanitiseAssistOffer,
  selectAssistant,
  spareUplinkBps,
} from './peer-assist.js'
import type { AssistEnvironment, AssistVolunteer } from './peer-assist.js'
import type { AssistOffer, CapacityEstimate } from './types.js'

/** A 64-hex device pubkey, deterministic per label. */
function dev(label: string): string {
  return label.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a')
}

const A = dev('aa11')
const B = dev('bb22')

function capacity(over: Partial<CapacityEstimate> = {}): CapacityEstimate {
  return { uplinkBps: 20_000_000, peers: 4, perPeerBps: 600_000, ...over }
}

function offer(over: Partial<AssistOffer> = {}): AssistOffer {
  return {
    reachability: 'public',
    capacity: capacity(over.capacity),
    relaying: 0,
    maxRelayed: MAX_ASSISTED_PAIRS,
    ...over,
  }
}

function volunteer(label: string, over: Partial<AssistOffer> = {}): AssistVolunteer {
  return { device: dev(label), offer: offer(over) }
}

describe('spareUplinkBps', () => {
  it('is what is left after this device pays for its own call', () => {
    // 20 Mbps at 0.8 headroom is 16 Mbps to spend; four peers at 600 kbps is
    // 2.4 Mbps already spent.
    expect(spareUplinkBps(capacity())).toBeCloseTo(16_000_000 - 2_400_000, 3)
  })

  it('is zero, never negative, for a device already past its headroom', () => {
    expect(spareUplinkBps(capacity({ uplinkBps: 1_000_000, peers: 10 }))).toBe(0)
  })

  it('is zero for an estimate that is not a measurement', () => {
    expect(spareUplinkBps(capacity({ uplinkBps: Number.NaN }))).toBe(0)
    expect(spareUplinkBps(capacity({ perPeerBps: Number.POSITIVE_INFINITY }))).toBe(0)
    expect(spareUplinkBps(capacity(), Number.NaN)).toBe(0)
  })
})

describe('assistCostBps', () => {
  it('charges a pair both directions, because a relay sends each end the other', () => {
    expect(assistCostBps(offer())).toBe(600_000 * ASSIST_STREAMS_PER_PAIR)
  })
})

describe('assistSlots', () => {
  it('is bounded by what the volunteer said it would carry, not by its uplink', () => {
    // A gigabit uplink pays for dozens of pairs; the cap is the answer.
    expect(assistSlots(offer({ capacity: capacity({ uplinkBps: 1_000_000_000 }) }))).toBe(MAX_ASSISTED_PAIRS)
  })

  it('is bounded by spare uplink when that is the smaller of the two', () => {
    // 4 Mbps uplink, 0.8 headroom = 3.2 Mbps; already sending 2.4 Mbps to
    // four peers, so 0.8 Mbps spare and a pair costs 1.2 Mbps.
    expect(assistSlots(offer({ capacity: capacity({ uplinkBps: 4_000_000 }) }))).toBe(0)
    // 6 Mbps: 4.8 spare of headroom, 2.4 spent, 2.4 left - two pairs.
    expect(assistSlots(offer({ capacity: capacity({ uplinkBps: 6_000_000 }) }))).toBe(2)
  })

  it('falls to zero as a volunteer fills up', () => {
    expect(assistSlots(offer({ relaying: MAX_ASSISTED_PAIRS }))).toBe(0)
  })

  it('is zero for an offer that does not survive sanitising', () => {
    expect(assistSlots({ reachability: 'public' } as unknown as AssistOffer)).toBe(0)
  })
})

describe('sanitiseAssistOffer', () => {
  it('passes an ordinary offer through unchanged', () => {
    expect(sanitiseAssistOffer(offer())).toEqual(offer())
  })

  it('clamps a fan-out claim to the cap this room enforces', () => {
    expect(sanitiseAssistOffer(offer({ maxRelayed: 1000 }))?.maxRelayed).toBe(MAX_ASSISTED_PAIRS)
  })

  it('drops an offer whose numbers are not numbers', () => {
    for (const bad of [
      offer({ capacity: capacity({ uplinkBps: Number.NaN }) }),
      offer({ capacity: capacity({ peers: -1 }) }),
      offer({ capacity: capacity({ peers: 1.5 }) }),
      offer({ capacity: capacity({ perPeerBps: Number.POSITIVE_INFINITY }) }),
      offer({ relaying: -1 }),
      offer({ relaying: 1.5 }),
      { ...offer(), capacity: undefined },
      { ...offer(), reachability: 'excellent' },
      { ...offer(), reachability: undefined },
    ]) {
      expect(sanitiseAssistOffer(bad as unknown), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('drops anything that is not an object at all', () => {
    for (const bad of [null, undefined, 7, 'public', [], true]) {
      expect(sanitiseAssistOffer(bad)).toBeUndefined()
    }
  })
})

describe('assistPairKey', () => {
  it('is the same string whichever end asks', () => {
    expect(assistPairKey(A, B)).toBe(assistPairKey(B, A))
  })

  it('folds case, because nothing on the wire forces it', () => {
    expect(assistPairKey(A.toUpperCase(), B)).toBe(assistPairKey(A, B))
  })
})

describe('selectAssistant', () => {
  it('returns null when nobody is volunteering', () => {
    expect(selectAssistant([A, B], [])).toBeNull()
  })

  it('never picks a volunteer that is behind a NAT', () => {
    const volunteers = [volunteer('cc33', { reachability: 'nat' }), volunteer('dd44', { reachability: 'symmetric' })]
    expect(selectAssistant([A, B], volunteers)).toBeNull()
  })

  it('never picks a volunteer that has not measured itself', () => {
    expect(selectAssistant([A, B], [volunteer('cc33', { reachability: 'unknown' })])).toBeNull()
  })

  it('never picks either end of the pair, however loudly it volunteers', () => {
    const volunteers: AssistVolunteer[] = [
      { device: A, offer: offer() },
      { device: B, offer: offer() },
    ]
    expect(selectAssistant([A, B], volunteers)).toBeNull()
  })

  it('never picks a volunteer with no room left', () => {
    expect(selectAssistant([A, B], [volunteer('cc33', { relaying: MAX_ASSISTED_PAIRS })])).toBeNull()
  })

  it('picks the one volunteer there is', () => {
    const only = volunteer('cc33')
    expect(selectAssistant([A, B], [only])?.device).toBe(only.device)
  })

  it('reaches the same answer at both ends, with no message exchanged', () => {
    const volunteers = ['cc33', 'dd44', 'ee55'].map((l) => volunteer(l))
    const fromA = selectAssistant([A, B], volunteers)
    const fromB = selectAssistant([B, A], [...volunteers].reverse())
    expect(fromB?.device).toBe(fromA?.device)
  })

  it('is unaffected by the order the roster happened to arrive in', () => {
    const volunteers = ['cc33', 'dd44', 'ee55', 'ff66'].map((l) => volunteer(l))
    const forwards = rankAssistants([A, B], volunteers).map((c) => c.device)
    const backwards = rankAssistants([A, B], [...volunteers].reverse()).map((c) => c.device)
    expect(backwards).toEqual(forwards)
  })

  it('is unaffected by the case a pubkey arrived in', () => {
    const volunteers = ['cc33', 'dd44', 'ee55'].map((l) => volunteer(l))
    const shouty = volunteers.map((v) => ({ ...v, device: v.device.toUpperCase() }))
    expect(selectAssistant([A.toUpperCase(), B], shouty)?.device).toBe(selectAssistant([A, B], volunteers)?.device)
  })

  it('skips a volunteer this pair has already tried and lost', () => {
    const volunteers = ['cc33', 'dd44', 'ee55'].map((l) => volunteer(l))
    const first = selectAssistant([A, B], volunteers)
    const second = selectAssistant([A, B], volunteers, { exclude: [first!.device] })
    expect(second).not.toBeNull()
    expect(second!.device).not.toBe(first!.device)
    // ...and both ends still agree on the replacement.
    expect(selectAssistant([B, A], volunteers, { exclude: [first!.device.toUpperCase()] })?.device).toBe(second!.device)
  })

  it('runs out honestly rather than cycling once every volunteer has failed', () => {
    const volunteers = ['cc33', 'dd44'].map((l) => volunteer(l))
    const exclude = volunteers.map((v) => v.device)
    expect(selectAssistant([A, B], volunteers, { exclude })).toBeNull()
  })

  it('ignores an offer that does not survive sanitising rather than trusting it', () => {
    const liar: AssistVolunteer = {
      device: dev('cc33'),
      offer: { reachability: 'public', capacity: { uplinkBps: Number.NaN, peers: 0, perPeerBps: 0 }, relaying: 0, maxRelayed: 9 } as AssistOffer,
    }
    expect(selectAssistant([A, B], [liar])).toBeNull()
  })

  it('reads a hundredfold capacity claim as the cap, not as a hundredfold share', () => {
    const boaster = volunteer('cc33', { maxRelayed: 500 })
    expect(selectAssistant([A, B], [boaster])?.slots).toBeLessThanOrEqual(MAX_ASSISTED_PAIRS)
  })
})

describe('spreading load rather than saturating one volunteer', () => {
  /** Pairs of made-up devices, enough to see a distribution. */
  function pairs(count: number): Array<[string, string]> {
    return Array.from({ length: count }, (_, i) => [dev(`e${i}a`), dev(`f${i}b`)] as [string, string])
  }

  it('spreads pairs across equal volunteers instead of stacking them on one', () => {
    const volunteers = ['c1', 'c2', 'c3', 'c4'].map((l) => volunteer(l))
    const counts = new Map<string, number>()
    for (const pair of pairs(400)) {
      const chosen = selectAssistant(pair, volunteers)
      counts.set(chosen!.device, (counts.get(chosen!.device) ?? 0) + 1)
    }
    expect(counts.size).toBe(4)
    // A quarter each, give or take. The assertion is deliberately loose: the
    // claim is "spread", not "perfectly balanced".
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(400 * 0.15)
      expect(count).toBeLessThan(400 * 0.4)
    }
  })

  it('gives a volunteer with more spare capacity more of the load, not all of it', () => {
    // Three slots against one slot.
    const big = volunteer('c1')
    const small = volunteer('c2', { capacity: capacity({ uplinkBps: 6_000_000 }), maxRelayed: 1 })
    expect(assistSlots(big.offer)).toBe(3)
    expect(assistSlots(small.offer)).toBe(1)

    const counts = new Map<string, number>()
    for (const pair of pairs(400)) {
      const chosen = selectAssistant(pair, [big, small])
      counts.set(chosen!.device, (counts.get(chosen!.device) ?? 0) + 1)
    }
    // The small one keeps a real share - it is not saturation of the best.
    expect(counts.get(small.device)!).toBeGreaterThan(400 * 0.1)
    expect(counts.get(big.device)!).toBeGreaterThan(counts.get(small.device)!)
  })

  it('moves only the pairs the departed volunteer was carrying', () => {
    // The property that makes losing a volunteer survivable: everybody else's
    // assignment is untouched, so a laptop closing does not reshuffle the room.
    const volunteers = ['c1', 'c2', 'c3', 'c4'].map((l) => volunteer(l))
    const before = new Map(pairs(200).map((p) => [p.join(), selectAssistant(p, volunteers)!.device]))
    const gone = volunteers[0]!.device
    const after = new Map(pairs(200).map((p) => [p.join(), selectAssistant(p, volunteers.slice(1))?.device]))

    for (const [pair, chosen] of before) {
      if (chosen === gone) continue
      expect(after.get(pair), `pair ${pair} should not have moved`).toBe(chosen)
    }
  })
})

describe('assistDecision', () => {
  function env(over: Partial<AssistEnvironment> = {}): AssistEnvironment {
    return {
      reachability: 'public',
      canRelay: true,
      capacity: capacity(),
      formFactor: 'desktop',
      onBattery: false,
      metered: false,
      ...over,
    }
  }

  it('does not offer without an explicit opt-in, however good the situation', () => {
    expect(assistDecision(env()).offering).toBe(false)
    expect(assistDecision(env(), undefined).offering).toBe(false)
    expect(assistDecision(env(), false).offering).toBe(false)
    expect(assistDecision(env(), true).offering).toBe(true)
  })

  it('recommends a desktop on mains power on an unmetered connection', () => {
    const decision = assistDecision(env(), true)
    expect(decision.recommended).toBe(true)
    expect(decision.blocks).toEqual([])
  })

  it('never recommends a phone, and says why', () => {
    const decision = assistDecision(env({ formFactor: 'mobile' }), true)
    expect(decision.recommended).toBe(false)
    expect(decision.blocks).toContain('mobile')
    // Still allowed, because it is their bandwidth to give if they insist.
    expect(decision.offering).toBe(true)
  })

  it('treats a form factor it cannot detect as a phone', () => {
    expect(assistDecision(env({ formFactor: undefined }), true).blocks).toContain('mobile')
    expect(assistDecision(env({ formFactor: 'unknown' }), true).recommended).toBe(false)
  })

  it('never recommends a device on battery or on a metered connection', () => {
    expect(assistDecision(env({ onBattery: true }), true).blocks).toContain('on-battery')
    expect(assistDecision(env({ metered: true }), true).blocks).toContain('metered')
  })

  it('does not hold undetectable battery or metering against a device', () => {
    expect(assistDecision(env({ onBattery: undefined, metered: undefined }), true).recommended).toBe(true)
  })

  it('refuses outright when the browser cannot forward frames, opt-in or not', () => {
    const decision = assistDecision(env({ canRelay: false }), true)
    expect(decision.offering).toBe(false)
    expect(decision.blocks).toContain('no-relay-support')
  })

  it('refuses outright when nobody could reach this device', () => {
    for (const reachability of ['nat', 'symmetric', 'unknown'] as const) {
      const decision = assistDecision(env({ reachability }), true)
      expect(decision.offering, reachability).toBe(false)
      expect(decision.blocks).toContain('not-publicly-reachable')
    }
  })

  it('refuses when there is nothing left over for even one pair', () => {
    const decision = assistDecision(env({ capacity: capacity({ uplinkBps: 4_000_000 }) }), true)
    expect(decision.offering).toBe(false)
    expect(decision.blocks).toContain('no-spare-uplink')
  })

  it('refuses a device that has measured nothing at all, rather than reading it as plenty', () => {
    // Two zeroes used to cancel: no uplink and no per-peer cost compared as
    // "enough spare for a pair that costs nothing". See `UplinkProbe`, which
    // reports zero exactly when it has measured nothing.
    const decision = assistDecision(env({ capacity: { uplinkBps: 0, peers: 0, perPeerBps: 0 } }), true)
    expect(decision.offering).toBe(false)
    expect(decision.blocks).toContain('no-spare-uplink')
  })
})

describe('buildAssistOffer', () => {
  const good: AssistEnvironment = {
    reachability: 'public',
    canRelay: true,
    capacity: capacity(),
    formFactor: 'desktop',
    onBattery: false,
    metered: false,
  }

  it('builds nothing at all until somebody has opted in', () => {
    expect(buildAssistOffer(good, 0)).toBeNull()
  })

  it('publishes the measured numbers, not a promise', () => {
    const built = buildAssistOffer(good, 1, true)
    expect(built).toEqual({
      reachability: 'public',
      capacity: capacity(),
      relaying: 1,
      maxRelayed: MAX_ASSISTED_PAIRS,
    })
  })

  it('is null again the moment the person revokes', () => {
    expect(buildAssistOffer(good, 1, false)).toBeNull()
  })
})
