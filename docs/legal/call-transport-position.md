# Call transport: current position and planned design

Draft, 23 October 2026. Not legal advice; not reviewed by a lawyer. Prepared
against web source `e8eeb5704bd101975766dc2f7bb7a42d475306ae` and Android
source `9efe3db642a22ccc08b1f87e4a4d5595184a0597`, with a host configuration
readback on 23 October 2026. Source state is not proof that every installed
client has updated. The law is in jurisdiction-kit's
[`law/gb/online-services.md`](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md),
verified 28 September 2026; section 2.11 adds primary sources read on
23 October 2026. `[P]` means primary source read; `[U]`
means an unresolved interpretation. Neither mark is legal advice. The
section "The built-in call relay" was first written against kithmoot
`12e62ebd` on 30 October 2026 and updated on 31 October 2026 against
kithmoot `a47682e2` and kithmoot-android `9216ac47`, for the owner's decision
to release the relay to everyone, off by default.

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

## The built-in call relay

Draft, first written 30 October 2026 and updated 31 October 2026. Not legal
advice; not reviewed by a lawyer. Prepared against kithmoot `a47682e2`,
kithmoot-android `9216ac47`, the design
[`docs/design/2026-10-28-built-in-relay.md`](../design/2026-10-28-built-in-relay.md)
(sections 3.4 and 3.5 and the owner decisions of 28 and 29 October), the K5
settings spec's owner decision of 30 October (section 2.0) and its approved
Turn on notice (section 9.2), and spry-turn 0.4.1 (`8db0f6e`),
`docs/supervised-mode.md`. The law is jurisdiction-kit's GB online-services
note: verified 28 September 2026, partial updates 23 and 25 October 2026,
review by 28 March 2027. No watch list item was rechecked for this update.

**The owner's decision, 30 October 2026.** Release the built-in relay to
everyone: visible in the desktop and Android apps, off until the person
turns it on through the Turn on notice. The person who turns it on runs it
for their own rooms; KithMoot's makers run no part of it.

**Where the code is.** At the commits above the relay is built but still
hidden. Desktop starts it only with `KITHMOOT_DESKTOP_RELAY=on`
(`desktop/main.mjs:84`, `desktop/relay-host.mjs:16`). Android shows the
relay page only in debug builds (`ui/KithMootApp.kt:1013`,
`ui/start/SettingsScreen.kt:158`, `ui/settings/DeveloperPage.kt:24`).
Everything below about the released relay is true only from the releases
that lift those gates and keep the rest of this section true.
The gates are lifted in desktop 0.1.120 and Android 0.6.130 (owner, 31
October 2026: "ship it"). The privacy notice names those versions.

### What is shipped and what is not

| Part | State at `a47682e2` / android `9216ac47` | Evidence |
|---|---|---|
| Share rule for a device with its own relay (a paired Spry node, or the built-in relay while it runs): offered automatically in rooms it made, elsewhere only after **Share my call relay here** | Released | `app/src/main.ts:2904`, `app/src/spry-pairing.ts:74` |
| Hide my IP one-time choice before using any member-run relay, `spry:` or `https:` | Released on web and desktop (0.1.115); Android has the same per-host store | `app/src/main.ts:9722`, `app/src/spry-pairing.ts:88`; Android `media/SpryMemberRelay.kt:81`, `media/SpryRoomAccess.kt:37` |
| Members republish a host's offer only as a marked copy (`relayed: true`) | Released | `app/src/spry-room.ts:57`, `:62` (`spryOfferHost`); `src/spry.ts` |
| Client accepts a foreign standard `spry:` offer | Released | `app/src/spry-room.ts:141` (`isSpryStandardOffer`) |
| Outside reachability check, run only when the host asks | Released | `app/src/relay-outside-test.ts`; Android `media/RelayOutsideTests.kt` |
| `spry-node` bundled in every desktop package, hash-checked | Released in the packages; nothing starts it without the gate | `desktop/spry-bundle.mjs`, `desktop/scripts/spry-release.json` (0.4.1) |
| Desktop supervisor, relay page, Turn on dialog, **Relay on** rail item, Stop | Built, behind the desktop gate | `desktop/relay-host.mjs`, `desktop/relay-supervisor.mjs`, `app/src/relay-words.ts`, `app/src/relay-settings-page.ts`; commits `61f059e4`, `7951bce5`, `217daeaf` |
| Android built-in relay: foreground service, phone conditions, page, notice | Built, debug builds only | android `callrelay/*`, `ui/settings/CallRelayWords.kt` |
| Supervised standard mode in spry-turn: no HTTP listener, no public mode, no anonymous credentials, no advert, every grant sealed, port opening, aggregate cap | In spry-turn's documentation at 0.4.1; the Rust code was not read | spry-turn `docs/supervised-mode.md` at `v0.4.1` |
| Calls settings page with one order of preference (own relay server, then the person's Spry, then the room's relay, then public, then direct) | Being reorganised; not checked as shipped | Not read for this update |

