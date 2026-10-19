# Meeting codes

Status: specification, 16 October 2026. Supersedes the 84-character encrypted
lookup in [short-invitation-feasibility.md](short-invitation-feasibility.md)
as the first short-link route; the full link remains the fallback everywhere.

## What people see

A host taps **Get a meeting code** and can read out or send:

- the code `ABC-DEF-GH`, typed into **Join with code** on the KithMoot home
  screen (web, desktop, Android);
- or the link `https://kithmoot.app/c/ABC-DEF-GH` (25 characters), which opens
  the app where it is installed and the browser otherwise;
- and, when **Add a password** is on, the same link with four password words
  after a `#`, such as `https://kithmoot.app/c/ABCDEFGH#ability-zoo-jasmine-forget`.
  That one link joins in a tap with no prompt; the words are in the fragment,
  which no server receives (see [Password](#password)). A host who prefers to
  send the words in a different message switches on **Send the password
  separately**, and the link is then the bare one above.

## Trust model

A code is short enough to read aloud, so it cannot carry the invitation's
key. Without a password the code service stores the **full invitation link**
and returns it to anyone who presents the code. The service can therefore
read those invitations, and what that means depends on the room:

- **Ask rooms** ("Ask me before anyone joins"): a member must press Let in.
  Nobody present means the guest gives up after 90 seconds and nobody is
  rung. The service, or anyone who guesses a code, gains nothing beyond
  knocking.
- **Rooms without a waiting room**, with or without an end time: anyone with
  the link gets the room key from the relays, so the service, or a successful
  guess, can enter the room while the code lives, and a late Join still starts
  a call that rings members. A code adds the 40-bit guess budget and a hard
  expiry of at most 7 days, so for a room that never ends it exposes less than
  the full link, which works for as long as the room does.

With a password the service stores only an envelope sealed under four words
it never sees, and returns the envelope to anyone who presents the code.
Opening it needs the words: someone who has the code alone, the service
included, must guess them. That guess is offline once the envelope is in
hand (the lookup budget limits fetching envelopes, not trying words), so the
protection is the 44 bits of the words through 600,000 PBKDF2 iterations,
for at most the code's 7-day life: far out of reach of a casual guesser or
an honest-but-curious service, not of an adversary willing to spend a large
GPU budget on one invitation within its life. The service can still see
that a code exists, when it was made and when it is fetched, and can refuse
or withhold an envelope; it cannot substitute one the words open. The
password is on by default for rooms without a waiting room, where the link
alone lets someone in, and off by default for Ask rooms, where a member must
still press Let in.

By default the host's link carries the words too, in its fragment, so a guest
taps once and nothing is typed. The fragment is never sent to any server, so
the service still holds only the sealed envelope and still cannot open it. What
changes is who holds both halves: a link with its words is as strong as the
full invitation link it stands for, and whoever has it can enter and forward
it. The password's job, keeping the invitation from the service and from
someone who merely guesses a code, is unchanged. A host who wants a link seen
in one place not to be enough switches on **Send the password separately**.

Chat, calls and files stay end-to-end encrypted from everyone outside the
room in every case; the service never sees room traffic. Only the room's
creator can issue a code in phase 1 (the same check as `canEndRoom`), so End
room and New link always hold the delete token.

## Hard rules

1. A code's lifetime never exceeds the room's. Its expiry is the room's end
   time or 7 days from issue, whichever is sooner; the host can issue a new
   code when one runs out. The service answers it as ended from then on.
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
`server/turn-credentials.mjs`: bound to `127.0.0.1:8114` (8093 is Caddy's loopback Tor front and other tenants hold 8094 to 8100), behind Caddy on
`kithmoot.forgesworn.dev` at `/codes`, a systemd unit in
`deploy/meeting-codes.service` and a deploy note in `deploy/README.md`.

Storage is one JSON file written atomically (temp file, fsync, rename),
bounded to 20,000 live codes and 200,000 tombstones (a tombstone keeps only
code, expiry, token hash and state, never the link); a full store refuses
creation rather than evicting anything. A live code past its expiry is
answered as ended at once; records are swept 30 days after expiry, on a timer
and at start. The per-address limits below trust the last `X-Forwarded-For`
hop, which is the visitor's own address only while `kithmoot.forgesworn.dev`
stays grey-cloud (DNS-only) on Cloudflare; proxying it would put every
visitor in one shared budget.

Each record: canonical code, the invitation link or, for a code with a
password, the envelope `{v, salt, nonce, ciphertext}`, `expires` (Unix
seconds), `deleteTokenHash` (SHA-256 of a 32-byte random token), `state`
(`live` or `ended`). A code allocated for a password and not yet uploaded is
`pending` and holds `uploadTokenHash` (SHA-256 of another 32-byte random
token) and `pendingUntil` (allocation plus 10 minutes) instead of a link or
envelope. Nothing else: no IP, account, room name or user agent is stored.

| Request | Behaviour |
| --- | --- |
| `POST /codes` `{link, expires}` | Validate, create, return `201 {code, expires, deleteToken}`. |
| `POST /codes` `{sealed: true, expires}` | Validate, allocate a `pending` code, return `201 {code, expires, deleteToken, uploadToken}`. |
| `PUT /codes/<code>` with `Authorization: Bearer <uploadToken>`, body `{envelope: {v, salt, nonce, ciphertext}}` | Store the envelope once and make the code live; `204`. Unknown, or pending past 10 minutes or its expiry, `404`; already uploaded `409`; ended `410`; wrong token `403`; invalid body `400`; body over 10 KiB `413`. |
| `GET /codes/<code>` | `200 {link, expires}` or `200 {envelope, expires}` for a live code; `410 {state: "ended"}` for a tombstone or an expired code; `404` for an unknown or pending code. |
| `DELETE /codes/<code>` with `Authorization: Bearer <deleteToken>` | Turn a live or pending code into a tombstone; `204`. Wrong token `403`; unknown `404`; already ended `204`. |
| `GET /codes/health` | `200`, on loopback only; Caddy does not proxy it. |

Validation on create: body at most 8 KiB JSON; `link` is a string at most
4,096 characters whose origin is `https://kithmoot.forgesworn.dev` or
`https://kithmoot.app`, path `/j/`, with a non-empty fragment and no query,
credentials or other path; `expires` is a safe integer with
`now < expires <= now + 7 days`; or, for a password, exactly
`{sealed: true, expires}` with the same `expires` rule. The service does not
parse invitations; the client decides eligibility (see below).

Validation on upload: body at most 10 KiB JSON, exactly `{envelope}`; the
envelope exactly `{v, salt, nonce, ciphertext}` with `v` the number 1 and the
others strict base64url without padding (the alphabet only, and only the one
encoding of the bytes): `salt` 16 bytes, `nonce` 12 bytes, `ciphertext` 17
bytes to 6 KiB. The service cannot open an envelope and does not try. A
pending code not uploaded within 10 minutes answers `404` from then on and is
discarded at the next sweep, not kept as a tombstone: it was never shown to
anyone, since the client shows a code with a password only after its upload.

Creation is also capped service-wide at 2,000 codes in any rolling 24 hours, answered `503`. Abuse limits, in memory, keyed by a salted hash of the client address (Caddy's
`X-Forwarded-For`, salt random per process, never written to disk): creation
10 a minute and 100 a day; lookups 30 a minute; misses (404) 10 a minute and
50 an hour, after which lookups from that address answer `429` until the
window passes. `PUT` spends the same lookup and miss budgets as `GET` and
`DELETE` (an unknown code is a miss, and so is a `GET` of a pending code, so
neither answer tells a guesser more than `404`). A process-wide ceiling of 200 misses a minute answers `429` to
every lookup until the minute passes, so a guesser spread over many addresses
cannot sweep the code space either. This is a deliberate trade: someone
spread over many addresses can make Join with code answer "Too many tries"
for everyone a minute at a time. Full links are unaffected. Responses carry `Cache-Control: no-store`. CORS allows only the
two KithMoot origins. Logs record status and route only, never codes, links or
tokens.

## Password

An optional password of four words seals the invitation link on the host's
device before the service sees it. Fixed bytes for a second implementation
are in [`vectors/meeting-code-password-v1.json`](../vectors/meeting-code-password-v1.json),
generated with `node:crypto` by `vectors/generate-meeting-code-password.mjs`
and reproduced by the app's WebCrypto code in its test.

**Words.** The frozen foregather en-v1 list (2,048 lowercase ASCII words,
copied byte for byte from foregather-kit `crates/foregather-kit/src/en-v1.txt`,
MIT, into `app/src/meeting-code-words-en-v1.txt`; SHA-256
`0334930ebdfbc76e81ec914515d7567ca85738a6bf3069249d97df951d44661c`, pinned by
a test with the count). Four words, each the low 11 bits of a 16-bit
`crypto.getRandomValues` value: 2,048 divides 65,536, so there is no modulo
bias. 44 bits in all. The canonical form is lowercase with single ASCII
spaces. Parsing accepts any case, surrounding whitespace, and hyphens, commas
or runs of whitespace between words; it requires exactly four words, each in
the list, ASCII only. Nothing is autocorrected or matched approximately.

**Envelope.**

- `salt`: 16 random bytes; `nonce`: 12 random bytes.
- key = PBKDF2-HMAC-SHA256(password = the canonical words as UTF-8, salt,
  600,000 iterations, 32 bytes), via WebCrypto.
- AES-256-GCM with that key and nonce; additional data = UTF-8
  `kithmoot-meeting-code/v1:<CANONICAL CODE>:<expires>` (`expires` in decimal
  Unix seconds); plaintext = UTF-8 JSON `{"v":1,"link":"<full link>"}`.
- Wire form `{v: 1, salt, nonce, ciphertext}`, each base64url without
  padding; `ciphertext` carries the 16-byte GCM tag at its end, as WebCrypto
  and `javax.crypto` both produce it.

The additional data binds the envelope to its code and expiry, so the
service cannot move an envelope to another code or stretch its life without
the guest's decryption failing. It also means the client must know the code
before sealing, so the service allocates first: `POST {sealed: true,
expires}`, seal, then `PUT` the envelope with the upload token.

**Link fragment.** The words travel in the short link's fragment:
`https://kithmoot.app/c/<CODE>#<words>`, where `<words>` is the canonical words
joined by single hyphens, lowercase, with no spaces: `ability-zoo-jasmine-forget`.
Every word in the list is `a-z` only, so a hyphen never occurs inside one and
nothing is percent-encoded; the canonical words come back exactly. The web app
formats and parses it in `passwordFragment` and `parsePasswordFragment`
(`app/src/meeting-codes.ts`), and the desktop app checks the same shape against
its own copy of the word list. Parsing is stricter than for typed words: a
leading `#` is allowed, then exactly four words from the list joined by single
hyphens. Upper case, spaces or `%20`, commas, underscores, `%2D`, a doubled,
leading or trailing hyphen, three or five words, a word outside the list and
any trailing text are all refused, and nothing is corrected. Words never go in
a query string, a request or a log.

**Host.** Next to Get a meeting code, an **Add a password** switch, on by
default for rooms without a waiting room (Ask off) and off by default for Ask
rooms, until the host sets it in that sheet. With it on: allocate, seal,
upload; any failure after allocation deletes the pending code. Then the sheet
shows the code and the one short link with the words in its fragment. Copy
puts that link, and only that link, on the clipboard (no code and no password
line, since a bare code in the text would ask a guest for words they were
never shown); Share sends it with a line that does not name the code. A host
who reads the bare code out loud still needs to give the words, so the sheet
keeps them behind **Reading the code out loud? Show the password words**,
beside the code and never in the default share text.

A second switch, **Send the password separately**, is off by default and
appears once a code has words. On, the link is the bare `https://kithmoot.app/c/<CODE>`,
the four words are shown for sending on their own, Copy puts the code and link
on one line and the words on the next, and the sheet tells the host to send
the words separately; Share sends the code and bare link only. It is a choice
about what the link says: sealing, the envelope and the service's record are
the same either way, and it is kept for the life of the page, not reset each
time the sheet opens. The words are kept with the code's record in the device
store, beside its delete token, so the sheet shows them again; they never go
on the delete queue or to another member.

**Guest.** A link with words arrives on the join page as
`/j/?c=<CODE>#<words>` (see [Routing](#routing)). Before anything else reads the
address, the page reads the fragment, removes it from the address bar with
`history.replaceState` so the words are not left in history, and keeps the
words in memory only. When the lookup answers with an envelope, the words open
it silently and the page continues to the door with no prompt. If the fragment
is absent, is not four list words, or opens nothing, the door asks **Enter the
password words you were given** in one field instead (a fragment that is
neither words nor a room link is dropped, so that is the outcome rather than
an incomplete-link failure). Typing a code in by hand always asks, as does a
bare link. Words that do not parse, or do not open the envelope, say **Those
words do not match. Check them and try again.** There is no client-side
lockout: each try is local and a fresh lookup spends the service's budget. The
opened link is checked exactly as a plain code's link is
(`returnedJoinFragment`), then goes through the existing `openLink` door; it
never auto-joins. The words and the envelope are held in memory only, never
stored on the guest's device, logged, or sent anywhere. The link as it was
sent still sits wherever it was sent or pasted, and a browser may record the
address it was first given before the redirect.

## Routing

- `kithmoot.forgesworn.dev`: `handle /codes*` reverse-proxies to the service,
  before the catch-all, as `/turn` does.
- `kithmoot.app/c/<code>`: Caddy answers `302` to
  `https://kithmoot.forgesworn.dev/j/?c=<code>` with `Cache-Control: no-store`,
  so Cloudflare does not cache it. The app reads `c` from the query. The
  `Location` names no fragment of its own, so the browser carries the fragment
  of the link it followed (the password words) through the redirect, and the
  server, which is never sent a fragment, sees neither. A fragment in
  `Location` would replace the browser's, so a test reads the Caddyfile and
  fails if one is ever added.

## Clients

**Eligibility.** Any room whose creator is on this browser and which has not
ended may offer a code.

**Create (web/desktop first).** In the invite sheet, **Get a meeting code**
posts the room's current full link (or, with a password, allocates and
uploads its sealed envelope, see [Password](#password)) with `expires` = the room's end time or
now + 7 days less one minute (for clock skew), whichever is sooner. When it
runs out the host can issue a new code. The returned code, expiry and delete token are kept with the
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
the door. A code with a password asks for its words first, unless the link it
arrived in carried them in its fragment (see [Password](#password)). `410` shows **This meeting has ended**; `404` **We could not find
that code. Check it and try again**; `429` **Too many tries. Wait a minute**;
network failure offers Retry. A code never auto-joins.

## Delivery

1. **Web and desktop (kithmoot):** service, tests, Caddy, unit, docs; create,
   delete and join in the web app; desktop `invitationTarget` accepts
   `https://kithmoot.app/c/<code>` and `kithmoot://c/<code>`, each with an
   optional fragment of exactly four list words (passed through as
   `?c=<code>#<words>`; any other fragment, a query, host or path is still
   refused). Ship with the next desktop release.
2. **Android join and End room:** verified link filter `kithmoot.app`
   `pathPrefix /c` (assetlinks already lists the package), Join with code, a
   confirmation door for code arrivals (Android currently enters group links
   at once), reading the password words from a code link's fragment as the
   web does, and End room for the creator. End room is what stops a late
   Join ringing everyone on Android, codes or not.
3. **Android host:** Ask rooms and Get a meeting code on Android.

## Tests

Service: code format and parsing against the foregather vectors' alphabet;
create/get/delete lifecycle; tombstone and expiry answers; validation refusals;
miss budget and 429; atomic write survives a crash between write and rename;
bounded store refuses creation when full; sealed allocation, single upload
(409 on a second), wrong and missing upload tokens, pending expiry with the
injected clock, envelope bounds and strict base64url, pending lookups as
misses. Password: the word list's hash and count, unbiased generation,
parsing, seal and open, wrong words, tampered code, expiry, salt, nonce and
ciphertext, and the fixed vector; the fragment format and parse, round-tripping
every list word and refusing malformed fragments; the Caddy redirect sets no
fragment. Web: eligibility, create stores the token with the room, End room and
New link delete, Join with code reaches the door without joining, each error
message; a code link with its words reaches the door with no prompt, one lookup
and nothing of the words sent, stored or left in the address bar; wrong,
malformed or missing words fall back to the prompt; the host's default link
carries the words and shares as that one link, and Send the password
separately restores the bare link with the words apart. Desktop: policy accepts
the two code forms, each with an optional fragment of four list words, and
nothing looser.
