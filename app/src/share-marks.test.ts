import { describe, it, expect, vi } from 'vitest'
import { FADE_MS, HOLD_MS, MARK_COLOURS, MARK_LIFETIME_MS, ShareMarks, colourForParticipant, coloursForShare, markAlpha, type MarkAuthor } from './share-marks.js'
import type { ScreenAnnotation } from '../../src/signal.js'

const ADA = 'ad'.repeat(32)
const ROWAN = 'ro'.repeat(32)
// Hashes to the same index as ADA (both land on MARK_COLOURS[1]) and sorts
// before it, so `coloursForShare` has to move one of them - a fixture for
// the clash-resolution tests, not a real pubkey shape.
const CLASHES_WITH_ADA = '00'.repeat(32)

const stroke = (shareId: string, strokeId: string): ScreenAnnotation =>
  ({ op: 'stroke', shareId, strokeId, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] })

/** A drawer, for tests that do not care who: a fixed identity distinct from
 *  any of the named participants above. */
const ME: MarkAuthor = { key: 'me', label: 'You' }

const authorFor = (participant: string, label: string): MarkAuthor => ({ key: participant, label })

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

describe('colourForParticipant', () => {
  it('is stable for one pubkey and, usually, different for another - the same colour wherever it is computed, including on the drawer\'s own screen', () => {
    const ada = colourForParticipant(ADA)
    expect(colourForParticipant(ADA)).toBe(ada)
    expect(colourForParticipant(ROWAN)).not.toBe(ada)
  })
})

describe('coloursForShare', () => {
  it('gives two people who do not hash to the same index their own colours', () => {
    const colours = coloursForShare([ADA, ROWAN])
    expect(colours.get(ADA)).toBe(colourForParticipant(ADA))
    expect(colours.get(ROWAN)).toBe(colourForParticipant(ROWAN))
    expect(colours.get(ADA)).not.toBe(colours.get(ROWAN))
  })

  it('resolves a clash deterministically by participant key order, moving the one that sorts later', () => {
    expect(colourForParticipant(CLASHES_WITH_ADA)).toBe(colourForParticipant(ADA))
    const colours = coloursForShare([ADA, CLASHES_WITH_ADA])
    // '00...0' sorts before 'ad...d', so it keeps the shared hash index and
    // ADA is the one moved on to the next free colour.
    expect(colours.get(CLASHES_WITH_ADA)).toBe(colourForParticipant(CLASHES_WITH_ADA))
    expect(colours.get(ADA)).not.toBe(colourForParticipant(ADA))
    expect(colours.get(ADA)).not.toBe(colours.get(CLASHES_WITH_ADA))
    // Order of the input does not change the outcome - it is sorted inside.
    expect(coloursForShare([CLASHES_WITH_ADA, ADA])).toEqual(colours)
  })

  it('runs out and repeats once there are more concurrent drawers than colours - a documented limit, not a crash', () => {
    const participants = Array.from({ length: MARK_COLOURS.length + 2 }, (_, i) => `p${i}`.repeat(8))
    const colours = coloursForShare(participants)
    expect(colours.size).toBe(participants.length)
    const used = new Set(colours.values())
    expect(used.size).toBeLessThanOrEqual(MARK_COLOURS.length)
  })
})

describe('ShareMarks', () => {
  it('shows a stroke solid, fades it, and forgets it after a couple of seconds', () => {
    const { marks, advance } = harness()
    marks.remember(stroke('share-a', 's1'), ME)
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
    marks.remember(stroke('share-a', 's1'), ME)
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
    marks.remember(stroke('share-a', 's1'), ME)
    marks.remember(stroke('share-a', 's1'), ME)
    marks.remember(stroke('share-a', 's2'), ME)
    marks.remember(stroke('share-b', 's3'), ME)
    expect(marks.alive('share-a')).toHaveLength(2)
    marks.remember({ op: 'clear', shareId: 'share-a', strokeId: '' }, ME)
    expect(marks.alive('share-a')).toEqual([])
    expect(marks.alive('share-b')).toHaveLength(1)
  })

  it('keeps a bounded number of strokes per share and of shares', () => {
    const { marks } = harness()
    for (let i = 0; i < 120; i++) marks.remember(stroke('share-a', `s${i}`), ME)
    expect(marks.alive('share-a')).toHaveLength(100)
    for (let i = 0; i < 20; i++) marks.remember(stroke(`share-${i}`, 'x'), ME)
    expect(marks.alive('share-a')).toEqual([])
    expect(marks.alive('share-19')).toHaveLength(1)
  })

  it('keeps each stroke with the author who drew it: two drawers, two colours, the right name on each', () => {
    const { marks } = harness()
    const ada = authorFor(ADA, 'Ada npub1ad…')
    const rowan = authorFor(ROWAN, 'Rowan npub1ro…')
    marks.remember(stroke('share-a', 's1'), ada)
    marks.remember(stroke('share-a', 's2'), rowan)
    const alive = marks.alive('share-a')
    const byStroke = (strokeId: string) => alive.find(m => m.annotation.strokeId === strokeId)!
    expect(byStroke('s1').author).toEqual(ada)
    expect(byStroke('s2').author).toEqual(rowan)
    expect(byStroke('s1').color).not.toBe(byStroke('s2').color)
  })

  it('agrees on a colour with a second, independent ShareMarks that has heard the same strokes - the sharer, the drawer and a third viewer all seeing the same colour needs nothing exchanged but the strokes themselves', () => {
    const sharer = harness().marks
    const thirdViewer = harness().marks
    const ada = authorFor(ADA, 'Ada npub1ad…')
    const rowan = authorFor(ROWAN, 'Rowan npub1ro…')
    for (const marks of [sharer, thirdViewer]) {
      marks.remember(stroke('share-a', 's1'), ada)
      marks.remember(stroke('share-a', 's2'), rowan)
    }
    const colourOf = (marks: ShareMarks, strokeId: string) => marks.alive('share-a').find(m => m.annotation.strokeId === strokeId)!.color
    expect(colourOf(sharer, 's1')).toBe(colourOf(thirdViewer, 's1'))
    expect(colourOf(sharer, 's2')).toBe(colourOf(thirdViewer, 's2'))
    expect(colourOf(sharer, 's1')).not.toBe(colourOf(sharer, 's2'))
  })

  it('gives a stroke still being drawn the colour it would get once remembered, clashes included', () => {
    const { marks } = harness()
    marks.remember(stroke('share-a', 's1'), authorFor(ADA, 'Ada'))
    // CLASHES_WITH_ADA has not drawn yet, so it is not one of `alive`'s
    // marks, but `colourFor` still has to account for ADA already being
    // live on this share so a stroke still in progress does not flash a
    // different colour the moment it is released.
    expect(marks.colourFor('share-a', CLASHES_WITH_ADA)).toBe(coloursForShare([ADA, CLASHES_WITH_ADA]).get(CLASHES_WITH_ADA))
  })
})