### Inventory question 7

Something the operator may run holds a key to content: a keeper
(`deploy/keeper@.service:6-13`) holds the room key for each room it keeps.
The built-in relay path is a different component. The design passes it no
room key or media key, and the media key exchange (DTLS-SRTP) runs between
the call's endpoints, so the relay forwards ciphertext. That makes the
relay's "no content" claim true for the relay. It does not make a general
claim that nothing ForgeSworn ships can read content true.

### Who operates what

**The person who turns it on** runs the relay on their own computer or
phone. They choose to turn it on, choose which other rooms it serves, and
can stop it. Their device holds the node's secret and a state file with the
room grants and each registered guest's per-room device key (spry-turn
`docs/supervised-mode.md`, "Pairing and state"): on desktop under the app's
profile with the keys sealed by the operating system's keychain
(`desktop/main.mjs:85`, `safeStorage`), on Android Keystore-wrapped in
`noBackupFilesDir` (android `callrelay/RelayIdentity.kt:85`, `:117`). Their
router opens the ports in their name. Their internet address is the one
guests connect to. As a fact, they operate that relay. What duties follow
from that is set out under "Position" below and is not settled.

When it runs differs by platform, and is wider than the 28 October phrase
"only while KithMoot is open":

- **Desktop.** It stops when the window closes, when the computer sleeps
  and when KithMoot quits. Once turned on it stays wanted until Stop: it
  starts again without asking when the window reopens, when the computer
  wakes, after local midnight if the daily limit stopped it, and, if the
  person ticked **Start it when KithMoot opens**, when KithMoot next opens
  (`desktop/main.mjs:461`-`:479`, `:594`-`:596`; `desktop/relay-settings.mjs:23`;
  K5 spec 2.0, Q1 and Q10). The **Relay on** rail item shows while it is
  starting or running.
- **Android.** It runs in a foreground service with a notification, so it
  can run while KithMoot is not on screen. It stays wanted until Stop, and
  runs only on Wi-Fi that is not metered, while the phone is charging with
  at least 50% battery (android `callrelay/RelayGates.kt:28`-`:32`, `:59`-`:61`;
  `callrelay/CallRelayService.kt`). Whether it starts by itself after the
  phone restarts was not checked (K5 spec Q11 leaves it to the builder).

Caps on both: 8 allocations, 2 per user, 16 TCP connections and 125,000
bytes a second per allocation (`desktop/relay-supervisor.mjs:32`), with the
node's own aggregate default. Daily limit: 5 GB on desktop
(`desktop/relay-settings.mjs:14`), 2 GB on Android
(android `callrelay/RelayConfig.kt:19`). The caps in the 26 October section
above belong to the development-only controls, not to this relay.

**ForgeSworn** writes and publishes the software, builds and signs the
helper (Developer ID on macOS; unsigned on Windows, like the app), and pins
its hash (`desktop/scripts/spry-release.json`). It sets the defaults: off,
share with rooms the person made, the caps, the Hide my IP rule, no open
mode. It runs no part of the data path or the control path: no relay,
credential issuer, directory, DNS name, address lookup or reachability
probe. It receives no usage counts, no reachability results and no reports.
The desktop app's ordinary update checks to ForgeSworn's site carry on as
the privacy notice describes; they are not part of the relay.

One fact to record for the access-facility test: ForgeSworn's update
channel can change or withdraw the feature in a later release. Section
146(10) counts the ability to withdraw or change a facility `[P]` (note
2.11). Whether a publisher's software updates are that kind of control over
a relay somebody else runs is not addressed in the note `[U]`. It does not
let ForgeSworn admit or remove a guest.

**Others in the path.** The Nostr relays the person's node uses for control:
up to four `wss://` relays on a domain name, taken from the person's own
relay list (`desktop/relay-host.mjs`, `pickControlRelays`; spry-turn
`--control-relay`; the Android selection was not read). On the web and
desktop defaults those are relays other people run
(`data/public-relays.json`); no relay ForgeSworn runs is among them. The
person's router and internet provider. The 30 October draft said the STUN
server would be asked once to compare the router's address; no such
comparison is in the desktop supervisor or host, and spry-turn's
documentation says the node makes none (`docs/supervised-mode.md`,
"Automatic router port opening", "Limits"). The outside check (below) is
the only reachability test, and it runs through a room member's device.

