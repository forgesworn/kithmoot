/**
 * "Open in the KithMoot app" on the web join screen.
 *
 * Someone who scans an invitation QR on Android lands in the browser. The
 * Android app registers the `kithmoot://` scheme (any host, any path) and
 * reads the room from the URL's fragment, so the same payload behind a
 * `kithmoot://join` base reaches it unchanged.
 */

/** Where the Android download lives. */
export const ANDROID_DOWNLOAD_URL = 'https://kithmoot.app/#android'

/** `join` is the host the app's own links use; `signet` is reserved for sign-in returns. */
const APP_BASE = 'kithmoot://join'

/** Whether a user agent is Android. The button is pointless anywhere else. */
export function isAndroidUserAgent(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent)
}

/**
 * The `kithmoot://` form of a web join link, keeping its query and fragment
 * byte for byte. `undefined` when the link carries no fragment, because the
 * app ignores a link with no room in it.
 */
export function appLinkFor(webLink: string): string | undefined {
  let url: URL
  try {
    url = new URL(webLink)
  } catch {
    return undefined
  }
  if (url.hash.length <= 1) return undefined
  return `${APP_BASE}${url.search}${url.hash}`
}
