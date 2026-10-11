# Browser MLS room custody preview

This is the first bounded slice of the reviewed development room composition.
It owns room-only foreground work and a dedicated room connection. Production
MLS remains unavailable. Explicit development creation saves a local witnessed
room after fresh installation checks. Authenticated invitation joining,
uncertain-join recovery remain held; an explicit manual round handles one saved
room and its exact home-box route. These controls
do not close the combined create/join/driver or browser P3-08 gate.

## Application controls and ownership

`DEV && VITE_BROWSER_MLS_PREVIEW=true` exposes a lazy room connection panel.
Opening it constructs concrete private components without storage, signing,
WASM or network I/O. Explicit buttons pair the dedicated endpoint, read saved
room routes, create a local witnessed room, check saved rooms or run one
bounded manual round through the
current persona witness. Route
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

## Room creation custody and private ceremony

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
synchronously. A genuinely nonreturning signing promise retains custody. The private consent
UI explicitly settles to denial on invalidation/deadline; that alone does not
claim a timeout unlocked actual signing or journal work.

The explicit creation API accepts only a saved route identifier, a bounded name
and a lifetime. The owner freshly reads its own sealed route state, requires one
exact route, derives the box identity from its verified card and constructs the
client privately. No caller supplies a box, installation, receipt or client.
Temporary route/seed bytes are wiped even if construction fails. The endpoint
starts before child/persona custody. Authenticated capabilities establish one
installation, then creation uses the actual child public key and a single exact
binding expiry. A lifetime exceeding the actual credential expiry is held with
an instruction to choose a covered lifetime; it is never silently truncated.

A private Allow/Deny dialog handles typed permission scopes only. Abort,
visibility, owner replacement, close and deadline settle to denial once. The
actual vault signing/journal tail still drains inside child custody. A bounded
clock captured before the first await covers the whole ceremony, including
cached permissions and endpoint cleanup. Wall or monotonic clock regression,
invalid samples and either ten-minute elapsed deadline permanently hold it.
The selected binding lifetime remains independent of that ceremony deadline.

After the actual child/persona callbacks release, the owner freshly checks the
exact saved session/generation, home box, installation, rendezvous key and
current device/credential under the released-child freshness predicate. The creation transaction's
confirmed-read token expired with held custody and is never reused. The same
private client authenticates capabilities again and requires the same
installation. A second exact-room witness confirmation after the remote reply
withholds a candidate changed during that request. After client settlement and endpoint/witness shutdown, final
checks require current account/capabilities, child revision/expiry, clock,
credential, binding and client context. Only a public saved session/generation
is returned. Candidate effect bytes are wiped even on interruption.

Changed, unavailable or malformed post capabilities and cleanup failure retain
any committed room/outbox and withhold saved confirmation. There is no automatic
retry, recreation or rollback. Failed native stop retains ownership until page
exit. A saved result confirms local witnessed creation and authenticated
installation checks; it does not claim delivery, invitation joining or remote
room-grant installation.

Native integration uses the actual private owner, IndexedDB/WebCrypto/Web Locks,
coordinated vault and pinned MLS WASM. A test-only bundled module seam replaces
the Link transport engine and remote peers, without adding a production factory
or exposing private services. This is not default-Link-WASM, live Bothy,
authenticated full-app creation, physical or independent production acceptance.
Those remain separate gates. Production creation and MLS stay disabled.

## One explicit manual round

The manual API accepts only a saved route identifier and canonical room session.
It starts the endpoint first, constructs one private fresh client, reads the
actual current credential and a fresh witnessed saved room binding, and compares
the exact device/credential and selected home box. The persisted rendezvous key
supplies authority; a caller cannot substitute it. PendingJoin/null installation
and different introduction/home boxes remain held before any BOX request.
Manual work does not need the short creation child to remain provisioned.

