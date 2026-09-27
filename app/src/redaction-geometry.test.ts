import { describe, expect, it } from 'vitest'
import { HOLD_MS, PAD_DIP, RedactionTrail, cropPlan, effectiveSource, hull, planRedaction, refuseShare, type RedactionState } from './redaction-geometry.js'

const display = { id: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 } }
const right = { id: '2', bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }
const box = (id: string, x: number, y: number, width: number, height: number, on = true) => ({ id, on, bounds: { x, y, width, height } })
const state = (over: Partial<RedactionState> = {}): RedactionState => ({ boxes: [], displays: [display, right], source: { kind: 'screen', displayId: '1' }, ...over })
const held = (s: RedactionState) => new RedactionTrail().next(s.boxes, 0)

describe('redaction geometry on a whole-screen share', () => {
  it('passes the picture untouched with no box on', () => {
    expect(planRedaction(state(), { width: 2880, height: 1800 }, [])).toEqual({ mode: 'pass' })
    const off = state({ boxes: [box('a', 100, 100, 200, 100, false)] })
    expect(planRedaction(off, { width: 2880, height: 1800 }, held(off))).toEqual({ mode: 'pass' })
  })

  it('maps a DIP box to frame pixels at the display scale, padded outwards', () => {
    const s = state({ boxes: [box('a', 100, 50, 200, 100)] })
    // A Retina frame: two pixels to every DIP.
    expect(planRedaction(s, { width: 2880, height: 1800 }, held(s))).toEqual({
      mode: 'boxes', rects: [{ x: (100 - PAD_DIP) * 2, y: (50 - PAD_DIP) * 2, width: (200 + 2 * PAD_DIP) * 2, height: (100 + 2 * PAD_DIP) * 2 }],
    })
    // A downscaled frame rounds outwards, never inwards.
    const plan = planRedaction(s, { width: 1000, height: 625 }, held(s))
    expect(plan.mode).toBe('boxes')
    const rect = plan.mode === 'boxes' ? plan.rects[0]! : undefined
    const k = 1000 / 1440
    expect(rect!.x).toBeLessThanOrEqual(100 * k)
    expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(300 * k)
    expect(rect!.y + rect!.height).toBeGreaterThanOrEqual(150 * k)
  })

  it('clips a box hanging off the edge, and ignores one on another display', () => {
    const s = state({ boxes: [box('a', 1400, 850, 300, 300), box('b', 1600, 100, 200, 200)] })
    expect(planRedaction(s, { width: 1440, height: 900 }, held(s))).toEqual({ mode: 'boxes', rects: [{ x: 1397, y: 847, width: 43, height: 53 }] })
    const other = state({ boxes: [box('b', 1600, 100, 200, 200)] })
    expect(planRedaction(other, { width: 1440, height: 900 }, held(other))).toEqual({ mode: 'pass' })
  })

  it('maps onto a display with a non-zero origin', () => {
    const s = state({ boxes: [box('b', 1600, 100, 200, 200)], source: { kind: 'screen', displayId: '2' } })
    expect(planRedaction(s, { width: 1920, height: 1080 }, held(s))).toEqual({ mode: 'boxes', rects: [{ x: 157, y: 97, width: 206, height: 206 }] })
  })

  it('goes black whenever it cannot be sure where a box falls', () => {
    const s = state({ boxes: [box('a', 100, 100, 200, 100)] })
    const frame = { width: 2880, height: 1800 }
    expect(planRedaction({ ...s, source: null }, frame, held(s))).toEqual({ mode: 'black', reason: 'unknown' })
    expect(planRedaction({ ...s, source: { kind: 'window' } }, frame, held(s))).toEqual({ mode: 'black', reason: 'window' })
    expect(planRedaction({ ...s, source: { kind: 'screen', displayId: '9' } }, frame, held(s))).toEqual({ mode: 'black', reason: 'geometry' })
    // A picture whose shape is not the display's is not what we think it is.
    expect(planRedaction(s, { width: 1600, height: 1200 }, held(s))).toEqual({ mode: 'black', reason: 'geometry' })
    expect(planRedaction(s, { width: 0, height: 0 }, held(s))).toEqual({ mode: 'black', reason: 'geometry' })
    expect(planRedaction(s, frame, [{ x: NaN, y: 0, width: 10, height: 10 }])).toEqual({ mode: 'black', reason: 'geometry' })
    // The track itself disagreeing with the main process is unknown too.
    expect(planRedaction(s, frame, held(s), 'window')).toEqual({ mode: 'black', reason: 'unknown' })
  })

  it('believes a source only when the track agrees', () => {
    expect(effectiveSource({ kind: 'screen', displayId: '1' }, undefined)).toEqual({ kind: 'screen', displayId: '1' })
    expect(effectiveSource({ kind: 'screen', displayId: '1' }, 'monitor')).toEqual({ kind: 'screen', displayId: '1' })
    expect(effectiveSource({ kind: 'screen', displayId: '1' }, 'window')).toBeNull()
    expect(effectiveSource({ kind: 'window' }, 'monitor')).toBeNull()
    expect(effectiveSource({ kind: 'screen', displayId: '1' }, 'browser')).toBeNull()
    expect(effectiveSource(null, 'monitor')).toBeNull()
  })
})

