# Separate ordinary Nostr messages

Source preparation for Vennel DG09.6 / G5. **Not compiled, tested, released or
accepted at runtime.** This builds on the separately published legacy-receive
source `17023aa3`; that source and its frozen qualification producer are unchanged.
The branch requires its own candidate/main integration and qualification.

From the ordinary account home, **Start public message** opens a new draft. It
does not import a room's text, link, invitation, membership or route. Enter the
other person's npub and a new message, then choose **Review public message**.
Review reads the configured account relays for both accounts' signed kind-10050
inbox lists. Missing, invalid or empty lists hold sending; no NIP-65 or default
destination substitutes for a missing inbox. The sender's list is required for
an encrypted history copy. This is a bounded observation of available relay
statements, not proof that no newer statement exists elsewhere.

The visible `○ public` chip, separate-public wording and exact destination lists
precede **Send public**. Content is encrypted; the public lane describes the
envelope's route and metadata exposure. There is no automated fallback from a
sheltered conversation. Ordinary, quiet and anonymous room routes remain separate;
this first account view is unavailable inside rooms, calls and account transitions.

Sending creates one unsigned kind-14 text rumor, without application markers or
room data, then separate kind-13 seals and random-key kind-1059 envelopes for the
recipient and sender. Both envelopes are prepared before either is published.
The existing SDK keeps the account key; only ephemeral wrapper keys are local.
NIP-04 encryption and sending are never requested.

The first supported signer path is NIP-07 through the existing pinned
`signet-login@0.19.1` provider-effect boundary. Each actual encrypt/sign start and
handoff rechecks account, expiry, view and contact permission. The SDK's one
transient signing retry is separately guarded. Other signer transports need their
own qualification and remain unavailable here. Reading the SDK tag does not prove
that its published installed artifact executes equivalently.

Publishing uses the existing guarded WebSocket carrier and exactly the reviewed
inbox destinations. A relay acknowledgement is reported as relay acceptance,
never delivery/read by the other person. Partial or uncertain results remain
visible. Only a user-selected retry can resend the identical unconfirmed envelope;
accepted halves are skipped. Nothing migrates back into the sheltered conversation.
An inbox requiring additional relay authentication can refuse this send; no new
authentication grant is silently created.

Drafts and retry envelopes are memory-only for this view. Close, page departure,
account replacement/sign-out and room transitions invalidate pending work and
clear displayed text. Already-started signer operations cannot be cancelled, but
late results cannot publish or repopulate the view. This is not a forensic memory
erasure guarantee or a persistent outbox/recovery implementation.

Written regression sources cover ordinary rumor contents and sender copies,
missing/newly empty/forged inbox lists, signer refusal or substitution, stale
provider starts, blocking, cancellation, bounds and exact-envelope retry. Both
asymmetric acknowledgement orders now have source cases: a retry must reuse only
the exact unconfirmed envelope and must not sign or encrypt again.

Additional source checks use the installed `Nip07Signer` class with a disposable
in-process provider: an account/view change during encryption or signing rejects
the late handoff; a transient signing retry has both a still-current positive
control and a cancellation refusal. The class import is not a replacement SDK
implementation, but these sources have not executed and establish no installed
artifact equivalence or actual extension acceptance.

The built-client browser source now includes pending encryption and seal results
across close, sign-out and home departure. A new draft must survive an old result.
The exact ciphertext or seal ID must reach the browser provider completion log
before the SDK return path is checked. Sign-out and home-departure cases invoke
actual root DOM handlers programmatically while the modal is open, explicitly
bypassing pointer modal blocking. They do not replace account state or call a
private app API. The original post-close sign-out control is retained separately.
All cases stay in the existing registered browser spec and have not run.

`nostr-message-relays.test.ts` supplies signed inbox statements in-process, then
uses the actual message controller, `RelayConnections` and guarded carrier against
real loopback WebSockets. A delayed HTTP upgrade has a successful-send control;
close, account change and recipient block must leave both inboxes without message
writes. It checks the composed cancellation mechanism, not which of the write
guard or cancellation poll wins a race. Defaults must not be contacted and relay
challenges must not create new AUTH grants. This is not an actual app lookup/UI,
external-client receipt, raw network privacy or persistent-retry proof. Existing
shared-carrier and default-borrower tests remain separate and unchanged.

The browser cases reuse the existing synthetic NIP-07 provider and default-relay
WebSocket redirection fixture. They are **not** external-client interoperability.
The separate C04 observer source at Vennel `2b49c3a2` requires unchanged Coracle's
real receive/decrypt/render path, actual KithMoot sender controls and warning,
original fresh builds and a separate isolated recipient relay without WebSocket
replacement or receiver state/event/DOM injection. Its first source pin remains
KithMoot `b87dc844`; selecting a newer candidate requires explicit pin/provenance
reconciliation. Neither C04 source preparation nor these regression sources are
runtime acceptance. Actual app lookup lifetime/boundedness, authenticated shared
borrower composition, additional transitions/platforms and fresh candidate/main
integration remain qualification obligations.
All remaining Vennel goals, supported signers/platforms, ordinary receive/history,
private transport, release, physical and outside-review gates remain open.

Protocol references: [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)
and [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md). UI wording
follows Vennel's existing `docs/brand-voice-states.md` separate-public state.
