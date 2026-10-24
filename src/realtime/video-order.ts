import type { CompressedFrame } from './wire.js'

export type OrderedVideoFrame = CompressedFrame & { sequence: number }
export interface VideoFrameOrderOptions {
  now?: () => number
  maxWaitMs?: number
  maxFrames?: number
  maxBytes?: number
  onFrame: (frame: OrderedVideoFrame) => boolean
  onDiscontinuity: () => void
  onKeyFrameRequired: () => void
}
interface Pending { frame: OrderedVideoFrame; arrived: number }

/** Orders complete authenticated video frames before decoding. Transport
 * arrival order never becomes a delivered-sequence fence. Retained bytes are
 * compressed frames only; authentication and capture belong to the caller. */
export class VideoFrameOrder {
  #pending = new Map<number, Pending>()
  #bytes = 0
  #delivered = -1
  #waiting = true
  #fenced = false
  #closed = false
  #lastNow = -Infinity
  #lastRequest = -Infinity
  #now: () => number
  #maxWait: number
  #maxFrames: number
  #maxBytes: number
  #counts = { deliveredFrames: 0, droppedFrames: 0, discontinuities: 0, keyFrameRequests: 0 }
  constructor(readonly options: VideoFrameOrderOptions) {
    this.#now = options.now ?? (() => performance.now())
    this.#maxWait = options.maxWaitMs ?? 40
    this.#maxFrames = options.maxFrames ?? 4
    this.#maxBytes = options.maxBytes ?? 512 * 1024
    if (!Number.isFinite(this.#maxWait) || this.#maxWait < 1 || this.#maxWait > 120
      || !Number.isSafeInteger(this.#maxFrames) || this.#maxFrames < 1 || this.#maxFrames > 4
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 512 * 1024
      || typeof options.onFrame !== 'function' || typeof options.onDiscontinuity !== 'function'
      || typeof options.onKeyFrameRequired !== 'function') throw new Error('Invalid video ordering limits')
  }
  #time(): number {
    const now = this.#now()
    if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || now < this.#lastNow) throw new Error('Invalid video ordering clock')
    this.#lastNow = now
    return now
  }
  #request(now: number): void {
    if (this.#closed || now - this.#lastRequest < 1000) return
    this.#lastRequest = now; this.#counts.keyFrameRequests++
    try { this.options.onKeyFrameRequired() } catch { /* A feedback observer cannot retain buffered media. */ }
  }
  #fence(now: number): void {
    this.#waiting = true
    if (!this.#fenced) {
      this.#fenced = true; this.#counts.discontinuities++
      try { this.options.onDiscontinuity() } catch { /* Keep the ordering fence even when a decoder reset throws. */ }
    }
    this.#request(now)
  }
  #drop(sequence: number): void {
    const pending = this.#pending.get(sequence)
    if (!pending) return
    this.#bytes -= pending.frame.data.byteLength
    this.#pending.delete(sequence); this.#counts.droppedFrames++
  }
  #clear(): void { for (const sequence of this.#pending.keys()) this.#drop(sequence) }
  #expire(now: number): void {
    let expired = false
    for (const [sequence, pending] of this.#pending) {
      if (now - pending.arrived >= this.#maxWait) { this.#drop(sequence); expired = true }
    }
    if (expired) this.#fence(now)
  }
  #emit(frame: OrderedVideoFrame, now: number): boolean {
    let accepted = false
    try { accepted = this.options.onFrame(frame) === true } catch { /* A failed decode requires a fresh key. */ }
    if (this.#closed) return false
    if (!accepted) { this.#counts.droppedFrames++; this.#fence(now); return false }
    this.#delivered = frame.sequence; this.#counts.deliveredFrames++
    this.#waiting = false; this.#fenced = false
    return true
  }
  #drain(now: number): void {
    while (!this.#closed && !this.#waiting) {
      const next = this.#pending.get(this.#delivered + 1)
      if (!next) return
      this.#pending.delete(next.frame.sequence); this.#bytes -= next.frame.data.byteLength
      if (!this.#emit(next.frame, now)) return
    }
  }
  /** Accepts an authenticated complete frame. A keyframe can jump forward;
   * deltas wait for a missing predecessor for at most maxWaitMs. While waiting
   * for a key, later deltas remain bounded so a late key can unlock them. */
  push(frame: OrderedVideoFrame): void {
    if (this.#closed) return
    const now = this.#time(); this.#expire(now)
    if (this.#closed) return
    if (!frame || frame.kind !== 'video' || !['key', 'delta'].includes(frame.type)
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffffffff
      || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0
      || !Number.isSafeInteger(frame.durationUs) || frame.durationUs < 0 || frame.durationUs > 0xffffffff
      || !(frame.data instanceof Uint8Array) || frame.data.byteLength < 1) {
      this.#counts.droppedFrames++; return
    }
    if (frame.sequence <= this.#delivered || this.#pending.has(frame.sequence)) { this.#counts.droppedFrames++; return }
    if (frame.data.byteLength > this.#maxBytes) { this.#counts.droppedFrames++; this.#fence(now); return }
    if (frame.type === 'key') {
      for (const sequence of this.#pending.keys()) if (sequence <= frame.sequence) this.#drop(sequence)
      if (this.#delivered >= 0 && (this.#waiting || frame.sequence !== this.#delivered + 1)) {
        // A keyframe supersedes the broken chain without waiting for its gap.
        // Avoid requesting another key when this one is already available.
        if (!this.#fenced) {
          this.#fenced = true
          this.#counts.discontinuities++
          try { this.options.onDiscontinuity() } catch { /* The key is still independently decodable. */ }
        }
      }
      if (!this.#closed && this.#emit(frame, now)) this.#drain(now)
      return
    }
    if (!this.#waiting && frame.sequence === this.#delivered + 1) {
      if (this.#emit(frame, now)) this.#drain(now)
      return
    }
    if (this.#pending.size >= this.#maxFrames || this.#bytes + frame.data.byteLength > this.#maxBytes) {
      // Preserve the newest bounded suffix. Any omitted predecessor forces
      // key recovery rather than decoding the suffix as a complete chain.
      this.#clear(); this.#fence(now)
    }
    if (this.#closed) return
    const copy: OrderedVideoFrame = { kind: 'video', type: 'delta', sequence: frame.sequence,
      timestampUs: frame.timestampUs, durationUs: frame.durationUs, data: frame.data.slice() }
    this.#pending.set(frame.sequence, { frame: copy, arrived: now }); this.#bytes += copy.data.byteLength
  }
  /** Enforces age while capture or the network is idle. */
  tick(): void { if (!this.#closed) this.#expire(this.#time()) }
  /** Drops the previous path's backlog and fences decode, preserving the
   * last successfully delivered sequence to reject old-path replays. */
  reset(): void {
    if (this.#closed) return
    const now = this.#time(); this.#clear(); this.#fence(now)
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#clear(); this.#waiting = true } }
  stats() {
    return { ...this.#counts, bufferedFrames: this.#pending.size, bufferedBytes: this.#bytes,
      deliveredSequence: this.#delivered, waitingForKeyframe: this.#waiting, closed: this.#closed }
  }
}
