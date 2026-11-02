# KithMoot node client integration

The library implements the pinned node transport, admission journal and device
access receiver. The web and desktop integration is an unapproved candidate;
its [review pack](kithmoot-node-ui-review.md) records the build and browser
evidence. Android integration and applicable maintainer acceptance remain.
These APIs do not enable a node for an ordinary room.

The wire format comes from `@forgesworn/fold-kit/node-room`, version 0.16.1.
Version 6 links contain a signed node record and permit an admission request.
They contain no room key or usable relay or TURN grant. Older clients refuse
them through the ordinary link parser. Version 5 remains the existing member
link format.

## Keeper

Pair with `parseKithmootNodePairingLink` and `claimKithmootNode`, then persist
the returned public node metadata. The fragment code expires after six minutes.
`enrolNodeRoom` uses the paired owner's signer and a keeper-signed node record.
The server receives no room secret or authority private key.

`openNodeKeeperAdmissions` takes the room authority key, room secret, current
epoch hint, keeper participant and an atomic `NodeKeeperStore`. Its journal is
private app storage and must be deleted by the room's existing self-destruct.
The journal is verified on restore and is never silently reset on read failure.

- Bootstrap the keeper's room device with `authoriseKeeperDevice` and a valid
  participant-signed room credential. Use that device's key for relay AUTH
  and TURN requests, rather than the participant or room authority key.
- Open `nodeKeeperInbox(node, authorityIdentity)` for the inviter's restricted
  ask door and subscribe there to kind 1059 addressed to the room authority.
  Publish sealed answers on that same inbox. It signs a scoped NIP-42 proof
  with the inviter key; its ask namespace is separate from the granted device's
  room transport. `inspect` verifies the request and supplies the admission
  card's participant, device and optional name.
- Unknown people require the keeper's **Let them in** action, passed as
  `admit(event, true)`. A person already admitted may add a device with
  `admit(event)`. Five live device grants per person are allowed.
- Publish the returned sealed answer only after `admit` resolves. The journal
  saves the signed grant before posting it. The supervisor acknowledges only
  after Spry and Shelter acknowledge. A lost response is retried with the same
  committed grant id. `onGrant` carries the accepted grant in the encrypted
  control channel; it never publishes a bare grant event to the room relay.
- Call `renew` periodically while the keeper is open, and `retry` after a
  transient failure. Renewals begin with ten days left and use the same id.
  Save failures block further admissions. A removal still attempts every
  restrictive revocation when storage fails.
- Connect `remove` to the existing participant removal/rekey flow. All of a
  removed person's device grants are revoked. The removed-person marker
  survives restart and prevents automatic readmission.

## Guest and retained room

`beginNodeJoin` opens only the signed node's ask door. Give it a local room
device key and the participant's signed room credential. Its result is a
verified admission or a denial. Cancel it when leaving the waiting screen.
Timeout, cancellation and transport failure close its sockets and timers.
There is no fallback to public relays or an ordinary bearer invitation.

After admission, `openNodeDeviceAccess` restores and verifies a
`NodeDeviceStore` bound to that descriptor and device. Persist the store
atomically. Call `refresh` before creating the room transport or calls, and
use `allowed` as both transports' permission guard:

```ts
const access = await openNodeDeviceAccess(node, deviceIdentity, admission.grant,
  deviceStore, { onClosure: closeAndSelfDestruct })
await access.refresh()
const transport = nodeRoomTransport(node, deviceIdentity, 'room', {
  allowed: access.allowed,
})
const calls = await nodeCallFactory(node, deviceIdentity, access.refresh, {
  allowed: access.allowed,
})
const session = new RoomSession({
  secret: admission.secret,
  identity: participantIdentity,
  deviceSk,
  name,
  authority: node.authority,
  node,
  transport,
  factory: calls.factory,
  expectedEpoch: admission.epochHint,
  requireFreshEpoch: true,
})
```

The keeper hosts the existing fresh-root epoch desk so an admitted device can
obtain the current epoch before publishing. Never enable a delegated member
desk or a kind-1463 bearer welcome for this profile.

