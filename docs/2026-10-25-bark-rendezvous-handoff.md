# Bark rendezvous handoff (development only)

The browser MLS preview can provision its rendezvous child through Bark's typed
`window.nostr.heartwood.provisionRendezvousV1` operation. The supporting Bark
source is `54c9a7dbe44af9e05f240ff841b361c2837638ef`. Reconnect the NIP-07 account
with that extension available, enrol its protected persona and paired witness,
then use **Review Bark device provisioning** in the development room panel.
Select a new child index and approve the displayed account, application device,
index, nonce and expiry in Bark and Heartwood. This route retains the production
MLS gates and does not change the pinned production WASM bundle.

The application creates a dedicated transport target in its existing sealed,
witnessed persona record. Only its public key is exposed after the protected
transaction is acknowledged. Bark receives exactly the selected persona,
public target, numeric index, nonce and expiry. It returns the existing encrypted
Heartwood envelope; it never returns its retained NIP-46 client secret. The
application decrypts with its protected target and the envelope's rendezvous
child public key, checks both public and encrypted request bindings, and
installs through the existing encrypted rendezvous vault. Room custody obtains
an opaque public device reference from that protected record. A structural
copy or a caller-supplied public key cannot replace that reference.

Provider, receiver, callable, account, foreground and protected-vault revision
changes hold the operation. Missing witness acknowledgement prevents target
exposure; a fresh coordinator can reconcile the durable candidate. Missing
protected target state during a response never generates a replacement target.
Sign-out and account forgetting clear the saved rendezvous child through the
existing lifecycle. The target remains sealed inside the persona installation.

The focused Chromium fixture uses actual coordinator, vault, custody, Rust WASM
and room operations with a synthetic typed extension transport and signed
witness/node transport. Its response uses real NIP-44 from a disposable CHILD
scalar to the actual protected application target. It checks actual room
creation, provider/callable/account changes, late expiry, nonce and encrypted
index mismatches, witness unavailability, target acknowledgement loss, opaque
reference rejection, restart and full-profile/invitation-profile coexistence.
This is application composition evidence; it does not exercise a physical
Heartwood, a built Bark extension connected to this application, or native
Link/Bothy mixed-client messaging.

The provision record's `e` (retained as receipt `expiresAt`) is the encrypted
handoff acceptance deadline, bounded by Heartwood to 600 seconds. Once accepted,
the protected child remains available for local restart and permitted derivation
until rotation, revocation, sign-out or loss of its protected state. It does not
inherit that short handoff deadline. Receipt metadata and exact index bindings
remain intact; replacing/clearing the child still invalidates held custody before
waiting for its lock. Room, credential, invitation and per-operation deadlines
remain independent and enforced. Missing state never triggers automatic
reprovisioning or a replacement child.

Focused Chromium fixtures advance past the accepted deadline, reconstruct the
protected vault/coordinator/room runtime, then create both room profiles with the
signer offline and perform real invitation ECDH through the Rust WASM engine.
Expired unaccepted replies, currentness changes and clearing still hold. This
is synthetic browser composition evidence, with physical signer and mixed-client
acceptance still outstanding. Production remains disabled.
