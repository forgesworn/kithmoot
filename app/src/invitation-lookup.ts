/**
 * Where to look for a group invitation the link's own relays no longer hold.
 *
 * A persistent link names the relays its invitation was published to when
 * the link was made. Public relays drop that event within days, and a room
 * that has since moved, or a creator who re-signs it on the room's current
 * relays, leaves the copy somewhere the link does not point. A person who
 * added one of those relays by hand got straight in, so the door now asks the
 * relays this device already uses, and the app's defaults, before saying the
 * invitation cannot be found.
 *
 * Harmless to ask anywhere: the invitation is signed by the link's inviter key
 * and encrypted to the link, so whichever relay answers cannot forge or read
 * it. A retirement notice found there still wins, as it does on the link's own
 * relays. The one place this never goes is out of a sheltered room: a link
 * that names a circle relay was kept off public relays on purpose.
 */

/** The admission failed because no relay asked had the invitation, not
 *  because it was retired, ended or malformed. */
export function isMissingInvitation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /group invitation (is not available on|could not be loaded from) its relays/.test(message)
}

function relayKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Relays worth asking after the link's own: this device's, then the app's
 * defaults, without the link's relays or any circle relay, and none at all
 * for a link that names a circle relay.
 */
export function widerInvitationRelays(
  link: readonly string[],
  own: readonly string[],
  defaults: readonly string[],
  isCircle: (url: string) => boolean,
): string[] {
  if (link.some(isCircle)) return []
  const seen = new Set(link.map(relayKey))
  const wider: string[] = []
  for (const url of [...own, ...defaults]) {
    const key = relayKey(url)
    if (seen.has(key) || isCircle(url) || !/^wss?:\/\//.test(key)) continue
    seen.add(key)
    wider.push(url)
  }
  return wider
}

/** The relays a link names that the room no longer uses, where a re-signed
 *  invitation also has to go so older copies of the link still find it.
 *  Circle relays are left to the room's own connection, which can
 *  authenticate to them. */
export function linkOnlyRelays(room: readonly string[], link: readonly string[], isCircle: (url: string) => boolean): string[] {
  const seen = new Set(room.map(relayKey))
  const out: string[] = []
  for (const url of link) {
    const key = relayKey(url)
    if (seen.has(key) || isCircle(url)) continue
    seen.add(key)
    out.push(url)
  }
  return out
}
