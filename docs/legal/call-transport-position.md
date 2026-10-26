# Call transport: current position and planned design

Draft, 23 October 2026. Not legal advice; not reviewed by a lawyer. Prepared
against web source `e8eeb5704bd101975766dc2f7bb7a42d475306ae` and Android
source `9efe3db642a22ccc08b1f87e4a4d5595184a0597`, with a host configuration
readback on 23 October 2026. Source state is not proof that every installed
client has updated. The law is in jurisdiction-kit's
[`law/gb/online-services.md`](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md),
verified 28 September 2026; section 2.11 adds primary sources read on
23 October 2026. `[P]` means primary source read; `[U]`
means an unresolved interpretation. Neither mark is legal advice.

## What exists today

ForgeSworn publishes the public app and update files. The public TURN
credential endpoint returns 410 (`deploy/Caddyfile.kithmoot:133`); the web
build needs an explicitly configured endpoint to use a credential service
(`app/src/main.ts:927`). Current web source chooses independent Cloudflare
STUN by default (`src/ice-defaults.ts:55`). An installed client can still
contain an older default.

People can explicitly configure their own TURN URLs and login on each
device. Web storage is localStorage (`app/src/call-relay.ts:23`, `:37`).
Android uses a Keystore-encrypted, no-backup file (`media/CallRelayStore.kt:8`,
`storage/EncryptedRoomStorage.kt:60`, `:68`, `:105`). These logins are not
published to Nostr or inserted into room invitations. A selected relay sees
IP addresses, authentication identity, timing and volume, and carries
encrypted WebRTC packets; it is not given the media session keys.

A separate private coturn instance is running for an arranged call with two
accounts. Host readback confirmed authentication, two configured accounts,
coturn output discarded, and Docker logging disabled. The old public
listener on 3478 is stopped. This private instance is not a public app
default and does not issue credentials to the public. Host and hosting-provider
network logs have not been audited; do not translate the application logging
settings into a promise that nobody records metadata.

`[INPUT: confirm whether the private facility is operated by an individual
solely for personal communications, or in a project/business capacity.
Record the capacity and relevant contact privately; do not infer it from
the hostname or publish a natural person's name.]`

## Position and limits

For the public distribution, the intended position is a publisher with
independent infrastructure choices. Applying that position to the actual
distribution remains a reasoned reading `[U]` (law note 2.2). Publishing
software and operating the separate private deployment must not be treated
as the same activity.

The statute distinguishes control over the user-to-user service from an
access facility `[P]`. Whether a particular TURN implementation falls within
that infrastructure role remains unresolved `[U]` (2.11). A single relay
login or one installed application does not establish that there is only
one legal user. Friends-only access and encryption do not establish an
Online Safety Act exemption by themselves (2.1, 2.10).

Purely personal processing is outside UK GDPR `[P]`; applying that position
to this private facility depends on the operator-capacity input above `[U]`
(3.9). Data protection and investigatory-powers questions remain separate
from Online Safety Act scope (3 and 5).

The historical closure timetable remains in `closure-record.md`. This
document establishes no fresh assessment start date and no retrospective
exemption. It does not reactivate archived assessments or adopt their drafts.

## Planned design, not shipped functionality

The owner's decision on 23 October 2026 is simple setup with an independent
relay provider, plus self-hosting. ForgeSworn will not operate the general
call service. The proposed profile import and connection check are research
and design work; they are not represented here as released features.

The provider or self-hosting operator supplies credentials directly. No
ForgeSworn shared provider account, root key, credential issuer or room
directory is proposed. Credentials remain device-local and relay-only mode
must retain its privacy guarantee. Any future provider recommendation needs
consumer eligibility, contract, metadata and network qualification; research
has not approved a named provider as a default.

Before adding a shared sponsor account, central issuer, discovery service,
public forwarding pool or media-processing server, revisit the actual service
boundary. An outsourced server does not automatically remove the app
operator's role `[U]` (2.2, 2.11). A narrow legal review of that boundary is
optional where its answer would change the design.

### 25 October 2026: public call relays found on the device

