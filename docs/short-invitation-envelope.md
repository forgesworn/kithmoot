# Short invitation envelope codec — G16

The browser codec is implemented in
[short-invitation-envelope.ts](../app/src/short-invitation-envelope.ts).
It makes no network requests, requests no admission and creates no membership.
The resolver, upload/deletion controls, application entry flow and native
consumer are still unimplemented. G16 remains open.

An allocated 16-byte random lookup ID is encoded as 22 canonical base64url
characters. Sealing generates a separate random 32-byte key and 12-byte nonce.
The 84-character address is `https://z1p.app/k/<id>#<key>`. The key stays in
the fragment; the stored envelope has exactly `v`, `expires`, `nonce` and
`ciphertext`. Base64url is unpadded and canonical. Expiry uses whole Unix
seconds; lifetimes must be positive and at most seven days. Expiry is exclusive.

AES-256-GCM uses a 128-bit authentication tag appended to the ciphertext.
Additional authenticated data is the UTF-8 encoding of
`kithmoot-short-invite/v1:<id>:<expires>`, with expiry in ordinary decimal.
Plaintext is UTF-8 JSON containing exactly `{ "v": 1, "url": <full invitation> }`.
Opening limits the response to 32 KiB before parsing or decoding, checks the
schema, encoding, expiry and authentication, and validates the recovered URL.
Only canonical `https://kithmoot.app/j/#...` targets without credentials or
queries are accepted. The existing fold-kit parser must recognise a v2/v3
invitation. Legacy traffic-secret links and unsupported modes are rejected.
The exact accepted full URL is returned for the ordinary review/admission flow.

This changes no circle wire format. The current checkout pins fold-kit
`eaa3495127e55242cf8a09e4c57963c570d68e8d`; its parser remains authoritative.
Raw temporary key and plaintext byte arrays are cleared on completion.
JavaScript strings and the browser's non-exportable CryptoKey have their usual
garbage-collection lifetime; this is not a claim of deterministic memory erasure.

## Verification

[Shared synthetic vectors](../vectors/short-invitation-envelope.json) cover
meeting v2 and persistent v3 invitations, generated with an independent Node
AES-256-GCM implementation. The 34 focused tests open those vectors, independently
decrypt WebCrypto output with Node, and reject changes to ID, key, nonce,
ciphertext and expiry. They also cover expiry at its boundary, lifetime/size
limits, unknown schemas, noncanonical encodings, unsafe targets and fresh
keys/nonces on repeated sealing.

An isolated Chromium 151.0.7922.34 run opened both independent vectors using
browser WebCrypto, rejected altered expiry and produced ciphertext authenticated
independently by Node. It made zero external requests and requested no admission.
No real identity or room was used. These checks establish local codec behaviour;
they do not establish native interoperability, a deployed resolver, phone app
links, messenger opening or physical guest acceptance.

Run the isolated browser check with
`node scripts/check-short-invitation-browser.mjs`. An optional output filename
writes a receipt without overwriting an existing file. The production build and
type-check pass. The full suite passes all 4,135 tests in 292 files with
`npx vitest run --maxWorkers=2`; an earlier default-worker run on the loaded Mac
had four timeouts, retained separately rather than counted as a pass.

Service allocation must supply a fresh collision-checked random ID before
sealing, retain independent owner deletion authority, and enforce its own expiry
and storage/rate limits. Client integration must explicitly review recovered
invitations and keep the full-link fallback. The
[feasibility report](short-invitation-feasibility.md) records the remaining
service, metadata, revocation and deployment boundaries.
