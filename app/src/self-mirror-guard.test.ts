import { describe, it, expect } from 'vitest'
import { coversWholeDisplay, isWholeDisplaySurface } from './self-mirror-guard.js'

describe('coversWholeDisplay', () => {
  it('is false with no area', () => {
    expect(coversWholeDisplay(null)).toBe(false)
  })

  it('is false for an ordinary partial area', () => {
    expect(coversWholeDisplay({ width: 640 / 1920, height: 480 / 1080 })).toBe(false)
  })

  it('is true for the exact whole picture', () => {
    expect(coversWholeDisplay({ width: 1, height: 1 })).toBe(true)
  })

  it('is true for a frame maximised to the screen, net of its own border and toolbar', () => {
    // AREA_INSET on a 1920x1080 display: 16px off the width, 92px off the height.
    expect(coversWholeDisplay({ width: (1920 - 16) / 1920, height: (1080 - 92) / 1080 })).toBe(true)
  })

  it('is false once the area is meaningfully smaller than the display', () => {
    expect(coversWholeDisplay({ width: 0.85, height: 0.85 })).toBe(false)
  })
})

describe('isWholeDisplaySurface', () => {
  it('is true only for a monitor surface', () => {
    expect(isWholeDisplaySurface('monitor')).toBe(true)
    expect(isWholeDisplaySurface('window')).toBe(false)
    expect(isWholeDisplaySurface('browser')).toBe(false)
    expect(isWholeDisplaySurface(undefined)).toBe(false)
  })
})
