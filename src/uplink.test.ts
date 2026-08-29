import { describe, it, expect } from 'vitest'
import { MIN_SAMPLE_MS, STALE_AFTER_MS, UplinkProbe, summariseStats } from './uplink.js'
import type { StatLike } from './uplink.js'
import { assistDecision } from './peer-assist.js'

/** One connection's `getStats()` report, in the shape a browser hands over. */
function report(over: {
  sent?: number
  received?: number
  estimate?: number
  extraPairs?: Array<{ state: string; availableOutgoingBitrate: number }>
} = {}): StatLike[] {
  const stats: StatLike[] = [
    { type: 'outbound-rtp', kind: 'video', bytesSent: over.sent ?? 0 },
    { type: 'inbound-rtp', kind: 'video', bytesReceived: over.received ?? 0 },
    { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: over.estimate ?? 0 },
  ]
  for (const pair of over.extraPairs ?? []) stats.push({ type: 'candidate-pair', ...pair })
  return stats
}

describe('summariseStats', () => {
  it('adds up every outbound and inbound stream on one connection', () => {
    const sample = summariseStats(
      [
        { type: 'outbound-rtp', kind: 'video', bytesSent: 1000 },
        { type: 'outbound-rtp', kind: 'audio', bytesSent: 200 },
        { type: 'inbound-rtp', kind: 'video', bytesReceived: 3000 },
        { type: 'inbound-rtp', kind: 'audio', bytesReceived: 400 },
      ],
      0,
    )
    expect(sample.bytesSent).toBe(1200)
    expect(sample.bytesReceived).toBe(3400)
  })

  it('takes the estimate from a succeeded candidate pair and ignores the rest', () => {
    const sample = summariseStats(
      [
        { type: 'candidate-pair', state: 'failed', availableOutgoingBitrate: 90_000_000 },
        { type: 'candidate-pair', state: 'in-progress', availableOutgoingBitrate: 80_000_000 },
        { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: 5_000_000 },
      ],
      0,
    )
    // A path ICE did not choose describes bandwidth on a route nothing is
    // flowing over, and a volunteer would be advertising it to people who
    // cannot use it.
    expect(sample.availableOutgoingBitrate).toBe(5_000_000)
  })

  it('takes the largest of several succeeded pairs rather than the last one seen', () => {
    const sample = summariseStats(
      [
        { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: 5_000_000 },
        { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: 1_000_000 },
      ],
      0,
    )
    expect(sample.availableOutgoingBitrate).toBe(5_000_000)
  })

  it('reads a missing, negative or nonsense figure as nothing measured', () => {
    const sample = summariseStats(
      [
        { type: 'outbound-rtp', bytesSent: Number.NaN },
        { type: 'inbound-rtp', bytesReceived: -5 },
        { type: 'candidate-pair', state: 'succeeded' },
      ],
      0,
    )
    expect(sample).toMatchObject({ bytesSent: 0, bytesReceived: 0, availableOutgoingBitrate: 0 })
  })

  it('survives a report full of things it does not understand', () => {
    const sample = summariseStats(
      [null as unknown as StatLike, { type: 'certificate' }, { type: 'media-source' }],
      0,
    )
    expect(sample.bytesSent).toBe(0)
  })
})

