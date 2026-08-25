import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEADROOM,
  needsForwarding,
  selectForwarder,
  type CapacityEstimate,
  type ForwarderRef,
} from './forwarder.js'

/** ~32 kbps Opus, the figure the design's arithmetic table uses. */
const OPUS_BPS = 32_000
/** ~2 Mbps, the low end of "legible 1080p screen share". */
const SCREEN_1080P_BPS = 2_000_000
/** A representative UK domestic uplink: 10 Mbps. */
const DOMESTIC_UPLINK_BPS = 10_000_000

const estimate = (over: Partial<CapacityEstimate> = {}): CapacityEstimate => ({
  uplinkBps: DOMESTIC_UPLINK_BPS,
  peers: 4,
  perPeerBps: 150_000,
  ...over,
})

describe('needsForwarding', () => {
  it('defaults to a headroom of 0.8, so promotion happens before saturation', () => {
    expect(DEFAULT_HEADROOM).toBe(0.8)
  })

  it('says no while the mesh fits inside the headroom budget', () => {
    // 4 x 150 kbps = 0.6 Mbps against an 8 Mbps budget.
    expect(needsForwarding(estimate())).toBe(false)
  })

  it('says yes once the mesh exceeds the headroom budget, before it exceeds the uplink', () => {
    // 9 Mbps needed, 10 Mbps uplink - fits raw, does not fit with headroom.
    const short = estimate({ peers: 9, perPeerBps: 1_000_000 })
    expect(short.peers * short.perPeerBps).toBeLessThan(short.uplinkBps)
    expect(needsForwarding(short)).toBe(true)
  })

  it('does not promote twenty people on audio-only', () => {
    // Headcount alone must never decide: 20 peers is far past any mesh
    // "ceiling" you would pick by counting heads, and 0.64 Mbps is nothing.
    expect(needsForwarding(estimate({ peers: 20, perPeerBps: OPUS_BPS }))).toBe(false)
  })

  it('promotes two people sharing legible 1080p screens', () => {
    // And the converse: a headcount of two, well under any ceiling, that a
    // 3 Mbps uplink cannot carry.
    expect(
      needsForwarding(estimate({ uplinkBps: 3_000_000, peers: 2, perPeerBps: SCREEN_1080P_BPS })),
    ).toBe(true)
  })

  it('never promotes a room with nobody to send to', () => {
    expect(needsForwarding(estimate({ peers: 0, perPeerBps: SCREEN_1080P_BPS }))).toBe(false)
  })

  it('never promotes a room sending nothing', () => {
    expect(needsForwarding(estimate({ peers: 50, perPeerBps: 0 }))).toBe(false)
  })

  it('treats the budget boundary as sufficient, not short', () => {
    // Exactly 8 Mbps needed against an 8 Mbps budget: promotion is for a
    // shortfall, and this is not one.
    expect(needsForwarding(estimate({ peers: 8, perPeerBps: 1_000_000 }))).toBe(false)
  })

  it('honours an explicit headroom', () => {
    const tight = estimate({ peers: 8, perPeerBps: 1_000_000 })
    expect(needsForwarding(tight, 0.8)).toBe(false)
    expect(needsForwarding(tight, 0.5)).toBe(true)
  })

  it('refuses an unmeasurable estimate rather than answering from a NaN', () => {
    // A silently false answer here is a room that congests and never
    // promotes, which presents as "the call is bad" and nothing else.
    expect(() => needsForwarding(estimate({ uplinkBps: Number.NaN }))).toThrow()
    expect(() => needsForwarding(estimate({ perPeerBps: Number.POSITIVE_INFINITY }))).toThrow()
    expect(() => needsForwarding(estimate({ uplinkBps: -1 }))).toThrow()
    expect(() => needsForwarding(estimate({ peers: -1 }))).toThrow()
    expect(() => needsForwarding(estimate({ peers: 2.5 }))).toThrow()
  })

  it('refuses a headroom that is not a fraction of the uplink', () => {
    expect(() => needsForwarding(estimate(), 0)).toThrow()
    expect(() => needsForwarding(estimate(), 1.5)).toThrow()
    expect(() => needsForwarding(estimate(), Number.NaN)).toThrow()
  })
})

