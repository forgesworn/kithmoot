# Existing MLS admission intent ledger

This implements counter and request-intent transitions for an already established
sender R inside an existing persona transaction. It is not imported by the app,
and supplies no bootstrap, fresh-R proof, private admission owner or joining UI.
Production MLS remains disabled.

`mls-admission-intent.ts` addresses one domain-separated vault object per R,
binding version, persona, installation and sender R. A missing object always
holds; malformed authenticated state takes the existing invalid-persona fence
path. There is no create, genesis, import, reset, replace-R, deletion or generic
mutation API. The future bootstrap must atomically install legitimately sealed
child custody and this ledger inside the browser's witnessed transaction, under
its separately reviewed signer/browser recovery protocol. Legacy expiring
provision receipts cannot authorise a fresh ledger at counter zero.

The decimal `nextCounter` is the next unburned unsigned u64 value. Reservation
generates operation and challenge with Web Crypto, appends their exact principal,
browser/engine device, credential, time and deadline, and advances the counter
in one transaction proposal. Reserving u64 MAX changes it to `exhausted`.
Numbers, signed conversions and wrapping are never used for counters. Failed,
zero or colliding random draws hold without writing. Metadata times never
authorise expiry, eviction, reuse or reset.

Request binding freezes the exact root, request public key, request event id,
request-core digest, paired box, requested expiry, creation time and deadline.
The actual private owner must validate those fields against its core/event and
promote the binding before signing. They are retained data, not cryptographic
or admission authority. The request precedes the authenticated Allow, so no
adder R or group is guessed or stored at this step. Future answer binding needs
nominal verified Allow evidence and a separate reviewed transition.

Exact request retries are idempotent. Changed fields or owner bindings conflict.
Abandonment is available only before request binding; it permanently retains
the burned counter. A bound request can become uncertain but cannot be abandoned
or rebound. No answer acceptance, completion or terminal transition is exposed.
At most one unsettled row per exact owner is permitted; after an unknown
promotion result the owner must reopen the existing ledger instead of issuing
a second reservation. Device replacement does not rewrite old rows or reset
the R-wide counter.

All rows remain, including abandoned and uncertain rows. The 1,024-row and
4 MiB bounds hold; no compaction or deletion is implemented. Input snapshots
precede asynchronous work. Invalid proposed inputs throw ordinary input errors
and do not label a healthy stored predecessor corrupt. Read/write plaintext
buffers owned by the helper are wiped after use.

These helpers stage proposals through `PersonaReader`/`PersonaTransaction`.
A structural transaction or a returned provisional row is not witnessed proof.
The private owner must use the concrete coordinator under held child/persona
custody, reconcile the witness, await promotion and check current authority
before exposing any reservation or signing. It must preserve uncertain durable
work if promotion or completion acknowledgement fails.

Native tests cover parsing, permanent burns, u64 MAX, immutable request retries,
owner mismatch, uncertainty, capacity, RNG failure and hostile inputs. Browser
tests use actual IndexedDB, native Web Locks and checked-in coordinator WASM,
with signed synthetic witness receipts and a synthetic preinstalled ledger.
They exercise concurrent reservations, lost acknowledgement, reload, witness
outage and whole-profile rollback. Fixture installation is not proof of fresh
R, signer allocation, real first-use genesis, a live witness service or physical
acceptance. Those end-to-end prerequisites remain open.