describe('UplinkProbe', () => {
  it('says nothing from a single sample, because a rate needs two', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 1_000_000, estimate: 8_000_000 }), 0)
    // Reading a cumulative counter as a rate would report an hour of call as
    // if it had happened in an instant.
    expect(probe.capacity(0)).toEqual({ uplinkBps: 0, peers: 0, perPeerBps: 0 })
    expect(probe.measured(0)).toBe(false)
  })

  it('measures the send rate between two samples', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 0)
    // 150,000 bytes in one second is 1.2 Mbps.
    probe.update('a', report({ sent: 150_000, estimate: 8_000_000 }), 1000)
    expect(probe.capacity(1000)).toEqual({ uplinkBps: 8_000_000, peers: 1, perPeerBps: 1_200_000 })
  })

  it('adds the estimates of connections sharing one uplink', () => {
    const probe = new UplinkProbe()
    for (const key of ['a', 'b', 'c']) {
      probe.update(key, report({ sent: 0, estimate: 3_000_000 }), 0)
      probe.update(key, report({ sent: 75_000, estimate: 3_000_000 }), 1000)
    }
    // Three flows competing for one household link converge on shares that
    // add up to it, so the sum is the estimate of the link rather than a
    // multiple of it.
    expect(probe.capacity(1000).uplinkBps).toBe(9_000_000)
    expect(probe.capacity(1000).peers).toBe(3)
  })

  it('counts what a person costs from whichever direction saw more of it', () => {
    const probe = new UplinkProbe()
    // Camera off: this device sends almost nothing but receives a full stream.
    probe.update('a', report({ sent: 0, received: 0, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 1_000, received: 75_000, estimate: 8_000_000 }), 1000)
    // Otherwise a listener would advertise that every pair it carried was
    // free, and be chosen for all of them.
    expect(probe.capacity(1000).perPeerBps).toBe(600_000)
  })

  it('does not count a connection that has moved nothing as a peer', () => {
    const probe = new UplinkProbe()
    probe.update('idle', report({ estimate: 4_000_000 }), 0)
    probe.update('idle', report({ estimate: 4_000_000 }), 1000)
    const capacity = probe.capacity(1000)
    expect(capacity.peers).toBe(0)
    expect(capacity.perPeerBps).toBe(0)
    // The link it measured is real even though nothing is using it.
    expect(capacity.uplinkBps).toBe(4_000_000)
  })

  it('ignores two samples taken too close together to divide', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 150_000, estimate: 8_000_000 }), MIN_SAMPLE_MS - 1)
    expect(probe.capacity(MIN_SAMPLE_MS).uplinkBps).toBe(0)
  })

  it('reads a counter that went backwards as a connection replaced, not a negative rate', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 900_000, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 1_000, estimate: 8_000_000 }), 1000)
    expect(probe.capacity(1000).perPeerBps).toBe(0)
  })

  it('stops counting a connection nobody has sampled for a while', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 150_000, estimate: 8_000_000 }), 1000)
    expect(probe.capacity(1000).uplinkBps).toBe(8_000_000)
    // An offer built on a stale measurement is a claim about a room that has
    // since changed.
    expect(probe.capacity(1000 + STALE_AFTER_MS + 1).uplinkBps).toBe(0)
  })

  it('forgets a closed connection at once, and forgets everything on clear', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 150_000, estimate: 8_000_000 }), 1000)
    probe.update('b', report({ sent: 0, estimate: 2_000_000 }), 0)
    probe.update('b', report({ sent: 150_000, estimate: 2_000_000 }), 1000)

    probe.forget('b')
    expect(probe.capacity(1000).uplinkBps).toBe(8_000_000)
    probe.clear()
    expect(probe.capacity(1000)).toEqual({ uplinkBps: 0, peers: 0, perPeerBps: 0 })
  })

  it('starts a forgotten key from scratch rather than from its old baseline', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 500_000, estimate: 8_000_000 }), 0)
    probe.forget('a')
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 1000)
    expect(probe.capacity(1000).uplinkBps).toBe(0)
  })

  it('lets a custom staleness window be shorter', () => {
    const probe = new UplinkProbe({ staleAfterMs: 2_000 })
    probe.update('a', report({ sent: 0, estimate: 8_000_000 }), 0)
    probe.update('a', report({ sent: 150_000, estimate: 8_000_000 }), 1000)
    expect(probe.capacity(4_000).uplinkBps).toBe(0)
  })
})

describe('what a measurement means for consent', () => {
  const base = { reachability: 'public', canRelay: true, formFactor: 'desktop' } as const

  it('will not volunteer a device that has measured nothing', () => {
    const probe = new UplinkProbe()
    const decision = assistDecision({ ...base, capacity: probe.capacity(0) }, true)
    // The hole this closes: an uplink of zero and a per-peer cost of zero
    // used to compare as "enough spare for a pair that costs nothing", so a
    // device that had measured nothing offered to carry three.
    expect(decision.offering).toBe(false)
    expect(decision.blocks).toContain('no-spare-uplink')
  })

  it('volunteers a measured laptop with room to spare', () => {
    const probe = new UplinkProbe()
    probe.update('a', report({ sent: 0, received: 0, estimate: 20_000_000 }), 0)
    probe.update('a', report({ sent: 75_000, received: 75_000, estimate: 20_000_000 }), 1000)
    const decision = assistDecision({ ...base, capacity: probe.capacity(1000) }, true)
    expect(decision.offering).toBe(true)
    expect(decision.blocks).toEqual([])
  })

  it('will not volunteer a measured link with nothing left on it', () => {
    const probe = new UplinkProbe()
    // 1 Mbps of uplink, already spending 600 kbps on its own call.
    probe.update('a', report({ sent: 0, estimate: 1_000_000 }), 0)
    probe.update('a', report({ sent: 75_000, estimate: 1_000_000 }), 1000)
    const decision = assistDecision({ ...base, capacity: probe.capacity(1000) }, true)
    expect(decision.offering).toBe(false)
    expect(decision.blocks).toContain('no-spare-uplink')
  })
})