const ALPHA: ForwarderRef = { url: 'wss://alpha.example/fwd', pubkey: 'AA'.repeat(32), label: 'Alpha' }
const BRAVO: ForwarderRef = { url: 'wss://bravo.example/fwd', pubkey: 'bb'.repeat(32) }
const CHARLIE: ForwarderRef = { url: 'ws://charlie.local:7788', label: 'The box under the stairs' }

describe('selectForwarder', () => {
  it('degrades rather than throwing when the room names no forwarder', () => {
    expect(selectForwarder([])).toBeNull()
  })

  it('returns the only usable forwarder', () => {
    expect(selectForwarder([BRAVO])).toEqual(BRAVO)
  })

  it('reaches the same answer from any ordering of the same list', () => {
    // Every client in the room must pick the same forwarder from the same
    // descriptor without exchanging a message about it, so the answer cannot
    // depend on the order the list happened to arrive in.
    const chosen = selectForwarder([ALPHA, BRAVO, CHARLIE])
    expect(selectForwarder([CHARLIE, BRAVO, ALPHA])).toEqual(chosen)
    expect(selectForwarder([BRAVO, ALPHA, CHARLIE])).toEqual(chosen)
    expect(chosen).toEqual(ALPHA)
  })

  it('is stable across repeated calls', () => {
    const refs = [ALPHA, BRAVO, CHARLIE]
    expect(selectForwarder(refs)).toEqual(selectForwarder(refs))
  })

  it('honours a preference named by pubkey, case-insensitively', () => {
    expect(selectForwarder([ALPHA, BRAVO], 'BB'.repeat(32))).toEqual(BRAVO)
    expect(selectForwarder([ALPHA, BRAVO], 'aa'.repeat(32))).toEqual(ALPHA)
  })

  it('honours a preference named by url', () => {
    expect(selectForwarder([ALPHA, BRAVO, CHARLIE], 'ws://charlie.local:7788')).toEqual(CHARLIE)
  })

  it('falls back to the deterministic pick when the preference is not in the list', () => {
    // A stale preference - a forwarder the room dropped between calls - must
    // cost nothing.
    expect(selectForwarder([ALPHA, BRAVO], 'wss://gone.example')).toEqual(ALPHA)
  })

  it('drops entries whose url is not a signalling endpoint', () => {
    const hostile: ForwarderRef[] = [
      { url: '' },
      { url: 'javascript:alert(1)' },
      { url: 'not a url at all' },
      { url: 'https://alpha.example/fwd' },
      BRAVO,
    ]
    expect(selectForwarder(hostile)).toEqual(BRAVO)
  })

  it('will not let a preference smuggle an unusable entry through', () => {
    const hostile: ForwarderRef[] = [{ url: 'javascript:alert(1)', pubkey: 'cc'.repeat(32) }, BRAVO]
    expect(selectForwarder(hostile, 'cc'.repeat(32))).toEqual(BRAVO)
  })

  it('returns null when no entry is usable', () => {
    expect(selectForwarder([{ url: '' }, { url: 'javascript:alert(1)' }])).toBeNull()
  })

  it('breaks a url tie on the pubkey, so equal urls still order deterministically', () => {
    const a: ForwarderRef = { url: 'wss://same.example/fwd', pubkey: 'ff'.repeat(32) }
    const b: ForwarderRef = { url: 'wss://same.example/fwd', pubkey: '11'.repeat(32) }
    expect(selectForwarder([a, b])).toEqual(b)
    expect(selectForwarder([b, a])).toEqual(b)
  })
})