Device-side discovery of operator-signed Spry adverts (kind 31478) was
reviewed against law note 2.13 (design:
`docs/2026-10-25-public-relay-discovery.md`). It is off by default. When the
user turns it on, the web app and Android from version 0.6.113 read adverts
from the Nostr relays in the device's own Connections list, over a connection that is not signed in, and
the user chooses a relay; the chosen operator issues an hour-long login
directly to the device. ForgeSworn runs no relay, index, directory, cache or
credential issuer for it and ships no list of call relays; it does not
check, rank or vouch for any operator, and receives no choice, failure or
usage report. This is design (b) for users on the shipped default Nostr
relays and design (a) for users who chose their own `[U]` (2.13). Each Nostr
relay's operator answers for that relay, and each public relay operator for
their own TURN service `[U]` (2.11). No ForgeSworn credential issuer and no
named provider as a default still hold. Shipping or fetching a curated
list, a ForgeSworn-run relay, index or badge, a discovery relay added to the
defaults, a publisher-set ordering or block list, or any count of which
relays people use would change this answer and needs a fresh review. The
privacy notice (sections 4.5, 4.6 and 7) and the "Check it yourself" page
describe what the device's relays and the chosen operator see. Android
parity was reviewed on 25 October 2026 under the same rules, with no change
to the reading. Android sends no web-app identifier, checks one relay
allocation without camera or microphone use, pins checked public addresses
while retaining the TLS hostname, and drops public logins when the call
ends. The Android addendum is `docs/2026-10-25-public-call-relays-android.md`
in the Android repository. Its physical TLS, DNS, relay-only and layout
checks remain separate acceptance gates.

### 26 October 2026: development-only desktop hosting controls

The desktop main process now imports the native supervisor and provides File-menu
Start/Stop controls. Hosting is enabled only in an unpackaged development run
with an explicit absolute owner configuration path; packaged builds cannot enable
it through that setting (`desktop/main.mjs:53`, `desktop/app-menu.mjs:114`).
Importing the module does not start a relay or read the configuration. An explicit
native action reads the bounded, strictly validated configuration and offers a
warning with Cancel selected by default before starting the separately supplied
executable (`desktop/spry-hosting-controls.mjs:25`, `:118`). The configuration and
executable path are trusted owner inputs; reading the configuration does not
authenticate the executable's publisher or integrity.
No native executable is packaged by this change. No renderer, PWA or preload IPC
path starts hosting, reads this configuration or requests its credentials.

The child receives a concrete IPv4 listener, at most 32 relay ports, and fixed
limits of 32 allocations, eight per credential, 32 TCP connections and 1,000,000
aggregate bytes per second per allocation. These are not a total bandwidth or
data cap (`desktop/spry-hosting.mjs:105`). Each run creates a new in-memory relay
secret, supplied only in the child environment after inherited `SPRY_*` settings
are removed. JavaScript strings and OS process environments cannot be reliably
zeroised. The supervisor can mint opaque TURN credentials for at most one hour;
the native controls provide no sharing or renewal path (`:99`, `:182`). This
integration passes no room or media keys to the child. The native child forwards
authenticated TURN packets; the supervisor discards stdout and parses bounded
readiness output without retaining raw child logs. OS, VPN and network-provider
metadata and logging remain separate considerations.

The controls request Stop on window close, quit and suspend. Resume does not
automatically restart hosting. The supervisor also keeps a private stdin pipe
to a native executable supporting `--exit-on-stdin-close`; EOF or a read error
terminates that native process independently of forwarding work. That exit
bypasses Rust destructors and relies on OS socket cleanup. The actual native
test passed authenticated allocation, Stop/rebind and old-credential rejection
after restart. A separate test killed a Node supervisor with SIGKILL during
incoming traffic and confirmed UDP/TCP listener and authenticated allocation
ports were released (`desktop/test/spry-hosting-native.test.mjs:117`, `:174`).
These are local protocol and process tests. Electron 44.4.1 acceptance also passed
with the source main process, menu and preload in a disposable app using an
offline synthetic page and the native executable
(`desktop/test/spry-hosting-electron.mjs`): native Cancel/Start/Stop, consent
invalidation on synthetic suspend, Stop without restart on synthetic resume,
refused development-update IPC, renderer crash, call/unsaved-work quit
cancellation, close/reopen Off and listener release on quit. This qualifies that
fixture; the full web bundle, installed/package-update paths, actual OS
sleep/wake and VPN behaviour remain unqualified. Suspend may occur before
shutdown completes; no shutdown guarantee on
suspend follows from these tests.

This hosting path publishes no adverts, operates no directory, shares no
credentials and makes no external reachability probe or telemetry request.
The native readiness line proves a local bind only, not VPN confinement,
Proton port forwarding or public reachability. Independent-network media,
Proton routing/kill-switch behaviour, battery/data use and performance remain
unqualified. The [implementation and acceptance record](../2026-10-26-desktop-spry-hosting.md)
must identify the reviewed revision and distinguish these evidence gates before
release.

ForgeSworn operates no relay or credential service through this change; the
developer who explicitly starts the executable operates that local instance.
Any later user-controlled deployment must be classified on its actual role and
operation, separately from the software publication. The existing
publisher-with-defaults and access-facility readings remain `[U]` under law
note 2.2/2.11, verified 28 September 2026 with transport primary sources read
23 October and discovery sources read 25 October; review is due 28 March
2027 or earlier if a relevant watch item moves. Personal use, encryption,
short-lived credentials and VPN use do not establish an exemption. Later
independently published adverts or encrypted access exchanges need a fresh
factual review under 2.13 and corresponding privacy wording before release.

