import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

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
