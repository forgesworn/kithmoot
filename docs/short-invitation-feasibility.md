# Short invitation feasibility — G16

Status: design and local experiment, 11 October 2026. No resolver, client
integration or public `/k/` route is implemented by this change. G16 stays open.

The subsequent [browser envelope codec](short-invitation-envelope.md) implements
bounded authentication and exact full-invitation validation with shared synthetic
vectors. It is not yet connected to an application entry flow or resolver.

## Proposed route

Use `https://z1p.app/k/<id>#<key>` for an optional encrypted lookup envelope.
The ID is 16 cryptographically random bytes encoded as 22 base64url characters.
The decryption key is a separate 32 random bytes, encoded as 43 characters only
in the fragment. The complete link is 84 characters, including punctuation.
The path alone retrieves ciphertext and cannot grant room access.

The existing Z1P home page, commercial product, accounts, repositories and
evidence graphs remain separate. KithMoot's resolver needs an isolated process,
bounded ciphertext storage and a dedicated `/k/` route. Being on the same domain
must not grant access to Z1P or introduce Z1P account requirements for guests.
The local `z1p-platform` checkout contains the marketing site and its Caddy
configuration; it currently has no invitation service. HTTPS `/` returned 200
on 11 October; this does not establish a deployed resolver or mobile handling.

## Measured alternatives

The [reproducible experiment](../scripts/measure-short-invite-feasibility.mjs)
serialises already-valid synthetic invitation values using the current pinned
[fold-kit encoder](https://github.com/forgesworn/fold-kit/blob/dc51766b7e6a141d5ba8aa0e5421df86432a7412/src/link.ts).
It uses Node's AES-256-GCM to test an envelope round trip and authentication.
It is sizing code, not another room-link parser or a production codec.

| Synthetic fixture | Current full link | Proposed lookup link | Reduction |
| --- | ---: | ---: | ---: |
| Minimal invitation, no hints | 214 characters | 84 characters | 61% |
| Named room, two relays and STUN | 312 | 84 | 73% |
| Persistent project room with account policy | 448 | 84 | 81% |

The sample stored envelopes are 399–711 bytes. Sizes depend on the original
link; the short address length does not. The receipt is
[recorded separately](evidence/short-invitation-feasibility-20261011.json).

A compact self-contained binary fragment avoids a resolver, but must still
carry both the 256-bit bearer and 256-bit inviter binding, plus version, room
mode and any network/policy hints. Compressing that material is a new circle
format requiring fold-kit implementation, vectors and independent native
support. Removing the inviter binding or replacing it with a memorable alias
is unacceptable. The encrypted lookup is the proposed first route because it
can carry the exact existing full invitation without changing admission wire
formats. Keep the current self-contained full link as the fallback.

## Envelope and access boundary

Encrypt `{ v: 1, url: <exact full invitation> }` locally with AES-256-GCM,
a fresh 96-bit nonce and the fragment key. Authenticate a fixed protocol label,
lookup ID and expiry as additional data. The stored envelope contains only
version, expiry, nonce and ciphertext with its authentication tag. Do not put
room names, participant lists, logos, invitation bearers, room secrets or the
fragment key in HTTP paths, queries, request headers or storage metadata.
The experiment rejects a wrong key, changed lookup ID, altered expiry,
altered ciphertext and expiry at the exact boundary.

Clients must validate the envelope's schema, bounded size, canonical encodings,
time bounds and authenticated expiry before use. Validate the recovered URL
against the allowed KithMoot entry origin/path and the existing fold-kit parser;
never execute an arbitrary redirect. Reject unknown modes and malformed or
expired payloads. Native and browser implementations need shared independent
vectors before an application codec is adopted.

Resolution creates no membership. Continue through the ordinary invitation
preview and admission path, preserving the original inviter, bearer, persistence
mode, policy and relay hints. Only an authentic grant may supply closed-room
contents or media. A shortened link cannot bypass retirement, rotation, room
expiry or the signed account/project checks. Unknown invitations cannot acquire
guessed project labels or fetch private artwork before admission.

## Service lifecycle and abuse controls

The following are proposed initial limits, requiring implementation and load
qualification: 32 KiB per envelope, a 24-hour default lifetime, a seven-day
maximum, a hard 256 MiB live-data ceiling, and bounded upload/read rates.
Use the earlier of the selected resolver expiry and known room expiry. The
browser enforces authenticated expiry even if a service replays stale bytes.
The service also expires and deletes records on its own clock, atomically and
across restart, and rejects new uploads when its storage ceiling is reached.

Use random server-assigned lookup IDs with collision checks and independent
256-bit owner deletion capabilities. Store only a hash of the deletion
capability; keep the owner's value in the appropriate encrypted local scope.
Never include it in the guest link. Deletion must be idempotent and cannot
delete another invitation. Do not reuse a participant's Nostr account as an
upload identity merely to make rate limiting convenient. Anonymous bounded
uploads require explicit abuse quotas and a reviewed challenge mechanism;
these are deployment gates, not protections established by this experiment.

For a particular 128-bit ID, even one billion independent guesses have success
probability about 2.94e-30. That ID provides location privacy; it is not the
decryption or admission credential. Dataset size affects any-record discovery,
and rate/storage ceilings remain necessary. The 256-bit fragment key protects
the authenticated envelope independently of an exposed ID.

Deleting a lookup prevents later retrieval through this service. It does not
revoke a full invitation already recovered, copied or cached. Real access
revocation still uses invitation retirement/rotation and room authority. The
UI must distinguish **Delete short link** from **Revoke invitation**.

## Preview, availability and metadata

Return a generic KithMoot invitation page to unfurlers. Opening or fetching it
cannot consume a use, request admission or reveal private room identity. An
explicit **Review invitation** action starts envelope retrieval and validation;
the usual review/request/Open room actions then govern entry. Use separate
expired/deleted, unavailable, invalid and waiting-for-host states.

The resolver can observe client IP, request time, ciphertext size, expiry and
repeated requests for the same ID. Logs and error reports must exclude
capabilities, request bodies, fragments and decrypted targets. Serve the route
with no third-party resources, `Referrer-Policy: no-referrer`, a restrictive CSP
and no-store API responses. Do not cache envelopes in a service worker or load
them automatically for link previews. A compromised resolver page can read
the fragment when visited: encrypted storage does not remove trust in served
client code. Native retrieval avoids executing resolver JavaScript but retains
the usual signed-application and network dependencies.

Resolving adds a hosting dependency and network request before normal relay
admission. Offer **Copy full invitation**, short-link copy and QR separately.
Retain the full link in the authorised owner's existing invitation storage;
guests lacking a recovered copy need the sender's full-link fallback during an
outage. Do not suggest that 84 characters are a human-memorable credential.

## Remaining acceptance

- Implement bounded encrypted storage, upload/deletion controls, atomic expiry,
  quotas, restart/backup behaviour and generic preview in an isolated service.
- Add the browser/native codec and shared independent vectors; circle format
  changes, if needed, land in fold-kit before its pinned client versions change.
- Integrate explicit create/review/copy/QR flows and full-link fallback while
  preserving closed-room, project/account and anonymous-room boundaries.
- Test actual Android app links and PWA opening from Signal and other messengers,
  with redirects, fragment loss, cancelled/duplicate opening and offline recovery.
- Check tamper, unknown schema, size/encoding limits, expiry, deletion, retirement,
  rotation, concurrent requests, unavailable resolver and crawler behaviour.
- Verify live route isolation, storage/log contents, caching and metadata,
  followed by physical guest/host acceptance before declaring G16 complete.