### 26 October 2026: call-content and roster-metadata review

This is a narrow source review of the call and roster changes in this working
revision, not a new deployment readback or whole-product legal audit. The owner
requires call audio/video to stay off Nostr: Nostr carries announcements,
encrypted room data and call setup/control, while ordinary call media uses
WebRTC. A separately selected TURN operator forwards encrypted WebRTC packets
without receiving their media session keys. It can still observe addresses,
opaque logins, timing, size, volume and duration. An admitted participant receives
playable media and can record it. The separate server forwarder terminates WebRTC
transport encryption; the browser integration requires additional encoded-frame
encryption before using that route (`app/src/forwarder-media.ts`,
`src/media-crypto.ts`). These distinctions do not establish that every optional
component a self-hoster could run is unable to read content.

The current default roster writer still signs kind 20461 with the device key
and exposes the shared room/epoch `d` tag (`src/roster.ts`, `src/session.ts`).
An observer can group device pseudonyms by that selector and correlate activity;
names and call/track details inside the encrypted body are a separate matter.
Signalling kind 21059 uses fresh outer keys but leaves the recipient `p` tag,
kind, timestamps, expiry and ciphertext size visible (`src/signal.ts`). Nostr
operators can additionally correlate connections and subscriptions. Ephemeral
events and expiration tags do not promise erasure by operators or observers.

The web candidate also changes public-profile lookups and pictures to require
an explicitly saved `true` preference; missing, malformed or unreadable storage
leaves them off (`app/src/relay-settings.ts:431`). The app applies that preference
before requesting profiles or follows (`app/src/main.ts:3168`). Saved explicit
choices remain effective. When enabled, profile queries disclose the requested
public keys to the named relays, and picture hosts learn requests to them; this
can link otherwise encrypted room identities to public accounts. Turning the
setting off cannot recall earlier requests. This changes candidate web behaviour,
not an already installed release; older clients may still default to enabled.
The privacy-page source now describes both this opt-in and the roster/signalling
metadata above (`site/privacy/index.html`, section 7). That wording has not been
published or read back from a public deployment in this review.

An optional roster envelope 2 codec now moves the device signature inside the
encrypted body and uses a fresh outer signing key (`src/roster.ts`). Readers
accept both envelopes, but the session writer stays on the legacy format.
Older readers discard the new envelope, so app/Android activation requires a
separate compatibility rollout and acceptance evidence. This revision therefore
does not claim a reduction in metadata emitted by the default writer. Even if
activated later, the public room/epoch `d` selector, timing and connection
metadata remain: replacing the outer device key does not make a room's events
unlinkable, and does not hide signalling recipients.

The associated source changes recheck peer admission when kindred proofs expire,
including peers with connected media. Detecting expiry on a roster read also
notifies media reconciliation; a local expired admission closes its own session
and suppresses further presence publication. Queued early signals are checked against
their signed inner timestamp and the existing 20-second acceptance window
(`src/session.ts`, `src/mesh.ts`, `src/signal-guard.ts`). These are admission and
replay controls, not guarantees against recording by an admitted participant or
traffic analysis by infrastructure operators. Local regression evidence and
remaining acceptance gates belong in the
[call privacy record](../2026-10-26-call-privacy-and-one-click.md).

These changes introduce no ForgeSworn call relay, credential issuer, directory
or advert service. Independent hosting remains a separate operator's choice;
joining a room or call does not start hosting. The publisher-with-defaults and
access-facility applications remain `[U]` under law note 2.2/2.11/2.13. Any
independent public forwarding deployment also needs the separate telecoms
classification in section 7 `[U]`; encryption and decentralisation establish
no exemption. The note remains verified 28 September 2026, with transport and
telecoms primary sources read 23 October and discovery sources read 25 October;
review is due 28 March 2027 or sooner if a relevant watch item moves. No legal
verified date, deadline or operating capacity is changed by this factual update.

## Documentation and publication

The public privacy, terms and report pages must describe the device-selected
relay, its metadata and the distinction between retired public services and
private deployments. They must not promise that a provider keeps no logs or
that all self-hosters are exempt. The self-hosting runbook remains
`docs/private-call-relay.md`; passwords and private account files are never
part of a legal notice.

This remains a draft when published. Publication records the findings and
open questions; it does not establish a legal exemption or adopt the terms
as a binding service agreement. Operator capacity, existing privacy
legal-basis choices, and the provider choice remain owner inputs.
Recording/transcription, other countries'
laws and a full product audit are outside this update.
