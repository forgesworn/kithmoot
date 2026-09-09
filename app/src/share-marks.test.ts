import { describe, it, expect, vi } from 'vitest'
import { FADE_MS, HOLD_MS, MARK_LIFETIME_MS, ShareMarks, markAlpha } from './share-marks.js'
import type { ScreenAnnotation } from '../../src/signal.js'

const stroke = (shareId: string, strokeId: string): ScreenAnnotation =>
  ({ op: 'stroke', shareId, strokeId, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] })

/** A clock and a scheduler the test drives by hand. */
function harness() {
  let now = 1_000
  const queue: { at: number; fn: () => void }[] = []
  const marks = new ShareMarks(() => now, (fn, ms) => { queue.push({ at: now + ms, fn }) })
  const advance = (ms: number) => {
    const until = now + ms
    while (true) {
      const next = queue.filter(q => q.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      queue.splice(queue.indexOf(next), 1)
      now = next.at
      next.fn()
    }
    now = until
  }
  return { marks, advance, queue }
}

describe('markAlpha', () => {
  it('is solid for the hold, fades to nothing over the fade, and stays gone', () => {
    expect(markAlpha(0)).toBe(1)
    expect(markAlpha(HOLD_MS - 1)).toBe(1)
    expect(markAlpha(HOLD_MS + FADE_MS / 2)).toBeCloseTo(0.5)
    expect(markAlpha(MARK_LIFETIME_MS)).toBe(0)
    expect(markAlpha(MARK_LIFETIME_MS * 3)).toBe(0)
  })
})

describe('ShareMarks', () => {
  it('shows a stroke solid, fades it, and forgets it after a couple of seconds', () => {
    const { marks, advance } = harness()
    marks.remember(stroke('share-a', 's1'))
    expect(marks.alive('share-a')).toHaveLength(1)
    expect(marks.alive('share-a')[0]!.alpha).toBe(1)
    advance(HOLD_MS + FADE_MS / 2)
    expect(marks.alive('share-a')[0]!.alpha).toBeCloseTo(0.5)
    advance(FADE_MS)
    expect(marks.alive('share-a')).toEqual([])
    expect(marks.any).toBe(false)
  })

  it('tells its painters about every step of the fade and then goes quiet', () => {
    const { marks, advance, queue } = harness()
    const painter = vi.fn()
    marks.subscribe(painter)
    marks.remember(stroke('share-a', 's1'))
    expect(painter).toHaveBeenCalledTimes(1)
    advance(MARK_LIFETIME_MS + 100)
    // One notification per tick across the lifetime, then no more ticks.
    expect(painter.mock.calls.length).toBeGreaterThan(MARK_LIFETIME_MS / 100)
    expect(queue).toHaveLength(0)
    const calls = painter.mock.calls.length
    advance(5_000)
    expect(painter).toHaveBeenCalledTimes(calls)
  })

  it('ignores a stroke it already holds and clears a share on request', () => {
    const { marks } = harness()
    marks.remember(stroke('share-a', 's1'))
    marks.remember(stroke('share-a', 's1'))
    marks.remember(stroke('share-a', 's2'))
    marks.remember(stroke('share-b', 's3'))
    expect(marks.alive('share-a')).toHaveLength(2)
    marks.remember({ op: 'clear', shareId: 'share-a', strokeId: '' })
    expect(marks.alive('share-a')).toEqual([])
    expect(marks.alive('share-b')).toHaveLength(1)
  })

  it('keeps a bounded number of strokes per share and of shares', () => {
    const { marks } = harness()
    for (let i = 0; i < 120; i++) marks.remember(stroke('share-a', `s${i}`))
    expect(marks.alive('share-a')).toHaveLength(100)
    for (let i = 0; i < 20; i++) marks.remember(stroke(`share-${i}`, 'x'))
    expect(marks.alive('share-a')).toEqual([])
    expect(marks.alive('share-19')).toHaveLength(1)
  })
})
