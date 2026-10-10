# Guest admission preview

An uncached temporary-room invitation opens a local review screen before sending
an admission request. Guests can edit their name and deliberately preview their
camera or check their microphone level. Opening the link starts neither check.
These tracks stay local, are separate from call tracks, and stop on Request to
join, Close invitation, document hiding or navigation. A permission completion
after cancellation releases its stream rather than attaching it to the screen.
Permission denial explains the check and leaves Request to join available.

Request to join, or Enter in the name field, starts one bounded request. Repeated
actions and overlapping relay retries reuse that request. The screen distinguishes
signer preparation, sending, relay acknowledgement and reconnecting; an
acknowledgement means the relay accepted the request, not that the host admitted
the guest. After an acknowledgement, ordinary periodic retries do not flash back
to Sending. A later failed retry shows the connection state again.

Cancel request stops the helper and its owned reply subscription. Delayed account
signatures cannot publish afterwards; delayed grants cannot cache admission or
open the room. The name remains available for a deliberate retry. Closing before
Request to join explicitly says that no request was sent. Retrying reopens the
review screen and requires another explicit request.

Requests use the guarded carrier, checking the originating room, account,
navigation generation, invitation and deadline immediately before writes.
Carriers without this guard fail closed. A request already sent cannot be
retracted: the host may still see its pending card until it expires. Cancelling
on the guest device does not revoke a previously issued room capability.

Saved admissions and persistent-group invitations retain their existing return
journeys. Opening a private invitation from the room list makes the review form
interactive while room switching waits for the guest; the rest of the room
remains unavailable until admission completes.

G17 remains open. No authenticated host-online heartbeat exists, so a timeout
cannot prove the host is offline. Complete host-offline/expiry guidance, native
preview parity, anonymous temporary-meeting creation, admission while a host
views another conversation, and unfamiliar-person/physical-device acceptance
remain separate work. Browser emulation and synthetic media do not establish
physical camera, microphone, suspension or mobile permission behaviour.

The [automation receipt](evidence/guest-admission-preview-2026-10-10.json) records
the tested revisions and scopes: current-main type checking and 3,843 unit
cases, the wider admission regression, final preview/private-room checks in
four browser projects, direct outbound-event/peer-media checks and light/dark
phone measurements. Physical acceptance and production publication remain open.
