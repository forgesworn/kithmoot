import { describe, expect, it } from 'vitest'
import { ANDROID_DOWNLOAD_URL, appLinkFor, isAndroidUserAgent } from './open-in-app.js'

describe('appLinkFor', () => {
  it('keeps the whole fragment', () => {
    expect(appLinkFor('https://kithmoot.forgesworn.dev/j/#abc_DEF-123')).toBe('kithmoot://join#abc_DEF-123')
    expect(appLinkFor('https://kithmoot.app/j/#a=b&c=d%20e')).toBe('kithmoot://join#a=b&c=d%20e')
  })

  it('keeps a query ahead of the fragment', () => {
    expect(appLinkFor('https://kithmoot.app/j/?x=1&y=2#frag')).toBe('kithmoot://join?x=1&y=2#frag')
  })

  it('has nothing to open without a room in the fragment', () => {
    expect(appLinkFor('https://kithmoot.app/j/')).toBeUndefined()
    expect(appLinkFor('https://kithmoot.app/j/#')).toBeUndefined()
    expect(appLinkFor('not a url')).toBeUndefined()
  })

  it('never uses the reserved sign-in host', () => {
    expect(appLinkFor('https://kithmoot.app/j/#x')).not.toContain('signet')
  })
})

describe('isAndroidUserAgent', () => {
  it('recognises Android browsers only', () => {
    expect(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36')).toBe(true)
    expect(isAndroidUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false)
    expect(isAndroidUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe(false)
  })
})

describe('ANDROID_DOWNLOAD_URL', () => {
  it('points at the Android section of the site', () => {
    expect(ANDROID_DOWNLOAD_URL).toBe('https://kithmoot.app/#android')
  })
})
