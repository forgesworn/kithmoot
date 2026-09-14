import { describe, it, expect } from 'vitest'
import { DEFAULT_ICE_URLS, LEGACY_DEFAULT_ICE_URLS, isDefaultIceUrls, originStunGuess, stunFromTurnUrl } from './ice-defaults.js'

describe('stunFromTurnUrl', () => {
  it('derives a stun: URL from a turn: URL with host and port', () => {
    expect(stunFromTurnUrl('turn:turn.kithmoot.example:3478')).toBe('stun:turn.kithmoot.example:3478')
  })

  it('does not invent optional stuns: from a turns: URL', () => {
    expect(stunFromTurnUrl('turns:turn.kithmoot.example:5349')).toBeUndefined()
  })

  it('drops a ?transport=... suffix, which is TURN-only', () => {
    expect(stunFromTurnUrl('turn:turn.kithmoot.example:3478?transport=tcp')).toBe('stun:turn.kithmoot.example:3478')
  })

  it('is case-insensitive on the scheme', () => {
    expect(stunFromTurnUrl('TURN:turn.kithmoot.example:3478')).toBe('stun:turn.kithmoot.example:3478')
  })

  it('returns undefined for a non-turn URL', () => {
    expect(stunFromTurnUrl('stun:stun.kithmoot.example:3478')).toBeUndefined()
  })

  it('returns undefined for a turn: URL with nothing after the scheme', () => {
    expect(stunFromTurnUrl('turn:')).toBeUndefined()
    expect(stunFromTurnUrl('turn:?transport=tcp')).toBeUndefined()
  })
})

describe('originStunGuess', () => {
  it('guesses this origin on port 3478 for a non-loopback https origin', () => {
    expect(originStunGuess({ protocol: 'https:', hostname: 'kithmoot.example' })).toEqual(['stun:kithmoot.example:3478'])
  })

  it('names nothing for an http origin', () => {
    expect(originStunGuess({ protocol: 'http:', hostname: 'kithmoot.example' })).toEqual([])
  })

  it('names nothing for localhost, even over https', () => {
    expect(originStunGuess({ protocol: 'https:', hostname: 'localhost' })).toEqual([])
  })

  it('names nothing for 127.0.0.1 or ::1', () => {
    expect(originStunGuess({ protocol: 'https:', hostname: '127.0.0.1' })).toEqual([])
    expect(originStunGuess({ protocol: 'https:', hostname: '::1' })).toEqual([])
    expect(originStunGuess({ protocol: 'https:', hostname: '[::1]' })).toEqual([])
  })
})

describe('isDefaultIceUrls', () => {
  it('treats the current empty default as the default', () => {
    expect(isDefaultIceUrls(DEFAULT_ICE_URLS)).toBe(true)
    expect(isDefaultIceUrls([])).toBe(true)
  })

  it('treats an existing link’s legacy Google hint as the old default', () => {
    expect(isDefaultIceUrls(LEGACY_DEFAULT_ICE_URLS)).toBe(true)
    expect(isDefaultIceUrls(['stun:stun.l.google.com:19302'])).toBe(true)
  })

  it('keeps a room that named its own, non-Google ICE servers', () => {
    expect(isDefaultIceUrls(['stun:turn.kithmoot.example:3478'])).toBe(false)
    expect(isDefaultIceUrls(['turn:turn.kithmoot.example:3478'])).toBe(false)
  })

  it('keeps a room that named Google’s STUN server alongside another server', () => {
    expect(isDefaultIceUrls(['stun:stun.l.google.com:19302', 'stun:turn.kithmoot.example:3478'])).toBe(false)
  })
})
