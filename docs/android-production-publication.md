# Publishing the first production Android APK

The first-production procedure below is historical. The current production
version and artifact identity come from `site/android-release.json`; subsequent
releases use the same immutable APK across the website, GitHub and Zapstore.
This runbook does not create an Android key, sign an APK or replace the
physical-phone gates in the Android repository.

## Android 0.6.103 reply quotes, and no ForgeSworn call relay or file storage, 22 October 2026

Version **0.6.103**, code **126**, brings reply quotes to Android: Reply on
any message, replies in time order with a quote of what they answer, and a
tap on the quote goes to the original (kithmoot-android #309, kithmoot #506).
It stops asking ForgeSworn's host for a TURN credential, keeps STUN there,
says when a call has no relay, and says why a call with Hide my IP address on
calls cannot start in a room without one (kithmoot-android #310, kithmoot
#525). A stored ForgeSworn file server is retired and cannot be chosen
(kithmoot #527), and a file its server no longer has reads as gone (kithmoot
#530). It also carries kithmoot-android #307 (envelope 2 groundwork; writers
stay off). No wire change.

The production APK is built from Android source
`6a4f3544` (the head of pull request #311), SHA-256
`e2314cb6d6ea439ac2105540f2f8f1e12d8483d4144c4971585fc3dbf330e087`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started; not yet observed on a device.

## Android 0.6.102 room notifications and timed mutes, 21 October 2026

Version **0.6.102**, code **125**, brings the calm shell's stage 7 to
Android: each room can tell you about every message, only mentions and
replies, nothing, or follow your default, and can be muted for 1 hour, 8
hours, 1 day or 1 week. A muted room says until when, shows a crossed-out
bell and a grey count, leaves the Chats count, and its calls don't ring
(kithmoot-android #306, kithmoot #496). It also reads chat envelope 2 and
one-time seal senders (kithmoot-android #304, kithmoot #508), and a
self-destruct deletes this device's own envelope 2 messages
(kithmoot-android #305, kithmoot #512). Android still writes envelope 1. No
wire change.

The production APK is built from Android source
`5a12aff8` (the head of pull request #308), SHA-256
`e218188f05bb8f746bcee9bbe1a8654e845d634fc0e9600137b8e74f268526be`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started; not yet observed on a device.

## Android 0.6.101 Hide my IP address on calls, Untitled room and Somebody, 21 October 2026

Version **0.6.101**, code **124**, adds Settings › Privacy › Hide my IP
address on calls (relay-only calls, off unless chosen, no direct fallback),
renews the TURN credential every 40 minutes, and brings the web's final
stage 6 wording: "Untitled room" for a room nobody named and "Somebody" for a
person with no name, never a key (kithmoot-android #301, kithmoot #499). It
also replaces the default relay relay.nostr.net, which stopped answering, with
relay.ditto.pub (kithmoot-android #302), and points Signet sign-in at Signet's
new relay (kithmoot-android #300). No wire change.

The production APK is built from Android source
`80f99d7d` (the head of pull request #303, merged once all checks passed), SHA-256
`10db7d088118c46b246c41f5d87349b69bea51256c1dcfb13098f9e8b6101060`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started a room over public relays; not yet observed on a device.

## Android 0.6.100 invite to a room and new default relays, 21 October 2026

Version **0.6.100**, code **123**, brings the calm shell's stage 6 to
Android: invite a contact to one of your rooms from People or from their
details in a room, invitation cards that name the sender and never show a
key, and the web's words at the ask-first door (kithmoot-android #297). It
also moves the default relays to relay.primal.net, nostr.oxtr.dev and
relay.nostr.net, as the web did (kithmoot-android #298, kithmoot #498). No
wire change.

The production APK is built from Android source
`7e6c10ee` (pull request #299 merged, all checks passed), SHA-256
`46cfe3ac6e38c7ada959527d5ae0926817d099552e32f92c182732b92c71d544`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started a room over the new default relays; not yet observed on a device.

## Android 0.6.99 Decline and block and no suggested file server, 21 October 2026

Version **0.6.99**, code **122**, adds Decline and block, kept on the phone
and never published, as on the web (kithmoot-android #294, kithmoot #488),
and stops the image dialog pre-filling ForgeSworn's file server
(kithmoot-android #295, kithmoot #489). No wire change.

The production APK is built from Android source
`ba147779` (pull request #296 merged, all checks passed), SHA-256
`ed312cbfd3204fbdf67607f9fd59070c5ea933e7fe675c0633f06b8e3e8755d9`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started a room over public relays; not yet observed on a device.

## Android 0.6.98 ring window, same-name keys and Effects headings, 20 October 2026

Version **0.6.98**, code **121**, follows the web's calm shell stage 5
review: a call rings for up to a minute from its start and an older call does
not ring, two people with the same name on a call show their short key, an
unnamed caller is "Somebody", and the Effects headings match the web
(kithmoot-android #293). No wire change.

The production APK is built from Android source
`ae9f6645` (pull request #293 merged, all checks passed), SHA-256
`53d801ac51d7574f5da3e5f4f986e223d2bcbb2fd9bfd447bd171d0a7317a85e`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started a room over public relays; not yet observed on a device.

## Android 0.6.97 room bar, Room info and the call, 20 October 2026

Version **0.6.97**, code **120**, brings stages 3 to 5 of the calm shell to
Android in step with the web and desktop apps: the room bar with Call, Search
and a ⋮ menu, Chat and Board tabs, a call banner with Join and an on-call bar
(kithmoot-android #290); Room info as a full page and Settings names as on the
web (#291); and the call bar, More, Effects, the ring screen and named call
tiles (#292). Invitation times read like the web's (#289). No wire change.

The production APK is built from Android source
`e4aa987d` (pull request #292 merged, all checks passed), SHA-256
`372d691aaafac7844434c2ab2b4c5cd8c27dd90c2a1fba5a35b2d1376736f606`, signed with
the retained production certificate. Installed on the arm64 emulator, where it
started a room over public relays; not yet observed on a device.

## Android 0.6.96 Chats, People and Boards, 20 October 2026

Version **0.6.96**, code **119**, brings stage 2 of the calm shell to Android
in step with the web and desktop apps: Chats, People and Boards in a bottom
bar (a rail on tablets), Chats with filter chips, a New sheet and received
invitations at the top, and People listing Signet contacts, contact cards and
the account's follow list with Message, Voice and Video (kithmoot-android
#288). Follow-list names are fetched only while public profiles are on.

The production APK is built from Android source
`3803acc8` (pull request #288 merged, all checks passed), SHA-256
`59585116260d81e231810f711e424960232e133bad60ae7be3166221a37875d8`, signed with
the retained production certificate. Launched on the arm64 emulator; not yet
observed on a device.

## Android 0.6.95 visible sending, 20 October 2026

Version **0.6.95**, code **118**, shows when a message is sending (an
hourglass on Send, a read-only field, and after a second a line saying there
is no need to press Send again) and clears the composer once the message is
kept, even when the keyboard changed the text as Send was pressed, which had
left sent text in the box (kithmoot-android #283). It also carries the Keeper
receiver contention fix (#287).

The production APK is built from Android source
`3f1e42fa` (pull request #283, all checks passed), SHA-256
`a6283a09aa1b36d3c39f45d51f0aec455f5a0eb4f03eea59186e0e0c4c15fb42`, signed with
the retained production certificate. Not yet observed on a device.

## Android 0.6.94 long pastes as documents, 19 October 2026

Version **0.6.94**, code **117**, sends a paste over the 2,000 character chat
limit as an encrypted text document with a 600 character preview, as the web
client does, instead of silently discarding it (kithmoot-android #279). The
document goes through the storage server already chosen for images, 8 MiB at
most; without one, nothing is sent and the composer says why. Android also
opens text documents from other clients, with Copy.

The production APK is built from Android source
`cbd3e818` (pull request #279, all checks passed), SHA-256
`5a5c5514a2293085360187cfd5815d436b11c2a62c961f42c39eaf7be866b2d3`, signed with
the retained production certificate. Not yet observed on a device.

## Android 0.6.93 calm chat screen, 19 October 2026

Version **0.6.93**, code **116**, carries stages 0 and 1 of the calm shell
redesign (kithmoot-android #277): one palette and type scale shared with web
and desktop, messages grouped into runs by sender, reactions under the bubble,
an outlined Agent label, a one-line composer on one centre line, and the back
arrow labelled Back to chats. It also opens room invitations sent from the
web client (#276).

The production APK is built from Android source
`6e5bd268` (pull request #280, all checks passed), SHA-256
`8da7c2be63c00cd8622016879291f5117091f0392ff5e4b4796e85708b57ffa7`, signed with
the retained production certificate. Installed over 0.6.92 on a Pixel 10 Pro
XL, where it launched without a crash; TalkBack order and high contrast text
are not yet checked on a device.

## Android 0.6.92 WebRTC echo cancelling — 19 October 2026

Version **0.6.92**, code **115**, uses WebRTC's own echo canceller and noise
suppressor instead of the handset's, so people on a call no longer hear
themselves back as reverb from a phone on loudspeaker. It also rolls back the
0.6.90 quiet automatic replies: call signals, epoch recovery answers and
keeper admission answers go out at once again while broken calls are
investigated.

The production APK is built from Android source
`df396bc5` (pull request #275, all checks passed), SHA-256
`500ac4b9dcd116b236901ab63b8d677d5253696a7eebaa18846fa1d94d6dc505`, signed with
the retained production certificate. Not yet observed on a device.

## Android 0.6.91 opaque camera avatar — 18 October 2026

Version **0.6.91**, code **114**, remembers Avatar before camera capture and
replaces the whole outgoing picture with original MIT mask artwork. The camera
stays on locally; screen sharing is separate. Automatic face masks, person
cut-outs and automatic framing remain unavailable pending qualified owned
models and runtime integration. The third-party camera vision SDK and Google
background weights have been removed.

The production APK is built from Android source
`8ecde8cc59ca9999208b5d812fbab2e3620c5d6c`, merged by pull request #272 at
`5459c381ba28fa4cdd018bea155b08a6b6ca0afe`, SHA-256
`d77aac33d19886245f36ee8e240800216ed8dc1d56f8ec590c4820e2de1ff907`.
It retains the production certificate, V3-only signing and reviewed lineage.
The [publication receipt](evidence/camera-privacy-0.1.88-0.6.91-2026-10-18.json)
records the 17-job source and main CI checks, exact GitHub/website/Zapstore APK,
signed feeds and public hashes. Synthetic device checks passed; physical
camera/call, real-face inference and battery/thermal acceptance remain open.

## Android 0.6.90 quieter automatic replies — 18 October 2026

Version **0.6.90**, code **113**, delays duplicate and stale call signals,
epoch recovery answers and refusals, and fresh keeper admission answers by a
short random time within per-device and global budgets, so they no longer
show a watcher within milliseconds that the phone is awake.

The production APK is built from Android source
`8677ce92` (pull requests #270 and #271, all checks passed), SHA-256
`13479461f8d0b414a16b56bc4926ca7033ccfb794a02b9958e7645f8ebf4b8cf`, signed with
the retained production certificate. Not yet observed on a device.

## Android 0.6.89 signed-out relay choices — 16 October 2026
Version **0.6.89**, code **112**, keeps relay read and write choices made while
signed out across a restart, instead of turning every relay read-write and
dropping unticked ones.
The production APK is built from Android source
`56c1ec82` (pull requests #267 and #268, all checks passed), SHA-256
`5e0a1b559e7ece2121e832bb824936fd96c683c961fa0726abc3861ab536da58`, signed with
the retained production certificate. Not yet observed on a device.

## Android 0.6.88 steady call video and compact record control — 15 October 2026
Version **0.6.88**, code **111**, keeps a call tile's picture through a brief
gap instead of flashing black, makes Record a red button and puts the
recording notice and its controls on one compact row. It also carries verified
join links, which open the app only once both sites serve the matching
`assetlinks.json`.
The production APK is built from Android source
`d2ffffca66b48442f67e77f68119f2161063585c` (pull request #266, all checks passed), SHA-256
`3f5bfc3711a313b78e104eb1cabebb40ff23f7784219a304b2062a26af494f3d`, signed with
the retained production certificate. The flash fix follows from code reading
and has not yet been observed on a device.

## Android 0.6.87 relay order and delivery evidence — 15 October 2026

Version **0.6.87**, code **110**, moves relays up or down in Settings, notices a
relay that accepts a stored message and then does not return it, keeps a
refused read on show, names the reason a write was refused and keeps paging a
keeper inbox relay that serves short pages.

The production APK is built from Android source
`8847178872bd403f2444f45962b071f4701be515` (workflow `38717529505`, all jobs
passed), SHA-256
`0900ae60cea73bf788233755900d69e6e84b1d1142e8db0afedecd9e1e7a1336`.
The [candidate receipt](evidence/relay-evidence-release-candidate-2026-10-15.json)
records the retained production certificate and lineage, the independent
publication check and the desktop 0.1.84 archive identities. The order row was
checked on an emulator; behaviour against real relays that silently drop stored
events has not been observed outside tests.

## Android 0.6.86 Signet contacts — 14 October 2026

Version **0.6.86**, code **109**, starts or reopens private conversations from an
authorised Signet contact without a shared room. Encrypted invitations support
a recipient's later visit while the creator is offline. Open remains deliberate;
existing room chat, calls, collaboration and joined-room background listeners
are reused. First-contact invitations are read while the account is open.

The production APK is built from Android source
`eacd069814f230f7afc15bb8cad2b7dcd9b931fb`, SHA-256
`0f1f39334412b2228348951791b199f2c8549bff9523fd0a37cd5395fdf84984`.
The [candidate receipt](evidence/signet-contacts-release-candidate-2026-10-14.json)
records the retained production certificate/lineage, independent APK signature
verification and desktop archive identities. The clean source worktree is
recorded before and after the standard signed build; AGP could not embed VCS
metadata from that isolated worktree. Source CI, merging and public readbacks
are separate release gates.

Automated browser and installed native journeys cover contact creation,
offline invitation discovery, reply and repeat opening. Independent invitation
fixtures establish browser/native envelope compatibility. Real Signet owner
approval, physical signer acceptance and a full installed browser-to-native
room journey remain unverified; this release does not claim ordinary NIP-17
chat interoperability.

## Android 0.6.85 screen fitting — 13 October 2026

Version **0.6.85**, code **108**, fits large desktop shares in both Android call
tiles and the expanded viewer. A new share resets zoom/pan; rotated decoded
frame dimensions determine the surface proportions. It retains recording and
Save source `56925350` from 0.6.84. No immutable 0.6.84 APK is replaced.

Source `faacbb4d0a9aa8ba8afa1f811e3db3bb0462c5ec` produces the reviewed
production APK, SHA-256
`2ddcca3a06480eff02c2e0bb08f7bc236a2c6852208c5908e52b6bcb3090741b`.
The [signed-build receipt](evidence/android-0.6.85-signed-build-2026-10-13.json)
records embedded source, certificate, lineage and independent publication checks.
All 29 capture cases pass on the disposable M4 emulator; summary, individual result counts and refusal checks were independently verified because that host lacks rg. The live compositor now keeps the first picture at zero and renders the latest due picture after queued audio, preserving every audio sample and the existing queue/permission bounds. A synthetic 3840-by-1080 live-video emulator check preserves all four desktop
edges in both views and after a zoomed same-track replacement. Existing drawing,
zoom and platform picture-in-picture checks pass. Physical Pixel and real-call
screen-share acceptance remain unverified. Exact-source hosted checks, merge
and public readbacks are required before this APK is published.

## Android 0.6.84 — 13 October 2026

Version **0.6.84**, code **107**, adds audio/video recording with local Save,
visible Save failures and retained export after picker cancellation. Local
recording and Save need no node. Encrypted Upload to a selected private node
and Send are separate actions. Original-node cancellation and its explicit
retry preserve the original authority and prevent resubmission after withdrawal.

The immutable production APK comes from Android source
`56925350b5b9dc0c7b7e6491d6caf42b6e0e0fcf`, SHA-256
`2f8b3d85bd38b9432f41775f1b00943dfdad472dc08a4eb763dfe195b4ecf5d6`.
The [signed-build receipt](evidence/android-0.6.84-signed-build-2026-10-13.json)
records certificate, V3-only scheme, full reviewed lineage and independent
unsigned/signed ZIP payload equality. Every payload entry matches the
physical-tested candidate except the embedded source metadata.

On the Pixel, short AAC audio and H.264/AAC video saved to Downloads and
completely decoded; audio picker cancellation retained the recording for a
successful retry. Physical long export, interruption, additional document
providers and independent Android playback remain unverified. Native keeper
quiet mode is unsupported. Those acceptance limits are separate from publishing
this exact artifact; the owner explicitly requested shipment.

Final-source workflow `38379975239` is required before merging the Android PR.
Website/GitHub/Zapstore publication and live readback are recorded separately.

## Android 0.6.83 preparation — 12 October 2026

The production candidate is version **0.6.83**, code **106**, from source
`6d8cb86dbedf827726cd7e20c166afc5f4ec4b12`. It retains interrupted invitation
changes and refuses reconnection when required hosting data is missing or damaged.
Room-list refreshes and artwork updates preserve the latest accepted state.

The immutable APK is 79,747,742 bytes, SHA-256
`74f006412ece18a4fbfe11c5b05ac799d174bbafb3e69a34619306046c0b37ef`.
Independent verification checks version/SDKs, the production certificate,
V3-only signing and the complete reviewed lineage. A fresh build on a second
Mac matches all 799 unsigned/signed ZIP payload entries. The initial cached
build differed in a generated Compose stability flag and baseline profile;
that mismatch is retained in the [signed-build receipt](evidence/android-0.6.83-signed-build-2026-10-12.json).

Integration main CI passes all sixteen jobs with actual reports audited.
The release's own sixteen-job PR/main gates, website CI, publication readbacks,
Zapstore publication/client indexing and physical acceptance remain separate.
This preparation does not claim publication or physical-device installation.

## Prepare one reviewable publication

The Android build must produce `kithmoot-0.6.0-production.apk` and print its APK,
production-certificate and lineage SHA-256 values. Record those values with the
physical acceptance evidence before changing this repository.

1. Copy `deploy/android-production-release.template.json` over
   `site/android-release.json`.
2. Replace the two placeholders with the independently recorded APK and
   production-certificate SHA-256 values. Leave the published preview
   certificate and its five reviewed capabilities unchanged.
3. Change the Android article in `site/index.html` to the production attributes
   and copy below. Keep the stable `/apk/kithmoot-latest.apk` link.

```html
<article id="android" class="platform" data-android-channel="production" data-android-version="0.6.0" data-android-version-code="23">
  <p class="platform-label">Android</p>
  <h3>A native client for your phone.</h3>
  <p>Android 13 or later. Version 0.6.0 is the first production-signed release. It updates the public preview in place and keeps its encrypted rooms, projects, Link consent and cadence state. A retained preview local-key account must be restored through a signer using the same identity; a different identity is refused before stored account data changes.</p>
  <p class="release-note"><strong>Production release.</strong> Signed with the owner-held KithMoot certificate and the reviewed preview-to-production lineage. No private key or room data is exported during the update.</p>
  <a class="button" href="apk/kithmoot-latest.apk?download=1">Download Android</a>
  <a class="source-link" href="https://github.com/forgesworn/kithmoot-android/releases">Release notes and source <span aria-hidden="true">↗</span></a>
</article>
```

The verifier binds the copy and manifest to the exact APK. It checks the file
hash, package, version, SDK floor and target, debuggable flag, current signing
certificate, v1/v2/v3 scheme states, both embedded lineage certificates and all
five capabilities granted to the previous signer.

```bash
nvm use 24
export ANDROID_APK=/absolute/path/to/kithmoot-0.6.0-production.apk
npm run verify:android-publication -- --apk "$ANDROID_APK"
DEPLOY_HOST=deploy@YOUR_BOX deploy/deploy.sh --dry-run
```

Review and merge the manifest/copy change before the public deployment. Use the
same immutable APK for the website and GitHub release; do not rebuild between
them.

## Publish and prove the exact result

State the exact host, source commit, APK hash and certificate before running the
real command:

```bash
ANDROID_APK=/absolute/path/to/kithmoot-0.6.0-production.apk \
DEPLOY_HOST=deploy@YOUR_BOX \
  deploy/deploy.sh
```

The deploy uploads the timestamped website and APK without activating either.
It rechecks the APK hash on the box, refuses to overwrite a different file with
the same versioned name, then switches the stable APK link and website release
together. If the website switch fails, it restores the previous APK link.

Afterwards, download the public stable URL and independently repeat the APK
hash, `aapt` and `apksigner` checks. Confirm that the live
`/android-release.json` matches it, the production copy is visible, the old
preview upgrades in place on the accepted physical phone, and the old-signed
APK is still refused. Publish the GitHub release only with that same artifact
and recorded evidence.

## Publish and verify Zapstore separately

A website deployment or GitHub release does not publish a Zapstore release.
Treat Zapstore as a separate delivery gate for every production Android version.
Use [Zapstore's publisher](https://zapstore.dev/docs/publish) with the exact
already-verified APK, the Android repository's `zapstore.yaml` metadata and
release notes for that version. Point `release_source` at that one APK rather
than relying on whichever local build happens to match a glob. The repository
changelog may lag the signed GitHub release notes.

A local APK source advertises the publisher's Blossom download URL. To keep
Zapstore downloads available during a CDN outage, the private publication
configuration can instead name the verified immutable GitHub APK URL as
`release_source`, with `BLOSSOM_URL=https://kithmoot.app/apk` for the prepared
owner mirror. The publisher includes the upstream URL first and the
content-addressed mirror second. Use the exact versioned GitHub asset, never a
moving `latest` URL.

Before signing, stage that same APK and the configured icon under their SHA-256
names in the public APK directory. Check server-side hashes and full public
downloads, and confirm HEAD returns 200 at both mirror paths. The publisher's
existence check then uses the already prepared files; the website's APK
directory is a download mirror. Keep the existing versioned APK immutable and
retain its production signing certificate and lineage.

The existing KithMoot listing belongs to
`npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`.
Preserve that publisher. The Nostr publisher key is separate from the Android
APK signing certificate. Keep signer connections and client keys in private
local configuration, outside repository files, command history and release logs.

Check the connected signer's actual public key before uploading or publishing.
In `zsp` 0.4.12, the config's publisher check resolves local `nsec`/`npub` values
but does not enforce the returned key for asynchronous bunker/browser signers.
The 0.6.75 publication used a local post-connection publisher check before the
normal publisher workflow. A rejected or expired bunker connection is a failed
connection, not evidence that a release-signing request reached the signer.

After publication, run the read-only channel verifier from this repository:

```bash
npm run verify:zapstore-publication -- --output /tmp/kithmoot-zapstore-receipt.json
```

It waits for the Zapstore relay to complete its query, verifies Nostr event
signatures and the existing publisher, checks the latest `main` release against
the production manifest, follows its signed APK asset reference, and compares
the advertised version/code, SDKs, certificate, filename and size. It then
downloads every advertised public artifact and verifies its byte count and SHA-256.
It checks every advertised download against the same manifest, accepting only
the exact versioned GitHub APK and owner-hosted versioned/content-addressed
mirrors alongside Zapstore's content-addressed CDN. An unavailable source,
duplicate URL, unexpected host/path, partial response, truncated file or
different payload fails verification. It signs nothing and reads no private
key. `--manifest /path/to/manifest.json`
can check a prepared release manifest before it becomes the website manifest.
An absent/stale release, invalid signature, mismatched asset, incomplete relay
query or unavailable/mismatched download fails the command.

The APK's Android signature and lineage remain the responsibility of
`verify:android-publication` above. A successful channel receipt does not prove
that Zapstore's Android client has indexed the update or that a physical phone
has installed and accepted it; the receipt leaves those gates explicitly open.

Prepared release, 10 October 2026: **0.6.79**, code **102**, from Android
main `04062201179cb41bb993c08c0c9e255bbc8a166c`. Opening a chat no longer
changes its activity time or list position. The single-message Send guard
from 0.6.78 remains. GitHub publishes the immutable production APK; website
and Zapstore publication still require their independent release gates.

The APK is 79,362,718 bytes, SHA-256
`39f819ae81ec1efb9990ea89d7872e143bddc06fcb7f6f751a1dba1a1df5cfbc`.
Full downloaded APK verification checked version/SDKs, the production
certificate, V3-only signatures and the reviewed previous-signer capabilities.
401 protocol, 1,911 debug app and 1,911 release app unit tests, both lint gates,
and hosted recovery/signing-lineage checks passed. Physical-device acceptance
remains open. The [release evidence](evidence/conversation-admission-release-2026-10-10.json)
records the separate publication states.

Earlier Prepared release, 10 October 2026: **0.6.78**, code **101**, from Android
source `7eccbea6decc40457a806692d44ec105e8149054`. Repeated Send taps claim
the composer synchronously, preventing copies of the same pending draft. A new
draft can queue as soon as its predecessor is encrypted and retained locally,
while relay confirmation is pending. Intentional repeated text remains allowed.
The immutable APK is 79,334,046 bytes, SHA-256
`f3ee6f3033236dc90f136588e69c1365477da659bed22fe489f7fda887f351e9`.
The existing M4 production key signed it; independent M1 verification checked
all 799 unchanged ZIP payload entries, version/SDKs, certificate, V3 signing
and previous-signer capabilities. The [signed-build receipt](evidence/android-0.6.78-signed-build-2026-10-10.json)
records local unit/lint/build and real-composer emulator evidence. Both update
manifests are signed. All four hosted checks passed on that exact source; the
merged native tree `9647360` matches it. Publication readbacks, Zapstore-client
indexing and physical tester acceptance remain separate gates.

Prepared release, 10 October 2026: **0.6.77**, code **100**, from Android
source `e4b080cb37acfdeb5e1d204bb28291971a4f545d`. The immutable APK is
79,305,374 bytes, SHA-256
`8f6465ac113e8060aae539ece7218d5283cc7d0a2338f7aa47d7e780bb954234`.
The M4 signed it with the existing production certificate and lineage;
independent M1 verification checked all 799 unchanged ZIP payload entries,
version/SDKs, certificate, V3-only signing and previous-signer capabilities.
Both unit-test variants and both lint checks passed. The [signed-build receipt](evidence/android-0.6.77-signed-build-2026-10-10.json)
keeps source, signed artefact and publication gates distinct. Hosted release CI,
public website/GitHub/Zapstore readbacks and physical/client acceptance require
their own evidence; this preparation paragraph does not claim publication.

Latest verified publication, 10 October 2026: **0.6.77**, code **100**, channel
`main`, APK SHA-256
`8f6465ac113e8060aae539ece7218d5283cc7d0a2338f7aa47d7e780bb954234`,
79,305,374 bytes. The [production receipt](evidence/android-0.6.77-publication-2026-10-10.json)
records all four native release gates, exact merged/build tree equality, website
main `5a59381`, all twelve publication checks and release
`20261010T052716Z`. All 305 deployed files and thirteen public assets matched;
the downloaded stable APK passed full signature and lineage verification.
GitHub and the Zapstore CDN returned the same immutable bytes. Signed Zapstore
release `4656e5b24f1f6997c38ab85ddf2c702b43437240cb0df1ffd09790571705af77`
references asset `53c77ab91055bea62b48ab2b191a4d9e3cf6ade3d8ec7ca1efffe9d60c836f4e`
under the existing publisher. Relay EOSE, signatures and the entire CDN download
were verified. Physical installation and Zapstore-client acceptance remain open.

Previous verified publication, 9 October 2026 at 23:44 UTC: version **0.6.76**,
code **99**, channel `main`, APK SHA-256
`733a1a778e53edfe083d59b5480279dbc18126b3b38634f1b55206b0d6c474d5`,
79,137,438 bytes. Signed release
`6158b03a5c051967200e2878eb59d506f3758799adcf226fa8b55ea907d9d939`
references asset
`984be9a9e7124073a2cc50d3d184b22aea43618c4a85998a6ddc896ecfd08db9`.
The existing publisher, both event signatures, release reference, certificate,
version/code and complete CDN download matched the production manifest. The
same APK was independently downloaded from the
[GitHub release](https://github.com/forgesworn/kithmoot-android/releases/tag/v0.6.76)
and matched its recorded hash and size. Zapstore-client indexing and physical
installation remain unverified. This Android release adds signed capture notices;
it does not provide native recording/export.

Earlier verification, 9 October 2026 at 21:22 UTC: version **0.6.75**, code **98**, channel
`main`, APK SHA-256
`9eeb8ef7a301568455247b94f791153cb8ba99153258ad95085d45e05d5f78db`,
79,088,286 bytes. The signed release event is
`c493f7e442ed447971fdf2cbc3ad48adbf1c580b221f0cc24a6b92668e2be674`,
referencing APK asset
`2a11e34ac43c689f7213584970a9dd4f678bfe0624f508367898bc063eb5bca0`.
The public download matched the production manifest. Store-client and physical
installation acceptance were not claimed by that publication check.


## Android 0.6.80 website publication — 11 October 2026

[PR #367](https://github.com/forgesworn/kithmoot/pull/367) merged after all twelve
hosted checks passed. Merged source `a76de8ad7711ab25b063f64eebd6430d45639e98`
passed typecheck, 3,903 unit tests, 132 MLS browser checks and 19 website/update
browser checks before deployment. Website release `20261010T235516Z` now serves
the signed 0.6.80 (103) update manifest and stable Android download.

The public stable APK is the same immutable 79,411,870-byte production artifact
already published on GitHub and Zapstore, SHA-256
`09a5e5de88aa670a3f64318a1e11ed12b05c39c7b9d80897b07d7faea7944c10`.
A fresh full download passed independent package, SDK, original certificate,
V3-only signature and reviewed-lineage verification. All 305 server and public
HTTP files matched the build; clean 390/1440-pixel light/dark browser checks
found no page errors or horizontal overflow. Desktop 0.1.72 and previous
installers/APKs remain available. The previous website release is retained.

The native guest camera/microphone preview on Android main, the newer recording
permission guidance and draft logo feature are separate changes and are not
included in this publication. Physical Android and Zapstore-client installation
acceptance remain open. The [publication receipt](evidence/android-0.6.80-website-publication-2026-10-11.json)
records the exact source and these boundaries.
