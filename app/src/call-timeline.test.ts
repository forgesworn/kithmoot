import { describe, it, expect } from 'vitest'
import {
  CallTimeline,
  PairHealthSampler,
  AdvertTracker,
  sanitiseDevice,
  sanitiseDetail,
  MAX_ENTRIES,
  MAX_AGE_MS,
  type PairSample,
} from './call-timeline.js'

function fakeClock(startAt = 1_000_000) {
  let now = startAt
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('CallTimeline', () => {
  it('orders entries oldest first, newest last', () => {
    const clock = fakeClock()
    const timeline = new CallTimeline(clock.now)
    timeline.record('signal-sent', 'aabbccdd')
    clock.advance(1000)
    timeline.record('signal-received', 'aabbccdd')
    clock.advance(1000)
    timeline.record('ice-restart', 'aabbccdd')
    const kinds = timeline.entries().map((e) => e.kind)
    expect(kinds).toEqual(['signal-sent', 'signal-received', 'ice-restart'])
    expect(timeline.entries().map((e) => e.atMs)).toEqual([0, 1000, 2000])
  })

  it('caps at MAX_ENTRIES, dropping the oldest first', () => {
    const clock = fakeClock()
    const timeline = new CallTimeline(clock.now)
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      timeline.record('signal-sent', 'aabbccdd', `n${i}`)
      clock.advance(1)
    }
    expect(timeline.entries().length).toBe(MAX_ENTRIES)
    expect(timeline.entries()[0].detail).toBe('n50')
    expect(timeline.entries()[timeline.entries().length - 1].detail).toBe(`n${MAX_ENTRIES + 49}`)
  })

  it('caps at MAX_AGE_MS, dropping entries older than the window', () => {
    const clock = fakeClock()
    const timeline = new CallTimeline(clock.now)
    timeline.record('signal-sent', 'aabbccdd', 'old')
    clock.advance(MAX_AGE_MS + 1)
    timeline.record('signal-sent', 'aabbccdd', 'new')
    const details = timeline.entries().map((e) => e.detail)
    expect(details).toEqual(['new'])
  })

  it('never throws on a bad device or detail, and drops what it cannot vouch for', () => {
    const timeline = new CallTimeline()
    timeline.record('signal-sent', 'not-hex-at-all', 'fine detail')
    expect(timeline.entries()[0].device).toBeUndefined()
    expect(timeline.entries()[0].detail).toBe('fine detail')
  })

  it('formats one line per entry with a relative timestamp', () => {
    const clock = fakeClock()
    const timeline = new CallTimeline(clock.now)
    timeline.record('signal-sent', 'aabbccdd', 'offer')
    const lines = timeline.format()
    expect(lines).toEqual(['+0.0s signal-sent aabbccdd offer'])
  })

  it('omits device and detail from a line when absent', () => {
    const timeline = new CallTimeline()
    timeline.record('probe-failed')
    expect(timeline.format()).toEqual(['+0.0s probe-failed'])
  })
})

describe('sanitiseDevice', () => {
  it('accepts an 8-hex id unchanged', () => {
    expect(sanitiseDevice('aabbccdd')).toBe('aabbccdd')
  })

  it('shortens a longer all-hex id to its first 8 characters', () => {
    const full = 'a'.repeat(64)
    expect(sanitiseDevice(full)).toBe('aaaaaaaa')
  })

  it('rejects anything that is not hex', () => {
    expect(sanitiseDevice('not-hex')).toBeUndefined()
    expect(sanitiseDevice('Alice')).toBeUndefined()
  })

  it('passes undefined through', () => {
    expect(sanitiseDevice(undefined)).toBeUndefined()
  })
})

describe('sanitiseDetail', () => {
  it('keeps ordinary short text', () => {
    expect(sanitiseDetail('offer')).toBe('offer')
  })

  it('drops anything with a long hex run, as a key or id would have', () => {
    expect(sanitiseDetail(`key ${'f'.repeat(32)}`)).toBeUndefined()
  })

  it('drops text that looks like an SDP or candidate fragment', () => {
    expect(sanitiseDetail('v=0\r\no=- 1 1 IN IP4 0.0.0.0')).toBeUndefined()
    expect(sanitiseDetail('a=candidate:1 1 udp 2122260223 10.0.0.1 5000 typ host')).toBeUndefined()
    expect(sanitiseDetail('candidate:1 1 udp 2122260223 10.0.0.1 5000 typ host')).toBeUndefined()
  })

  it('truncates long text rather than passing all of it through', () => {
    const long = 'x'.repeat(200)
    const result = sanitiseDetail(long)
    expect(result?.length).toBeLessThan(90)
    expect(result?.endsWith('...')).toBe(true)
  })

  it('drops empty or whitespace-only text', () => {
    expect(sanitiseDetail('')).toBeUndefined()
    expect(sanitiseDetail('   ')).toBeUndefined()
  })
})

