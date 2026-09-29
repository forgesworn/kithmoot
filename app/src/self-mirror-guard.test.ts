import { describe, it, expect } from 'vitest'
import { coversWholeDisplay, mayShowItself } from './self-mirror-guard.js'

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

describe('mayShowItself', () => {
  it('is false only for a single tab', () => {
    expect(mayShowItself('browser')).toBe(false)
  })

  it('is true for a whole screen, any window, and a capture with no hint', () => {
    expect(mayShowItself('monitor')).toBe(true)
    expect(mayShowItself('window')).toBe(true)
    expect(mayShowItself(undefined)).toBe(true)
  })
})
