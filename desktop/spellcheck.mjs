/**
 * Spelling without Google.
 *
 * On Windows and Linux, Electron's built-in spellchecker fetches Hunspell
 * dictionaries from Google (redirector.gvt1.com) as soon as a session
 * starts, whatever a window's `spellcheck` preference says: a fresh 0.1.89
 * on Linux did so in its first second. KithMoot does not contact Google, so
 * on those platforms each session gets spelling switched off, no languages,
 * and a download address on this machine at a port Chromium refuses to
 * open, so nothing can reach Google even if a dictionary is asked for later.
 * macOS uses its own spellchecker, which downloads nothing.
 * See docs/decisions.md, "Nothing goes to Google", 19 October 2026.
 */

/** Port 9 (discard) is on Chromium's restricted list: a request to it fails
 *  before any connection is made. */
export const NO_DICTIONARY_DOWNLOAD = 'http://127.0.0.1:9/'

/** True where Electron spells with the operating system's own checker. */
export const usesSystemSpellchecker = (platform = process.platform) => platform === 'darwin'

/** Apply to every session before a window uses it. A no-op on macOS. */
export function keepSpellingLocal(ses, platform = process.platform) {
  if (usesSystemSpellchecker(platform)) return false
  ses.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_DOWNLOAD)
  ses.setSpellCheckerLanguages([])
  ses.setSpellCheckerEnabled(false)
  return true
}
