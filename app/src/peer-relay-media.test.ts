// The browser pumps against stand-ins: no worker runs here, so what is pinned
// is which transforms are attached where and when, the codec rules, and what
// a failing worker does. The frames themselves move in test/peer-assist.spec.ts
// and the worker's own logic in peer-relay-media.worker.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRelayMediaPipeline, sameCodec } from './peer-relay-media.js'
import { RelayPair } from '../../src/peer-relay.js'
import type { RelayLeg } from '../../src/peer-relay.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const VP8 = { mimeType: 'video/VP8', clockRate: 90_000 }
const H264_BASE = { mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' }
const H264_HIGH = { mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' }
const RTX = { mimeType: 'video/rtx', clockRate: 90_000 }

class FakeTransform {
  constructor(readonly worker: unknown, readonly options: Record<string, unknown>) {}
}

function scope(codecs = [VP8, H264_BASE, RTX]) {
  const posted: unknown[] = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const worker = {
    addEventListener: (type: string, cb: (event: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), cb]),
    postMessage: (m: unknown) => void posted.push(m),
    terminate: vi.fn(),
  }
  const emit = (type: string, data?: unknown) => {
    for (const cb of listeners.get(type) ?? []) cb({ data })
  }
  return {
    posted,
    worker,
    ready: () => emit('message', { op: 'ready' }),
    error: () => emit('error'),
    value: {
      RTCRtpScriptTransform: FakeTransform as never,
      RTCRtpReceiver: { getCapabilities: () => ({ codecs }) },
      createWorker: () => worker as unknown as Worker,
    },
  }
}

interface Stats { inbound?: string; outbound?: string }

function leg(receiverCodecs = [VP8, RTX], stats: Stats = { inbound: 'video/vp8', outbound: 'video/vp8' }) {
  const preferred: unknown[][] = []
  const failed: string[] = []
  const report = (type: string, mime?: string) => async () => {
    const map = new Map<string, Record<string, unknown>>()
    if (mime) {
      map.set('x', { type, codecId: 'c' })
      map.set('c', { type: 'codec', mimeType: mime })
    }
    return map
  }
  const receiver = { transform: null as unknown, getParameters: () => ({ codecs: receiverCodecs }), getStats: report('inbound-rtp', stats.inbound) }
  const sender = { transform: null as unknown, getStats: report('outbound-rtp', stats.outbound) }
  const transceiver = { setCodecPreferences: (codecs: unknown[]) => void preferred.push(codecs) }
  const value: RelayLeg = {
    pair: new RelayPair(A, B),
    from: A,
    to: B,
    role: 'camera',
    source: { track: { kind: 'video' } as MediaStreamTrack, receiver },
    sink: { clock: { kind: 'video' } as MediaStreamTrack, sender, transceiver },
    fail: (reason) => void failed.push(reason),
  }
  return { value, receiver, sender, preferred, failed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('sameCodec', () => {
  it('matches on name, rate and the format parameters that change the bitstream', () => {
    expect(sameCodec(VP8, { mimeType: 'video/vp8', clockRate: 90_000 })).toBe(true)
    expect(sameCodec(VP8, H264_BASE)).toBe(false)
    expect(sameCodec(H264_BASE, { ...H264_BASE, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e034' })).toBe(true)
    expect(sameCodec(H264_BASE, H264_HIGH)).toBe(false)
    expect(sameCodec({ mimeType: 'audio/opus', clockRate: 48_000, channels: 2, sdpFmtpLine: 'useinbandfec=1' }, { mimeType: 'audio/opus', clockRate: 48_000, channels: 2 })).toBe(true)
  })
})

describe('BrowserRelayMediaPipeline', () => {
  it('is unavailable without the standard script transform', () => {
    expect(new BrowserRelayMediaPipeline({}).ready).toBe(false)
    expect(new BrowserRelayMediaPipeline({}).carry(leg().value)).toBeNull()
  })

  it('is not ready, and taps nothing, until its worker says it is running', () => {
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    const l = leg()
    pipeline.warm()
    pipeline.prepare(l.receiver)
    expect(pipeline.ready).toBe(false)
    expect(l.receiver.transform).toBeNull()
    expect(pipeline.carry(l.value)).toBeNull()

    fake.ready()
    expect(pipeline.ready).toBe(true)
    // The receiver offered early is tapped now.
    expect((l.receiver.transform as FakeTransform).options).toMatchObject({ side: 'tap' })
    pipeline.close()
  })

  it('taps the source, drives the clock, and holds the clock to the source codec', () => {
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const l = leg()
    const handle = pipeline.carry(l.value)
    expect(handle).not.toBeNull()
    expect((l.receiver.transform as FakeTransform).options).toMatchObject({ side: 'tap' })
    expect((l.sender.transform as FakeTransform).options).toMatchObject({ side: 'drive', video: true })
    expect(l.preferred).toEqual([[VP8, RTX]])
    handle!.close()
    expect(l.sender.transform).toBeNull()
    pipeline.close()
  })

  it('taps a receiver once however many legs carry it', () => {
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const first = leg()
    pipeline.prepare(first.receiver)
    const tap = first.receiver.transform
    pipeline.carry(first.value)
    expect(first.receiver.transform).toBe(tap)
    pipeline.close()
  })

  it('carries only VP8 video until other codecs are measured', () => {
    const fake = scope([VP8, H264_BASE, RTX])
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    expect(pipeline.carry(leg([H264_BASE]).value)).toBeNull()
    expect(pipeline.carry(leg([]).value)).toBeNull()
    pipeline.close()
  })

  it('gives every transform back and fails every leg when the worker fails', () => {
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const l = leg()
    pipeline.carry(l.value)
    fake.error()
    expect(l.receiver.transform).toBeNull()
    expect(l.sender.transform).toBeNull()
    expect(l.failed).toEqual(['the pump worker stopped'])
    expect(pipeline.ready).toBe(false)
    expect(fake.worker.terminate).toHaveBeenCalled()
  })

  it('gives back unused taps when this device stops offering', () => {
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const idle = leg()
    const busy = leg()
    pipeline.prepare(idle.receiver)
    pipeline.carry(busy.value)
    pipeline.release()
    expect(idle.receiver.transform).toBeNull()
    expect(busy.receiver.transform).not.toBeNull()
    expect(fake.posted).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'untap' })]))
    pipeline.close()
  })

  it('fails a leg when nothing goes out on it within the check', async () => {
    vi.useFakeTimers()
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const l = leg([VP8, RTX], { inbound: 'video/vp8' })
    pipeline.carry(l.value)
    await vi.advanceTimersByTimeAsync(4_100)
    expect(l.failed).toEqual(['nothing went out on the carried m-line'])
    pipeline.close()
  })

  it('fails a leg whose codecs differ once media flows, and keeps one that matches', async () => {
    vi.useFakeTimers()
    const fake = scope()
    const pipeline = new BrowserRelayMediaPipeline(fake.value)
    pipeline.warm()
    fake.ready()
    const wrong = leg([VP8, RTX], { inbound: 'video/vp8', outbound: 'video/h264' })
    const right = leg()
    pipeline.carry(wrong.value)
    pipeline.carry(right.value)
    await vi.advanceTimersByTimeAsync(4_100)
    expect(wrong.failed).toEqual(['codec video/vp8 in, video/h264 out'])
    expect(right.failed).toEqual([])
    pipeline.close()
  })
})
