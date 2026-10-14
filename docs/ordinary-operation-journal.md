# Ordinary operation journal: source boundary

This is an unmounted local custody format and a generic owner barrier. It does
not implement the durable producer, page or browser-process recovery, current
membership authority, independent rollback protection, or deployment acceptance.

The format has five phases: prepared, provider-started, provider-returned,
candidate-committed and settled. All ordinary owner paths classify all reserved
control rows under the origin-wide write lock before running callbacks, entropy,
migration or expiry. An active, missing, mixed or unauthenticated journal holds
ordinary work. The lock is not retained across provider work; the durable barrier
must remain until an exact private continuation settles the operation.

The exact stages are predecessor P, enrolled E, credential candidate C and
settlement S. Both E revisions equal P+1; both C revisions equal E+1. Settlement
must atomically write both S frames and a compact control, with S revisions C+1.
The journal binds exact P/E/C frame digests and revisions. E/C markers carry a
null commitment. S markers carry a domain-separated binary SHA-256 commitment
binding id, tab, sequence, P/E/C digests and revisions, request/result digests,
canonically sorted native scopes and immutable ceilings. Every subsequent
ordinary mutation preserves these markers byte-for-byte. Generic settled reads
require equal browser/tab markers, the matching control commitment and current
revisions greater than C. This avoids putting a frame's own digest inside itself.

A control encrypts byte-identical packets under the actual browser and tab
nonextractable AES keys, with distinct purpose/key/generation/expiry AAD. A
packet contains a bounded canonical classification header and a length-delimited
opaque body. Generic classification parses only the header, checks exact lengths
and request/result byte digests, and wipes decrypted packets. It never decodes
producer strings or copies key material. Private producer decoding returns owned
32-byte key arrays, which its caller must wipe. Prepared carries no keys/nonces;
provider-started and provider-returned carry both; candidate-committed strips
them; settled has no body and retains immutable request/result commitments.

The still-required producer must commit both enrollment markers and prepared
control atomically before invoking a provider. Restart after provider-started is
unknown and must not invoke the provider again. Provider-returned retains the
exact signed response and private candidate material. Candidate commit and
settlement each require exact three-record reconciliation after a lost native
completion. Only after freshly authenticating S may the private controller
synchronously adopt S and resume. It must never resume between C and S.

Known settled expiry must atomically remove the tab, its control and its browser
marker. The private settled-expiry writer now authenticates the complete store,
validates exact effective browser/tab images offline, and queues one browser
marker removal plus tab/control deletions in a single native transaction.
It preserves all other effective pending records, fences and migration metadata.
Capacity is checked before the single fresh browser nonce. Every attempted write
is reconciled against whole-store exact prior/target classifications; prior is
HOLD, mixed/unavailable state retains the original candidate until a read-only
retry establishes exact facts. Closing the retained owner joins this uncertainty.
Active, unknown or malformed history still holds before cleanup entropy. There is no public journal write exemption or raw
Session adoption facade.

The current native fixtures exercise custody classification, phase refusal,
corrupt/mixed rows, settled commitment alterations, multiple controls, preserved
markers during later writes, ordinary pending frames, storage limits, and
close/live/version-change cuts during control decryption. Fixture enrollment is
not a production producer. Same-page fresh-owner tests are not process-restart
acceptance. Actual producer fault cuts and real process restart remain required.

Complete app composition now routes canonical markers as protected records,
then requires marker metadata from the same genuine pair custody token. Raw
copies and projections that add, delete or change markers remain held. The
metadata is provenance only and cannot advance or recover a phase. Consumer
reads also compare exact encrypted control digests in their own coherent native
transaction; a changed, missing or newly inserted control cannot inherit an
earlier classification. The producer still must reauthenticate control payloads
and exact owner frames in each fixed transition transaction.

A lower-layer lifecycle-root verifier is backed by a module-private WeakMap. It
accepts only the actual sole quiescent lifecycle root, with no children, a live
body and current generation. It has no registration/mint API and returns no
execution or journal capability. This check proves graph ownership only; the
fixed producer must separately establish native custody and current authority.
Owner-to-bootstrap imports and generic writer exemptions remain excluded.

