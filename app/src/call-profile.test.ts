/**
 * The kill switch: step S12 of the call reliability design.
 *
 * The default is the whole point of this file. Profile 2 changes how every
 * pair of new clients negotiates, and a change to a call that can only be
 * undone by shipping is not a change anybody should make on a Friday. Off
 * unless somebody says otherwise, and one reload back to exactly what every
 * client from before today speaks.
 */

import { describe, it, expect } from 'vitest'
import { readCallProfile, CALL_PROFILE_KEY } from './call-profile.js'

function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial))
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
  }
}

describe('which call profile this device advertises', () => {
  it('is profile 1 when nobody has said anything', () => {
    expect(readCallProfile('', storage())).toBe(1)
    expect(readCallProfile('?room=x', storage())).toBe(1)
  })

  it('is profile 1 with no storage at all', () => {
    // A private window, or a browser with site data blocked. The default is
    // the safe one, so there is nothing to fall back to.
    expect(readCallProfile('')).toBe(1)
  })

  it('honours the stored switch', () => {
    expect(readCallProfile('', storage({ [CALL_PROFILE_KEY]: '2' }))).toBe(2)
    expect(readCallProfile('', storage({ [CALL_PROFILE_KEY]: '1' }))).toBe(1)
  })

  it('honours the query and remembers it, so a reload keeps the answer', () => {
    // The app reloads itself when a room link differs only in its fragment,
    // and a switch that did not survive that would be a switch that worked
    // once.
    const store = storage()
    expect(readCallProfile('?callProfile=2', store)).toBe(2)
    expect(store.held.get(CALL_PROFILE_KEY)).toBe('2')
    expect(readCallProfile('', store)).toBe(2)
  })

  it('lets the query turn it off again, which is the point of it', () => {
    const store = storage({ [CALL_PROFILE_KEY]: '2' })
    expect(readCallProfile('?callProfile=1&room=x', store)).toBe(1)
    expect(store.held.get(CALL_PROFILE_KEY)).toBe('1')
  })

  it('ignores anything that is not exactly 1 or 2', () => {
    for (const value of ['0', '3', '2.0', 'two', '', ' 2', 'true']) {
      expect(readCallProfile(`?callProfile=${encodeURIComponent(value)}`, storage()), value).toBe(1)
    }
    expect(readCallProfile('', storage({ [CALL_PROFILE_KEY]: 'yes' }))).toBe(1)
  })

  it('still honours the query when the browser refuses to remember it', () => {
    const refusing = {
      getItem: () => {
        throw new Error('site data blocked')
      },
      setItem: () => {
        throw new Error('site data blocked')
      },
    }
    expect(readCallProfile('?callProfile=2', refusing)).toBe(2)
    expect(readCallProfile('', refusing)).toBe(1)
  })
})
