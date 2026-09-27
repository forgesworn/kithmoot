import type { RoomPolicy } from '../../src/index.js'

/**
 * Where public-profile lookups run, as a rule with no DOM in it.
 *
 * A lookup is a plaintext query naming the keys of the people in a room
 * (see `profiles.ts` for what that hands a relay). In an open room that is
 * the price of faces, and the person's own switch decides it. A room with
 * a member list, a direct message or a quiet conversation, exists to keep
 * who is in it from the relays, so there the lookup waits for a second
 * switch that starts off. The same rule covers the person's own key: a key
 * this browser made has no profile to find, and asking for one only tells
 * the relays which key is about to walk into the room.
 */
const MEMBER_ROOMS_KEY = 'kithmoot.profiles.memberRooms'

/** Whether a room names its members, which is what a direct message and a
 *  quiet conversation both do. */
export function hasMemberList(policy: RoomPolicy | undefined): boolean {
  return Array.isArray(policy?.members) && policy.members.length > 0
}

/** Whether lookups run in a room with this policy, or outside any room
 *  when there is none. */
export function lookupsAllowed(opts: { enabled: boolean; inMemberRooms: boolean; policy: RoomPolicy | undefined }): boolean {
  if (!opts.enabled) return false
  return opts.inMemberRooms || !hasMemberList(opts.policy)
}

/** Off unless the person turned it on: only the exact saved word counts. */
export function memberRoomsPreference(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(MEMBER_ROOMS_KEY) === 'true' } catch { return false }
}

export function saveMemberRoomsPreference(storage: Pick<Storage, 'setItem'>, enabled: boolean): void {
  try { storage.setItem(MEMBER_ROOMS_KEY, String(enabled)) } catch { /* The switch still applies to this visit. */ }
}

/** The hosts a lookup would ask, once each and in the order given, for
 *  the sentence that names them. A URL that does not parse is left out:
 *  the pool would refuse it too. */
export function lookupHosts(urls: readonly string[]): string[] {
  const hosts: string[] = []
  for (const url of urls) {
    let host: string
    try { host = new URL(url).host } catch { continue }
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}
