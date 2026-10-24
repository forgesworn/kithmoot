import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeCallAdapter, type LocalSource, type RealtimeCallOptions } from './adapter.js'
import { FrameSealer, fragmentPacket, type CompressedFrame, type Publication } from './wire.js'
import type { CiphertextQueue, QueueMetadata } from './runtime.js'
import type { DatagramSender } from './forwarder.js'

const factories = vi.hoisted(() => ({ encoder: vi.fn(), decoder: vi.fn() }))
vi.mock('./codec.js', () => ({ createRealtimeEncoder: factories.encoder, createRealtimeDecoder: factories.decoder }))

const ROOM_KEY = new Uint8Array(32).fill(7)
const SENDER = 'a'.repeat(64)
const publication = (byte: string): Publication => ({ sender: SENDER, id: byte.repeat(32) })
const video = publication('1'), audio = publication('2'), remoteVideo = publication('3'), remoteAudio = publication('4')
const codecStats = () => ({ videoFrames: 0, audioFrames: 0, droppedVideo: 0, droppedAudio: 0 })
function compressed(kind: 'audio' | 'video' = 'video', type: 'key' | 'delta' = 'key', size = 3): CompressedFrame {
  return { kind, type, timestampUs: 1000, durationUs: 20_000, data: new Uint8Array(size).fill(17) }
}
function encoderHandle() { return { close: vi.fn(), requestKeyFrame: vi.fn(), stats: vi.fn(codecStats) } }
function decoderHandle() {
  return { close: vi.fn(), push: vi.fn((_frame: CompressedFrame & { sequence: number }) => true),
    discontinuity: vi.fn((_kind: 'video' | 'audio') => {}), stats: vi.fn(codecStats), stream: {} as MediaStream }
}
type Encoder = ReturnType<typeof encoderHandle>
type Decoder = ReturnType<typeof decoderHandle>
function source(): LocalSource & { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn()
  const stream = { getTracks: vi.fn(() => [{ stop }]) } as unknown as MediaStream
  return { sender: SENDER, role: 'camera', video, audio, stream, stop }
}
function queueFixture() {
  const entries: Array<{ metadata: QueueMetadata; ciphertext: Uint8Array }> = []
  const waiting = new Set<number>()
  const queue = {
    offer: vi.fn((metadata: QueueMetadata, ciphertext: Uint8Array, _now: number) => {
      entries.push({ metadata: { ...metadata }, ciphertext })
      return { accepted: true, dropped: 0, waitingForKeyframe: waiting.has(metadata.stream) }
    }),
    pop: vi.fn((_now: number) => entries.shift()),
    tick: vi.fn((_now: number) => 0),
    waitingForKeyframe: vi.fn((stream: number) => waiting.has(stream)),
    close: vi.fn(() => { entries.length = 0 }),
  } satisfies CiphertextQueue
  return { queue, entries, waiting }
}
function linkFixture() {
  return { send: vi.fn((_bytes: Uint8Array, _options?: { deadlineMs?: number }) => true), close: vi.fn(() => {}) } satisfies DatagramSender
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const active: RealtimeCallAdapter[] = []
function fixture(local = source(), withRemote = true) {
  const q = queueFixture(), encoders: Encoder[] = [], decoders: Decoder[] = []
  const outputs: Array<(frame: CompressedFrame) => void> = []
  factories.encoder.mockImplementation(async (_stream, output) => {
    const handle = encoderHandle(); encoders.push(handle); outputs.push(output); return handle
  })
  factories.decoder.mockImplementation(async () => {
    const handle = decoderHandle(); decoders.push(handle); return handle
  })
  let now = 100
  const options: RealtimeCallOptions = {
    roomKey: ROOM_KEY, queueFactory: vi.fn(async () => q.queue), local: [local],
    remote: withRemote ? [{ sender: SENDER, role: 'camera', video: remoteVideo, audio: remoteAudio }] : [],
    onRemoteStream: vi.fn(), onKeyFrameRequired: vi.fn(), onError: vi.fn(), now: () => now,
  }
  return { ...q, options, encoders, decoders, outputs, local, setNow: (value: number) => { now = value } }
}
async function create(options: RealtimeCallOptions) {
  const adapter = await RealtimeCallAdapter.create(options); active.push(adapter); return adapter
}

beforeEach(() => { factories.encoder.mockReset(); factories.decoder.mockReset(); vi.useFakeTimers() })
afterEach(() => {
  for (const adapter of active.splice(0)) { try { adapter.close() } catch { /* Failure-isolation regressions still clean fake timers. */ } }
  vi.clearAllTimers(); vi.useRealTimers()
})

describe('realtime adapter publication and transport lifetime', () => {
  it('queues already encrypted complete frames and marks audio independent of WebCodecs key type', async () => {
    const f = fixture(), adapter = await create(f.options), link = linkFixture()
    adapter.replaceForwarder(link)
    f.outputs[0](compressed('audio', 'key'))
    const [metadata, packet, now] = f.queue.offer.mock.calls[0]
    expect(metadata).toMatchObject({ video: false, key: false, sequence: 0, deadlineMs: 180 })
    expect(now).toBe(100)
    expect(packet.length).toBe(54 + 16 + 3)
    expect(packet.slice(54)).not.toEqual(compressed('audio').data)
    expect(link.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5)
    expect(link.send).toHaveBeenCalledOnce()
    expect(link.send.mock.calls[0][1]).toEqual({ deadlineMs: 180 })
    expect(adapter.snapshot()).toMatchObject({ encodedFrames: 1, sentFrames: 1, sentDatagrams: 1 })
  })

  it('does not retain media while disconnected and never stops caller-owned source tracks', async () => {
    const f = fixture(), adapter = await create(f.options)
    f.outputs[0](compressed())
    expect(f.queue.offer).not.toHaveBeenCalled()
    adapter.close(); adapter.close()
    expect(f.local.stop).not.toHaveBeenCalled()
    expect(f.local.stream.getTracks).not.toHaveBeenCalled()
    expect(f.encoders[0].close).toHaveBeenCalledOnce()
    expect(f.decoders[0].close).toHaveBeenCalledOnce()
    expect(f.queue.close).toHaveBeenCalledOnce()
    f.outputs[0](compressed())
    await vi.advanceTimersByTimeAsync(30)
    expect(f.queue.offer).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requests fresh video after expiry or audio eviction marks the queue waiting', async () => {
    const f = fixture(), adapter = await create(f.options)
    adapter.replaceForwarder(linkFixture()); f.encoders[0].requestKeyFrame.mockClear()
    // The audio offer itself does not report a video stream's dependency loss.
    f.queue.tick.mockImplementation(() => { f.waiting.add(1); return 1 })
    await vi.advanceTimersByTimeAsync(5)
    expect(f.encoders[0].requestKeyFrame).toHaveBeenCalled()
    expect(f.queue.waitingForKeyframe).toHaveBeenCalledWith(1)
  })

  it('requests recovery after a partial datagram send without treating congestion as a fatal codec error', async () => {
    const f = fixture(), adapter = await create(f.options), link = linkFixture()
    adapter.replaceForwarder(link); f.encoders[0].requestKeyFrame.mockClear()
    link.send.mockReturnValueOnce(true).mockReturnValueOnce(false)
    f.outputs[0](compressed('video', 'key', 14_000))
    await vi.advanceTimersByTimeAsync(5)
    expect(link.send).toHaveBeenCalledTimes(2)
    expect(f.encoders[0].requestKeyFrame).toHaveBeenCalled()
    expect(adapter.snapshot()).toMatchObject({ sentFrames: 0, sentDatagrams: 1, droppedFrames: 1, closed: false })
    expect(f.options.onError).not.toHaveBeenCalled()
  })

  it('drains the previous path on replacement and preserves publication salt and sequence', async () => {
    const f = fixture(), adapter = await create(f.options), first = linkFixture(), second = linkFixture()
    adapter.replaceForwarder(first)
    f.outputs[0](compressed())
    const old = f.entries[0].ciphertext.slice()
    adapter.replaceForwarder(second)
    expect(first.close).toHaveBeenCalledOnce()
    expect(f.entries).toHaveLength(0)
    f.outputs[0](compressed())
    const next = f.entries[0].ciphertext
    expect(new DataView(old.buffer).getUint32(28)).toBe(0)
    expect(new DataView(next.buffer, next.byteOffset).getUint32(28)).toBe(1)
    expect(next.slice(20, 28)).toEqual(old.slice(20, 28))
    expect(next.slice(20, 32)).not.toEqual(old.slice(20, 32))
    await vi.advanceTimersByTimeAsync(5)
    expect(first.send).not.toHaveBeenCalled()
    expect(second.send).toHaveBeenCalledOnce()
    expect(f.decoders[0].discontinuity).toHaveBeenCalledWith('video')
    expect(f.decoders[0].discontinuity).toHaveBeenCalledWith('audio')
  })

  it('closes immediately when queue scheduling throws and stops the interval', async () => {
    const f = fixture(), adapter = await create(f.options), link = linkFixture()
    adapter.replaceForwarder(link)
    f.queue.tick.mockImplementation(() => { throw new Error('private scheduler detail') })
    await vi.advanceTimersByTimeAsync(20)
    expect(f.options.onError).toHaveBeenCalledOnce()
    expect((f.options.onError as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toBe('Realtime media pipeline failed')
    expect(adapter.snapshot().closed).toBe(true)
    expect(link.close).toHaveBeenCalledOnce()
    expect(f.encoders[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('realtime adapter authenticated reception', () => {
  it('does not request a video keyframe when an authenticated audio frame is rejected by the decoder', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteAudio, ROOM_KEY)
    f.decoders[0].push.mockReturnValue(false)
    try {
      for (let n = 0; n < 8; n++) {
        for (const packet of fragmentPacket(sealer.seal(compressed('audio', 'key')).packet)) adapter.receive(packet)
      }
      expect(f.decoders[0].push).toHaveBeenCalledTimes(8)
      expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
      expect(adapter.snapshot().keyFrameRequests).toBe(0)
      expect(f.encoders[0].requestKeyFrame).not.toHaveBeenCalled()
    } finally { sealer.close() }
  })

  it('bounds waiting-video and gap feedback to one callback per publication per second and resumes at the boundary', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteVideo, ROOM_KEY)
    f.decoders[0].push.mockReturnValue(false)
    const waiting = factories.decoder.mock.calls[0][0].onKeyFrameRequired as () => void
    try {
      for (const packet of fragmentPacket(sealer.seal(compressed()).packet)) adapter.receive(packet)
      for (let n = 0; n < 20; n++) {
        waiting()
        sealer.seal(compressed('video', 'delta')) // Missing media causes another authenticated gap.
        for (const packet of fragmentPacket(sealer.seal(compressed('video', 'delta')).packet)) adapter.receive(packet)
      }
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledExactlyOnceWith(remoteVideo.id)
      expect(adapter.snapshot().keyFrameRequests).toBe(1)
      // Repeated gaps while waiting for a usable key share one decode fence.
      expect(f.decoders[0].discontinuity).toHaveBeenCalledOnce()
      expect(f.decoders[0].push).toHaveBeenCalledOnce()
      f.setNow(1099); waiting()
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledOnce()
      f.setNow(1100); waiting(); waiting()
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledTimes(2)
      expect(adapter.snapshot().keyFrameRequests).toBe(2)
    } finally { sealer.close() }
  })

  it('waits up to 40 ms for a missing video predecessor before fencing the broken chain', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteVideo, ROOM_KEY)
    try {
      for (const packet of fragmentPacket(sealer.seal(compressed()).packet)) adapter.receive(packet)
      sealer.seal(compressed('video', 'delta')) // Lost frame.
      for (const packet of fragmentPacket(sealer.seal(compressed('video', 'delta')).packet)) adapter.receive(packet)
      expect(f.decoders[0].push).toHaveBeenCalledOnce()
      expect(f.decoders[0].discontinuity).not.toHaveBeenCalled()
      expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
      f.setNow(139); await vi.advanceTimersByTimeAsync(5)
      expect(f.decoders[0].discontinuity).not.toHaveBeenCalled()
      f.setNow(140); await vi.advanceTimersByTimeAsync(5)
      expect(f.decoders[0].push).toHaveBeenCalledOnce()
      expect(f.decoders[0].discontinuity).toHaveBeenCalledOnce()
      expect(f.decoders[0].discontinuity).toHaveBeenCalledWith('video')
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledExactlyOnceWith(remoteVideo.id)
      expect(adapter.snapshot().receivedFrames).toBe(2)
      for (const packet of fragmentPacket(sealer.seal(compressed('video', 'delta')).packet)) adapter.receive(packet)
      expect(f.decoders[0].push).toHaveBeenCalledOnce()
      f.setNow(150)
      for (const packet of fragmentPacket(sealer.seal(compressed('video', 'key')).packet)) adapter.receive(packet)
      expect(f.decoders[0].push).toHaveBeenCalledTimes(2)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([0, 4])
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledOnce()
      expect(f.decoders[0].discontinuity).toHaveBeenCalledOnce()
    } finally { sealer.close() }
  })

  it('authenticates a late initial keyframe and releases its buffered delta in decode order', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteVideo, ROOM_KEY)
    const link = linkFixture(); adapter.replaceForwarder(link)
    try {
      const key = fragmentPacket(sealer.seal({ ...compressed('video', 'key', 14000), timestampUs: 1000 }).packet)
      const delta = fragmentPacket(sealer.seal({ ...compressed('video', 'delta'), timestampUs: 2000 }).packet)
      for (const packet of delta) adapter.receive(packet)
      expect(f.decoders[0].push).not.toHaveBeenCalled()
      expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
      expect(f.decoders[0].discontinuity).not.toHaveBeenCalled()
      // Both encrypted key fragments arrive after delta1 but before its
      // bounded reorder wait expires. Arrival order must not fence key0 out.
      f.setNow(139)
      for (const packet of key.reverse()) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => [frame.sequence, frame.type, frame.timestampUs])).toEqual([
        [0, 'key', 1000], [1, 'delta', 2000],
      ])
      expect(adapter.snapshot().receivedFrames).toBe(2)
      expect(f.decoders[0].discontinuity).not.toHaveBeenCalled()
      expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
      f.setNow(140); await vi.advanceTimersByTimeAsync(5)
      for (const packet of fragmentPacket(sealer.seal({ ...compressed('video', 'delta'), timestampUs: 3000 }).packet)) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([0, 1, 2])
      expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
    } finally { sealer.close() }
  })

  it('advances the decode cursor only for accepted frames, allowing an older key after decode rejection', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteVideo, ROOM_KEY)
    try {
      const key0 = fragmentPacket(sealer.seal(compressed('video', 'key')).packet)
      const key1 = fragmentPacket(sealer.seal(compressed('video', 'key')).packet)
      f.decoders[0].push.mockReturnValueOnce(false)
      for (const packet of key1) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([1])
      expect(f.decoders[0].discontinuity).toHaveBeenCalledOnce()
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledExactlyOnceWith(remoteVideo.id)
      f.setNow(110)
      for (const packet of key0) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([1, 0])
      expect(f.decoders[0].push.mock.results.map(result => result.value)).toEqual([false, true])
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledOnce()
      expect(adapter.snapshot().receivedFrames).toBe(2)
    } finally { sealer.close() }
  })

  it('drops the previous forwarder pending video before a late key can unlock it', async () => {
    const f = fixture(), adapter = await create(f.options), sealer = new FrameSealer(remoteVideo, ROOM_KEY)
    const first = linkFixture(), replacement = linkFixture()
    adapter.replaceForwarder(first)
    expect(f.options.onKeyFrameRequired).not.toHaveBeenCalled()
    expect(f.decoders[0].discontinuity).not.toHaveBeenCalled()
    try {
      const key0 = fragmentPacket(sealer.seal(compressed('video', 'key')).packet)
      const lateKey1 = fragmentPacket(sealer.seal(compressed('video', 'key')).packet)
      const pendingDelta2 = fragmentPacket(sealer.seal(compressed('video', 'delta')).packet)
      for (const packet of key0) adapter.receive(packet)
      for (const packet of pendingDelta2) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([0])
      f.setNow(110); adapter.replaceForwarder(replacement)
      expect(first.close).toHaveBeenCalledOnce()
      expect(f.decoders[0].discontinuity.mock.calls.map(([kind]) => kind)).toEqual(['audio', 'video'])
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledExactlyOnceWith(remoteVideo.id)
      for (const packet of lateKey1) adapter.receive(packet)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([0, 1])
      f.setNow(160); await vi.advanceTimersByTimeAsync(5)
      expect(f.decoders[0].push.mock.calls.map(([frame]) => frame.sequence)).toEqual([0, 1])
      // Authentication replay state also survives replacement.
      for (const packet of pendingDelta2) adapter.receive(packet)
      expect(f.decoders[0].push).toHaveBeenCalledTimes(2)
      expect(f.options.onKeyFrameRequired).toHaveBeenCalledOnce()
      expect(f.options.onError).not.toHaveBeenCalled()
    } finally { sealer.close() }
  })

  it('ignores wrong-key frames, unbound publications and replayed authenticated frames', async () => {
    const f = fixture(), adapter = await create(f.options)
    const wrong = new FrameSealer(remoteVideo, new Uint8Array(32).fill(9))
    const unbound = new FrameSealer(publication('5'), ROOM_KEY)
    const good = new FrameSealer(remoteVideo, ROOM_KEY)
    try {
      for (const sealer of [wrong, unbound]) for (const packet of fragmentPacket(sealer.seal(compressed()).packet)) adapter.receive(packet)
      expect(f.decoders[0].push).not.toHaveBeenCalled()
      const packet = fragmentPacket(good.seal(compressed()).packet)[0]
      adapter.receive(packet); adapter.receive(packet)
      expect(f.decoders[0].push).toHaveBeenCalledOnce()
      expect(adapter.snapshot().receivedFrames).toBe(1)
    } finally { wrong.close(); unbound.close(); good.close() }
  })
})

