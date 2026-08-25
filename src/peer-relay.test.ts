import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RELAY_QUEUE,
  FrameRelay,
  PeerRelay,
  RelayPair,
  detectRelayCapability,
} from './peer-relay.js'
import type { EncodedFrameLike, EncodedStreamPair, RelayScope } from './peer-relay.js'
import { MAX_ASSISTED_PAIRS } from './peer-assist.js'

/** A frame the way a browser hands one out: bytes plus a type. */
function frame(byte: number, length = 8, type: 'key' | 'delta' = 'delta'): EncodedFrameLike {
  const data = new Uint8Array(length).fill(byte)
  return { data: data.buffer as ArrayBuffer, type }
}

function bytesOf(frame: EncodedFrameLike): number[] {
  return [...new Uint8Array(frame.data)]
}

/** A sender or receiver's stream pair, driven by hand. */
function streamPair(): {
  pair: EncodedStreamPair
  push: (frame: EncodedFrameLike) => Promise<void>
  end: () => Promise<void>
  written: EncodedFrameLike[]
} {
  const written: EncodedFrameLike[] = []
  let controller!: ReadableStreamDefaultController<EncodedFrameLike>
  const readable = new ReadableStream<EncodedFrameLike>({
    start(c) {
      controller = c
    },
  })
  const writable = new WritableStream<EncodedFrameLike>({
    write(frame) {
      written.push(frame)
    },
  })
  return {
    pair: { readable, writable },
    push: async (frame) => {
      controller.enqueue(frame)
      await settle()
    },
    end: async () => {
      controller.close()
      await settle()
    },
    written,
  }
}