`[INPUT, open: which control relays the owner's own built-in relay would
list. The relay takes them from the person's own relay list, unchanged; the
release adds no ForgeSworn relay to anybody's list. A relay ForgeSworn runs
for its own use would be picked only if the owner has it on their own list,
and room members' devices would then send encrypted control requests to it,
which bears on the standing position that ForgeSworn's servers are closed
and for its own use. Raised with the owner on 31 October 2026, not yet
answered.]`

### Who can use it

Admitted devices in rooms the person made, and in rooms where they turned
on **Share my call relay here**. Nobody else: no advert, no anonymous
issuer, no HTTP listener, and every grant sealed to a registered device key
(`SPRY_ROOM_SEAL=required`). A copied grant without a registered device key
is refused (design 3.3).

The person does not pick each guest. Room membership follows whoever holds
the link: in a room without the knock setting, "Anyone who opens the link
comes straight in while you are here" (`app/src/main.ts:2898`), and any
member can pass the link on. Members also republish the offer as a marked
copy so the room keeps the relay while its host is away. So the relay's
users are whoever is admitted to those rooms, which may include people the
person has never met. This matters for the closed-group reading below.

Releasing the relay to everyone does not widen who can use any one person's
relay; it widens how many people may run one.

Other devices on the host's own home network cannot reach the relay through
the router, because spry-turn 0.4.1 does not loop traffic back inside the
network; the host's own device can (owner's brief, 31 October; spry-turn
`docs/supervised-mode.md`, "The status line", on local addresses). The node
never records a local client's address.

### What the person running it can see

- Each guest's internet address and port, and the timing, volume and length
  of their relayed traffic.
- The addresses of the devices a guest's packets go to through the relay.
  TURN permissions name those peers, so a relay learns both ends of a
  relayed leg. This is how the protocol works; it was not tested against
  spry-turn's code for this refresh.
- An opaque TURN login and a per-room per-device Spry key for each
  registered guest, kept in the state file.
- Not the call's content: the relay is given no media key and forwards
  DTLS-SRTP ciphertext. Not room ids, names or room keys (design 3.4).

The node's status output carries counts only: allocations open, bytes
relayed, and the time of the newest outside allocation, never an address
(`docs/supervised-mode.md`, "The status line"). That is the node's own
output. The person's operating system, router, firewall and internet
provider may keep their own records, and the person can run their own
tools on their own machine. Nothing here promises that no record is kept.

### What guests reveal, and the Hide my IP rule

To the host's relay: the items above. To the host's control relays: that a
key sent small encrypted requests to the node's key, with timing and the
guest's address. Those may be relays the guest does not otherwise use
(design 3.3). To other members: nothing new.

**Hide my IP, as shipped** (owner decisions 28 and 29 October;
`app/src/main.ts:9722`, `app/src/spry-pairing.ts:88`; Android
`media/SpryMemberRelay.kt:75`-`:81`):

- With Hide my IP off, a member-run relay is used automatically.
- With Hide my IP on, a member-run relay, built-in `spry:` or `https:`, is
  used only after a one-time choice naming the host: "Use Alex's relay?
  Alex will see your address; others won't." with **Use relay** and **Not
  now**.
- The choice is per host participant, covers all that person's relays, and
  is kept on the device only (`kithmoot.spry-consent.v1`, registered at
  `app/src/ordinary-physical-snapshot.ts:61`). It is never synced,
  published or put in a link.
- The device's own relay and a relay entered by hand are never asked about.
- With Hide my IP on, only the single member whose descriptor carries the
  offer unmarked can be asked about. A marked copy names nobody and is
  ignored, so a guest who arrives while the host is away is refused
  (`app/src/spry-room.ts:62`, `spryOfferHost`).

The code comment at `app/src/spry-pairing.ts:89` still describes the
consent as for "a built-in relay, reached over `spry:`". The behaviour has
covered `https:` offers since `2537853c`. This is a stale comment, not a
legal gap.

**The outside test.** When the host asks, a member's device (or the host's
own phone) runs a short test through the relay. The relay sees that
device's address, as on any call through it. The verdict goes back to the
host only, inside the existing encrypted channel, signed by the tester's
device key. It names no addresses (`app/src/relay-outside-test.ts`).

### What the host reveals

- Their public internet address, to every guest who redeems the offer. It
  is in the credential answer, not in the room descriptor (design 3.4).
