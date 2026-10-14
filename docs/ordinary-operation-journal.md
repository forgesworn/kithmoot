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
marker. The current generic expiry path holds whenever controls exist; it cannot
silently erase this history. There is no public journal write exemption or raw
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
