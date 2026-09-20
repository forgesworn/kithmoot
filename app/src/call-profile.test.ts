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

/** A device that has opened the app before, in a tab that has not. */
function device(initial: Record<string, string> = {}) {
  return { local: storage(initial), session: storage() }
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

  it('honours a stored off switch, and ignores a stored on one', () => {
    // Nothing writes a durable `2` any more; one left by an older build must
    // not keep a device on it silently.
    expect(readCallProfile('', storage({ [CALL_PROFILE_KEY]: '1' }))).toBe(1)
    expect(readCallProfile('', storage({ [CALL_PROFILE_KEY]: '2' })), 'a durable on switch was honoured').toBe(1)
  })

  it('honours this page session\'s own switch', () => {
    expect(readCallProfile('', storage(), storage({ [CALL_PROFILE_KEY]: '2' }))).toBe(2)
  })

  it('honours the query and keeps it for this page session, so a reload keeps the answer', () => {
    // The app reloads itself when a room link differs only in its fragment,
    // and a switch that did not survive that would be a switch that worked
    // once.
    const d = device()
    expect(readCallProfile('?callProfile=2', d.local, d.session)).toBe(2)
    expect(readCallProfile('', d.local, d.session)).toBe(2)
  })

  it('BUG: a forwarded room link does not turn it on for a device for good', () => {
    // "join us" goes into a group chat and is opened by everybody. A
    // `?callProfile=2` on the end of it must not leave every one of those
    // devices negotiating differently for ever, origin-wide, with nothing on
    // screen to say so and no way to undo it.
    const d = device()
    expect(readCallProfile('?callProfile=2', d.local, d.session)).toBe(2)
    expect(d.local.held.has(CALL_PROFILE_KEY), 'the shared link wrote a durable switch').toBe(false)

    // A new tab of the same browser: same device, same origin, no memory of
    // somebody else's link.
    const later = { local: d.local, session: storage() }
    expect(readCallProfile('', later.local, later.session)).toBe(1)
  })

  it('lets the query turn it off again, and that one is remembered for good', () => {
    // The asymmetry is the point: off is somebody saying "not on my device",
    // and it must not need saying twice.
    const d = device()
    readCallProfile('?callProfile=2', d.local, d.session)
    expect(readCallProfile('?callProfile=1&room=x', d.local, d.session)).toBe(1)
    expect(d.local.held.get(CALL_PROFILE_KEY)).toBe('1')

    const later = { local: d.local, session: storage() }
    expect(readCallProfile('', later.local, later.session)).toBe(1)
    // And it beats a link that tries to turn it back on... for the device,
    // not for the page: an explicit link is still an explicit ask.
    expect(later.local.held.get(CALL_PROFILE_KEY)).toBe('1')
  })

  it('ignores anything that is not exactly 1 or 2', () => {
    for (const value of ['0', '3', '2.0', 'two', '', ' 2', 'true']) {
      expect(readCallProfile(`?callProfile=${encodeURIComponent(value)}`, storage(), storage()), value).toBe(1)
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
    expect(readCallProfile('?callProfile=2', refusing, refusing)).toBe(2)
    expect(readCallProfile('', refusing, refusing)).toBe(1)
  })
})
