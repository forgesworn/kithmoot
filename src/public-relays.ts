import { isForgeSwornHost } from './forgesworn-hosts.js'

/**
 * The public relays KithMoot suggests, and the three new devices start on.
 *
 * Exported verbatim to `data/public-relays.json`; a unit test fails if the two
 * differ by a byte. Reviewed product data, changed on a release schedule, not
 * a protocol vector.
 *
 * An entry qualifies only if, on its `checked` date:
 *  1. It is run by someone other than ForgeSworn or its maintainers (no host
 *     under `forgesworn.dev` or `kithmoot.app`; the release checklist covers
 *     the owner's own relays).
 *  2. Its relay information (NIP-11) names a contact or an operator pubkey.
 *  3. It is free: no `payment_required`, and no sign-in (`auth_required`) to
 *     read or write kinds 1460, 1462 and 1463.
 *  4. It supports NIP-40 expiry, which ended rooms rely on.
 *  5. It answered from a UK home line with connect and EOSE both under 2 s,
 *     on two tries.
 *  6. It is a general relay that keeps any kind. A profile-only relay does
 *     not qualify.
 *  7. `test: 'round-trip'` means a throwaway key published one event each of
 *     1460, 1462, 1463 and 1059 (and 20462), each with a NIP-40 expiry,
 *     read them back by id and removed them with a NIP-09 deletion. Until
 *     then `test: 'read'`: the relay held at least one event of each room
 *     kind.
 *
 * List rules: at most six entries; exactly three defaults, from three
 * operators on three hosts; at least two entries with `quietRooms`, one of
 * them a default.
 *
 * Checked again on 30 October 2026 from a UK home line, read only, with a
 * second UK line (a server) for reachability. relay.primal.net,
 * relay.ditto.pub and offchain.pub passed 1 to 6 and became the defaults.
 * nostr.oxtr.dev stopped being a default: it dropped connections from the
 * home line while answering the server. relay.damus.io refused the home line
 * with HTTP 503 and relay.snort.social closed its TLS; that pattern, an IP
 * that had sent too much, is what the client changes of that date address.
 * nos.lol, nostr.mom, relay.nostr.band and relay.nostr.net answered neither
 * line. nostr-pub.wellorder.net took 2.6 s once (criterion 5); it does name
 * an operator pubkey. nostr.data.haus is the first to round-trip test.
 *
 * Checked on 21 October 2026 from the UK and from Germany. Left out:
 *  - nos.lol and nostr.mom: unreachable on 21 October, and one host.
 *  - relay.nostr.net: a default for a few hours on 21 October, until it
 *    stopped answering from the UK and from Germany.
 *  - nostr-pub.wellorder.net: its relay information names no contact.
 *  - nostr.bitcoiner.social: answered in 3.2 and 3.5 s; only gift wraps seen.
 *  - nostr.data.haus and relay.angor.io: only gift wraps seen; angor names no
 *    contact.
 *  - nostr.wine, nostr.land and nostr21.com: paid or sign-in.
 *  - relay.snort.social, relay.0xchat.com and relay.nostr.band: unreachable
 *    or errored.
 *  - purplepag.es: profiles only. The app still asks it for profiles.
 *
 * offchain.pub is a default from 30 October 2026 but not marked for quiet
 * rooms: it refused a stranger's gift wrap on 25 September 2026, and the
 * write test decides.
 *
 * relay.damus.io is removed on 1 November 2026: after refusing the home line
 * with HTTP 503 on 30 October it escalated to banning writes from the address
 * outright ("banned: too many rate-limit violations"), clearing only when the
 * caller changed network address. A suggestion list cannot point at a relay
 * that bans the read/write pattern the list is for (criteria 3 and 5). The
 * app also stops asking it for profiles and prunes it from saved device
 * choices and room hints at use time; see app/src/relay-settings.ts.
 */
export interface PublicRelay {
  /** Canonical, `wss://host/`. */
  readonly url: string
  /** As its relay information (NIP-11) names it. */
  readonly operator: string
  /** One of the relays new devices start on. */
  readonly default: boolean
  /** Held and served kind 1059 without sign-in. */
  readonly quietRooms: boolean
  /** Measured retention band, when measured. */
  readonly keeps?: 'under-a-day' | 'days' | 'week-or-more'
  /** What the last check did. */
  readonly test: 'read' | 'round-trip'
  /** ISO date the last check passed. */
  readonly checked: string
}

const ENTRIES: PublicRelay[] = [
  { url: 'wss://relay.primal.net/', operator: 'Primal Public Relay', default: true, quietRooms: true, keeps: 'under-a-day', test: 'read', checked: '2026-10-30' },
  { url: 'wss://relay.ditto.pub/', operator: 'Ditto Relay', default: true, quietRooms: true, test: 'read', checked: '2026-10-30' },
  { url: 'wss://offchain.pub/', operator: 'offchain.pub', default: true, quietRooms: false, test: 'read', checked: '2026-10-30' },
  { url: 'wss://nostr.oxtr.dev/', operator: '0xtr relay', default: false, quietRooms: true, test: 'read', checked: '2026-10-21' },
]

export const PUBLIC_RELAYS: readonly PublicRelay[] = Object.freeze(ENTRIES.map(relay => Object.freeze(relay)))

export const DEFAULT_PUBLIC_RELAYS: readonly PublicRelay[] = Object.freeze(PUBLIC_RELAYS.filter(relay => relay.default))

/** True when a relay URL is on one of ForgeSworn's own hosts. */
export function isForgeSwornRelay(url: string): boolean {
  return isForgeSwornHost(url.replace(/^wss?:/i, 'https:'))
}