Historical cleanup uses only retained navigation, bookmarks, room links and
creator evidence; the current page URL cannot rescue orphaned access or poison
independently bound custody. Origin-bearing Signet and initial-login records
must agree on one canonical retained origin, then pass their existing strict
shape/signature checks. This proves historical internal consistency only, never
current-origin authority. No-origin images use a sentinel only for otherwise
empty origin-bound checks. Historical tokens are structurally excluded from
live binding, projected sizing, reads, resources and commit receipts. The fixed
composer module loads before the lock/transactions, avoiding a static owner
import cycle; no public writer exemption, callback registration or token mint
interface is introduced.

The native fixture cuts cover all eight old/new combinations of the three target
records, changes to another control before writing and before reconciliation,
lost completion/offline readback, joined close, and cancellation during each
writer authentication. Version-change handler cuts invoke the handler directly;
separate actual version-2 upgrade-event cuts also exercise every cleanup
writer authentication boundary.
Fixture journal enrollment remains distinct from the unimplemented producer,
and these tests do not establish page/browser-process restart or production
startup acceptance.


Durable renewal preflight now computes a separate domain-separated commitment
of the complete acknowledged P images: owner roles, purpose/keyId/generation,
revision/expiry, code-unit-sorted records and fences, and migration metadata.
Original frame digests bind the encrypted enrollment transaction; this semantic
commitment permits verification of a strictly inverted E projection without
reproducing old ciphertext nonces. The future bounded request must persist this
commitment and the exact prior marker/fence presence and values. Persistence and
inversion during actual startup remain unimplemented.

The existing renewal controller now compares this complete commitment around
provider waits, including fields outside the selected room/record projection.
Its owner capacity check reserves fixed E=P+1, C=P+2 and S=P+3 images, marker
replacement/addition, future settled commitment, scoped fence slots and revision
digit growth before seal allocation/signing. These are sizing placeholders only:
no E/C/S journal phase is written by this preflight. Journal-phase/body/result
reservation, the actual fixed enrollment/provider continuation, C/S settlement,
factory obligation binding and process-startup reconstruction remain required.

The current WIP adds a factory-local, one-use renewal obligation. The registrar
has one production callsite in the private bootstrap constructor; its capture
closure remains a private field and is called only from the actual suspended
renewal root's authenticated P read. It binds the exact factory, owners/scopes,
participant/account/room/device/proof/lease, authority, source semantic and frame
digests, and root. It does not grant a phase exemption or expose an arbitrary
callback, raw frame or journal writer. Mutation/historical reads, fabricated
objects, reused/completed roots and revoked foregrounds are refused.

The specialised owner enrollment consumes that obligation, reauthenticates P
and all control topology, revalidates fixed semantic refs and owner/journal
budgets, then commits exactly E-browser, E-tab and prepared control atomically.
Prepared control carries no seal/C nonce material. Every attempted write is
classified against the complete exact prior/target store; mixed/unavailable
readback keeps the original frozen candidate, Web Lock and both owner obligations
until a custody-only retry establishes facts. Definite prior is a typed abort;
a returned E handle supplies no provider or Session-adoption authority.

The bounded versioned request stores complete P semantic/frame commitments,
immutable typed refs, original source headers, the exact prior settled marker and
control classification/digest, and fence presence/value. Its inverse accepts
only exact E=P+1 with the new prepared marker and specified scope cells, restores
only those cells/markers/revisions on owned authenticated copies, then verifies
the complete P semantic commitment. Original P AES nonces are never replayed.

Native enrollment fixtures insert the fixed enrollment call into the actual
private factory renewal body and keep that root paused for observation. The
normal renewal body still uses its earlier paired commit: enrollment integration,
private provider-started continuation, exact result retention, C/S transitions,
startup reconstruction and process-restart acceptance remain unimplemented.
Production remains unmounted; the test observer is not a shipped producer.
