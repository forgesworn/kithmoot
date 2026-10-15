import { describe, expect, it } from 'vitest'
import { ANDROID_DOWNLOAD_URL, DESKTOP_DOWNLOAD_URL, appLinkFor, appPlatform, isAndroidUserAgent } from './open-in-app.js'

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

describe('appPlatform', () => {
  it('offers the app on Android and on computers the desktop app runs on', () => {
    expect(appPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36')).toBe('android')
    expect(appPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36')).toBe('desktop')
    expect(appPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe('desktop')
    expect(appPlatform('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('desktop')
  })

  it('offers nothing where there is no app', () => {
    expect(appPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBeUndefined()
    expect(appPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBeUndefined()
    expect(appPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBeUndefined()
    expect(appPlatform('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/126 Safari/537.36')).toBeUndefined()
  })

  it('sends a computer to the desktop downloads', () => {
    expect(DESKTOP_DOWNLOAD_URL).toBe('https://kithmoot.app/downloads/')
  })
})
