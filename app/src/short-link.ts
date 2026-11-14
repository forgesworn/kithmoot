import { longNodeRoomLink } from '@forgesworn/fold-kit/node-room'

/**
 * Where the short-link page at /n/ sends the browser.
 *
 * A short (version 7) node-room link is about a quarter the length of the
 * version 6 one, which matters to chat apps and QR codes, but a reader from
 * before version 7 cannot open it: an Android app up to 0.6.150 says the room
 * could not be opened, and a browser still running a cached copy of the web
 * app calls it incomplete. This page is outside the app, so no service worker
 * answers it and no app link claims it. It rebuilds the version 6 link that
 * every reader understands and hands that to the app at /j/, beside it.
 *
 * Only an open room is rebuilt. Anything else, an ended link, one signed
 * ahead of this device's clock, a long link or no link at all, goes on to the
 * app unchanged, so the app's own door says what is wrong with it.
 */
export function appLinkForShort(href: string, now: number): string {
  const here = new URL(href)
  const app = new URL('../j/', here)
  app.search = here.search
  app.hash = here.hash
  return longNodeRoomLink(app.href, now) ?? app.href
}
