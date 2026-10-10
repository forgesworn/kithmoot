# Browser MLS member revocation request foundation (P3-08)

This development-only slice implements the member-to-keeper wire boundary from
Vennel contract section 7.1. Production MLS remains disabled, and the production
app does not import this module.

## Protocol boundary

`createVmlsRevocationRumor` creates the unsigned inner kind 21350 rumour. Its
only fields are the requesting account, keeper, device, expiration, and bounded
session and box hints. The parser requires the exact field and tag set, binds
the rumour author to the authenticated kind 13 seal author, verifies its event
id, rejects duplicate hints, enforces the seven-day lifetime and ten-minute
future-skew limits, and accepts between one and 64 session and box hints.

`wrapVmlsRevocationRequest` identity-signs a kind 13 seal and encrypts it inside
a kind 1059 gift wrap made with a fresh ephemeral key. Seal and wrapper times
are independently backdated by up to two days. Only the keeper `p` tag is
visible outside the encrypted payload. Signer substitution, account changes,
oversized payloads, invalid randomness, and malformed or unauthenticated relay
material fail closed.

`sendVmlsRevocationRequest` selects only the keeper's verified latest kind
10050 DM relay list. It has no NIP-65 or configured-relay fallback and gives the
publisher `authenticate: false`, so the member identity must not be disclosed
through NIP-42. The publisher contract resolves only after at least one relay
has returned `OK true`; callers may set `NotAuthorised.requested` only after
that resolution. A missing relay list or a refused/uncertain publish leaves the
request unrecorded.

`vmlsMemberGrantReference` derives the member-side stable reference as
`SHA-256(UTF8("kithmoot/vmls-member-grant/v1") || box32 || device32)`.

## Evidence and remaining work

Unit coverage exercises strict framing and time bounds, NIP-59 round trips,
outer metadata minimisation, signer and author binding, hostile relay input,
verified kind 10050 selection, absence of fallback and identity AUTH, refused
publication, account invalidation, and the member grant reference. The
production build is byte-for-byte identical to its clean base build.

This is the protocol and sender dependency boundary only. It does not add a
production import, UI action, encrypted request journal, automatic retry,
directory network lookup, keeper inbox, dedicated endpoint lifecycle, operator
prompt, or MLS/grant revocation. Those remain open P3-08 work, and this module
must not be wired into production before their gate evidence and the production
security review are complete.