Feed verified encrypted control-channel grants to `access.observe`, and poll
`refresh` while the room is open. An old active reply cannot cross a stored
revocation or reset floor. An HTTP refusal, grant expiry or reset stops access;
it does not authorise deletion. `onClosure` is invoked only for the explicit
keeper-signed closure statement. Connect it to existing self-destruct and
close the session, managed calls and access controller on teardown.

## Closing a room

Stop the keeper grant desk with `close`; its return value is the newest
signed grant second. Pass that as `resetFloor` to `prepareNodeRoomClose`,
along with the root secret, room authority and `session.currentEpoch()`.
The preparation publishes nothing. It signs the grant reset and explicit
closure statement, and encrypts the v6 retirement and self-destruct rekey.
No new epoch secret is sealed to any member. Clear the caller's temporary
current-epoch copy after preparation.

`pendingNodeRoomClose` projects only signed events and public pairing fields.
`submitPendingNodeRoomClose` calls `NodeRoomCloseStore.stage` before any HTTP
request. The store must keep the public operation reference outside the
room's self-destruct boundary, and the exact signed request inside it. On a
lost acknowledgement, retry the same stored request without re-signing.

After the node acknowledges its durable intent, `forgetRoom` deletes that
request and descriptor. Also invoke it from verified self-destruct if the
room closes before the HTTP response reaches the app. The existing room
wiper deletes room secrets, message caches and the keeper/device journals.
Only the paired node's public metadata and random operation id remain for
`queryNodeCloseOperation`, signed by the paired owner account. A pending
phase is not completion; `done` requires a complete receipt verified against
the pinned public service key.

A returning device can still fetch an explicit keeper closure after its old
admission grant has been pruned. That old id is only a query handle. It cannot
restore relay access or obtain a TURN credential.

## Enforced transport policy

The session accepts only the branded transport and call factory for its
descriptor and device. It rejects peer assistance, foreign relay overrides,
forwarder offers and other participants' ICE descriptors. Node rooms do not
produce a roster for unrelated paired Spry services or send relay probes.

Calls use only validated credentials and URLs for the pinned node, including
TURN over TLS on `turn.<node>:443`. Every peer connection uses
`iceTransportPolicy: 'relay'`. Managed calls renew credentials before their
five-minute limit, update existing connections and restart ICE. Refusal or
expiry closes connections; it never switches to a direct connection.

Every node room event has a rolling NIP-40 deadline of at most thirty days,
clamped to a fixed room end. Long-lived chat and epoch desks resolve the
deadline at signing time. Node v1 has files off: main chat and channels refuse
attachment sends and remove received attachment references before callbacks
or message consumers. App upload, download and direct-file actions must also
be disabled before a node room is offered in the UI.

## Remaining acceptance

The browser candidate stores pairing metadata by account and private node
room state by account and room. Creation saves keeper custody before enrolment.
A v6 link asks through the node's separate ask door; an admitted guest enters
without typing. The runtime owns the device access receiver, authenticated
room pool, keeper inbox, root epoch desk and managed relay-only call factory.
Files, alternate relays, peer forwarding and automatic public profile lookups
are disabled in this room path. Local unpairing leaves existing rooms running
and does not prevent their keeper closing them.

Signed `node` announcements repeat the pinned room record and do not migrate
an existing room. Signed `node-grant` controls pass through the persisted
device receiver. Default decline is silent. Removal revokes device grants
before rekeying and wipes the removed device's local room data. Whole closure
uses durable intent, node purge and the existing local self-destruct, without
opening ordinary public NIP-09 deletion sockets. Only the public operation
reference survives, for the owner's verified completion check.

Real WebSocket tests cover guest admission and a retained session after
thirty-one days. Unit tests cover durable grant replay, failure and renewal;
the credential rotation tests use an RTC double. These do not qualify browser
media, native clients, an internet node or physical GrapheneOS. The backend
fixture independently exercises the actual Spry and Shelter processes.

Maintainer must review and approve UI work on KithMoot's Settings → Calls →
Your KithMoot node and Room details → Hosted on before merging or approval.
ZAT pending. The candidate's build and named-screen review pack must be
refreshed after material UI changes. The Archy install, launch, pairing hand-off,
delete-everything and status screens have the same gate.
