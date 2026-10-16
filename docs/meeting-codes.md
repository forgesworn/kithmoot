# Meeting codes

Status: specification, 16 October 2026. Supersedes the 84-character encrypted
lookup in [short-invitation-feasibility.md](short-invitation-feasibility.md)
as the first short-link route; the full link remains the fallback everywhere.

## What people see

A host taps **Get a meeting code** and can read out or send:

- the code `ABC-DEF-GH`, typed into **Join with code** on the KithMoot home
  screen (web, desktop, Android);
- or the link `https://kithmoot.app/c/ABC-DEF-GH` (25 characters), which opens
  the app where it is installed and the browser otherwise.

## Trust model

A code is short enough to read aloud, so it cannot carry the invitation's
key. The code service stores the **full invitation link** and returns it to
anyone who presents the code. The service can therefore read invitations, and
what that means depends on the room:

- **Ask rooms** ("Ask me before anyone joins"): a member must press Let in.
  Nobody present means the guest gives up after 90 seconds and nobody is
  rung. The service, or anyone who guesses a code, gains nothing beyond
  knocking.
- **Rooms with an end time** (group rooms with no waiting room): anyone with
  the link gets the room key from the relays, so the service, or a successful
  guess, can enter the room during its lifetime, and a late Join still starts
  a call that rings members until the end time. A code changes none of that;
  it adds only the 40-bit guess budget and a hard expiry. It is no worse than
  sending the full link, and no better.

Rooms that admit anyone with the link and never end keep full links only.
Chat, calls and files stay end-to-end encrypted from everyone outside the
room in every case; the service never sees room traffic. Only the room's
creator can issue a code in phase 1 (the same check as `canEndRoom`), so End
room and New link always hold the delete token.

## Hard rules

1. A code's lifetime never exceeds the room's. Its expiry is the room's end
   time, or at most 7 days for an Ask room, and the service deletes it then.
2. The host's **End room** deletes the code. **New link** deletes the old code
   (a new code can then be issued for the new link).
3. An expired or deleted code shows **This meeting has ended** (or **This code
   has expired**) and resolves to nothing. The service keeps a record of every
   deleted or expired code for 30 days after its expiry, answering `410`, and
   never reissues a code value it still holds.
4. Arriving by code never joins, starts a call or rings anyone. It opens the
   existing invitation door, whose Join is a press; microphone and camera
   start unticked as today.
5. Codes are never guessable in practice: 8 symbols from the frozen
   foregather base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (40 bits,
   CSPRNG, one byte per symbol, low five bits), with a per-address miss
   budget at the service.

## Code format

Generation and parsing follow foregather `foregather-access/base32-en-v1/1`
(see foregather-kit `docs/character-codes.md`), at a fixed 8 characters:
display `ABC-DEF-GH`; parse accepts upper or lower case, surrounding
whitespace, unseparated text or hyphens between triples; rejects I, L, O, U,
internal spaces and misplaced hyphens. No ambiguous-character substitution.
The canonical form (8 uppercase symbols, no hyphens) is what the service
stores and what URLs carry.

## Service: `server/meeting-codes.mjs`

Plain Node (22 on the box), no dependencies, the same shape as
`server/turn-credentials.mjs`: bound to `127.0.0.1:8093`, behind Caddy on
`kithmoot.forgesworn.dev` at `/codes`, a systemd unit in
`deploy/meeting-codes.service` and a deploy note in `deploy/README.md`.

Storage is one JSON file written atomically (temp file, fsync, rename),
bounded to 20,000 records (live plus tombstones); a full store refuses
creation rather than evicting live codes. A live code past its expiry is
answered as ended at once; records are swept 30 days after expiry, on a timer
and at start.

Each record: canonical code, the invitation link, `expires` (Unix seconds),
`deleteTokenHash` (SHA-256 of a 32-byte random token), `state` (`live` or
`ended`). Nothing else: no IP, account, room name or user agent is stored.

