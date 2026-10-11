# Browser MLS room custody preview

This is the first bounded slice of the reviewed development room composition.
It owns room-only foreground work and a dedicated room connection. Production
MLS remains unavailable. Creating rooms, authenticated invitation joining,
uncertain-join recovery and manual driver rounds are still held; these controls
do not close the create/join/driver or browser P3-08 gate.

## Application controls and ownership

`DEV && VITE_BROWSER_MLS_PREVIEW=true` exposes a lazy room connection panel.
Opening it constructs concrete private components without storage, signing,
WASM or network I/O. Explicit buttons pair the dedicated endpoint, read saved
room routes or check saved rooms through the current persona witness. Route
reads are local; pairing and witness checks hold in quiet/Tor-only contexts.
There is no background round, timer, retry or cached authority/readiness mark.

The private owner receives the actual account context, never service substitutes.
It captures raw signer owner/functions, account, generation and privacy mode;
same-key capability replacement and hidden-page state withhold late success.
External invalidation aborts synchronously, closes the panel and clears account,
route, room, pairing-code and relay input data before awaiting cleanup. Reopening
requires an explicit action and cannot restart unfinished work.

Room foreground never constructs or prepares grant custody. Its private persona
links/coordinator/vault/room operations are separate from the grant owner's outer
preparation boundary. The nominal endpoint, storage AAD, naming key and native
writer lock cannot substitute for grant, witness or ordinary account Link.

## Secret custody and settlement

One native global room lock precedes room naming and opaque account storage
locks. Nonextractable HMAC-SHA256 naming custody derives opaque per-account
database names; raw Nostr accounts do not appear in enumerable database/lock
names. The first naming key and a domain-separated self-check commit together.
Fresh reads refuse missing, falsy, extractable or changed-key state rather than
deriving a replacement namespace and orphaning saved connection authority.

The account is bound inside the encrypted payload and AES-GCM additional data.
Each account has nonextractable AES-256 custody with strict record/key presence,
schema and size bounds. Seed/account replacement, dropping/replacing saved
routes, arbitrary initial routes and corrupt/foreign seals are refused. Initial
key/record creation is atomic; updates freshly decrypt and compare the original
record before appending exactly one verified route. Temporary seed/route and
stale response bytes are wiped. Native transaction completion is the local
durability boundary, not a claim about physical disk flushing.

The callback must finish endpoint/witness cleanup before returning. Foreground
settlement joins dynamically added signer/native work; native endpoint release
drains actual nested work without joining its own outer callback. Do not track
endpoint start/pair/stop control promises as tasks which recursively await their
own release, or await foreground settlement inside a tracked task/callback.
Endpoint control is already owned by BrowserLink's native lifecycle. Failed
engine stop permanently retains the native writer lock until page exit.
Blocked IndexedDB opens and genuinely unfinished native/signer work may retain
shutdown indefinitely; there is no timeout release or false remote rollback.

## Dormant room creation custody foundation

The actual private owner now constructs a fixed-namespace creation wrapper
around the existing concrete encrypted rendezvous vault. It binds the current
account to the actual retained NIP-46 bunker device key and raw signer/provision
owner and function references. Replacement of a reference or mutation of the
device key material invalidates the captured ceremony. No text field, enrolled
MLS device, caller receipt or injected storage supplies that authority.

Creation custody exposes only a frozen public receipt and boolean current and
release predicates. It exposes no child, scalar, ECDH or provision operation.
The current predicate ends at child callback release. The release predicate
freshly checks the original vault revision, child expiry and foreground after
unlock, including through later client and endpoint cleanup.

The owner privately constructs a concrete coordinated-vault subclass which
registers the entire actual leaf signing promise with its room foreground
before yielding. Lower creation cancellation can finish while consent,
signing or journal storage continues. The child callback always dynamically
drains those registered tails before unlocking, even after an exception or
invalidation. External owner pause also invalidates lower room operations
synchronously. A genuinely nonreturning consent/signing promise retains
custody; a later private consent UI must explicitly settle to denial on
invalidation/deadline rather than claim a timeout unlocked real work.

This is a dormant foundation. There is no application create API or new UI
control. Native regressions use the real encrypted provision reader, concrete
vault, signing journal and pinned MLS WASM with fixture peers. They prove
actual tail retention, cross-tab child invalidation, device capability changes
and a room binding lifetime independent of the short child receipt. They do
not prove the private paired-route client, authenticated pre/post installation
readback, final effect fencing after client/endpoint shutdown or live Bothy.
Those ceremonies must land before an application creation control is enabled.

## Forget integrity in every build

The small read-only room-custody guard is deliberately included in production.
It creates no database, naming key, slot, endpoint or preview runtime. Any
retained room-prefixed database, even interrupted/empty/malformed state, holds
“Forget this browser”. The final check and entire confirmation/deletion callback
hold the same native global lock as room seed writers and saved-route readers,
including on an initially empty browser. Its transient native lock closes the
late-first-writer race and leaves no persistent custody of its own.

This intentionally changes production bytes for deletion integrity. It does not
enable production MLS. Refusal says local room connection data remains and no
remote withdrawal has been confirmed; it promises no unavailable remediation.
An explicit reviewed local-abandon/remote-retire workflow remains a later slice.

## Evidence and limits

Native Chromium/Firefox/WebKit fixtures use actual IndexedDB, WebCrypto and Web
Locks with controlled foreground visibility for simultaneous tabs. Their engine
seam controls late settlement and failures; it is not default-WASM live Bothy
acceptance. They cover account/namespace separation, unchanged legacy grant
custody, late start/pair/request/signer/crypto/stop tails, competing tabs, failed
stop ownership, malformed and foreign seals, naming-key replacement, actual
private owner route reads and the empty-browser forget/writer race.

Real app checks cover opening with no I/O, account invalidation and input clearing,
the absent production preview controls, and retained-custody refusal in both
development and production. Full units/typecheck/build, final native/app results,
independent exact-source review, hosted candidate/main CI and exact deployed
bytes/security headers remain distinct release requirements.

Create requires exact rendezvous custody plus authenticated pre/post capabilities
readback. Join requires a strict authenticated invitation/request/answer decoder
binding keeper/account/device, stable operation, routes and receipt. Neither a
pasted keeper nor raw caller-shaped join options satisfy that requirement.
Single-box delivery, live default-WASM Bothy, historical writers/cached engines,
profile/process/backup recovery, candidate retirement, pruning/renewal, P7,
physical/operator and independent production acceptance remain open.
