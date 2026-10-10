# Closed-room admission feedback

The browser host keeps each request visible while its grant is being sent.
Approval is a decision; a successful relay publication is reported as
“Invitation sent”; only the guest's independently validated grant opens its
join controls. None of those host messages claims the guest has joined.

KithMoot pins fold-kit 0.10.0 at `babacfb0fdf17b68cb9f77bc3805ce68c151961f`,
which supplies correlated grant publication/failure callbacks. The wire
envelopes remain compatible. Requests keep separate identities even when
guests supply the same name; their cards show the request-signing device and
identify names/accounts as guest-supplied claims. Controls remain connected
when another request arrives, preserving keyboard focus and a pointer press.

A rejected grant leaves a failed card with connection/retry guidance.
Dismiss only removes that card; it neither admits the guest nor sends a
decline. The guest can deliberately retry from its existing timeout screen,
retaining its entered name. Leaving the host room cancels pending decisions
and timers; a decision rechecks the originating session, room, invitation and
contact policy before authorising anything.

The [10 October automation receipt](evidence/admission-grant-feedback-2026-10-10.json)
records the reproduced false-success message, the complete unit suite and
Chrome/Firefox/WebKit/desktop-build checks with synthetic guests and a local
signature-verifying relay. It is not native Android or physical acceptance.

G17 remains open. Guest cancellation, distinct authenticated decline/offline
states, concurrent-host reconciliation, admission from another conversation,
native Android composition, expiry/revocation qualification and unfamiliar
guest/host observation still need complete journeys. The current request
does not cryptographically bind a claimed account to its signing device;
automatic admission based on an account claim needs verified account/device
proof before G17 can be accepted. Displaying a claim label is insufficient.