describe('redaction while a box moves', () => {
  it('keeps the hull of the old and new places black for a short time', () => {
    const trail = new RedactionTrail()
    expect(trail.next([box('a', 0, 0, 100, 100)], 0)).toEqual([{ x: 0, y: 0, width: 100, height: 100 }])
    const moved = trail.next([box('a', 50, 20, 100, 100)], 16)
    expect(moved).toContainEqual({ x: 50, y: 20, width: 100, height: 100 })
    expect(moved).toContainEqual(hull({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 20, width: 100, height: 100 }))
    expect(trail.next([box('a', 50, 20, 100, 100)], 16 + HOLD_MS + 1)).toEqual([{ x: 50, y: 20, width: 100, height: 100 }])
  })

  it('keeps a box turned off or closed black for a short time', () => {
    const trail = new RedactionTrail()
    trail.next([box('a', 0, 0, 100, 100)], 0)
    expect(trail.next([box('a', 0, 0, 100, 100, false)], 10)).toEqual([{ x: 0, y: 0, width: 100, height: 100 }])
    expect(trail.next([], HOLD_MS + 20)).toEqual([])
    trail.next([box('b', 5, 5, 100, 100)], 1000)
    expect(trail.next([], 1010)).toEqual([{ x: 5, y: 5, width: 100, height: 100 }])
  })
})

describe('redaction inside an area share', () => {
  it('carries frame rectangles into the crop, rounded outwards and clipped', () => {
    const plan = { mode: 'boxes' as const, rects: [{ x: 300, y: 200, width: 100, height: 100 }, { x: 0, y: 0, width: 10, height: 10 }] }
    // A 400x300 crop at (200, 150), drawn at the same size.
    expect(cropPlan(plan, { x: 200, y: 150, width: 400, height: 300 }, { width: 400, height: 300 })).toEqual({ mode: 'boxes', rects: [{ x: 100, y: 50, width: 100, height: 100 }] })
    // Drawn at half size.
    expect(cropPlan(plan, { x: 200, y: 150, width: 400, height: 300 }, { width: 200, height: 150 })).toEqual({ mode: 'boxes', rects: [{ x: 50, y: 25, width: 50, height: 50 }] })
    // Wholly outside the crop.
    expect(cropPlan({ mode: 'boxes', rects: [{ x: 0, y: 0, width: 10, height: 10 }] }, { x: 200, y: 150, width: 400, height: 300 }, { width: 400, height: 300 })).toEqual({ mode: 'pass' })
    // A box straddling the crop edge is cut at the edge, not dropped.
    expect(cropPlan({ mode: 'boxes', rects: [{ x: 150, y: 100, width: 100, height: 100 }] }, { x: 200, y: 150, width: 400, height: 300 }, { width: 400, height: 300 })).toEqual({ mode: 'boxes', rects: [{ x: 0, y: 0, width: 50, height: 50 }] })
  })

  it('stays black on a black plan and on a nonsense crop', () => {
    expect(cropPlan({ mode: 'black', reason: 'unknown' }, { x: 0, y: 0, width: 10, height: 10 }, { width: 10, height: 10 })).toEqual({ mode: 'black', reason: 'unknown' })
    expect(cropPlan({ mode: 'boxes', rects: [{ x: 0, y: 0, width: 10, height: 10 }] }, { x: 0, y: 0, width: 0, height: 10 }, { width: 10, height: 10 })).toEqual({ mode: 'black', reason: 'geometry' })
  })
})

describe('starting a share with boxes on', () => {
  it('refuses a single app while a box is on, and allows it with none on', () => {
    const on = state({ boxes: [box('a', 0, 0, 100, 100)], source: { kind: 'window' } })
    expect(refuseShare(on, undefined)).toMatch(/cannot follow a single app/)
    expect(refuseShare({ ...on, source: { kind: 'screen', displayId: '1' } }, 'window')).toMatch(/cannot follow a single app/)
    expect(refuseShare({ ...on, boxes: [box('a', 0, 0, 100, 100, false)] }, undefined)).toBeUndefined()
    expect(refuseShare({ ...on, source: { kind: 'screen', displayId: '1' } }, 'monitor')).toBeUndefined()
  })
})
