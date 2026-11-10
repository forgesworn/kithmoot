# Let the same owner keep a room from another device

Status: design proposal, 9 November 2026. No keeper synchronisation, key
transfer, new endpoint or production enablement is implemented by this note.

## Required behaviour

An owner signed in on their web, desktop and Android devices can recover the
authority for an existing room and accept a join request there. They keep the
same room, conversation history and participant identity. A request must say
whether it is awaiting a keeper, has expired or failed to reach the node.
Signing in must not leave somebody assuming authority was restored when the
signer or the authority transfer is still unavailable.

## Why the current account login does not do this

`app/src/node-room-runtime.ts:createBrowserNodeRoom` creates a random room
authority key distinct from the account and device keys. It saves that key
before enrolment. `BrowserNodeRoom.authoritySk` in `app/src/node-rooms.ts` is
optional: an admitted device has a room secret and device grant but usually
has no keeper authority. `openBrowserNodeRoom` opens its keeper inbox only
when that authority key is present. `src/kithmoot-node.ts:nodeKeeperInbox`
requires the exact public authority pinned in the signed node descriptor.

The joiner's account credential binds its participant and device. It is not
permission to sign somebody else's grants. `src/node-admission.ts` also keeps
a durable membership, removal and grant journal; copying only a root key to
another app would leave that second keeper with incomplete revocation state.

The same npub on two devices therefore establishes the same account, but
does not currently restore the independent room authority or its journal.
Neither signing out nor creating a replacement room repairs this gap.

## Proposed bounded first implementation

1. Establish a versioned keeper recovery package bound to the account,
   original room, exact signed node descriptor and authority public key.
   Include the room reading secret, epoch floor and the journal state needed
   for recovery. Exclude the source device's identity key, network pairing
   secret, unrelated rooms and signer connection credentials.
2. Make the package end-to-end encrypted to the owner's account and keep its
   ciphertext on that owner's private node. Authenticate both storage access
   and the package's room authority. Feature-detect the account signer's
   encryption/decryption support; an unavailable or refusing signer leaves
   recovery pending and retains the existing working keeper.
3. Restore through an explicit authenticated owner-device flow, with the
   signer doing the necessary decryption. Verify every binding before an
   atomic local commit. Preserve the target device's own room identity and
   grant. Report exactly which existing rooms acquired keeper authority.
4. Add a shared, monotonically versioned membership/removal journal before
   enabling simultaneous keepers. Every admission, renewal and removal must
   reconcile its current version. A stale keeper may not re-admit a removed
   participant or recreate revoked grants. This requires a defined protocol
   extension and server-side conflict handling; current per-profile journals
   alone are insufficient.
5. Retain the source keeper until the target has decrypted, committed,
   reloaded and demonstrated a real admission. An interrupted transfer is
   retryable and must not replace the source authority, room or history.

The initial transfer is full room authority: any device that receives a root
key can retain it. Account sign-out or deleting a recovery ciphertext cannot
revoke a copy already made. Independent revocation of keeper devices needs
either authority rotation or a separate, revocable delegated-keeper protocol.
Do not present device sign-out as that protection. Decide and document this
custody model before implementing automatic restoration on account login.

No ForgeSworn recovery service, public relay backup or server-held decryption
key is proposed. The private node would gain encrypted recovery material and
journal metadata; that new retention and access contract needs documentation
alongside the protocol and client changes.

## Regression and acceptance gates

- Reproduce the present gap with two isolated profiles on the same synthetic
  account: the creator can admit, the ordinary admitted profile cannot open
  the authority inbox, and the node refuses a forged keeper signature.
- Transfer and cold-reopen an existing room on web, desktop and Android.
  Verify unchanged room, participant, target device key and retained history.
- Refuse wrong account, room, descriptor, authority, epoch, expired package,
  malformed ciphertext and unsupported signer operations. Never persist
  partial plaintext or log the package, signer secrets or room keys.
- Interrupt each storage, signer and local-commit boundary. Recovery must be
  idempotent; the original keeper must remain usable throughout.
- Race admissions from two devices with a removal from a third. Retry only
  against current journal state; old packages, offline keepers and replayed
  requests must not undo a removal or reset.
- Exercise a fresh request, duplicate, cancellation, expired ten-minute
  request and retry after reconnect. A new request must reach every eligible
  online keeper; an old approval cannot admit a different device.
- Explicitly verify the chosen keeper-device revocation behaviour. Package
  deletion and account logout must never be counted as root-key revocation.
- Finish with a real owner restoring authority onto another owned device and
  accepting a separate person's current request. Automated profiles and
  published builds do not replace that check.

Until those gates pass, keep the existing keeper app open for admissions and
describe portability as pending. The Android responsiveness repair and local
call endurance tests do not deliver this feature.