- The same with Hide my IP on: the owner decided on 28 October that a host
  with Hide my IP on may still run the relay. The Turn on dialog says so
  when Hide my IP is on (T-ON-HIDEIP, below).
- Port mappings on their router, visible to whoever manages that network.
  On a router that grants only permanent mappings, a mapping may outlive a
  crash until the next launch removes it (owner decision, 28 October). The
  approved notice says KithMoot "closes it again when the relay stops",
  which is true of a Stop and not of that crash case; the privacy notice
  carries the exception.

### Position

**ForgeSworn, today.** For the public distribution, publisher with defaults,
as above and still `[U]` (note 2.2). Its own servers are closed and for its
own use. The built-in relay adds software that other people run, not a
service ForgeSworn runs. Somebody who installs and runs the software
operates their own deployment (note 6.1). Publishing general-purpose
software does not make the publisher party to an offence someone commits
with it, absent intent or belief `[P]` (6.1); do not present the relay as a
way round any law. The owner means to stay in this position, and the design
keeps it while all of these hold:

- no ForgeSworn relay, control relay default, credential issuer, directory,
  advert, address lookup or reachability service;
- no telemetry, usage count or test result reaching ForgeSworn;
- no open mode, anonymous issuer or public advert in the built-in relay;
- grants issued by the person's own node, sealed to admitted devices.

Any one of those changing needs a fresh review (2.2, 2.11, 2.13).

Releasing the relay to everyone, off by default, does not move ForgeSworn
from this position: it publishes the same software to more people and runs
nothing more. Two further conditions keep it there after release:

- no update turns the relay on for anyone who has not pressed **Turn on**
  on that device, and nothing outside the device can turn it on;
- the Turn on notice, or one at least as clear, stays in front of the first
  start.

**The person who turns it on.** They operate their relay. The note leaves
open what follows, and the answer depends on facts about each person that
the software cannot know. This document does not settle it.

| Regime | What the note says | What turns on the person's facts |
|---|---|---|
| Online Safety Act (2.1, 2.2, 2.10, 2.11) | No primary source classifies a TURN relay `[U]`. Family and friends by invitation has no exemption and no decision `[U]`. Selecting guests in an ordinary conversation is not by itself enough to be a provider `[U]`. Forwarding for unrelated users is a separate role `[U]` | Whether it relays for people they know or, through link sharing, for people they do not; whether the rooms serve a project or business (2.10, internal business row) |
| Data protection (3.1, 3.9) | Guests' addresses are personal data. Purely personal or household processing is outside UK GDPR `[P]`; applying that to a given person is `[U]` | Whether the rooms are private life only, or work, a project or a public group |
| Investigatory powers (5.1, 5.2) | The definition is wide; a relay for people in the UK "very probably" meets it `[U]` | Where they and their guests are |
| Communications Act and PECR (7, 4.1) | Written for public packet relays; whether a given relay is in scope is `[U]` | Whether a relay offered only to room members is "public" at all; the note does not say |

What the software does to keep the person's role small: off by default,
the notice before every Turn on, rooms only, sealed grants, a visible Stop
and **Relay on** indicator (desktop) or notification (Android), stopping on
desktop when the window closes or the computer sleeps, the phone conditions
on Android, caps and a daily limit, and no addresses in its own output. None of these is an exemption,
and the dialog must not suggest one.

### The Turn on notice

Decided by the owner on 30 October 2026 (K5 spec 2.0 and 9.2), merged from
the K5 placeholder and the draft this section carried on 30 October. Both
decision markers that draft left are settled: the notice follows spry-turn
GOALS G7's wider "laws that apply to you" in place of "your local laws",
and the line "KithMoot's makers run no part of it" is on the privacy notice,
not in the dialog. G7 asks for proportionate information before restricted
hosting and a separate acknowledgement before public hosting; the built-in
relay has no public mode, so this is the lighter form. The dialog asks on
every **Turn on**; starting again on open, on wake or after midnight does
not ask (K5 Q9). Cancel has focus when it opens.

As shipped behind the gates (`app/src/relay-words.ts:150`; android
`ui/settings/CallRelayWords.kt:133`), with `<device>` "computer" or "phone"
and `<limit>` 5 GB or 2 GB:

> **Turn on the call relay on this <device>?**
>
> People in rooms you made, and rooms where you share it, can send their
> encrypted calls through this <device> when they can't connect directly.
> They'll see your internet address. It uses your upload bandwidth, up to
> <limit> a day. KithMoot asks your router to open what the relay needs and
> closes it again when the relay stops. You run this relay and can stop it
> at any time. Check that the laws that apply to you and your internet
> provider's terms allow it.

