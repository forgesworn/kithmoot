import type { Event } from 'nostr-tools/pure'
import { encodeShortNodeRoomLink } from '@forgesworn/fold-kit/node-room'

/**
 * The short-link page beside the app at `appBase` (app/short-link-page.ts,
 * served at /n/). Short links point there rather than at the app, so a reader
 * from before link version 7 still opens them: the page hands the app the
 * long form.
 */
export function shortLinkPageFor(appBase: string): string {
  return new URL('../n/', appBase).href
}

/**
 * The link a person copies, shares or scans from the invite page. With
 * `shortPage`, a node room's is the short form (link version 7) on that page:
 * the same signed record in about a quarter of the length. Without it, or for
 * any other room, it is `long`. Everything a device keeps, syncs, sends to
 * another device or puts in the address bar stays long, so a device that
 * predates version 7 can still read it. A record the short encoder cannot
 * rebuild byte for byte keeps its long link.
 */
export function shareableRoomLink(shortPage: string | undefined, node: Event | undefined, now: number, long: () => string): string {
  return shortPage && node ? encodeShortNodeRoomLink(shortPage, node, now) : long()
}
