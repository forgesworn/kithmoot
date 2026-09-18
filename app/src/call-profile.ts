/**
 * The call signalling profile this build advertises, and the switch that
 * turns it off again.
 *
 * Profile 2 - fixed media slots, the reliable signal channel, pair
 * generations and the health ladder - is **off by default**, deliberately.
 * It changes how every pair of new clients negotiates, and the one thing a
 * call cannot afford is a change that can only be undone by shipping. So the
 * answer to a bad day is a reload: `?callProfile=1` in the address bar, or
 * `kithmoot.callProfile` in this browser's storage, and the device is back to
 * exactly what every client from before today speaks.
 *
 * The far end's own claim still governs the pair. This only says what this
 * device advertises about itself; §2.3's rule is that both roster entries
 * have to say `callProfile: 2` before a pair uses any of it, so one person
 * turning it on can never change anybody else's call.
 *
 * Kept as its own module with no imports so the rule can be tested as a
 * function rather than through a page.
 */

/** Where the switch is remembered between page loads. */
export const CALL_PROFILE_KEY = 'kithmoot.callProfile'

/** The query parameter that sets it, for tests and for a person being talked
 *  through a bad call over the phone. */
export const CALL_PROFILE_PARAM = 'callProfile'

/** Only these two. Anything else - a typo, a hostile link, a value from an
 *  older build - is read as "not set". */
export type CallProfile = 1 | 2

function parse(value: string | null | undefined): CallProfile | undefined {
  if (value === '1') return 1
  if (value === '2') return 2
  return undefined
}

/**
 * What this device should advertise, given a URL and a storage.
 *
 * The query wins over storage and is remembered, so a link someone was sent
 * survives the reload the app does when it re-reads a room fragment - and so
 * that turning it off stays off without anybody having to keep the URL.
 * Storage that throws (a private window, blocked site data) is simply
 * absent: the default is the safe one, so there is nothing to fall back to.
 */
export function readCallProfile(search: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): CallProfile {
  let stored: CallProfile | undefined
  try {
    stored = parse(storage?.getItem(CALL_PROFILE_KEY))
  } catch {
    stored = undefined
  }

  let asked: CallProfile | undefined
  try {
    asked = parse(new URLSearchParams(search).get(CALL_PROFILE_PARAM))
  } catch {
    asked = undefined
  }

  if (asked !== undefined && asked !== stored) {
    try {
      storage?.setItem(CALL_PROFILE_KEY, String(asked))
    } catch {
      // A browser that will not remember it still honours it for this page,
      // which is all a one-off diagnosis needs.
    }
  }

  return asked ?? stored ?? 1
}