describe('AdvertTracker', () => {
  it('reports nothing on the first sighting of a stable set of roles', () => {
    const tracker = new AdvertTracker()
    const changes = tracker.update([{ device: 'aabbccdd', roles: ['mic', 'camera'] }])
    expect(changes).toEqual([{ device: 'aabbccdd', added: ['mic', 'camera'], removed: [] }])
  })

  it('reports nothing when nothing changed', () => {
    const tracker = new AdvertTracker()
    tracker.update([{ device: 'aabbccdd', roles: ['mic'] }])
    const changes = tracker.update([{ device: 'aabbccdd', roles: ['mic'] }])
    expect(changes).toEqual([])
  })

  it('reports a role gained', () => {
    const tracker = new AdvertTracker()
    tracker.update([{ device: 'aabbccdd', roles: ['mic'] }])
    const changes = tracker.update([{ device: 'aabbccdd', roles: ['mic', 'camera'] }])
    expect(changes).toEqual([{ device: 'aabbccdd', added: ['camera'], removed: [] }])
  })

  it('reports a role lost', () => {
    const tracker = new AdvertTracker()
    tracker.update([{ device: 'aabbccdd', roles: ['mic', 'camera'] }])
    const changes = tracker.update([{ device: 'aabbccdd', roles: ['mic'] }])
    expect(changes).toEqual([{ device: 'aabbccdd', added: [], removed: ['camera'] }])
  })

  it('reports every role removed once when a device disappears entirely', () => {
    const tracker = new AdvertTracker()
    tracker.update([{ device: 'aabbccdd', roles: ['mic', 'camera'] }])
    const changes = tracker.update([])
    expect(changes).toEqual([{ device: 'aabbccdd', added: [], removed: ['mic', 'camera'] }])
    // And it does not repeat the same departure on the next call.
    expect(tracker.update([])).toEqual([])
  })
})

describe('PairHealthSampler', () => {
  function sample(overrides: Partial<PairSample> = {}): PairSample {
    return {
      device: 'aabbccdd',
      tier: 'direct',
      connectionState: 'connected',
      signalingState: 'stable',
      slots: [{ label: 'video', counter: 10 }],
      outboundAcknowledged: true,
      ...overrides,
    }
  }

  it('reports a first sample as first-sample, never guessing progress', () => {
    const sampler = new PairHealthSampler()
    const [line] = sampler.snapshot([sample()])
    expect(line).toContain('video:first-sample')
  })

  it('reports moving when a counter has increased since the last sample', () => {
    const sampler = new PairHealthSampler()
    sampler.snapshot([sample({ slots: [{ label: 'video', counter: 10 }] })])
    const [line] = sampler.snapshot([sample({ slots: [{ label: 'video', counter: 25 }] })])
    expect(line).toContain('video:moving')
  })

  it('reports stalled when a counter has not moved since the last sample', () => {
    const sampler = new PairHealthSampler()
    sampler.snapshot([sample({ slots: [{ label: 'video', counter: 10 }] })])
    const [line] = sampler.snapshot([sample({ slots: [{ label: 'video', counter: 10 }] })])
    expect(line).toContain('video:stalled')
  })

  it('tracks slots and pairs independently', () => {
    const sampler = new PairHealthSampler()
    sampler.snapshot([
      sample({ device: 'aabbccdd', slots: [{ label: 'audio', counter: 5 }, { label: 'video', counter: 5 }] }),
      sample({ device: '11223344', slots: [{ label: 'video', counter: 5 }] }),
    ])
    const lines = sampler.snapshot([
      sample({ device: 'aabbccdd', slots: [{ label: 'audio', counter: 5 }, { label: 'video', counter: 9 }] }),
      sample({ device: '11223344', slots: [{ label: 'video', counter: 5 }] }),
    ])
    expect(lines[0]).toContain('audio:stalled')
    expect(lines[0]).toContain('video:moving')
    expect(lines[1]).toContain('video:stalled')
  })

  it('flags an unanswered offer from the signalling state', () => {
    const sampler = new PairHealthSampler()
    const [line] = sampler.snapshot([sample({ signalingState: 'have-local-offer' })])
    expect(line).toContain('unanswered-offer')
  })

  it('does not flag an unanswered offer when stable', () => {
    const sampler = new PairHealthSampler()
    const [line] = sampler.snapshot([sample({ signalingState: 'stable' })])
    expect(line).not.toContain('unanswered-offer')
  })

  it('reports whether our outbound is acknowledged by remote-inbound-rtp', () => {
    const sampler = new PairHealthSampler()
    const [line] = sampler.snapshot([sample({ outboundAcknowledged: false })])
    expect(line).toContain('outboundAcked=false')
  })
})
