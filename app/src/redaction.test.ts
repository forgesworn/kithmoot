import { describe, expect, it } from 'vitest'
import { DesktopRedaction } from './redaction.js'
import { HIDDEN_PLAN, RedactionTrail } from './redaction-geometry.js'

describe('a share hidden on purpose', () => {
  it('is painted the moment it is hidden or shown, and the controls are told', () => {
    const redaction = new DesktopRedaction(undefined)
    const painted: boolean[] = [], told: boolean[] = []
    const stop = redaction.onPaint(() => painted.push(redaction.hidden))
    redaction.onChange(() => told.push(redaction.hidden))
    redaction.setHidden(true)
    // Painted before the call returns, already hidden: no tick in between.
    expect(painted).toEqual([true])
    expect(told).toEqual([true])
    redaction.setHidden(true)
    expect(painted).toEqual([true])
    redaction.setHidden(false)
    expect(painted).toEqual([true, false])
    expect(told).toEqual([true, false])
    // A share that has ended is not painted again.
    stop()
    redaction.setHidden(true)
    expect(painted).toEqual([true, false])
  })

  it('covers the whole of an area share while hidden, and nothing of it once shown', () => {
    const redaction = new DesktopRedaction(undefined)
    const trail = new RedactionTrail()
    const plan = () => redaction.areaPlan(trail, { width: 1600, height: 900 }, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, { width: 800, height: 450 })
    expect(plan()).toEqual({ mode: 'pass' })
    redaction.setHidden(true)
    expect(plan()).toEqual(HIDDEN_PLAN)
    redaction.setHidden(false)
    expect(plan()).toEqual({ mode: 'pass' })
  })
})