| Request | Behaviour |
| --- | --- |
| `POST /codes` `{link, expires}` | Validate, create, return `201 {code, expires, deleteToken}`. |
| `GET /codes/<code>` | `200 {link, expires}` for a live code; `410 {state: "ended"}` for a tombstone or an expired code; `404` for an unknown code. |
| `DELETE /codes/<code>` with `Authorization: Bearer <deleteToken>` | Turn a live code into a tombstone; `204`. Wrong token `403`; unknown `404`; already ended `204`. |
| `GET /codes/health` | `200`. |

Validation on create: body at most 8 KiB JSON; `link` is a string at most
4,096 characters whose origin is `https://kithmoot.forgesworn.dev` or
`https://kithmoot.app`, path `/j/`, with a non-empty fragment and no query,
credentials or other path; `expires` is a safe integer with
`now < expires <= now + 7 days`. The service does not parse invitations; the
client decides eligibility (see below).

Abuse limits, in memory, keyed by a salted hash of the client address (Caddy's
`X-Forwarded-For`, salt random per process, never written to disk): creation
10 a minute and 100 a day; lookups 30 a minute; misses (404) 10 a minute and
50 an hour, after which lookups from that address answer `429` until the
window passes. A process-wide ceiling of 200 misses a minute answers `429` to
every lookup until the minute passes, so a guesser spread over many addresses
cannot sweep the code space either. Responses carry `Cache-Control: no-store`. CORS allows only the
two KithMoot origins. Logs record status and route only, never codes, links or
tokens.

## Routing

- `kithmoot.forgesworn.dev`: `handle /codes*` reverse-proxies to the service,
  before the catch-all, as `/turn` does.
- `kithmoot.app/c/<code>`: Caddy answers `302` to
  `https://kithmoot.forgesworn.dev/j/?c=<code>` with `Cache-Control: no-store`,
  so Cloudflare does not cache it. The app reads `c` from the query.

## Clients

**Eligibility.** A room may offer a code only if it is an Ask room, or it has
an end time. The control is absent otherwise.

**Create (web/desktop first).** In the invite sheet, **Get a meeting code**
posts the room's current full link with `expires` = the room's end time, or
now + 7 days for an Ask room without one (renewable by the host, issuing a
new code). The returned code, expiry and delete token are kept with the
room's creator records, in the same storage as the room's other host
secrets, never in the link and never synced to guests. The sheet shows the
code in triples, the short link, Copy and Share, and the expiry in words.

**Delete.** End room, New link and Forget room (for the creator) send DELETE
with the stored token; a failed DELETE is retried on the next open and does
not block the action. Expiry needs no client.

**Join.** Home gains **Join with code**: one field, Enter or a Join button.
`/j/?c=<code>`, `kithmoot.app/c/<code>` (desktop `invitationTarget` and the
Android verified link) and the typed code all do the same thing: canonicalise,
GET, then hand the returned link to the existing `openLink` flow, which shows
the door. `410` shows **This meeting has ended**; `404` **We could not find
that code. Check it and try again**; `429` **Too many tries. Wait a minute**;
network failure offers Retry. A code never auto-joins.

## Delivery

1. **Web and desktop (kithmoot):** service, tests, Caddy, unit, docs; create,
   delete and join in the web app; desktop `invitationTarget` accepts
   `https://kithmoot.app/c/<code>` and `kithmoot://c/<code>`. Ship with the
   next desktop release.
2. **Android join and End room:** verified link filter `kithmoot.app`
   `pathPrefix /c` (assetlinks already lists the package), Join with code, a
   confirmation door for code arrivals (Android currently enters group links
   at once), and End room for the creator. End room is what stops a late
   Join ringing everyone on Android, codes or not.
3. **Android host:** Ask rooms and Get a meeting code on Android.

## Tests

Service: code format and parsing against the foregather vectors' alphabet;
create/get/delete lifecycle; tombstone and expiry answers; validation refusals;
miss budget and 429; atomic write survives a crash between write and rename;
bounded store refuses creation when full. Web: eligibility, create stores the
token with the room, End room and New link delete, Join with code reaches the
door without joining, each error message. Desktop: policy accepts the two code
forms and nothing looser.
