# Native initial extension login

`OrdinaryInitialLogin` is an unmounted controller for an explicitly requested
first NIP-07 login. It requires completed native browser/tab migration, a live
foreground generation, old-client checks and the versioned SDK headless-boundary
contract. Opening requires an absent SDK session and no other pending SDK login.
An existing authenticated session needs the separate guarded restore path; it
is never silently replaced by this controller.

The exact tab key `kithmoot.initial-login.v1` belongs to the `initialLogin`
physical family. Its canonical record binds the NIP-07 method, origin, app,
challenge, selected account or authenticated absence, creation/expiry, and both
native generations and `@ordinary-signet` fences. The full image composer
requires real paired native provenance, matching current headers, no overlapping
SDK session/redirect/relay login, and the exact tab owner. The record is pending
protocol state, not signed identity, room membership or current MLS admission.
Expired or interrupted records remain inert; no time pruning or automatic retry
turns them into absence. Old/new-client fencing remains a root-entry obligation.

Both projected images must have room for the pending record, reserved fences
and the maximum fixed login-proof/session shape before challenge entropy or
provider effects. Sizing uses placeholders only; they are never retained or
accepted as cryptographic evidence. A real random challenge is generated under
a fresh complete native decision, then acknowledged in a paired mutation before
extension account discovery. The actual discovery callback starts synchronously
under another complete native decision; waiting and joining take place outside
the origin lock. The selected account is acknowledged in the pending record
before signing. Every SDK signing attempt and proof handoff uses a fresh paired
read, exact pending/SDK bytes, client checks, capacity and lifetime checks.
A legitimate transient provider error can retry through a new decision; a
native refusal cannot permit another prompt.

The independently verified proof and account/method are committed as the exact
SDK session partition in the same native transaction that removes the pending
tab record. Unknown retention stays joined through the owner's reconciliation
protocol. The controller opens the established-session foreground adapter only
after acknowledgement and a fresh native read. Only that adapter's frozen
session escapes; consumers never receive the raw SDK wrapper. The caller must
adopt this session into the coordinated root, increment the foreground generation
on selection/reset changes, and close this controller on exit.

The controller owns the raw SDK wrapper, revokes the foreground synchronously,
joins initial and foreground operations, then closes the raw wrapper. Closing
either native owner joins registered provider work. Tab lifetime expiry also
revokes/closes this controller. A provider must not await the close that joins
its own request. The operation latch precedes caller selectors and rejects
concurrent or reentrant initial login. Failures expose no session; retained
pending bytes remain available for explicit cancellation/recovery.

`cancelPending` requires a fresh live native pair and full semantic preflight.
It removes only a verified pending record and advances both SDK fences in one
acknowledged native mutation. Old unabortable wallet work is still joined by its
owner and cannot hand off through the old fences. Cancellation cannot remove an
already promoted SDK session, invent a successful absence, or authorise other
pending login methods. After cancellation a new explicit attempt uses the new
fences and a new challenge. The actual tab lifetime and cleanup/reopen topology
remain owned by the coordinated tab runtime.

Tests use real IndexedDB, Web Locks, AES-GCM and the complete image composer.
The extension backend is synthetic. Source/package/automated-browser evidence
does not prove real-wallet behaviour, deployed root mounting, registry release,
independent anti-rollback continuity or physical acceptance. Guarded session
restore, the modal, redirects/Amber, initial NIP-46 connection, management and
transport frames, tab/credential renewal and the remaining root consumers remain
open. The installed SDK is an exact recorded development candidate; the current
registry dependency does not reproduce it. Production MLS and DG08 completion
remain held until their separate gates pass.