One actual message driver uses the default bounded page/record limits. Its
native driver lock precedes persona custody, and its whole round promise is
owned by the room foreground. Actual client settlement remains inside that
lock. Every completed or stalled result performs a final witnessed tick and
phase/generation refresh; crossing expiry cannot report an Active result.
Only an Active room with the originally authenticated installation can reach
the owner's success fence. Other destinations and uncertain bytes stay retained.

After the round leaves the driver lock and foreground task set, an exact
witnessed confirmation binds its returned generation to the original device,
credential, rendezvous key, box and installation using the owner's current
predicate. This replaces the driver's soon-to-expire confirmation predicate.
Driver close occurs outside tracked/driver/persona callbacks, starts endpoint
shutdown and joins actual round/client/shutdown work. External pause invalidates
all privately owned drivers synchronously and joins all tails even on failure.

After actual endpoint/witness cleanup, a local confirmed read compares the same
witnessed durable revision and exact captured binding, then freshly checks the
device/credential. It starts no endpoint or witness/network work. A concurrent
write, replaced authority, expired credential, clock change or failed cleanup
withholds the counters and retains committed/uncertain state. Raw bunker device
key material is captured and compared throughout the scope; its temporary copy
is wiped after foreground settlement. No client/driver is reused by a later
operation, and no timer, automatic retry or background round is added.

The panel requires explicit saved-room and route reads before selection, runs
one bounded round per click and clears both selections on invalidation.
Resolved counts mean witnessed outbox clearance after confirmed box deposition
or safe clearance of a superseded commit slot. They do not establish recipient
acceptance. A stalled bounded attempt still retains uncertainty.
Invitation initiation/recovery, full two-account delivery and production MLS
remain separate gates.

The local manual composition passes 66 owner cases across Chromium, Firefox and
WebKit, alongside 81 lower-driver and 84 creation cases. Four actual-app
development/production lifecycle checks cover explicit controls, account
invalidation and absent production preview. All 4,080 units and typecheck pass.

A separate three-browser lab uses default pinned Link/MLS WASM, a real local
Bothy G5 box and a separate witness daemon. After an explicit external fixture
operator device grant, it creates a witnessed room, queues a genuine single-
member Update CommitSlot, clears the short creation child and runs one explicit
manual round. The round resolves one record, leaves no outgoing record and
releases ownership; another explicit round resolves none. Fixture identity,
provisioning and operator controls remain. This proves neither full-app bunker
acceptance nor invitation joining, two-account delivery or deployed/physical
operator acceptance. Production MLS remains disabled.

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

## Disposable full-app bunker lab

The opt-in `playwright.mls-account-live.config.ts` suite includes a fresh bunker
journey on Chromium, Firefox and WebKit. It drives the installed Signet NIP-46
login, actual browser-device enrolment and scoped child provisioning, then pairs
the private room endpoint, reads saved routes, approves both typed permissions,
creates one witnessed room and explicitly runs an empty manual round. Sign-out
acceptance waits for actual logout completion and checks that the bunker URI and
client key have been removed. The companion Vennel launcher is
`lab/browser-mls-bunker-room.mjs`.

Set `BOTHYD`, `LAB_RELAY` and `BOX_CONTROL` only for disposable local Bothy/witness
fixtures. Without those variables the bunker case skips. The test-only Vite
configuration supplies the loopback relay proxy on the development server;
production configuration and application authority are unchanged. The fixture
bunker exchanges real signed/encrypted kind-24133 messages, and the in-page
fixture operator installs a fresh device grant outside the private room owner
using default Link WASM and NIP-42. Neither is physical Heartwood or an independent
operator. No client, route, receipt or readiness object is injected into the app.

Traces, screenshots and videos are off. Tests clear URI/pairing input fields
immediately after their handlers capture them because Playwright can still write
an automatic DOM failure context. Fixture response work drains before key wiping;
all owned cleanup is attempted even if one resource fails. This single-member,
empty-round journey does not establish invitation joining, two-account delivery,
process/profile recovery, deployed operator or production MLS acceptance.
