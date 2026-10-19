# Private conversations from Signet contacts

The intended journey is **Contacts → find a person → Message**. People need
not share a room first. Signet sign-in already supplies the account signer;
contact directory access remains a separate, explicitly confirmed Signet grant.
Guest invitation joining and existing signers remain available.

## Web and desktop implementation

Contacts is reachable from home, workspace navigation, mobile navigation and
Room details. Search uses only the granted names and public identities on the
device. Blocks win; revoked, unreadable and long-lapsed directories cannot
start contact messages. Names retained after ordinary projection expiry remain
labels only, with no restored tiers or check authority.

Message reopens the earliest known ordinary private conversation with the
selected account. Otherwise it creates a persistent two-person room and sends
its invitation to the other account. The conversation keeps existing calls,
files, channels, Boards and agent authority; contacting someone grants none of
their directory or agent permissions.

The invitation is an unsigned kind-14 rumor, authenticated inside a signed
kind-13 seal and a random-key kind-1059 gift wrap. Its encrypted tags are
`[p, recipient]` and `[kithmoot-invitation, 1, room-id]`; its text is the full
invitation link. A separate wrap to the sender enables their other devices to
find the same invitation. No application label, room ID, sender or invitation
capability appears in outer tags. The carrying relay sees the recipient key,
connection metadata and randomized outer timestamps. This is an invitation
extension using the NIP-17 envelope, not full NIP-17 conversation support.

Delivery prefers the recipient's kind-10050 inbox list, then their NIP-65 read
list, asked for only while public profile lookups are on. With neither, it
attempts KithMoot's configured relays; this fallback is
application-specific and cannot guarantee reachability across disjoint relay
choices. Receivers read their configured relays plus their own published inbox
list. This does not change existing private conversations' routing.

An unopened receiver can recover the invitation from the relay later. Incoming
requests require **Open conversation**; receiving a request does not join a
room, enable media or run an agent. Links supply fragments to this app rather
than redirecting to the sender's host. Both the envelope sender/rumor binding
and the room policy's exact two participants are checked. Resolving the
invitation must produce the stated room before joining.

The account-scoped inbox stores invitations and exact pending envelopes in an
authenticated encrypted journal, with its random storage key sealed to the
account's signer. A Web Lock serializes writers. Persistence precedes any
invitation delivery; only relay acknowledgement clears each destination.
Failed sends remain visible under Contacts and can be explicitly retried.
Every delayed socket write rechecks the account and current contact/block
permission. Dismissal and forgotten-room tombstones suppress old invitations;
forgetting also cancels this inbox's pending deliveries. Delivered copies are
not recalled. Signing out closes readers and pending work; forgetting the
browser removes its journal through the existing storage cleanup.

Startup requests a bounded 32-day/256-envelope window and serializes at most
64 decryptions. The journal holds at most 256 invitations and 128 pending
destination envelopes, with a 2 MiB plaintext bound. These are retrieval and
resource limits, not relay retention guarantees or a durable message archive.

## Acceptance

- Two independent browser accounts, no shared room: contact grant, search,
  start, recipient's first later visit, first message, reply and repeat opening.
- Phone-width receiver and wide sender; web Chromium, Firefox, WebKit and the
  desktop build. Synthetic browser signers exercise the same signer interface,
  not physical My Signet approval or installed native acceptance.
- Preserve existing shared-room private invitations and Signet grant
  confirmation, persistence, block and revocation tests.
- Authenticate sender binding and exact membership; preserve failed writes,
  storage refusal, grant withdrawal, account cancellation and forgetting.

The matching native Android directory and account invitation inbox are prepared for Android 0.6.86 in
[Android PR #261](https://github.com/forgesworn/kithmoot-android/pull/261),
using the pinned shared Kotlin Signet contacts SDK. Initial invitations are
read while the native account is open; joined-room background call/message
listeners continue to serve the private rooms. This change does not add a
background notification service for first-contact invitations.

`scripts/contact-invitation-interop.mjs` generates the committed browser fixture
and verifies native output. The independent native unit suite reads the browser
fixture, and this repository's unit suite reads the committed native fixture.
Both recipient and sender copies are checked. These prove wire compatibility;
installed My Signet approval, a full browser-to-native room journey and physical
signer/device acceptance remain independent gates.
