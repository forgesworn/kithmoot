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

Updated 1 November 2026: the public call relay, the STUN listener and the
relay ForgeSworn runs were opened to the public again (section 7). Updated
2 November 2026: the relay closed again at 00:33 UTC and the owner settled
the default-relay divergence (section 8); the public call relay and the
STUN listener stay open. Sections 1 to 6 are kept as written; where they
say a surface whose later history changed is open or closed, the later
sections govern.

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

## 4. Where ForgeSworn stood, 23 October 2026

Superseded on 1 November 2026 (section 7).

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

**Who used it, 24 August to 23 October 2026.** By the operator's account,
mainly two regular users, plus three or four friends who tried it with the
operator by invitation. No public sign-up drive or marketing took place in
that period. Counts of keys on the host (for example, uploads from about ten
keys in the last 30 days before closure) overstate people: each device, app
install and test run has its own key. The operator's judgement, for law note
2.1, is that this is not a significant number of UK users. Ofcom expects that
judgement to be explained (2.1, `[P]`); the lowest figure in a published
enforcement decision is an average of 855 UK visitors a month (2.1, `[S]`).
Whether the UK was a target market, the other limb of 2.1, is not settled by
these numbers.

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

## 7. 1 November 2026: reopened

Section 6's trigger has fired. After calls failed for people, the owner
reopened, from about 22:00 UTC on 1 November 2026:

| Surface | Now | Evidence |
| --- | --- | --- |
| TURN credentials, `GET /turn`, and the TURN server | Open to anyone, no account; hour-long logins; coturn on 3478 and 5349 with logs discarded, 1 Mbit/s per session. Used by default by the web app, desktop 0.1.124 and Android 0.6.132 | `server/turn-credentials.mjs`, `deploy/coturn/turnserver.conf`, `app/src/main.ts`; that `/turn` answers is the host's report, as `deploy/Caddyfile.kithmoot` on this branch still answers 410 |
| STUN | coturn answers STUN on 3478 again, so older clients that name it (Android through 0.6.105, desktop through 0.1.101) reach it. New default STUN is Google's, then Cloudflare's | `src/ice-defaults.ts`; host's report |
| The relay ForgeSworn runs, `relay.trotters.cc` | First default relay again, for new installs and rooms. Reads and writes open to anyone, no authentication. The allowlist now only sets retention: strangers' private messages and media deleted on each clean-up run, app data, reports and deletions after 90 days, the rest after 7 days; public kinds 1, 6, 7 and 9735 after a day for everyone | `data/public-relays.json`; access and retention are the host's report |

Still closed: the file store (uploads and reads), meeting codes and
`/drops` (410). Section 3's deletions stand.

Consequences for this record:

- Section 3's account of the relay, "closed to keys held for project work"
  and "treated as the project's inbox" (note 2.12), no longer describes it.
  Strangers' events can now reach other strangers, which is where 2.12 says
  the inbox reading falls away and 2.1 applies `[U]`.
- Section 5's reading that a service which stops before its deadline owes
  no assessment does not fit a service that reopens before that deadline.
  Whether the three-month period (note 2.4, `[P]`) runs from 24 August 2026
  or restarts on 1 November 2026 is not covered by the note `[U]`. Counted
  from 24 August 2026, the cautious reading, both assessments fall due on
  24 November 2026.
- See `call-transport-position.md`, section "1 November 2026", for the
  position this put ForgeSworn in and the evidence for each fact, and its
  section of 2 November 2026 for the position that now stands.

## 8. 2 November 2026: the relay closed again; the default-relay decision

The open window ended before its own deadline. By owner decision of
2 November 2026 the rehearsed relock ran at 00:33 UTC: the sign-in gates
were restored, the 1,347 events the open period admitted were purged with
verification (none remaining; the inbox-door and allowlisted records kept),
and the nightly backup resumed against the closed state. Verified from
outside: a stranger's write is refused, an anonymous read gets the
authentication challenge, and the relay information again says writes are
restricted (the operator's relay position note, correction entry of
2 November 2026).

The same day the owner settled the divergence the window created in the
apps' default relay lists, taking option (a) of the decision record
(`docs/decisions.md`, 2 November 2026):

- The web app returns to its documented rule: every suggested relay is run
  by someone other than ForgeSworn (`src/public-relays.ts`,
  `data/public-relays.json`), and a test now pins relay.trotters.cc out of
  the list so it cannot ride in with an unrelated change again
  (`src/public-relays.test.ts`).
- The in-development Android client keeps relay.trotters.cc first: the
  client is under development and its test fleet holds the allowlisted
  keys. The blessing holds only while the decision record's three
  conditions hold; if the client ships publicly, or any condition lapses,
  the question returns to the owner.
- The released desktop 0.1.124 and 0.1.125 bundles still name the relay
  first (their release tags); desktop releases after 0.1.125 follow the
  web list.

The relay therefore stands again as section 3 of this record described it:
closed to keys held for project work, with the one door for sealed messages
and signer requests addressed to those keys, and treated as the project's
inbox, not a service to the public (law note 2.12, `[U]`). The operator's
relay position note holds the four conditions that keep that reading, and
the reassessment this record asks for before any change to defaults or
open surfaces (section 6) happened: this section is its record.

Consequences for this record:

- Section 7's relay row described the window only; it stopped being true at
  00:33 UTC on 2 November 2026, and its retention schedule fell with the
  window. The closed-posture retention stands as the position note records
  it: sealed messages addressed to the allowlisted keys expire within
  30 days, and what strangers send is held for a shorter window.
- Section 7's first consequence is reversed: strangers' events can no
  longer reach other strangers, so the inbox reading (note 2.12) again
  describes the relay. The open hours of 1-2 November 2026 were a temporary
  in-scope period the law note does not cover; the position note records
  that gap as deliberately unfilled.
- Section 7's second consequence stands for the surfaces that stayed open:
  the public call relay and the STUN listener. The timetable reading given
  there (both assessments due on 24 November 2026 on the cautious count
  from 24 August 2026; the deadline `[P]`, the start-date question `[U]`)
  continues to apply to them. For the relay, which closed again before the
  date, section 5's reading returns: a service that stops before its
  deadline owes no assessment for it `[U]`, subject to the temporary-window
  gap above.
- The call surfaces that stayed open keep their footing from 1 November
  2026: default call transport for anyone (note 2.11, `[U]` in
  application). The position and its bounds are recorded in
  `call-transport-position.md` (section of 2 November 2026).

## 9. 2 November 2026: web STUN fallback corrected

The automatic fallback in `src/ice-defaults.ts` again names Cloudflare only.
The default public `/turn` issuer and coturn remain available. Browser and
agent resolution derive STUN from a successful plain TURN URL and use the
fallback when no login is available. No server, retention policy, admission
rule or key holder changes in this correction. Installed desktop and Android
builds retain their own defaults until separately updated; the privacy and
terms pages distinguish them. Sections 7 and 8 remain dated records of the
reopening and relay closure, rather than a current-web STUN inventory. The
law note is still the one verified 28 September 2026; no new legal conclusion
is made here.
