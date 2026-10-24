import { describe, expect, it, vi } from 'vitest'
import { VideoFrameOrder, type OrderedVideoFrame, type VideoFrameOrderOptions } from './video-order.js'

function frame(sequence: number, type: 'key' | 'delta' = 'delta', size = 3): OrderedVideoFrame {
  return { kind: 'video', type, sequence, timestampUs: sequence * 1000, durationUs: 20_000,
    data: new Uint8Array(size).fill(sequence % 256) }
}
function fixture(overrides: Partial<VideoFrameOrderOptions> = {}) {
  let now = 0
  const onFrame = vi.fn((_frame: OrderedVideoFrame) => true), onDiscontinuity = vi.fn(), onKeyFrameRequired = vi.fn()
  const order = new VideoFrameOrder({ now: () => now, onFrame, onDiscontinuity, onKeyFrameRequired, ...overrides })
  return { order, onFrame, onDiscontinuity, onKeyFrameRequired, at: (time: number) => { now = time },
    delivered: () => onFrame.mock.calls.map(([frame]) => frame.sequence) }
}

describe('bounded authenticated video ordering', () => {
  it('holds an initial delta until a lower-sequence late key unlocks it', () => {
    const f = fixture()
    f.order.push(frame(101))
    expect(f.onFrame).not.toHaveBeenCalled()
    expect(f.order.stats()).toMatchObject({ deliveredSequence: -1, bufferedFrames: 1, waitingForKeyframe: true })
    f.at(10); f.order.push(frame(100, 'key')); f.order.push(frame(102))
    expect(f.delivered()).toEqual([100, 101, 102])
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 102, bufferedFrames: 0, bufferedBytes: 0, waitingForKeyframe: false })
    expect(f.onDiscontinuity).not.toHaveBeenCalled()
    expect(f.onKeyFrameRequired).not.toHaveBeenCalled()
  })

  it('releases contiguous deltas in sequence when a missing predecessor arrives within the budget', () => {
    const f = fixture()
    f.order.push(frame(0, 'key')); f.order.push(frame(3)); f.order.push(frame(2))
    expect(f.delivered()).toEqual([0])
    f.at(39); f.order.push(frame(1))
    expect(f.delivered()).toEqual([0, 1, 2, 3])
    expect(f.onDiscontinuity).not.toHaveBeenCalled()
    expect(f.onKeyFrameRequired).not.toHaveBeenCalled()
    expect(f.order.stats().bufferedBytes).toBe(0)
  })

  it('expires a missing chain while idle and requires a fresh key before any dependent delta', () => {
    const f = fixture()
    f.order.push(frame(0, 'key')); f.order.push(frame(2))
    f.at(39); f.order.tick()
    expect(f.order.stats().bufferedFrames).toBe(1)
    f.at(40); f.order.tick()
    expect(f.delivered()).toEqual([0])
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 0, bufferedFrames: 0, waitingForKeyframe: true })
    expect(f.onDiscontinuity).toHaveBeenCalledOnce()
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
    f.order.push(frame(1))
    expect(f.delivered()).toEqual([0])
    f.at(41); f.order.push(frame(3, 'key')); f.order.push(frame(4))
    expect(f.delivered()).toEqual([0, 3, 4])
  })

  it('bounds initial key waiting by the same age budget and does not extend it for a duplicate', () => {
    const f = fixture()
    f.order.push(frame(101))
    f.at(39); f.order.push(frame(101))
    expect(f.order.stats().bufferedFrames).toBe(1)
    f.at(40); f.order.tick()
    expect(f.order.stats()).toMatchObject({ bufferedFrames: 0, bufferedBytes: 0, deliveredSequence: -1 })
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
    f.order.push(frame(100, 'key'))
    expect(f.delivered()).toEqual([100]) // Expired delta 101 is never replayed.
  })

  it('uses a newer independent key immediately and drops superseded pending deltas', () => {
    const f = fixture()
    f.order.push(frame(0, 'key')); f.order.push(frame(2)); f.order.push(frame(4))
    f.at(5); f.order.push(frame(3, 'key'))
    expect(f.delivered()).toEqual([0, 3, 4])
    expect(f.order.stats()).toMatchObject({ bufferedFrames: 0, droppedFrames: 1, deliveredSequence: 4 })
    expect(f.onDiscontinuity).toHaveBeenCalledOnce()
    expect(f.onKeyFrameRequired).not.toHaveBeenCalled()
  })

  it('never advances the delivered cursor for a decoder rejection and can recover from a lower late key', () => {
    const f = fixture()
    f.onFrame.mockReturnValueOnce(false)
    f.order.push(frame(100, 'key'))
    expect(f.order.stats()).toMatchObject({ deliveredSequence: -1, deliveredFrames: 0, waitingForKeyframe: true })
    f.order.push(frame(101))
    f.at(5); f.order.push(frame(99, 'key'))
    expect(f.order.stats().deliveredSequence).toBe(99)
    expect(f.delivered()).toEqual([100, 99])
    // A new independently decodable frame supersedes the rejected frame.
    f.order.push(frame(102, 'key')); f.order.push(frame(103))
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 103, deliveredFrames: 3, bufferedFrames: 0 })
  })

  it('resets decode only once when a jumping keyframe is itself rejected', () => {
    const f = fixture()
    f.order.push(frame(0, 'key'))
    f.onFrame.mockReturnValueOnce(false)
    f.order.push(frame(3, 'key'))
    expect(f.onDiscontinuity).toHaveBeenCalledOnce()
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 0, waitingForKeyframe: true, discontinuities: 1 })
  })

  it('fences a rejected contiguous delta without releasing later dependent frames', () => {
    const f = fixture()
    f.order.push(frame(0, 'key')); f.order.push(frame(2))
    f.onFrame.mockReturnValueOnce(false)
    f.order.push(frame(1))
    expect(f.delivered()).toEqual([0, 1])
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 0, waitingForKeyframe: true, bufferedFrames: 1 })
    f.order.push(frame(3))
    expect(f.delivered()).toEqual([0, 1])
    f.order.push(frame(4, 'key'))
    expect(f.delivered()).toEqual([0, 1, 4])
  })

  it('copies buffered bytes so caller mutation cannot change a later released frame', () => {
    const f = fixture(), future = frame(101)
    f.order.push(future); future.data.fill(255)
    f.order.push(frame(100, 'key'))
    expect(f.onFrame.mock.calls[1][0].data).toEqual(new Uint8Array(3).fill(101))
  })

  it('enforces both the frame and combined-byte budget and recovers rather than decoding a truncated chain', () => {
    for (const options of [{ maxFrames: 2 }, { maxBytes: 6 }]) {
      const f = fixture(options)
      f.order.push(frame(101)); f.order.push(frame(102)); f.order.push(frame(103))
      expect(f.order.stats()).toMatchObject({ bufferedFrames: 1, bufferedBytes: 3, deliveredSequence: -1, waitingForKeyframe: true })
      expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
      f.order.push(frame(102, 'key'))
      expect(f.delivered()).toEqual([102, 103])
      expect(f.order.stats().bufferedFrames).toBe(0)
    }
  })

  it('never emits an oversized frame and keeps key requests bounded under repeated overflow and expiry', () => {
    const f = fixture({ maxBytes: 3 })
    for (let n = 0; n < 20; n++) f.order.push(frame(n, 'key', 4))
    expect(f.onFrame).not.toHaveBeenCalled()
    expect(f.onDiscontinuity).toHaveBeenCalledOnce()
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
    f.at(999); f.order.push(frame(20, 'key', 4))
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
    f.at(1000); f.order.push(frame(21, 'key', 4))
    expect(f.onKeyFrameRequired).toHaveBeenCalledTimes(2)
    expect(f.order.stats()).toMatchObject({ bufferedFrames: 0, bufferedBytes: 0, deliveredSequence: -1 })
  })

  it('drops old and duplicate frames without regressing an accepted cursor', () => {
    const f = fixture()
    f.order.push(frame(10, 'key')); f.order.push(frame(11))
    f.order.push(frame(10, 'key')); f.order.push(frame(11)); f.order.push(frame(9, 'key'))
    expect(f.delivered()).toEqual([10, 11])
    expect(f.order.stats()).toMatchObject({ deliveredSequence: 11, droppedFrames: 3 })
    expect(f.onDiscontinuity).not.toHaveBeenCalled()
  })

  it('reset releases old-path pending data, preserves the delivered cursor and waits for an independent key', () => {
    const f = fixture()
    f.order.push(frame(10, 'key')); f.order.push(frame(12)); f.order.reset()
    expect(f.order.stats()).toMatchObject({ bufferedFrames: 0, bufferedBytes: 0, deliveredSequence: 10, waitingForKeyframe: true })
    f.order.push(frame(10, 'key')); f.order.push(frame(12))
    expect(f.delivered()).toEqual([10])
    f.order.push(frame(11, 'key'))
    expect(f.delivered()).toEqual([10, 11, 12])
    expect(f.onDiscontinuity).toHaveBeenCalledOnce()
    expect(f.onKeyFrameRequired).toHaveBeenCalledOnce()
  })

  it('closes idempotently without retaining pending bytes or invoking later callbacks', () => {
    const f = fixture()
    f.order.push(frame(101)); f.order.close(); f.order.close()
    f.order.push(frame(100, 'key')); f.order.tick(); f.order.reset()
    expect(f.order.stats()).toMatchObject({ closed: true, bufferedFrames: 0, bufferedBytes: 0, deliveredSequence: -1 })
    expect(f.onFrame).not.toHaveBeenCalled()
    expect(f.onDiscontinuity).not.toHaveBeenCalled()
    expect(f.onKeyFrameRequired).not.toHaveBeenCalled()
  })

  it('contains decoder/feedback errors and handles close during a decoder callback', () => {
    const f = fixture({ onDiscontinuity() { throw new Error('decoder reset failed') }, onKeyFrameRequired() { throw new Error('observer failed') } })
    f.onFrame.mockImplementationOnce(() => { throw new Error('decoder failed') })
    expect(() => f.order.push(frame(0, 'key'))).not.toThrow()
    expect(f.order.stats()).toMatchObject({ deliveredSequence: -1, waitingForKeyframe: true })
    f.onFrame.mockImplementationOnce(() => { f.order.close(); return true })
    f.order.push(frame(1, 'key'))
    expect(f.order.stats()).toMatchObject({ closed: true, deliveredSequence: -1, bufferedFrames: 0 })
  })

  it('validates hard limits, scalar frame metadata and monotonic clocks', () => {
    const callbacks = { onFrame: () => true, onDiscontinuity() {}, onKeyFrameRequired() {} }
    for (const options of [{ maxWaitMs: NaN }, { maxWaitMs: 0 }, { maxWaitMs: 121 }, { maxFrames: 0 },
      { maxFrames: 5 }, { maxFrames: 1.5 }, { maxBytes: 0 }, { maxBytes: 512 * 1024 + 1 }]) {
      expect(() => new VideoFrameOrder({ ...callbacks, ...options })).toThrow('Invalid video ordering limits')
    }
    const f = fixture()
    for (const mutation of [{ kind: 'audio' }, { sequence: -1 }, { sequence: 2 ** 32 }, { sequence: 1.1 },
      { timestampUs: NaN }, { durationUs: -1 }, { type: 'unknown' }, { data: new Uint8Array() }]) {
      f.order.push({ ...frame(0, 'key'), ...mutation } as OrderedVideoFrame)
    }
    expect(f.onFrame).not.toHaveBeenCalled()
    expect(f.order.stats().bufferedBytes).toBe(0)
    f.at(10); f.order.tick(); f.at(9)
    expect(() => f.order.tick()).toThrow('Invalid video ordering clock')
    f.at(Infinity); expect(() => f.order.tick()).toThrow('Invalid video ordering clock')
  })
})
