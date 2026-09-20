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
 * The query wins over storage, and **only the off value is remembered**.
 *
 * That asymmetry is the whole of the rule, and it is about who chose. A room
 * link is a thing people forward: "join us" goes into a group chat and is
 * opened by everybody, and a `?callProfile=2` on the end of it would then
 * turn a different negotiation on for every one of those devices, for this
 * origin, permanently, with nothing on screen to say so and nothing to undo
 * it with. Nobody chose that; one person pasted a link. So turning it **on**
 * lasts as long as the page session that asked - a reload of the same tab
 * keeps it, a new tab does not, closing the browser ends it - and turning it
 * **off** is remembered for good, because that one is somebody saying "not
 * this, not on my device", and it must not need saying twice.
 *
 * Storage that throws (a private window, blocked site data) is simply
 * absent: the default is the safe one, so there is nothing to fall back to.
 */
export function readCallProfile(search: string, storage?: CallProfileStorage, session?: CallProfileStorage): CallProfile {
  const asked = ask(search)

  if (asked === 1) {
    // Remembered, and remembered in the durable place: an off switch that
    // had to be set again on the next visit would not be an off switch.
    write(storage, '1')
    write(session, '1')
    return 1
  }

  if (asked === 2) {
    // This page session only. Kept so the reload the app does when it
    // re-reads a room fragment does not drop it mid-join.
    write(session, '2')
    return 2
  }

  // Nothing asked: an explicit off is durable, an on is only ever this page
  // session's.
  if (read(storage) === 1) return 1
  return read(session) ?? 1
}

/** `localStorage` and `sessionStorage` both satisfy this, and so does a test
 *  double. Both are optional everywhere: a browser may refuse either. */
export type CallProfileStorage = Pick<Storage, 'getItem' | 'setItem'>

function read(storage: CallProfileStorage | undefined): CallProfile | undefined {
  try {
    return parse(storage?.getItem(CALL_PROFILE_KEY))
  } catch {
    return undefined
  }
}

function ask(search: string): CallProfile | undefined {
  try {
    return parse(new URLSearchParams(search).get(CALL_PROFILE_PARAM))
  } catch {
    return undefined
  }
}

function write(storage: CallProfileStorage | undefined, value: string): void {
  try {
    storage?.setItem(CALL_PROFILE_KEY, value)
  } catch {
    // A browser that will not remember it still honours it for this page,
    // which is all a one-off diagnosis needs.
  }
}
