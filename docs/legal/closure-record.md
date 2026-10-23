# KithMoot closure record

What ForgeSworn ran for KithMoot users, when it stopped, and where that
leaves ForgeSworn. Drafted on 22 October 2026 from the repository at
`d04f0dd3` and the report of the session that runs the box. Not legal
advice; no lawyer has read it. The law is in jurisdiction-kit's
`law/gb/online-services.md`, verified 28 September 2026; its evidence marks
are carried here: `[P]` primary source read, `[S]` secondary, `[U]`
unchecked. Where a fact rests on the host's report and not on the
repository, it says so.

Updated 23 October 2026 for the private call relay and the access-facility
distinction in law note 2.11, primary sources read on that date. The original
public services' closure history is preserved. See
[`call-transport-position.md`](call-transport-position.md) for the current
deployment and the future design; those are separate from the closures below.

## 1. What ForgeSworn ran

From 24 August 2026 ForgeSworn ran default infrastructure on
`kithmoot.forgesworn.dev` that anybody loading the app could reach. The
launch date is the owner's statement; it matches the repository, where the
deploy kit for a default TURN server and app hosting, and the TURN
credential service, were both committed on 24 August 2026.

| Surface | What it did |
| --- | --- |
| TURN credentials, `GET /turn`, and the TURN server | Minted a short-lived call relay credential for anyone who asked, and relayed calls |
| STUN | Told a device its own public address, on the same server as TURN |
| File store (Blossom) | Took encrypted uploads from any signing key; served them by hash, on the public host and a read-only onion front; until 23 October 2026 also from two mirror nodes on the owner's own machines, which served them by hash over Tor |
| Meeting codes, `/codes` | Stored room links behind short codes |
| Drop tier, `/drops` | Held sealed messages for later delivery |
| A relay | Was a default relay until September 2026 |
| Keepers | Room creators run on the box, holding their rooms' keys. Whose rooms is not known (section 3) |

## 2. What closed, and when

| Date | What | Evidence |
| --- | --- | --- |
| September 2026 | The relay ForgeSworn also runs stopped being a default | Release notes on the site; exact date not checked |
| 21 October 2026 | `/drops` no longer fronted; the tier runs on the box's loopback only | `deploy/Caddyfile.kithmoot` on `main` has no `/drops` route; loopback-only is the host's report |
| 22 October 2026 | New file uploads and `/codes` answer 410 Gone; the meeting code service stopped | Host's report; `deploy/Caddyfile.kithmoot` on `main` since PR #526 |
| 22 October 2026 | The relay ForgeSworn also runs closed to an allowlist of keys held for project work, reads and writes, behind relay authentication (NIP-42). One exception: anybody may send a sealed message or a remote-signer request addressed only to those keys, so the project can be contacted; strangers cannot read anything or reach each other | Host's report; exception checked against the live write policy 23 October 2026 |
| 22 October 2026, about 16:40 UTC | `/turn` and stored-file reads, including the onion front on ForgeSworn's host, answer 410 Gone; the TURN credential and file store services disabled | Checked from outside: `/turn` and `/blossom/<hash>` answer 410. `deploy/Caddyfile.kithmoot` on `main` since PR #534 |
| 22 October 2026, about 18:30 UTC | The TURN server's KithMoot secret removed, so no credential minted for KithMoot works any more; the stored files moved off the live data path into a trash folder on the box | Host's report |
| 22 October 2026, about 19:40 UTC | The trash folder emptied: the stored files and the meeting-code store deleted | Host's report |
| 23 October 2026, about 01:45 UTC | The two archive nodes on the owner's own machines, which mirrored the file store over Tor, stopped with the jobs that fed them; their copies, 86 encrypted files of about 170 MB on each, deleted | Checked on both machines: the nodes answered an unauthenticated read by hash until they stopped; their data folders were moved to the trash at about 01:45 UTC and the trash emptied by about 01:58 UTC on both machines |

Clients: Android 0.6.103 stops asking ForgeSworn's host for a TURN
credential and retires a stored ForgeSworn file server
(`docs/android-production-publication.md`). PR #525, merged and deployed on
22 October 2026, tells people that ForgeSworn-held files are gone; desktop
0.1.100, cut from it, was released the same day.

## 3. What remains

- **Stored files.** Deleted on 22 October 2026: the 84 encrypted blobs,
  about 164 MB. The archive nodes' copies, 86 files, two more than the
  store held when it closed, were deleted on 23 October 2026 (section 2).
  ForgeSworn holds no copy on its server or in the nodes' data folders.
  Copies remain only in the owner's encrypted, offline machine backups,
  which serve nothing and are kept by the owner's decision of 23 October
  2026: Time Machine cannot delete one folder from a backup, only whole
  backups.
