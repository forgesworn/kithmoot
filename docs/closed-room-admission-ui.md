# Closed-room admission feedback

Temporary-room hosts keep a separate card for each request while an invitation
or refusal is being sent. Cards show the signing device and distinguish a
verified account signature from an unverified claim. Matching signed account
proofs can qualify invited accounts for automatic admission; a bare account
claim cannot. Duplicate names remain separate requests.

KithMoot pins fold-kit 0.12.0 at
`dc51766b7e6a141d5ba8aa0e5421df86432a7412`. Explicit Decline sends its encrypted
version-3 refusal to the guest device, bound to this exact request and current
root/delegated responder authority. It contains no room secret or new authority.
Legacy grant envelopes and invitation URLs remain compatible; an older guest
ignores the new refusal and keeps its bounded wait.

Host feedback waits for relay acknowledgement. A failed refusal remains visible
with Retry decline and a separate local Dismiss. Retry uses the same signed event;
it does not renew the response clock or switch the decision into a grant. The
guest independently authenticates a refusal before showing Your request was
declined, closing the waiting subscription and stopping request retries. That
state exposes no room contents or join controls, retains the entered name and
explains asking the host before deliberately trying again.

A successful relay publication means Invitation sent or Refusal sent; it does
not establish guest receipt or entry. A refusal cannot revoke an already received
grant. With concurrent authorised hosts, the first validated response wins.

The [refusal automation receipt](evidence/admission-refusal-2026-10-10.json)
records 3,740 unit tests and 60 browser journeys across Firefox, WebKit, Chromium
and desktop Chromium. The tests use a local signature-verifying relay and cover
held acknowledgements, rejected replies, immutable retries, saved names, unsent
host drafts and existing signed-account/private-room admission. These are
synthetic browser results, separate from Android and physical acceptance.

G17 remains open. Guest preview, cancellation, offline/reconnecting states,
admission from another conversation, complete native composition and unfamiliar
guest/host acceptance remain. The refusal attempt checks source room, epoch,
invitation, transport, contact policy and expiry before publication and after
acknowledgement. Navigation, retirement and invitation replacement close the
invitation transport. A write-bound guard for delayed connections and the
transport's background retries still needs qualification before this browser
change is released; a post-acknowledgement check alone cannot retract a reply.
