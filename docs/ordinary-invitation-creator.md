# Ordinary invitation creator custody

This is source preparation for the protected client. The production PWA does
not call `OrdinaryInvitationCreator`. It performs no relay dial, publication,
NIP-42 authentication or current membership decision. Historical source proof,
local native custody and relay acknowledgement are separate evidence.

`prepare(now)` uses the actual Fold-kit persistent-invitation encoder once,
validates its signed canonical source against the captured capability and room
root, and atomically retains the actual owner and room writer records, signed
fixed relay list, creator proof and pending publication intent in the browser
and tab owners. No ciphertext is returned as retained until the paired native
transaction is acknowledged. Unknown acknowledgement retries that same paired
candidate without rerunning the writer, signer or encryption. Reopen and retry
return the same retained event bytes without restamping or fresh randomness.

The creator proof has its own domain; it does not fabricate member query EOSE
or completion evidence. Its operation hash binds the account/visitor actor,
capability, root, native browser generation and invitation deletion fence,
canonical event, actual link and keep selection, explicit publication
destinations, network profile, source kind and predecessor operation. The
signed room relay list is authenticated inside the event and remains distinct
from publication destinations and unsigned link hints. Exact fixed field order
is required throughout the proof. Secret input buffers are copied before native
awaits and erased on refusal or close. Immutable JavaScript strings cannot be
erased and remain only inside protected owner custody or detached results.

## Transitions

- New-room and DM creation require a fresh room with no conflicting retained
  room, owner, admission, bookmark, creator/member proof or fixed relay row. Possessing
  old keys cannot relabel legacy state as a newly proven creator source.
- Rotation requires the exact selected, fully acknowledged predecessor
  operation for the same actor and root, a different invitation, and an available historical proof slot.
  Its inviter and bearer must differ from every retained creator capability for
  that actor and room. Invitation IDs derive from the bearer alone, so reusing
  a retained bearer also collides with its existing owner/proof slot. It retains the older owner/proof.
  The new selected event replaces the fixed list, or atomically removes it if
  the new invitation omits signed relays.
- Renewal requires the exact selected, fully acknowledged predecessor for the
  same invitation, with a strictly later authored timestamp. It replaces that
  invitation's owner/proof/pending intent atomically and preserves every earlier
  authored canonical source, oldest first. Ends cannot be omitted or extended,
  destruction cannot be cleared, and a previously named relay list cannot be
  omitted on renewal. The new signed list may change.
- Pending or partly acknowledged operations must retry the existing bytes.
  They cannot be replaced by rotation or renewal. A destination set is complete
  only when every exact configured destination has acknowledged that event.
- Forget advances both captured invitation fences in one native transaction.
  Forgetting historical custody preserves a newer selected room. Forgetting
  the selected invitation removes its room metadata and retains a fixed row
  only where the post-mutation selected creator or verified member proof binds
  its exact list and root. Historical creator proofs alone do not retain it.

The caller explicitly captures `predecessorOperation` for rotation/renewal.
A further renewal captures the newly acknowledged operation; reopening the
same renewal selection returns its existing event. Every source row is compared
again inside the paired mutation, so another page changing even a valid routing
row between read and retention causes a hold before candidate encryption.

## Bounds and acceptance

There are at most 64 historical creator proof slots per actor/room and 64
canonical authored events per invitation, including the current event. A proof
also has a separate 1 MiB UTF-8 ceiling. These are refusal limits, not eviction
policies; a packet set can hit the byte limit before the count limit. The native
whole-image capacity gate still applies before AES nonce allocation.

`test/ordinary-creator.spec.ts` exercises actual native IndexedDB/AES custody
in Chromium, Firefox and WebKit, actual encoder and owner/room writer paths,
account and visitor renewal, all signed-list rotation transitions, forgetting
in both orders, exact retries after restart, lost native acknowledgements,
cross-page source-row races, strict canonical tampering, recreated generation,
owned-buffer cleanup and both 64-entry limits. Acknowledged intent fixtures in
these custody tests model already received receipts; they are not relay wire
acceptance or proof that delivery occurred.

Guarded relay dial/enqueue, all-destination delivery, NIP-42 refusal and timeout
handling, old/new client fencing, actual app startup integration, independent
rollback protection and current admission/rekey authority remain delivery
requirements. This source checkpoint does not close those gates or physical
browser/Android MLS and release acceptance.
