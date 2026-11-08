import { describe, expect, it, vi } from 'vitest'
import { wrapSegmenter } from './bundled-segmenter.js'

describe('bundled foreground result ownership', () => {
  it('keeps the person mask after the SDK releases and reuses its heap', () => {
    const person = new Float32Array([0.9, 0.1])
    const release = vi.fn(() => person.fill(0))
    const sdk = { segment: vi.fn(() => ({ confidenceMasks: [
      { width: 2, height: 1, getAsFloat32Array: () => new Float32Array([0.1, 0.9]) },
      { width: 2, height: 1, getAsFloat32Array: () => person },
    ], close: release })), close: vi.fn() }
    const result = wrapSegmenter(sdk).segment({}, 1)!
    expect([...result.data]).toEqual([expect.closeTo(0.9), expect.closeTo(0.1)])
    expect(person).toEqual(new Float32Array(2))
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases malformed results and throws so the compositor covers the frame', () => {
    const release = vi.fn()
    const sdk = { segment: () => ({ confidenceMasks: [{ width: 2, height: 1,
      getAsFloat32Array: () => new Float32Array([NaN, 1]) }], close: release }), close() {} }
    expect(() => wrapSegmenter(sdk).segment({}, 1)).toThrow('Invalid foreground mask')
    expect(release).toHaveBeenCalledOnce()
  })

  it('runs each source afresh at repeated timestamps and closes only once', () => {
    const sdk = { segment: vi.fn(() => ({ confidenceMasks: [], close() {} })), close: vi.fn() }
    const segmenter = wrapSegmenter(sdk), first = {}, second = {}
    expect(segmenter.segment(first, 10)).toBeNull()
    expect(segmenter.segment(second, 10)).toBeNull()
    expect(sdk.segment.mock.calls).toEqual([[first], [second]])
    segmenter.close(); segmenter.close()
    expect(segmenter.segment(first, 11)).toBeNull()
    expect(sdk.close).toHaveBeenCalledOnce()
    expect(sdk.segment).toHaveBeenCalledTimes(2)
  })
})