- **The former public STUN listener.** It stopped on 23 October 2026.
  A host readback on that date found the legacy coturn container exited and
  no listener on 3478. Older clients, including Android through 0.6.105
  and desktop through 0.1.101, may still name that former listener. Desktop
  0.1.102 and Android 0.6.106 move those defaults to Cloudflare; a web
  deploy does not update the desktop app's bundled copy. Current web and Android source names
  Cloudflare STUN unless the device or room selects another server
  (`src/ice-defaults.ts`, Android `media/CallIceServers.kt`). This is not a
  claim that every installed release has updated. STUN handles address
  discovery and IP metadata; its legal classification needs the separate
  service/access-facility analysis in law note 2.11, not an automatic
  provider conclusion.
- **The private call relay.** A distinct authenticated instance remains
  running for an arranged personal call, with two accounts and no coturn or
  container logs. It is not a public application default or a public
  credential issuer. Its existence and unresolved operator-capacity input
  are recorded in `call-transport-position.md`; closure of the former public
  service did not close this private instance.
- **Same-origin calls in the apps.** Closed by PR #541, merged on 23 October 2026. The web app
  asks for `/turn` or `/codes` only when its build names an endpoint
  (`VITE_TURN_CREDENTIAL_ENDPOINT`, `VITE_MEETING_CODES_BASE`), and
  ForgeSworn's builds name none. `kithmoot-agent` asks for TURN only when
  `KITHMOOT_TURN_ENDPOINT` names one. Meeting code links use the deployer's
  own join page, not a ForgeSworn address, and the code service accepts only
  the origins its operator names. The code stays as software for people
  who deploy KithMoot themselves.
- **Keepers on the box.** None runs. The two the box held, for the
  operator's own rooms, were retired on 4 September 2026 and their state
  is kept on the box only (host's report).
- **Meeting code data.** The service is stopped and disabled. Its store of
  room links, about 1 KB, was deleted on 22 October 2026.
- **The drop tier** still runs on the box's loopback. Whether anything
  other than the box can reach it was not checked.
- **The app and the update check.** `kithmoot.forgesworn.dev` still serves
  the web app as static files, and the desktop app checks it for updates.
  Neither lets one user's content reach another.

ForgeSworn's own services that are not for KithMoot users, including the
relay above, are out of scope here. That relay is closed to keys held for
project work, except that strangers may send sealed messages addressed only
to those keys; it is treated as the project's inbox, not a service to the
public (jurisdiction-kit `gb/online-services` 2.12, a reading that is not
settled).

**Contact.** `abuse@safety.forgesworn.dev` stays as the contact for anything
about data ForgeSworn still holds, such as a request to delete a stored
file by its hash. It is not a reporting route for a live service.

## 4. Where ForgeSworn stands now

**Aimed at: a publisher of software, with defaults that point only at
servers other people run.** The apps' default relays and default public
file server are run by others. Each operator's service and infrastructure
roles need their own scope analysis (law note 2.2 and 2.11, a reading,
`[U]`). Somebody who installs and runs the software controls their own
deployment; that fact alone does not classify it as a regulated service.
Publishing
general-purpose software does not make the publisher a party to what
others do with it (law note 6.1, Serious Crime Act 2007 sections 44, 45
and 50, `[P]`). The privacy notice still owes an account of the third
parties the defaults contact (law note 3.2).

**Today:** the public software's defaults use independent infrastructure,
with older installed releases potentially naming retired services. A separate
private authenticated call relay remains (section 3). Its operator's capacity
must be recorded before asserting a household-use position for it.

## 5. Historical assessment timetable

While ForgeSworn ran these surfaces for strangers it took the cautious
reading: that what it ran could be a user-to-user service with UK links
(law note 2.1) and that it was the provider of it (2.2).

A new service owes its illegal content risk assessment three months after
launch (law note 2.4, `[P]`) and its children's access assessment on the
same timetable (2.4, `[S]`). From 24 August 2026 both fell due on 24
November 2026. The last open surface, the mirror nodes' onion fronts,
closed on 23 October 2026, before that date.

Reading: a service that stops being provided before its deadline owes no
assessment for it. `[U]`: the law note has no source on a service that
closes before its deadline. This is not a finding that no duty applied
while it ran. The drafts in [`archive/`](archive/) record how ForgeSworn
treated the service's other duties during that time (law note 2.3).

## 6. Changes that require a fresh scope check

Reassess before introducing a ForgeSworn relay, TURN server, file store or
same-origin service used by the apps. A reachable endpoint is not by itself
proof of user-to-user provider status: classify the underlying service,
control of admission and any access facility separately (law note 2.11).
TURN-specific application remains a reading `[U]`.

The owner's current design choice is independent providers with simple
onboarding and a self-hosting alternative, without a ForgeSworn public call
service. A shared provider account or ForgeSworn credential broker would need
another review. The proposed import/connector flow is not yet shipped.

Self-hosted TURN is to be made easy (plan item S9) on these rules: setup
runs on the deployer's own machine; ForgeSworn never holds their secrets;
no list of servers ForgeSworn runs or vouches for; no phone-home; closed by
default.

Revisit this record before shipping any default, or starting to run
anything others can reach (law note 2.2).