/** Let the stream machinery run. Streams schedule on microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

const CHROMIUM: RelayScope = {
  RTCRtpSender: { prototype: { createEncodedStreams() {}, transform: undefined } },
  RTCRtpReceiver: { prototype: { createEncodedStreams() {}, transform: undefined } },
  RTCRtpScriptTransform: class {},
}

const SAFARI: RelayScope = {
  RTCRtpSender: { prototype: { transform: undefined } },
  RTCRtpReceiver: { prototype: { transform: undefined } },
  RTCRtpScriptTransform: class {},
}

const NEITHER: RelayScope = {
  RTCRtpSender: { prototype: {} },
  RTCRtpReceiver: { prototype: {} },
}

describe('detectRelayCapability', () => {
  it('accepts a browser with insertable streams on both sides', () => {
    // Measured: Chromium relays 118 of 135 frames through this path with the
    // far end decoding every one it received. See ASSIST-REPORT.md.
    expect(detectRelayCapability(CHROMIUM)).toEqual({
      mechanism: 'insertable-streams',
      canForwardFrames: true,
      missing: [],
    })
  })

  it('will not claim a script-transform-only browser can relay until somebody has measured it', () => {
    const capability = detectRelayCapability(SAFARI)
    expect(capability.mechanism).toBe('script-transform')
    // The API is there and attaches on both sides. Nothing has been seen to
    // come out of it, and advertising an assist we cannot deliver is worse
    // than not advertising.
    expect(capability.canForwardFrames).toBe(false)
    expect(capability.missing).toContain('measured frame forwarding over RTCRtpScriptTransform')
  })

  it('takes a measurement as permission when one has been made', () => {
    const capability = detectRelayCapability(SAFARI, { assumeScriptTransformRelays: true })
    expect(capability.canForwardFrames).toBe(true)
    expect(capability.missing).toEqual([])
  })

  it('refuses a browser with neither mechanism, and says what was missing', () => {
    const capability = detectRelayCapability(NEITHER)
    expect(capability).toMatchObject({ mechanism: 'none', canForwardFrames: false })
    expect(capability.missing).toContain('RTCRtpSender.createEncodedStreams')
    expect(capability.missing).toContain('RTCRtpScriptTransform')
  })

  it('refuses a browser that can read a receiver but not replace a sender', () => {
    const halfway: RelayScope = {
      RTCRtpSender: { prototype: {} },
      RTCRtpReceiver: { prototype: { createEncodedStreams() {} } },
    }
    expect(detectRelayCapability(halfway).canForwardFrames).toBe(false)
  })

  it('refuses an empty scope rather than throwing on a missing global', () => {
    expect(detectRelayCapability({}).mechanism).toBe('none')
  })
})

describe('FrameRelay', () => {
  it('moves a frame from one connection to the other byte for byte', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    const outbound = streamPair()
    relay.consume(inbound.pair)
    relay.emit(outbound.pair)

    await inbound.push(frame(0xab, 5))
    // The clock ticks: the local encoder produces a frame, which is replaced.
    await outbound.push(frame(0x00, 2))

    expect(outbound.written).toHaveLength(1)
    expect(bytesOf(outbound.written[0]!)).toEqual([0xab, 0xab, 0xab, 0xab, 0xab])
    expect(relay.stats).toMatchObject({ received: 1, forwarded: 1, bytesIn: 5, bytesOut: 5 })
  })

  it('never enqueues an inbound frame onwards, so nothing decodes it', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    relay.consume(inbound.pair)
    await inbound.push(frame(0x11))
    // The inbound pair's own writable is where a decoder would be fed. It is
    // the absence of a write here that is the whole "without decoding" claim.
    expect(inbound.written).toHaveLength(0)
  })

  it('carries the frame type across, so a key frame stays a key frame', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    const outbound = streamPair()
    relay.consume(inbound.pair)
    relay.emit(outbound.pair)

    await inbound.push(frame(0x22, 4, 'key'))
    await outbound.push(frame(0x00, 2, 'delta'))
    expect(outbound.written[0]!.type).toBe('key')
  })

  it('drops the outbound frame when there is nothing to carry, rather than sending the clock', async () => {
    const relay = new FrameRelay()
    const outbound = streamPair()
    relay.emit(outbound.pair)

    await outbound.push(frame(0xff, 3))
    // The clock's own picture is a blank rectangle. Sending it would put that
    // rectangle where a person should be.
    expect(outbound.written).toHaveLength(0)
    expect(relay.stats.starved).toBe(1)
  })

  it('drops the oldest frame when the clock cannot keep up, and counts it', async () => {
    const relay = new FrameRelay({ queue: 3 })
    const inbound = streamPair()
    const outbound = streamPair()
    relay.consume(inbound.pair)
    relay.emit(outbound.pair)

    for (const byte of [1, 2, 3, 4, 5]) await inbound.push(frame(byte, 1))
    expect(relay.stats.dropped).toBe(2)
    expect(relay.queued).toBe(3)

    await outbound.push(frame(0, 1))
    // The newest frames are the ones still worth sending, so 1 and 2 went.
    expect(bytesOf(outbound.written[0]!)).toEqual([3])
  })

  it('holds a sensible amount by default', () => {
    expect(DEFAULT_RELAY_QUEUE).toBe(60)
    const relay = new FrameRelay()
    for (let i = 0; i < 100; i += 1) relay.accept(frame(i % 256, 1))
    expect(relay.queued).toBe(DEFAULT_RELAY_QUEUE)
  })

  it('counts the bytes it actually moved, so a person can be told what they spent', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    const outbound = streamPair()
    relay.consume(inbound.pair)
    relay.emit(outbound.pair)

    for (const byte of [1, 2, 3]) await inbound.push(frame(byte, 1000))
    for (let i = 0; i < 3; i += 1) await outbound.push(frame(0, 1))

    expect(relay.stats.bytesIn).toBe(3000)
    expect(relay.stats.bytesOut).toBe(3000)
  })

  it('stops carrying anything once closed', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    const outbound = streamPair()
    relay.consume(inbound.pair)
    relay.emit(outbound.pair)

    await inbound.push(frame(0x33, 2))
    relay.close()
    await outbound.push(frame(0, 1))
    expect(outbound.written).toHaveLength(0)
  })

  it('survives the inbound connection ending, because that is how a leg finishes', async () => {
    const relay = new FrameRelay()
    const inbound = streamPair()
    relay.consume(inbound.pair)
    await inbound.push(frame(0x44, 2))
    await inbound.end()
    expect(relay.stats.received).toBe(1)
  })

  it('copies the bytes out, because the inbound frame is recycled', async () => {
    const relay = new FrameRelay()
    const source = frame(0x55, 4)
    relay.accept(source)
    // The browser reuses the buffer for the next frame; a relay that kept the
    // reference would forward whatever landed in it afterwards.
    new Uint8Array(source.data).fill(0x99)

    const outgoing = frame(0x00, 1)
    expect(relay.fill(outgoing)).toBe(true)
    expect(bytesOf(outgoing)).toEqual([0x55, 0x55, 0x55, 0x55])
  })
})

describe('RelayPair', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('carries each end towards the other, on its own leg', () => {
    const pair = new RelayPair(A, B)
    expect(pair.leg(A)).not.toBeNull()
    expect(pair.leg(B)).not.toBeNull()
    expect(pair.leg(A)).not.toBe(pair.leg(B))
  })

  it('is the same pair whichever end names it', () => {
    expect(new RelayPair(A, B).key).toBe(new RelayPair(B, A).key)
  })

  it('normalises the case a pubkey arrived in', () => {
    const pair = new RelayPair(A.toUpperCase(), B)
    expect(pair.leg(A)).not.toBeNull()
    expect(pair.other(A)).toBe(B)
  })

  it('answers rather than throws for a device that is not part of it', () => {
    const pair = new RelayPair(A, B)
    expect(pair.leg('c'.repeat(64))).toBeNull()
    expect(pair.other('c'.repeat(64))).toBeNull()
  })

  it('adds both directions together when asked what it cost', () => {
    const pair = new RelayPair(A, B)
    pair.leg(A)!.accept(frame(1, 100))
    pair.leg(B)!.accept(frame(2, 250))
    expect(pair.stats).toMatchObject({ received: 2, bytesIn: 350 })
  })
})

describe('PeerRelay', () => {
  const devices = Array.from({ length: 12 }, (_, i) => i.toString(16).repeat(64).slice(0, 64))

  it('carries nothing until it is asked', () => {
    expect(new PeerRelay().relaying).toBe(0)
  })

  it('refuses past the cap rather than ruining the volunteer\'s own call', () => {
    const relay = new PeerRelay()
    for (let i = 0; i < MAX_ASSISTED_PAIRS; i += 1) {
      expect(relay.admit(devices[i * 2]!, devices[i * 2 + 1]!)).not.toBeNull()
    }
    expect(relay.relaying).toBe(MAX_ASSISTED_PAIRS)
    expect(relay.admit(devices[10]!, devices[11]!)).toBeNull()
    expect(relay.refused).toBe(1)
  })

  it('will not let a local caller volunteer past the protocol cap', () => {
    const relay = new PeerRelay({ maxPairs: 100 })
    expect(relay.max).toBe(MAX_ASSISTED_PAIRS)
  })

  it('gives both ends of a pair the same slot, because both ask', () => {
    const relay = new PeerRelay()
    const first = relay.admit(devices[0]!, devices[1]!)
    const second = relay.admit(devices[1]!, devices[0]!)
    expect(second).toBe(first)
    expect(relay.relaying).toBe(1)
  })

  it('frees the slot when a pair is dropped', () => {
    const relay = new PeerRelay()
    relay.admit(devices[0]!, devices[1]!)
    relay.drop(devices[1]!, devices[0]!)
    expect(relay.relaying).toBe(0)
    expect(relay.admit(devices[2]!, devices[3]!)).not.toBeNull()
  })

  it('drops every pair a departing device was part of', () => {
    const relay = new PeerRelay()
    relay.admit(devices[0]!, devices[1]!)
    relay.admit(devices[0]!, devices[2]!)
    relay.admit(devices[3]!, devices[4]!)
    expect(relay.dropDevice(devices[0]!)).toBe(2)
    expect(relay.relaying).toBe(1)
  })

  it('reports what carrying everything has actually cost', () => {
    const relay = new PeerRelay()
    const pair = relay.admit(devices[0]!, devices[1]!)!
    pair.leg(devices[0]!)!.accept(frame(1, 1200))
    expect(relay.stats.bytesIn).toBe(1200)
  })

  it('stops carrying everything when consent is revoked, and takes nothing else down', () => {
    const relay = new PeerRelay()
    const pair = relay.admit(devices[0]!, devices[1]!)!
    relay.close()
    expect(relay.relaying).toBe(0)
    expect(pair.closed).toBe(true)
    // Revoked means revoked: nothing gets back in afterwards.
    expect(relay.admit(devices[2]!, devices[3]!)).toBeNull()
  })

  it('accepts a volunteer who will only carry one pair', () => {
    const relay = new PeerRelay({ maxPairs: 1 })
    expect(relay.admit(devices[0]!, devices[1]!)).not.toBeNull()
    expect(relay.admit(devices[2]!, devices[3]!)).toBeNull()
  })

  it('accepts a volunteer who will carry none, which is a plain refusal', () => {
    const relay = new PeerRelay({ maxPairs: 0 })
    expect(relay.admit(devices[0]!, devices[1]!)).toBeNull()
  })
})
