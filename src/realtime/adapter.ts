import { createRealtimeEncoder, createRealtimeDecoder, type RealtimeCodecConfig } from './codec.js'
import { FrameSealer, FrameOpener, fragmentPacket, inspectDatagram, type Publication, type CompressedFrame } from './wire.js'
import type { DatagramSender } from './forwarder.js'
import type { CiphertextQueue, QueueFactory } from './runtime.js'
import { VideoFrameOrder } from './video-order.js'

export interface SourceBinding {
  sender: string
  role: 'camera' | 'screen'
  video?: Publication
  audio?: Publication
}
export interface LocalSource extends SourceBinding { stream: MediaStream }
export interface RealtimeCallOptions {
  roomKey: Uint8Array
  queueFactory: QueueFactory
  local: readonly LocalSource[]
  remote: readonly SourceBinding[]
  config?: RealtimeCodecConfig
  onRemoteStream: (source: SourceBinding, stream: MediaStream) => void
  onKeyFrameRequired?: (publication: string) => void
  onError?: (error: Error) => void
  now?: () => number
}
type Encoder = Awaited<ReturnType<typeof createRealtimeEncoder>>
type Decoder = Awaited<ReturnType<typeof createRealtimeDecoder>>

/** Endpoints alone own room keys, capture streams and codec instances. */
export class RealtimeCallAdapter {
  #queue: CiphertextQueue
  #link: DatagramSender | null = null
  #encoders: Encoder[] = []
  #decoders: Decoder[] = []
  #sealers = new Map<string, { sealer: FrameSealer; stream: number; encoder: Encoder | null }>()
  #receivers = new Map<string, { opener: FrameOpener; decoder: Decoder; kind: 'video' | 'audio'; sequence: number; videoOrder?: VideoFrameOrder }>()
  #timer: ReturnType<typeof setInterval> | undefined
  #closed = false
  #requestedKeys = new Map<string, number>()
  #counters = { encodedFrames: 0, sentFrames: 0, sentDatagrams: 0, receivedFrames: 0, droppedFrames: 0, keyFrameRequests: 0 }
  private constructor(readonly options: RealtimeCallOptions, queue: CiphertextQueue) { this.#queue = queue }
  static async create(options: RealtimeCallOptions): Promise<RealtimeCallAdapter> {
    if (options.roomKey.length !== 32 || options.local.length > 2 || options.remote.length > 32) throw new Error('Invalid realtime call')
    const all = [...options.local, ...options.remote].flatMap(v => [v.video, v.audio].filter((p): p is Publication => !!p))
    if (new Set(all.map(p => p.id)).size !== all.length) throw new Error('Duplicate realtime publication')
    for (const source of [...options.local, ...options.remote]) {
      if (!['camera', 'screen'].includes(source.role) || !/^[0-9a-f]{64}$/.test(source.sender) || !source.video && !source.audio
        || [source.video, source.audio].some(p => p && p.sender !== source.sender)) throw new Error('Invalid source binding')
    }
    const queue = await options.queueFactory({ maxBytes: 2 * 1024 * 1024, maxFrames: 64, maxStreams: 4, maxResidenceMs: 200 })
    const adapter = new RealtimeCallAdapter(options, queue)
    try { await adapter.#init(); return adapter } catch (error) { adapter.close(); throw error }
  }
  async #init(): Promise<void> {
    let stream = 1
    for (const source of this.options.remote) {
      const decoder = await createRealtimeDecoder({ config: this.options.config,
        onKeyFrameRequired: () => { if (source.video) this.#requestKeyframe(source.video.id) },
        onError: () => this.#fail() })
      if (this.#closed) { decoder.close(); throw new Error('Realtime call stopped') }
      this.#decoders.push(decoder)
      for (const publication of [source.video, source.audio]) if (publication) {
        const video = publication === source.video
        this.#receivers.set(publication.id, { opener: new FrameOpener(publication, this.options.roomKey, this.#now), decoder,
          kind: video ? 'video' : 'audio', sequence: -1, ...(video ? { videoOrder: new VideoFrameOrder({ now: this.#now,
            onFrame: frame => decoder.push(frame), onDiscontinuity: () => decoder.discontinuity('video'),
            onKeyFrameRequired: () => this.#requestKeyframe(publication.id) }) } : {}) })
      }
      this.options.onRemoteStream(source, decoder.stream)
    }
    for (const source of this.options.local) {
      for (const publication of [source.video, source.audio]) if (publication) {
        this.#sealers.set(publication.id, { sealer: new FrameSealer(publication, this.options.roomKey), stream: stream++, encoder: null })
      }
      const encoder = await createRealtimeEncoder(source.stream, frame => this.#publish(source, frame), { config: this.options.config, onError: () => this.#fail() })
      if (this.#closed) { encoder.close(); throw new Error('Realtime call stopped') }
      this.#encoders.push(encoder)
      for (const publication of [source.video, source.audio]) if (publication) this.#sealers.get(publication.id)!.encoder = encoder
    }
    this.#timer = setInterval(() => { try { this.#flush() } catch { this.#fail() } }, 5)
  }
  #now = (): number => (this.options.now ?? (() => performance.now()))()
  #requestKeyframe(publication: string): void {
    const now = this.#now(), previous = this.#requestedKeys.get(publication) ?? -Infinity
    if (now - previous < 1_000) return
    this.#requestedKeys.set(publication, now); this.#counters.keyFrameRequests++
    this.options.onKeyFrameRequired?.(publication)
  }
  #fail(): void {
    if (this.#closed) return
    try { this.options.onError?.(new Error('Realtime media pipeline failed')) } catch { /* Observers cannot prevent shutdown. */ }
    finally { this.close() }
  }
  #publish(source: LocalSource, frame: CompressedFrame): void {
    if (this.#closed || !this.#link) return
    const publication = frame.kind === 'video' ? source.video : source.audio
    if (!publication) return
    const state = this.#sealers.get(publication.id)!
    const sealed = state.sealer.seal(frame), now = this.#now()
    const result = this.#queue.offer({ stream: state.stream, video: frame.kind === 'video', key: frame.kind === 'video' && frame.type === 'key',
      sequence: sealed.sequence, deadlineMs: now + (frame.kind === 'audio' ? 80 : 200) }, sealed.packet, now)
    this.#counters.encodedFrames++
    if (!result.accepted) this.#counters.droppedFrames++
    if (result.waitingForKeyframe) state.encoder?.requestKeyFrame()
  }
  #flush(): void {
    if (this.#closed) return
    const now = this.#now(); this.#queue.tick(now)
    for (const state of this.#sealers.values()) if (this.#queue.waitingForKeyframe(state.stream)) state.encoder?.requestKeyFrame()
    for (let n = 0; n < 8; n++) {
      const frame = this.#queue.pop(now)
      if (!frame) break
      if (!this.#link) { this.#counters.droppedFrames++; continue }
      let sent = true
      for (const datagram of fragmentPacket(frame.ciphertext)) {
        if (!this.#link.send(datagram, { deadlineMs: frame.metadata.deadlineMs })) { sent = false; break }
        this.#counters.sentDatagrams++
      }
      if (sent) this.#counters.sentFrames++
      else { this.#counters.droppedFrames++; for (const encoder of this.#encoders) encoder.requestKeyFrame() }
    }
    for (const receiver of this.#receivers.values()) { receiver.opener.tick(); receiver.videoOrder?.tick() }
  }
  receive(datagram: Uint8Array): void {
    if (this.#closed) return
    const meta = inspectDatagram(datagram)
    if (!meta) return
    const receiver = this.#receivers.get(meta.publication)
    if (!receiver) return
    const frame = receiver.opener.push(datagram)
    if (frame && frame.kind === receiver.kind) {
      this.#counters.receivedFrames++
      if (frame.kind === 'video') receiver.videoOrder!.push({ ...frame, kind: 'video' })
      else if (frame.sequence > receiver.sequence && receiver.decoder.push(frame)) receiver.sequence = frame.sequence
    }
  }
  requestKeyFrame(publication?: string): void {
    if (publication) this.#sealers.get(publication)?.encoder?.requestKeyFrame()
    else for (const encoder of this.#encoders) encoder.requestKeyFrame()
  }
  /** Replacement preserves publication/nonce state. No publisher lookup,
   * credential root, room re-admission or media-key handover is involved. */
  replaceForwarder(link: DatagramSender): void {
    if (this.#closed) { link.close(); return }
    const old = this.#link; this.#link = link; try { old?.close() } catch { /* The replacement remains usable. */ }
    // Discard locally queued frames from the old path before requesting a
    // new keyframe. Sequence counters continue, preventing nonce reuse.
    while (this.#queue.pop(this.#now())) { this.#counters.droppedFrames++ }
    if (old) {
      for (const decoder of this.#decoders) decoder.discontinuity('audio')
      for (const receiver of this.#receivers.values()) receiver.videoOrder?.reset()
    }
    this.requestKeyFrame()
  }
  snapshot() { return { ...this.#counters, closed: this.#closed, encoders: this.#encoders.map(e => e.stats()), decoders: this.#decoders.map(d => d.stats()),
    videoOrdering: [...this.#receivers.values()].flatMap(receiver => receiver.videoOrder ? [receiver.videoOrder.stats()] : []) } }
  close(): void {
    if (this.#closed) return
    this.#closed = true; clearInterval(this.#timer)
    const cleanup = [() => this.#queue.close(), () => this.#link?.close(),
      ...this.#encoders.map(encoder => () => encoder.close()), ...this.#decoders.map(decoder => () => decoder.close())]
    for (const close of cleanup) try { close() } catch { /* Complete the remaining owned-resource cleanup. */ }
    this.#link = null
    for (const state of this.#sealers.values()) state.sealer.close()
    for (const receiver of this.#receivers.values()) { receiver.videoOrder?.close(); receiver.opener.close() }
    this.#receivers.clear(); this.#sealers.clear(); this.#requestedKeys.clear()
  }
}
