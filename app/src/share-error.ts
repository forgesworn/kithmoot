/**
 * What to tell somebody whose screen share did not start.
 *
 * Chromium's own messages are written for developers. "Invalid capture
 * constraints" is what the desktop app gets on a Mac when the Screen
 * Recording permission is missing or stale - and it goes stale on every
 * update of an ad-hoc signed build, because the stored grant is tied to an
 * identity the new build no longer has. Nobody can act on the raw words, so
 * they are swapped for the steps that fix it, and kept aside for a bug
 * report.
 *
 * No DOM, so it can be tested without a browser.
 */

export const SCREEN_PERMISSION_ADVICE =
  'Your computer did not allow screen sharing. On a Mac: System Settings, Privacy & Security, Screen Recording: ' +
  'remove KithMoot with the minus button, add it back, then quit and reopen KithMoot.'

export interface ShareErrorText {
  /** What the page shows. */
  plain: string
  /** The browser's own words, for a bug report. Empty when they are the same as `plain`. */
  raw: string
}

function rawOf(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message }
  if (typeof err === 'object' && err !== null) {
    const { name, message } = err as { name?: unknown; message?: unknown }
    return { name: typeof name === 'string' ? name : '', message: typeof message === 'string' ? message : String(err) }
  }
  return { name: '', message: String(err) }
}

/** Whether the operating system, rather than the person, refused the capture. */
export function isSystemRefusal(err: unknown): boolean {
  const { name, message } = rawOf(err)
  if (/invalid capture constraints/i.test(message)) return true
  // Chromium's wording when the OS denies it outright, as opposed to the
  // person pressing Cancel in the picker ("Permission denied").
  return name === 'NotAllowedError' && /by system/i.test(message)
}

export function describeShareError(err: unknown): ShareErrorText {
  const { message } = rawOf(err)
  if (isSystemRefusal(err)) return { plain: SCREEN_PERMISSION_ADVICE, raw: message }
  return { plain: message, raw: '' }
}
