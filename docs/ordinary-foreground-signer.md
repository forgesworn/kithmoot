# Native foreground signer custody

`OrdinaryForegroundSigner` is an unmounted adapter for an already established
Signet session. It requires the reviewed SDK provider-boundary contract
(`providerEffectBoundary === 1`), completed native browser and tab migration,
and the complete authenticated paired-image composer. Passing an extra argument
to an older SDK cannot establish this contract. KithMoot now pins the published
`signet-login@0.18.2`, which contains this boundary. See [SDK provenance](ordinary-sdk-provenance.md). The protected
foreground adapter remains unmounted in production.

The adapter captures the source session, account, method, signed authentication
proof, expiry, display name, raw signer, capabilities and method receivers.
Every operation requires the same source session and foreground generation.
The source session remains owned by the embedding; its `currentSession`
callback selects that source object. The adapter's detached, frozen `session`
is the consumer-facing value. Account/proof/method replacement or revocation
holds the foreground. A signed stored login proof proves integrity and account
ownership at its signed time; it does not establish fresh server login, room
membership, current MLS admission or independent rollback protection.

Session proofs and returned events are captured through data descriptors,
without invoking their accessors or `toJSON`. Templates are captured before
caller-owned live/selection callbacks. The adapter permits one operation at a
time: concurrent or reentrant starts hold the foreground and never launch a
second provider. The first operation remains joined through settlement.
Templates allow at most 128 tags, 32 parts per tag and 1,024 UTF-16 units per
part, with the existing 2 MiB content shape limit and an 8 MiB aggregate
canonical JSON UTF-8 ceiling. Escapes and lone surrogates count at their encoded
size; sparse/accessor-backed data is refused before native reads or providers.

Opening and each provider attempt validate the complete current browser/tab
images under the native origin Web Lock. The captured `@ordinary-signet`
fences must still match, the tab lease must be live, and all seven SDK session
records must match the captured native partition. The old-client fence runs
before these reads and before final handoff. Other protected families cannot
be ignored merely because this particular operation signs an event.
For bunkers, the exact URI and 32-byte client key also match the concrete SDK
signer. The adapter retains a private comparison copy, rechecks the source
reference and bytes, and wipes only its own copy on permanent hold or close.

The SDK invokes the adapter boundary for every NIP-07 attempt, including its
transient retry, and after a deferred bunker becomes ready. The actual provider
callback starts synchronously inside the fresh paired-read decision. Its
promise is retained without returning it from the native callback. The lock is
released before waiting for the unabortable provider. A second full native
decision checks the result handoff; the outer operation checks again after SDK
validation. Signing returns a detached frozen event with the captured template,
expected account and independently verified signature. NIP-04 and NIP-44 each
retain their captured method receivers and use the same start/join/handoff
checks. Failures do not produce successful absence or plaintext fallbacks.
The SDK checks the upgraded bunker's captured pubkey, URI and client key before
forwarding inputs and again inside the asynchronous consumer start decision.
A substituted upgrade is closed before it can receive event/plaintext data.

`revoke()` acts synchronously. `close()` revokes and joins outer SDK calls and
provider boundary work, including deferred upgrades and retry delays. It never
closes the borrowed raw signer. Its external owner must revoke this adapter,
await its close, then close the raw connection. A provider must not await a
close that joins its own unsettled call. `OrdinaryStateOwner.joinPairLifetime`
also registers each operation with both native owners before its first
continuation. Closing either owner therefore joins it, including automatic tab
lifetime expiry; the resource join does not authorise any effect. External
per-call boundaries are
refused, and this adapter does not advertise the SDK support marker itself.
NIP-46 management methods are deliberately absent until a separately authorised
carrier/lifecycle adapter exists.

`borrowNip44` permits an additional trusted native component's synchronous
paired-image restrictions inside every actual SDK start and handoff decision.
It captures exact data-method descriptors and refuses extra/accessor fields
and asynchronous validators. The base image/session checks run again after
the additional restriction. It never accepts an external SDK effect boundary
or grants permission to replace the foreground checks. The first consumer is
the unmounted [native room-board storage prerequisite](ordinary-room-board-storage.md).

`borrowSignEvent` applies the same additional synchronous restriction to
signing. It returns a frozen callable with no raw signer, capabilities or SDK
support marker. Templates are captured before callbacks, and an external
per-call boundary is refused before any provider attempt. Consent and native
room/carrier restrictions are checked inside each actual SDK attempt, after
its result, and at the final detached event handoff. Signing and crypto share
the foreground's single-operation latch and joined owner lifetimes.
The unmounted native invitation query, creator publisher and account member
bootstrap now select it for authentication and credential signing. Production
entry and `RoomSession` do not yet select these consumers.
Its trusted consumer callbacks cannot establish current membership or MLS
admission authority.

Native tests use real IndexedDB, Web Locks, WebCrypto, the complete composer and
the published SDK pinned by the dependency and lockfile. Extensions and bunker
backends are synthetic. They check provider starts under the native lock, unlocked waiting,
coherent session/fence/lease checks, revocation, retry, delayed upgrade,
template aliases, signature validation, encryption/decryption and joined close.
The borrowed-signing cases additionally check consent and native relay-row
changes during deferred upgrades, NIP-07 retry delays, unabortable providers
and final handoff. Loopback NIP-42 tests use real browser WebSockets and the
actual authentication adapter with the narrowed SDK signer; they establish
signature handoff behaviour, not native socket constructor/frame guards.
They do not prove production mounting, real wallet/device behaviour or carrier
privacy. Historical local candidate substitutions remain recorded in their
validation receipts. The current dependency is the published package; its release and
registry evidence do not establish this adapter's production mounting.

Protected initial login/connection/restoration, ephemeral nsec foreground
binding without persistent secret/session records, NIP-46 management and
transport-internal frames still need their own coordinated startup/carrier
boundaries. Credential/tab-epoch renewal, creator/member bootstrap and the
native board-provider mount remain part of the full startup integration.
Current authority, independent continuity, protected consumer release, deployment and
physical acceptance remain open. DG08 and the overall delivery goal are not
complete.
