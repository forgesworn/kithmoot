# Explicit member device custody

This source checkpoint adds the custody grammar needed before an ordinary
persistent invitation can bootstrap its first member device. It is **not mounted
in the production entry flow**. The separate
[first-member bootstrap](ordinary-persistent-bootstrap.md) now implements incoming
device/credential creation, paired admission retention and actor-scoped forget
over this grammar. Guarded admission queries and tab epoch lifecycle remain open.

## Proof formats

V1 remains exactly `kithmoot/persistent-admission-proof/v1`. Its device fingerprint
always denotes browser custody, including an existing prepared browser device
when the admission choice is `keep:false`. V1 canonical bytes stay readable; the
reader never searches tab storage to reinterpret its owner.

An explicit `deviceCustody` input selects V2, whose operation domain is
`kithmoot/persistent-admission-proof/v2`. It contains either a browser room scope
or a tab room scope. Both bind `room:<roomId>`, the owner's generation and the
room deletion fence. A tab scope additionally binds the exact native tab purpose
and lease expiry. These are authenticated custody headers, not caller assertions
of membership, entropy, transport consent or independent continuity.

V2 browser devices require `keep:true`. V2 tab devices require `keep:false` and
an epoch-zero fingerprint with exactly its original room ID. Credential expiry
must not exceed the signed admission end, or the tab lease for tab custody, and
must follow the proof's retained timestamp. These historical checks do not make
expired credentials currently usable; the forthcoming effect adapter must
recheck wall-clock lifetime before signing, commit and return.

The V2 browser and tab physical names use `invitation-proof.v2` and
`admission-proof.v2`. Browser proofs retain one logical slot per participant,
invitation and tab purpose across both versions. Selected tab proofs retain one
logical slot per participant and invitation across both versions. An explicit
successor transaction must remove the previous version. No automatic upgrade or
choice change occurs. The V1 admission adapter refuses a matching V2 record at
open, source reads and forget, preserving it for the V2 lifecycle.

The maker reconstructs binding and scope fields before hashing. Caller property
insertion order cannot change canonical proof bytes. Strict reload independently
revalidates the actual signed Fold evidence and the bound room secret, then
checks operation and exact bytes. EOSE remains a bounded local query observation;
it supplies neither global absence nor current admission or keeper authority.

## One identity topology

The paired identity validator checks browser and tab records together. The
participant and secondary credential remain browser-only. Tab identity grammar
allows only exact account-scoped device, device-owner, own-credential and
own-seal names. It refuses duplicate physical names, split account/room groups,
legacy/scoped aliases, repeated device public keys and shared seal histories,
including conflicts under different physical names in the other owner.

The complete composer requires each tab device to have a selected private V2
proof, exact current device continuity and matching native room scope headers.
Signed relay evidence remains in the tab proof. Any browser fixed-relay row for
a V2 tab device, whether signed or unsigned, holds the image. Once that tab
custody expires, the browser can retain a `keep:false` room link and its global
participant without orphan device, admission, proof, fixed-relay or room-secret
records. Reopen with a fresh empty tab validates that remaining browser image.

Tab epoch records are still refused. Browser epoch records cannot supply an
epoch for a tab device. Production mounting remains gated on the tab-local epoch
lifecycle as well as the actual first-member bootstrap adapter.

## Remaining bootstrap work

The separate bootstrap source implements the following requirements; production
integration and authority gates remain open. It must preflight the complete native pair and projected capacity
before device/seal entropy. It must start credential signing synchronously inside
a fresh paired read, await outside the origin lock, and repeat exact-image CAS at
commit. It must use actual Fold credentials and writer formats, avoid pruning
other retained tab rooms, retain identity/admission/proof together, and hold the
same candidate through unknown native acknowledgement without re-signing.

It must wipe provisional and late buffers on refusal, recheck lifetime before
return, and atomically forget tab identity/proof/admission with both invitation
fences. Two competing tabs can both pass preflight and sign before one loses CAS;
a global sign-once claim needs a durable shared reservation. Protected query
carrier consent, runtime mounting, current authority, independent antirollback,
Android/browser MLS, Tor and physical/release acceptance remain separate gates.

## Validation

The native browser spec exercises actual signed Fold credentials and evidence,
actual IndexedDB paired retention, Web Locks, non-extractable key/AES-GCM custody
and reload in Chromium, Firefox and WebKit. Its migration from prepared V1 data
to V2 is an explicit test fixture, not a production bootstrap implementation.
The expiry/reopen case closes the selected owner and opens a different empty tab
owner; it checks the post-expiry browser topology, without claiming physical
browser lease pruning acceptance. No external relays, physical Tor or Android
acceptance is supplied by these checks.


The incoming bootstrap extends V2 invitation scope names explicitly to
`invitation:<participant>:<invitationId>`, with matching browser/tab names. Those
names are already authenticated operation fields. Historical global V2 scopes
remain readable; no existing proof is reinterpreted. Bootstrap uses only the
actor form so forget preserves other actors sharing the same invitation.
