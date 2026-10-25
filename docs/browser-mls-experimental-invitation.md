# Experimental invitation adoption

This separate `Vennel/invitation/1` development profile is unallocated and has
not had independent security review. Production MLS remains disabled. Existing
full-profile rooms retain the original WASM runtime, marker, allocation gates
and installation checks. The invitation marker is experimental `0xF0B4`, with
version-3 snapshots and membership policy `all-current-members/1`.

## Explicit development workflow

Start the normal development preview with both `VITE_BROWSER_MLS_PREVIEW=true`
and `VITE_BROWSER_MLS_INVITATION_PREVIEW=true`. In MLS room connection, pair the
dedicated room route, enrol the current MLS device in witness settings, and
provision the browser rendezvous child. Select **Experimental invitation/1**
before creating a room. This choice creates an actual OpenMLS group.

Use the intended person's independently obtained persona, enrolled device,
rendezvous and leaf-home identifiers when issuing an invitation. The vault
shows the complete context and requires fresh purpose-specific consent. It
independently reads strict canonical CBOR, recomputes the invitation domain
and digest, authenticates the original signed leaf/person credential, and
compares the issuer with protected room/device/rendezvous metadata. A durable
per-purpose reservation prevents repeated prompts after interruption; exact
signed retries retain the same signature. Protected transaction revalidation
checks the original credential, revocation, expiry and room binding after
async signing. Reply provenance is an opaque in-memory association.

Export is possible only after the issuer snapshot is witnessed and ACKed.
Recover last saved invitation reopens the protected issued-ID journal instead
of issuing another invitation. Exchange the bytes through an authenticated
private conversation. Paste, QR and operator AUTH alone establish no trusted
inviter. On receipt, enter the expected inviter from a separately trusted
contact or OOB source. The application compares that pin, intended current
persona/device/rendezvous/leaf home, group/home/installation and expiry, and
shows the complete context in a fresh acceptance dialog.

The joiner's context commitment, exact engine session and complete sealed
response are saved atomically under the persona single-writer transaction.
After an uncertain ACK, acceptance first discovers the existing association
and reopens it. Recover exact saved response returns the existing record ID
and envelope, including after a trusted restart; it never reseals or creates
another KeyPackage. An exact retry keeps the same bytes.

The inviter first records the exact response with its witness. A separate
button exports a private 137-byte registration request. A separately
authorised keeper, in their own account and paired node route, registers the
Welcome package and exports the node's signed 201-byte receipt. The current
member imports and verifies that receipt and proposes MLS Add without node
keeper credentials. The application refuses registration
if response acceptance would still require a new snapshot. The keeper request
opts into `registration_receipt: true` on the existing keeper-only PUT; old
nodes without a signed receipt hold before member Add. The receipt binds the
node, installation, package, Welcome mailbox and expiry through a separate
Ed25519 domain. It proves observed registration, not continuing retention.
Neither invitation,
carrier declaration, group creation nor MLS membership grants storage keeper
rights. The experimental room never infers a keeper from its creator or inviter.

Run explicit manual rounds for the Add Commit and Welcome. The joiner signs
its required Update and runs another explicit round before sending. Queue
messages and read saved messages/current engine members through the same
protected room host. Any current member can remove another current member,
including the creator, using the explicit member Remove control. Remove only
changes MLS membership; it does not revoke storage grants.

## Private carrier and currentness boundary

The current UI deliberately supports authenticated private OOB exchange and
one exact paired home box for a bounded demo. The wire keeps the joiner's leaf
home separate from group home. No single-box protocol invariant is introduced.
Private invitation/context/capability bytes are never placed in URLs, public
tags, directories or public relay events. The ordinary box driver holds
`InvitationOob` and unprovisioned `InvitationMailbox` records instead of
routing them into ordinary deposit. There is no `/drops` or bootstrap grant.

Foreground/account/privacy transitions invalidate work and drain actual
signer/client/child tails. Opening a saved invitation session selects its
runtime from protected room metadata. Its protected host installation and
local-anchor hash must match the surviving local installation. Mismatched
installation dispatches `DetectedImport`, missing local anchor dispatches
`DetectedStateLoss`, and a different anchor dispatches `DetectedClone`; the
engine returns a recovery hold. Reading cannot silently recreate a missing
anchor. The local marker is opaque and contains no persona, device or room.
This detects observed discontinuity, not arbitrary jointly restored backups.

The separate development loader pins source commit and exact JS/WASM hashes,
verifies the candidate manifest and bytes, and executes/instantiates those
verified bytes directly. It has no production fallback. The original
`app/public/vmls-wasm` verifier and pin remain unchanged. Artifacts are from
Vennel `fa366b49adcb5ff9b541209fe9ccda31f5d0d15f`; they are development
inputs, not a published release or allocation statement.

## Evidence limits

Independent manual-Python context/hash reference vectors, canonical-reader
and continuity-disposition unit checks, and driver no-deposit negatives are
included. Six actual Chromium cases cover the protected lifecycle, independent
keeper registration and member Add, trusted-inviter mismatch, local marker
loss, missing/forged receipts, initial adoption reply loss with exact restart
recovery, and the real panel's account guards/private-field clearing. The
network-attempt observer includes a positive control. These are synthetic
own-stack checks; a full owner/native-Link UI journey remains separate.

Reproduce the bounded checks with:

```sh
npm run typecheck
node scripts/check-vmls-invitation-wasm.mjs
node scripts/check-vmls-wasm.mjs
npx playwright test -c playwright.mls-invitation.config.ts
```

The production PWA build also passed with both preview flags disabled. No physical
signer/device, mixed native/browser journey, real node routing, independent
security review or production-enable claim follows from synthetic checks.
