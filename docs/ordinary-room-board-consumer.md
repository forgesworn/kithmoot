# Awaited room-board catalogue consumer

`RoomBoards` requires one account/room `RoomBoardCatalogueCustody`. Its native
implementation is `OrdinaryRoomBoardStorage`; production explicitly selects
`legacyRoomBoardCatalogueCustody` while protected startup remains unmounted.
There is no native-to-legacy fallback. Both adapters propagate unsupported
cache, parse, decrypt and write errors, preserve the source, and close the
consumer. Legacy plaintext remains bare arrays inside account-self encryption;
only the native adapter supplies the version-2 account/room/whole-set binding.

Open awaits custody load and checks before installing the listener or sending
a catalogue request. A failed open cannot enter the root's ready catalogue
map. Already delivered channel history is scanned even without a subsequent
change callback or request echo. Only three detached board fields and bounded
message descriptors are used; application getters and mutable input/message
arrays cannot substitute values across asynchronous work.

Explicit share first retains the full selected catalogue and awaits its
acknowledgement, then updates the local map/UI, then attempts the board-channel
and visible chat announcement. A retained invitation records an intended
share; it is not evidence of relay acceptance or independent peer delivery.
A transport failure after acknowledgement leaves the durable selected board
available for explicit retry with the same invitation. Fresh custody must
still pass after a refused send. Storage/selection failure instead revokes the
consumer without disclosing or displaying its unacknowledged candidate.

Incoming history stages detached catalogue and seen-message sets. Changed
catalogues are acknowledged before either set or the UI advances. Open, share,
ingest and sends use one bounded serial queue. Reentrant selection/changed
callbacks hold it. Reentrant change notifications coalesce into another history
scan. Catalogue reply pacing uses a separate owned task; each reply re-enters
the queue and checks that its selected invitation still matches the current
catalogue. Its waits are cancelled on revocation and never block saves.

Every whole operation joins custody lifetime before its first continuation.
Native custody joins both browser/tab owners and its own close. Revocation is
immediate, removes listeners and cancels waits; close then joins queued work,
already started unabortable wallet/send calls, and custody close. No callback
may await the close which is joining that same callback's operation.

The production root separately owns opening, ready and closing catalogues.
Room leave, docked-call end, account restore/replacement, sign-out, browser
forget and failed room entry join them before disposing their original
transport/signer. Media shutdown and call-generation invalidation precede a
potentially slow normal-room join. Failed closes remain owned and cannot turn
into permission to clear the signer on the next attempt. After an await,
captured generation/session/transport checks prevent old cleanup from clearing
a newer room. Unadopted returned signers are closed if catalogue closure prevents
account adoption; disposal does not clear another account's global SDK keys.

Unit tests cover the consumer and the same lifecycle helpers used by the root.
Native browser tests use real IndexedDB, Web Locks, WebCrypto, NIP-44 and the
published SDK pinned by the dependency and lockfile. Their room object and
channel/chat callbacks are synthetic; they prove custody and lifetime behaviour, not real RoomSession,
relay or physical acceptance. Built-app journeys separately cover the explicit
legacy production adapter with the actual bundled board child.

Pre/post `custody.check` does not guard actual deferred socket starts. Native
RoomSession binding, subscription/publication frames, actual invitation/Girnel
grant checks, explicit legacy recovery, protected production startup and other
login/restore carriers remain open. The [SDK registry release](ordinary-sdk-provenance.md)
is complete; protected consumer release, current MLS
authority, independent continuity, deployment, physical acceptance and DG08
completion are also open.
