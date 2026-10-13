# Persistent member invitation custody

This is an unpublished source adapter for an already prepared room device.
`OrdinaryPersistentAdmission` runs the real Fold-kit persistent invitation
evidence query and retains its result in native encrypted browser/tab custody.
It is not mounted in `main.ts`. The existing main cache writer is extracted
unchanged into `admission-store.ts`; its current production wrapper still uses
session storage. No production protected-bootstrap claim follows from this
change.

The caller supplies an authorised transport, the original account (or explicit
visitor-null), actual participant, persistent capability, expected room root,
room ID, keep choice and foreground selection. Opening requires existing strict
room metadata, a verified room device and signed credential records. It does
not invent a device, dial defaults, create a relay pool, publish an admission
request, or fall back to plaintext. New-member device construction and creator
publication intent remain separate work.

## Query and atomic retention

Opening captures both invitation deletion fences and generations. Before the
network query, the adapter strictly composes both owners' actual access,
bookmark and navigation records, verifies the selected stored room link and
keep choice, and captures the exact access/proof/cache/fixed-list sources and
public device fingerprint. The network query runs without the storage Web
Lock. Its result is independently revalidated against the captured capability
and root inside the final pair mutation. Source changes, lifecycle loss or
forgotten scopes hold the original images.

The proof retains canonical signed source events, contributor IDs and the
derived root, earliest conference end, sticky destruct and unambiguous newest
relay list. Its domain/version operation hash covers the capability, actual
participant/account, room/invitation, browser generation/fence, tab
generation/fence/purpose/exact lease, device public key, signed credentials,
credential-derived seal public keys, observed epoch/public epoch IDs, keep
choice and original kept timestamp. Reload recomputes the entire canonical
proof and independently verifies the signed invitation events; the hash alone
is never evidence.

The actual `storeKeptAdmission`, `storeTabAdmission` and
`RelayConnections.setRoomRelays` writers run over revocable private views.
Fixed relays are marked signed only for a retained nonempty relay contributor
set and its exact selected list. Both images are sized before either nonce,
sealed separately and installed in one authenticated native transaction.
Uncertain acknowledgement holds the same pair; retry does not rerun the query,
callback or encryption. No admission escapes before acknowledgement and final
selection, credential expiry, conference end and tab-lease checks.

With keep enabled, the browser stores one proof slot per invitation/tab
purpose and the tab stores its exact reference. An unchanged shared kept
admission preserves its timestamp so another live tab is not orphaned. Each
invitation/participant has at most 64 browser proof slots; refresh replaces its
own slot and may remove expired other slots, without evicting a live one.
Each canonical proof is bounded to 1 MiB. Fold-kit also enforces its own event,
per-event and aggregate query limits before reload or crypto work.

With keep disabled, complete proof data stays in the encrypted tab image.
Browser record contents are unchanged: no membership/evidence/fixed signed
list is added. The pair primitive still installs a new encrypted browser frame
and revision. Existing durable membership requires explicit forget before
changing this choice; a bare legacy signed fixed row holds, even if its list
matches. Legacy encrypted cache rows can be upgraded only with exact root,
mode, epoch, end and destruct claims, valid writer shape/timestamp and an exact
legacy signed list. This does not claim cleanup of external raw storage.

## Historical evidence and recovery

Proof credentials remain independently verifiable historical signed events.
Selected-tab restoration requires the same currently verified room device,
retained seal keys for replaced credential seals, a currently usable
credential, and a matching retained observed epoch ID. Zero-to-later continuity
requires retained zero-root history; a v1-only advance cannot supply it.
Activity timestamps are not device identity. Epoch keys, secrets and past
secret strings are not copied into proofs or public device fingerprints.

Unselected browser proofs supply only historical signed invitation/fixed-list
custody. Their old credential/seal/epoch history does not poison current
startup after bounded histories roll forward. A selected proof lacking current
continuity holds load and preflight. Opening exposes no admission and permits
an explicit fresh query to refresh that selected proof, including after
restart. This local continuity check is not independent antirollback evidence
or current membership/rekey authority.

Full-image preflight accepts proof-bearing images only with an opaque custody
token issued inside a live native pair callback. Exact record matching and
authenticated browser generation/fence plus selected tab
generation/fence/purpose/expiry prevent copying a valid proof into a recreated
owner. Tokens expire when the callback ends. Preflight releases counts, not
keys, permission, relay choices or a current session.

Forget removes all of this participant's browser invitation proof slots,
kept admission and the current tab's admission/proof, while incrementing both
captured invitation fences in the same commit. It removes the room's fixed
list only when no other browser proof for that room remains. The adapter
aborts its query and wipes its owned capability/root copies. Other tab images
are not physically erased by this two-owner operation; their old browser fence
must prevent subsequent effects. Fresh opening after forget requires an
explicit choice and new capture.

EOSE is one local completed observation, not proof of global nonretirement,
current keeper authority or current MLS membership. Immutable JavaScript
strings cannot be erased. Current membership/rekey evidence, independent
continuity storage, complete protected ordinary startup/effect adapters,
creator and first-join flows, browser/Android MLS, physical acceptance,
publication and production installation remain open gates.
