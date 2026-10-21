import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { LookupScope } from './profiles.js'

/**
 * Who a public-profile lookup is allowed to ask about, and where, as rules
 * with no DOM in them. `profiles.ts` says what a lookup hands a relay; this
 * decides which lookups are made at all and which relays hear them.
 *
 * Two rules, both about keeping a relay from learning more than it must:
 *
 * - A key this browser made for itself is never looked up. A name-only visit
 *   uses a key generated here, which has no public profile to find, and the
 *   question would tell the room's relays the participant key that the
 *   room's own events keep inside the ciphertext.
 * - The account signed in on this browser is only ever asked about on the
 *   public profile relays, never on a room's.
 */

/**
 * Whether a key is one this browser generated for a name-only visitor.
 * Remembers what it derived, because this runs on every render and
 * deriving a public key is the dear part.
 *
 * `stored` is the hex of the participant key kept on this device, or
 * nothing. What counts as made here is that key alone:
 *
 * - A signed-in account's key is not. It is the person's real Nostr key and
 *   may have a public profile, so it is looked up like anyone's. (A browser
 *   that was name-only before the person signed in still holds the old key;
 *   that key is still made here, and the account's is still not.)
 * - The per-room account pass (`accountPassForRoom` in main.ts) is not.
 *   That function returns a pass only when `pass.pubkey` equals
 *   `expectedAccount`, the account last signed in on this browser, so the
 *   pass's key is the real account key under a credential the account
 *   signed for this room's device key. Nothing it names is ever a
 *   participant, and the account key has the same profile whether or not
 *   its signer is connected at the moment.
 * - The per-room device key (`deviceKey`) is made here but is never a
 *   participant, so it is never asked about and needs no rule.
 */
export function createMadeHere(stored: () => string | null | undefined): (pubkey: string) => boolean {
  let derivedFrom: string | undefined
  let derived: string | undefined
  return pubkey => {
    let hex: string | null | undefined
    try { hex = stored() } catch { return false }
    if (!hex) return false
    if (hex !== derivedFrom) {
      try {
        derived = getPublicKey(hexToBytes(hex))
        derivedFrom = hex
      } catch {
        // A value that is not a key is not one we made.
        derived = undefined
        derivedFrom = undefined
        return false
      }
    }
    return derived === pubkey
  }
}

/** Where each of these keys is to be asked about. */
export interface RoutedLookups { room: string[]; public: string[] }

/**
 * Split a request into what may be asked, and on which relays.
 *
 * Keys made here are dropped. The account's own key goes to the public
 * relays whatever the caller asked for: it is who this browser is, not who
 * is in the room, and a room's relays would otherwise learn from this
 * browser, which they are connected to, which Nostr account it belongs to.
 * With no room open there is no room to ask, so a `room` request goes to the
 * public relays too: a room's pool built for nowhere would otherwise be
 * pointed at the wrong relays when a room does open. Everyone else is asked
 * about as the caller said.
 */
export function routeLookups(
  pubkeys: readonly string[],
  scope: LookupScope,
  rules: { madeHere(pubkey: string): boolean; isAccount(pubkey: string): boolean; roomOpen: boolean },
): RoutedLookups {
  const routed: RoutedLookups = { room: [], public: [] }
  const inRoom = scope === 'room' && rules.roomOpen
  for (const pubkey of new Set(pubkeys)) {
    // Checked first: whatever key a person has signed in with is a real
    // account, even if the same bytes were once generated here.
    const account = rules.isAccount(pubkey)
    if (!account && rules.madeHere(pubkey)) continue
    routed[inRoom && !account ? 'room' : 'public'].push(pubkey)
  }
  return routed
}

/** The hosts a lookup would ask, once each and in the order given, for the
 *  sentence that names them. A URL that does not parse is left out: the
 *  pool would refuse it too. */
export function lookupHosts(urls: readonly string[]): string[] {
  const hosts: string[] = []
  for (const url of urls) {
    let host: string
    try { host = new URL(url).host } catch { continue }
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/** Hosts as a sentence fragment: "a", "a and b", "a, b and c". */
export function hostList(hosts: readonly string[]): string {
  if (hosts.length < 2) return hosts.join('')
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`
}