describe('realtime adapter asynchronous setup and failure isolation', () => {
  it('closes prior handles when a later asynchronous encoder setup rejects', async () => {
    const f = fixture(), late = deferred<Encoder>(), early = encoderHandle()
    factories.encoder.mockReset().mockResolvedValueOnce(early).mockReturnValueOnce(late.promise)
    const second = source(); second.video = publication('6'); second.audio = publication('7')
    const pending = RealtimeCallAdapter.create({ ...f.options, local: [f.local, second] })
    const failure = expect(pending).rejects.toThrow('late encoder unavailable')
    await vi.waitFor(() => expect(factories.encoder).toHaveBeenCalledTimes(2))
    late.reject(new Error('late encoder unavailable'))
    await failure
    expect(early.close).toHaveBeenCalledOnce()
    expect(f.decoders[0].close).toHaveBeenCalledOnce()
    expect(f.queue.close).toHaveBeenCalledOnce()
    expect(f.local.stop).not.toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes an encoder that finishes after its error callback already closed the adapter', async () => {
    const f = fixture(), late = deferred<Encoder>(), handle = encoderHandle()
    let reportError: (() => void) | undefined
    factories.encoder.mockImplementation((_stream, _output, options) => { reportError = options.onError; return late.promise })
    const pending = RealtimeCallAdapter.create(f.options)
    const failure = expect(pending).rejects.toThrow('Realtime call stopped')
    await vi.waitFor(() => expect(reportError).toBeTypeOf('function'))
    reportError!(); late.resolve(handle); await failure
    expect(handle.close).toHaveBeenCalledOnce()
    expect(f.decoders[0].close).toHaveBeenCalledOnce()
    expect(f.queue.close).toHaveBeenCalledOnce()
    expect(f.options.onError).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['queue', 'link', 'encoder', 'decoder'] as const)('isolates a throwing %s close and still releases every other handle', async throwing => {
    const f = fixture(), adapter = await create(f.options), link = linkFixture()
    adapter.replaceForwarder(link)
    const failures = { queue: f.queue.close, link: link.close, encoder: f.encoders[0].close, decoder: f.decoders[0].close }
    failures[throwing].mockImplementation(() => { throw new Error('close failed') })
    expect(() => adapter.close()).not.toThrow()
    for (const close of Object.values(failures)) expect(close).toHaveBeenCalledOnce()
    expect(f.local.stop).not.toHaveBeenCalled()
    expect(adapter.snapshot().closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains a throwing failure observer and still closes queue, link and codecs', async () => {
    const f = fixture()
    f.options.onError = vi.fn(() => { throw new Error('observer failed') })
    const adapter = await create(f.options), link = linkFixture(); adapter.replaceForwarder(link)
    f.queue.tick.mockImplementation(() => { throw new Error('scheduler failed') })
    await vi.advanceTimersByTimeAsync(5)
    expect(f.queue.close).toHaveBeenCalledOnce()
    expect(link.close).toHaveBeenCalledOnce()
    expect(f.encoders[0].close).toHaveBeenCalledOnce()
    expect(f.decoders[0].close).toHaveBeenCalledOnce()
    expect(adapter.snapshot().closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