Android adds: "It runs only on Wi-Fi that isn't metered, while this phone
is charging and has at least 50% battery, and it uses some battery."

When Hide my IP is on, both add: "Hide my IP address doesn't hide your
address from people who use your relay."

Checked against the code: every sentence matches the facts above, except
the crash case of router openings noted under "What the host reveals". The
notice does not say the relay is private, log-free or exempt.

The dialog must not say or imply that a private, encrypted or log-free
relay is exempt from anything, that nobody keeps records, or that the
person carries no duties.

### Gaps in the law note for this question

The note is inside its review date and not overdue. Nothing in it is stale
by date. These are places where it does not settle the home relay question.
None is resolved here. On 31 October 2026 items 7 and 8 were written into the
note as open questions marked `[U]` (a sentence in 2.13 and a scoping row in
section 1), on a local jurisdiction-kit branch not yet merged. Items 1 to 6
need sources read before they can go in, and were not researched.

1. **2.11, TURN classification.** No primary source classifies a TURN relay
   under the access-facility provisions, and the note does not say where
   "forwarding for unrelated users" begins. Room members admitted by link
   are neither the operator nor plainly unrelated. Settled by: an Ofcom
   statement or decision on packet relays (already on the watch list).
2. **2.10, closed groups admitted by link.** The family and friends row has
   no decision, and the note does not consider a closed group whose
   membership the operator does not control because any member can pass the
   link on. Settled by: an Ofcom statement or decision on small closed
   services; failing that, a narrow legal review, which is optional and
   worth it only if the answer would change what ForgeSworn ships.
3. **2.1, "encounter" through a relay.** The note reads "encounter" as to
   "read, view, hear or otherwise experience" (2.12) but does not apply it
   to a service that carries only ciphertext no member can read through it.
   Whether a TURN relay is a service "by means of which" content is
   encountered is open. Settled by: the same Ofcom classification as item
   1, or a written reading of sections 3 and 236 against a relay, marked as
   a reading.
4. **3.9, mixed-purpose hosts.** The note gives the household test but
   cannot apply it to a person whose rooms mix private life and project
   work. Nothing external settles this; it turns on each person's own
   purpose. What the note could add: the ICO's guidance and any case law on
   "purely" personal processing, which it does not record.
5. **5.1, private relays.** "Very probably" is written for a relay serving
   people in the UK generally. Sections 5.1 and 5.2 do not record whether the
   investigatory powers definitions or the Home Office code treat a relay
   for invited people differently. Settled by: reading the code's
   provisions on private and non-public systems into the note.
6. **7 and 4.1, non-public relays.** Both are framed around public packet
   relays. Sections 7 and 4.1 do not record the Communications Act's meaning
   of a public electronic communications service, so they cannot say whether
   a members-only relay is outside. Settled by: reading the statutory
   definition of "public" into section 7.
7. **2.13, offers inside an encrypted room.** The four designs cover
   adverts others can read. An offer carried inside an encrypted room
   descriptor, readable only by members, is none of them. The likely
   reading is that it is not discovery at all, but the note does not say.
   Settled by: a sentence in 2.13 marked `[U]`.
8. **Section 1, scoping.** No row asks "does your software let its users
   relay calls for each other?". The nearest row sends the reader to 2.2
   and 2.11, which is right, but the case is common enough to name.

### Public pages

`site/privacy/index.html` is updated with this section (31 October 2026):
the relay on desktop and Android, off until turned on, what it sees and
reveals for the person running it and for their guests, the share rule,
the Hide my IP rule, that KithMoot's makers run no part of it, and the
relay's keys and settings kept on the device. It still says "in versions
that offer it" until the releases are named.

`site/report/index.html` and `site/terms/index.html` do not mention relays
run by room members. A report about a member's relay can only go to that
member or the room; nothing ForgeSworn runs can stop it. `[DECISION:
whether the report page should say so before release.]`

### What would change this reading

A ForgeSworn control relay among the defaults; any reachability, address
or usage service ForgeSworn runs; an open mode, advert or anonymous issuer;
grants issued by anything but the person's own node; relaying for rooms the
person neither made nor chose; any route by which the relay receives a
media or room key; an update that turns the relay on without the person's
**Turn on**; or any count, crash report or check result sent to ForgeSworn.

### Not checked

The release builds that lift the gates, which do not exist yet; spry-turn's
Rust code (only its documentation was read); the Android selection of
control relays and whether the Android relay starts by itself after a phone
restart; the Calls settings page and its order of preference; behaviour on
real routers and networks; what operating systems, routers and internet
providers record; the published privacy page (the edit is in source only);
the laws of other countries.

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
