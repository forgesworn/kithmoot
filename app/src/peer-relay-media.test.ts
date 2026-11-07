// The browser pumps against stand-ins: no worker runs here, so what is pinned
// is which transforms are attached where, and the codec rules. The frames
// themselves move in test/peer-assist.spec.ts.
import { describe, expect, it } from 'vitest'
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
  const worker = { addEventListener: () => {}, postMessage: (m: unknown) => posted.push(m), terminate: () => {} } as unknown as Worker
  return {
    posted,
    value: {
      RTCRtpScriptTransform: FakeTransform as never,
      RTCRtpReceiver: { getCapabilities: () => ({ codecs }) },
      createWorker: () => worker,
    },
  }
}

function leg(receiverCodecs = [VP8, RTX]) {
  const preferred: unknown[][] = []
  const failed: string[] = []
  const receiver = { transform: null as unknown, getParameters: () => ({ codecs: receiverCodecs }) }
  const sender = { transform: null as unknown }
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

  it('taps the source, drives the clock, and holds the clock to the source codec', () => {
    const { value } = scope()
    const pipeline = new BrowserRelayMediaPipeline(value)
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
    const { value } = scope()
    const pipeline = new BrowserRelayMediaPipeline(value)
    const first = leg()
    pipeline.prepare(first.receiver)
    const tap = first.receiver.transform
    pipeline.carry(first.value)
    expect(first.receiver.transform).toBe(tap)
    pipeline.close()
  })

  it('refuses a leg whose source codec the far side cannot be offered', () => {
    const { value } = scope([VP8, RTX])
    const pipeline = new BrowserRelayMediaPipeline(value)
    expect(pipeline.carry(leg([H264_HIGH]).value)).toBeNull()
    pipeline.close()
  })
})
