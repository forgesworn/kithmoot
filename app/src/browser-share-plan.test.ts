import { describe, expect, it } from 'vitest'
import { browserSharePlan, type BrowserShareState } from './browser-share-plan.js'

const state = (): BrowserShareState => ({ crop: { x: .25, y: .25, width: .5, height: .5 },
  masks: [{ x: .4, y: .4, width: .2, height: .2 }], hidden: false, confirmedSize: { width: 640, height: 360 } })

describe('protected browser share geometry', () => {
  it('maps source masks into a cropped output with outward padding', () => {
    const plan = browserSharePlan(state(), 640, 360)
    expect(plan.cover).toBe(false)
    if (plan.cover) throw new Error('unexpected cover')
    expect(plan.source).toEqual({ x: 160, y: 90, width: 320, height: 180 })
    const mask = plan.masks[0]!
    expect(mask.x).toBeLessThanOrEqual(93)
    expect(mask.y).toBeLessThanOrEqual(51)
    expect(mask.x + mask.width).toBeGreaterThanOrEqual(227)
    expect(mask.y + mask.height).toBeGreaterThanOrEqual(129)
  })
  it('clips masks to the crop and ignores non-intersecting regions', () => {
    const s = state(); s.masks = [{ x: 0, y: 0, width: .1, height: .1 }, { x: .1, y: .1, width: .4, height: .4 }]
    const plan = browserSharePlan(s, 640, 360)
    if (plan.cover) throw new Error('unexpected cover')
    expect(plan.masks).toHaveLength(1)
    expect(plan.masks[0]!.x).toBe(0); expect(plan.masks[0]!.y).toBe(0)
  })
  it('covers the entire output until a changed source size is explicitly confirmed', () => {
    expect(browserSharePlan(state(), 1280, 720)).toEqual({ cover: true })
    const s = state(); s.confirmedSize = { width: 1280, height: 720 }
    expect(browserSharePlan(s, 1280, 720).cover).toBe(false)
  })
  it('covers malformed, non-finite, hidden and out-of-bounds selections', () => {
    for (const crop of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: -.1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 }, { x: .8, y: 0, width: .3, height: 1 }]) {
      const s = state(); s.crop = crop; expect(browserSharePlan(s, 640, 360)).toEqual({ cover: true })
    }
    const s = state(); s.hidden = true; expect(browserSharePlan(s, 640, 360)).toEqual({ cover: true })
    s.hidden = false; s.masks = [{ x: 0, y: 0, width: Infinity, height: 1 }]
    expect(browserSharePlan(s, 640, 360)).toEqual({ cover: true })
  })
})
