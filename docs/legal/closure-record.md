# KithMoot closure record

What ForgeSworn ran for KithMoot users, when it stopped, and where that
leaves ForgeSworn. Drafted on 22 October 2026 from the repository at
`d04f0dd3` and the report of the session that runs the box. Not legal
advice; no lawyer has read it. The law is in jurisdiction-kit's
`law/gb/online-services.md`, verified 28 September 2026; its evidence marks
are carried here: `[P]` primary source read, `[S]` secondary, `[U]`
unchecked. Where a fact rests on the host's report and not on the
repository, it says so.

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
| File store (Blossom) | Took encrypted uploads from any signing key; served them by hash, on the public host and a read-only onion front |
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
| 22 October 2026 | The relay ForgeSworn also runs closed to an allowlist of the operator's own keys, reads and writes, behind relay authentication (NIP-42) | Host's report |
| 22 October 2026, about 16:40 UTC | `/turn` and stored-file reads, including the onion front, answer 410 Gone; the TURN credential and file store services disabled | Checked from outside: `/turn` and `/blossom/<hash>` answer 410. `deploy/Caddyfile.kithmoot` on `main` since PR #534 |
| 22 October 2026, about 18:30 UTC | The TURN server's KithMoot secret removed, so no credential minted for KithMoot works any more; the stored files moved off the live data path into a trash folder on the box | Host's report |

Clients: Android 0.6.103 stops asking ForgeSworn's host for a TURN
credential and retires a stored ForgeSworn file server
(`docs/android-production-publication.md`). PR #525 (web, open) tells
people that ForgeSworn-held files are gone. The desktop 0.1.100 release
commit, cut from #525, is on a branch and not on `main`; whether it has
shipped was not checked.

## 3. What remains

- **Stored files.** The 84 encrypted blobs, about 164 MB, sit in a trash
  folder on the box, unreachable from outside, waiting for the owner to
  empty it. Until then ForgeSworn still holds that data, and data
  protection still applies to it (law note 3.1). `[INPUT: whether the
  archive nodes still hold copies.]`
- **STUN on ForgeSworn's host.** The app derives `stun:<host>:3478` from
  the host that served it (`src/ice-defaults.ts`, `originStunGuess`), and
  Android 0.6.103 keeps STUN there. When the app is loaded from
  `kithmoot.forgesworn.dev`, that is ForgeSworn's server, answering anyone.
  STUN carries no user's content to another user. The law note does not say
  whether a server like that bears on the Online Safety Act (not covered).
  The owner decided on 22 October 2026 to keep it: it carries no content,
  and the alternatives are a large company's STUN, which sees the same
  addresses, or calls that fail more often. It does see users' IP
  addresses, which is data protection (law note 3.1).
- **Same-origin calls in the apps.** On `main`, and still on PR #525, the
  web app asks its own origin for `/turn` (`app/src/main.ts`,
  `TURN_CREDENTIAL_ENDPOINT`) and `/codes` (`meetingCodeClient`). On
  ForgeSworn's host both now answer 410, so nothing is served, but the
  defaults are still in the code.
- **Keepers on the box.** None runs. The two the box held, for the
  operator's own rooms, were retired on 4 September 2026 and their state
  is kept on the box only (host's report).
- **Meeting code data.** The service is stopped and disabled. Its store of
  room links, about 1 KB, sits in the same trash folder as the stored
  files, waiting to be emptied.
- **The drop tier** still runs on the box's loopback. Whether anything
  other than the box can reach it was not checked.
- **The app and the update check.** `kithmoot.forgesworn.dev` still serves
  the web app as static files, and the desktop app checks it for updates.
  Neither lets one user's content reach another.

ForgeSworn's own services that are not for KithMoot users, including the
relay above now that it is closed to the operator's own keys, are out of
scope here.

**Contact.** `abuse@safety.forgesworn.dev` stays as the contact for anything
about data ForgeSworn still holds, such as a request to delete a stored
file by its hash. It is not a reporting route for a live service.

## 4. Where ForgeSworn stands now

**Aimed at: a publisher of software, with defaults that point only at
servers other people run.** The apps' default relays and default public
file server are run by others; each server's operator is the provider of
that server (law note 2.2, a reading, `[U]`). Somebody who installs and
runs the software is the provider of their own deployment, and publishing
general-purpose software does not make the publisher a party to what
others do with it (law note 6.1, Serious Crime Act 2007 sections 44, 45
and 50, `[P]`). The privacy notice still owes an account of the third
parties the defaults contact (law note 3.2).

**Today:** close to that. What is left is ForgeSworn's STUN (kept by
decision), the same-origin defaults in section 3 that now meet 410, and the data in
section 3 still on the box.

## 5. Why no assessment fell due

While ForgeSworn ran these surfaces for strangers it took the cautious
reading: that what it ran could be a user-to-user service with UK links
(law note 2.1) and that it was the provider of it (2.2).

A new service owes its illegal content risk assessment three months after
launch (law note 2.4, `[P]`) and its children's access assessment on the
same timetable (2.4, `[S]`). From 24 August 2026 both fell due on 24
November 2026. The open surfaces closed on 22 October 2026, before that
date.

Reading: a service that stops being provided before its deadline owes no
assessment for it. `[U]`: the law note has no source on a service that
closes before its deadline. This is not a finding that no duty applied
while it ran. The drafts in [`archive/`](archive/) record how ForgeSworn
treated the service's other duties during that time (law note 2.3).

## 6. What would bring it back into scope

Any ForgeSworn default that lets one user's content reach another: a relay,
a TURN server, a file store, or a same-origin path on a ForgeSworn host
that the apps use by default. The owner has decided against all of them:
no ForgeSworn or company-run TURN, and no ForgeSworn defaults anywhere.
STUN, which carries no content, is the one exception, whoever runs it.

Self-hosted TURN is to be made easy (plan item S9) on these rules: setup
runs on the deployer's own machine; ForgeSworn never holds their secrets;
no list of servers ForgeSworn runs or vouches for; no phone-home; closed by
default.

Revisit this record before shipping any default, or starting to run
anything others can reach (law note 2.2).
