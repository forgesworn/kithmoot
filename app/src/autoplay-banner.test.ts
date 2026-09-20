import { describe, expect, it } from 'vitest'
import { AutoplayBannerState, isAutoplayBlock, shouldShowAutoplayBanner } from './autoplay-banner.js'

function activation(hasBeenActive: boolean): UserActivation {
  return { hasBeenActive, isActive: hasBeenActive }
}

describe('isAutoplayBlock', () => {
  it('is true for a DOMException named NotAllowedError', () => {
    expect(isAutoplayBlock(new DOMException('blocked', 'NotAllowedError'))).toBe(true)
  })

  it('is true for a plain object shaped the same way', () => {
    expect(isAutoplayBlock({ name: 'NotAllowedError' })).toBe(true)
  })

  it('is false for any other error', () => {
    expect(isAutoplayBlock(new DOMException('gone', 'AbortError'))).toBe(false)
    expect(isAutoplayBlock(new Error('boom'))).toBe(false)
    expect(isAutoplayBlock(undefined)).toBe(false)
  })

  it('with no userActivation to check, the error name alone is enough', () => {
    expect(isAutoplayBlock(new DOMException('blocked', 'NotAllowedError'), undefined)).toBe(true)
  })

  it('trusts a rejection while this page has never had a gesture', () => {
    expect(isAutoplayBlock(new DOMException('blocked', 'NotAllowedError'), activation(false))).toBe(true)
  })

  it('does not trust a rejection once the page has had a gesture - some other problem', () => {
    expect(isAutoplayBlock(new DOMException('blocked', 'NotAllowedError'), activation(true))).toBe(false)
  })
})

describe('shouldShowAutoplayBanner', () => {
  it('shows while in the room with audio not deliberately muted, whether or not this device pressed Join call', () => {
    expect(shouldShowAutoplayBanner({ inRoom: true, audioDeliberatelyMuted: false })).toBe(true)
  })

  it('never shows outside the room', () => {
    expect(shouldShowAutoplayBanner({ inRoom: false, audioDeliberatelyMuted: false })).toBe(false)
  })

  it('never shows when audio is deliberately muted', () => {
    expect(shouldShowAutoplayBanner({ inRoom: true, audioDeliberatelyMuted: true })).toBe(false)
  })
})

describe('AutoplayBannerState', () => {
  it('starts hidden', () => {
    expect(new AutoplayBannerState().visible).toBe(false)
  })

  it('a block shows it', () => {
    const state = new AutoplayBannerState()
    const shown = state.blocked(new DOMException('blocked', 'NotAllowedError'), { inRoom: true, audioDeliberatelyMuted: false })
    expect(shown).toBe(true)
    expect(state.visible).toBe(true)
  })

  it('a block that is not an autoplay error never shows it', () => {
    const state = new AutoplayBannerState()
    state.blocked(new Error('network'), { inRoom: true, audioDeliberatelyMuted: false })
    expect(state.visible).toBe(false)
  })

  it('a block while off the call never shows it', () => {
    const state = new AutoplayBannerState()
    state.blocked(new DOMException('blocked', 'NotAllowedError'), { inRoom: false, audioDeliberatelyMuted: false })
    expect(state.visible).toBe(false)
  })

  it('resumed hides it', () => {
    const state = new AutoplayBannerState()
    state.blocked(new DOMException('blocked', 'NotAllowedError'), { inRoom: true, audioDeliberatelyMuted: false })
    state.resumed()
    expect(state.visible).toBe(false)
  })

  it('a later block shows it again after it was resumed', () => {
    const state = new AutoplayBannerState()
    const deps = { inRoom: true, audioDeliberatelyMuted: false }
    state.blocked(new DOMException('blocked', 'NotAllowedError'), deps)
    state.resumed()
    state.blocked(new DOMException('blocked', 'NotAllowedError'), deps)
    expect(state.visible).toBe(true)
  })

  it('hide forces it off regardless of prior state', () => {
    const state = new AutoplayBannerState()
    state.blocked(new DOMException('blocked', 'NotAllowedError'), { inRoom: true, audioDeliberatelyMuted: false })
    state.hide()
    expect(state.visible).toBe(false)
  })
})
