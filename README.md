# KithMoot

**A town hall nobody owns.**

KithMoot is a conference room protocol built on Nostr. There is no account to
register and no operator who holds the guest list. A room is a secret, held by
whoever has the link. Anyone holding it can join; nobody outside it can even
tell the room exists.

**No operator is mandated**, which is not the same as no infrastructure.
Signalling rides Nostr relays that already exist, and media goes device to
device with nothing in the middle. But NAT is a fact: two people behind
symmetric NAT or carrier-grade NAT cannot reach each other directly, and a call
has no origin to fall back to the way a stream does. Roughly one connection in
five cannot be made directly.

What a symmetric-NAT client *can* always do is connect outbound to a peer with
a public address. So a pair that cannot reach each other is offered, in order:
a member of the room who volunteered to carry them, then a forwarder the room
names, then TURN. Most of that one-in-five is somebody in the room being
publicly reachable and willing, and only what is left over reaches a server
anybody pays for.

A room still names its own STUN and TURN servers, the way it names its relays:
a plural, swappable list. Self-host coturn, point at somebody else's, or name
none and accept that some pairs will not connect. Nobody is required, and no
single party can be removed to take the system down. That is the claim, and it
is narrower than "nothing to run".

**Live at [kithmoot.forgesworn.dev](https://kithmoot.forgesworn.dev/).** The app
is at [`/j`](https://kithmoot.forgesworn.dev/j/); the root is a page explaining
what this is. `/j` is short on purpose: a join link carries a 32-byte room
secret plus relay hints in its fragment, and every character in the path costs
QR density.

## The claim

A person, not a device, is the unit that joins a room. Bring a phone for
camera and mic and a laptop for a screen share, and everyone else sees **one
participant** with three tracks, not two strangers who happen to share a
room.

Every incumbent gets this wrong, Jitsi included: identity is per-connection,
so the same person joining from a laptop and a phone shows up as two separate
tiles, two names, two mute buttons. KithMoot groups by participant instead of
by connection. That's the whole product; everything else in this repo exists
to make that one thing true.

## What works today

- Room creation and join by URL. A room is a 32-byte secret carried in the
  link's fragment, never seen by whatever's serving the page.
- Kindred-gated access tiers (`open` / `ken` / `kith` / `kin`), built on the
  `kindred` primitive. A room can admit anyone with the link, or require
  proof of anything up to a mutually-verified bond.
- A participant-grouped roster: every device's presence is grouped by who it
  belongs to, and singular roles (`mic`, `monitor`) are arbitrated
  deterministically so two devices under one identity can never both claim
  the live microphone.
- Mesh WebRTC for video, voice and screen share, negotiated directly between
  devices with no media server in the path. SDP/ICE signalling travels
  wrapped in a NIP-59-style gift wrap addressed to one peer, so a relay
  carrying it never reads it.
- Room-key-encrypted chat (NIP-44), durable across a relay restart so it's
  there for anyone who joins late.
- **Names, and optionally a real Nostr identity.** Type a name and join, or
  sign in with a key you already have. See below.
- **Leaving is instant, and so is a dropped connection coming back.** A
  device that hangs up, closes the tab or navigates away says goodbye, and
  everybody else drops it at once rather than after the presence timeout. A
  connection that was up and reports `disconnected` is given a few seconds
  and an ICE restart before anybody gives up on it, the way Jitsi and Signal
  ride out a Wi-Fi blip, and a relay that drops its socket is re-dialled
  with every subscription re-issued.
- **A fresh device key for every room.** A relay learns the device keys in a
  room from the roster events it carries; one key across every room a
  browser ever joins would let it follow one person from room to room. The
  participant key, the one that identifies a person, only ever rides inside
  the room-key ciphertext.
- An installable PWA. Add it to a home screen or dock, and a service worker
  carries the shell offline.
- **Background blur and replacement**, on by default the first time you turn
  the camera on. Read the honest limits below before trusting it.
- **Voice masking**: pitch and formants shifted independently, in four
  presets. It defeats casual recognition and nothing more. Read the limits.
- **Forwarders**, so a room can outgrow the mesh. The room names them the way
  it names its TURN servers: a plural, swappable list. Promotion happens on
  *measured capacity*, never on headcount: two people sharing legible 1080p
  screens can need a forwarder while twenty on audio-only do not.
- **Media a forwarder cannot read.** A forwarder is given the room *id* and
  never the room *key*. Media is encrypted under a separately derived key, so
  it routes ciphertext it cannot decrypt and cannot forge attribution for.
- **Peer assist**, so a room's spare uplink comes from the people in it. A
  member that measures itself publicly reachable can offer to carry the pairs
  that cannot connect directly, and the room tries that before any server. It
  is opt in, revocable mid-call, never suggested on a phone or on battery or
  on a metered connection, and capped so volunteering cannot ruin the
  volunteer's own call. A fixed relay has fixed capacity; a room whose members
  carry it gets more capable as more people arrive.
- **A native Android app** (`forgesworn/kithmoot-android`), a second
  independent implementation, written against the published vectors without
  reading this codebase.
- **55 published interop vectors** (`vectors/`), which both implementations
  are checked against.

## Names, and who you are

Two ways in, one participant model.

**Type a name.** The default, and the whole of it: the app generates a
participant key, you type what people should call you, and you join. The
name is **self-asserted**. Anyone can type any name, including yours, so it
never stands alone. A short pubkey renders beside it everywhere, on tiles
and in chat, and the full npub is on the element's title. Two people who
both typed "Darren" are visibly two people.

**Sign in with Nostr.** Optional, behind a disclosure so it never gets in
the way. Uses [`signet-login`](https://www.npmjs.com/package/signet-login)
for the whole picker (NIP-07 extensions, NIP-46/NostrConnect, bunker URIs,
Amber on Android, and an nsec fallback), and the participant key becomes
your real Nostr identity, held wherever it already lives.

**This is also a security improvement.** On the signer path there is **no
participant secret in `localStorage` at all**. The reason it works is that
the participant key signs exactly one thing: a device credential, one small
event per room. Everything else already runs on other keys: the device key
signs the roster and the gift-wrapped signalling, the room key encrypts the
roster and the chat. So the whole surface an identity has to cover is a
pubkey and an async `signEvent`, which is
`ParticipantIdentity` in `src/identity.ts`. A locally generated key and an
external signer both satisfy it, and nothing else in the protocol can tell
which it has.

A signer that can prove who you are but cannot sign afterwards (an
auth-only session) is refused with a reason, because a room needs that one
signature per join.

### What a name is worth, stated plainly

- **A typed name is a claim.** Nothing checks it. That is the point of the
  zero-friction path, and it is why the pubkey is always beside it.
- **A `nostr` chip means the key has a published kind-0 profile.** That is
  the only signal that exists. Nothing on the wire distinguishes a real
  Nostr key from one this browser generated a moment ago, and nothing
  could.
- **A kind-0 name is also self-asserted.** It says "the holder of this key
  calls themselves Darren", which is the same kind of claim as a typed
  name; the difference is that the key is persistent and has a history.
  It is never labelled "verified", because it is not.
- **Names are sanitised at both ends.** `sanitiseDisplayName`
  (`src/display-name.ts`) strips every Unicode "other" character (controls,
  bidirectional overrides, zero-width padding), collapses whitespace, and
  caps the result at 32 code points. Applied on encode so
  this client never publishes a hostile name, and on decode because no
  other client is obliged to have bothered. Markup is deliberately kept as
  literal text: what makes it safe is that a name never reaches
  `innerHTML`, and there is a guard test for that rather than a filter
  pretending to be one.
- **A name is inside the ciphertext.** It rides in the room-key-encrypted
  roster alongside the participant pubkey, so a relay carrying a room
  cannot read its guest list by name any more than it can by key.

## Which platforms

| | Video | Voice | Chat | Screen share |
|---|---|---|---|---|
| **Desktop browser** (Chrome, Firefox, Safari) | yes | yes | yes | yes |
| **Android** (native app) | yes | yes | yes | yes |
| **Android** (browser / PWA) | yes | yes | yes | unreliable |
| **iOS / iPadOS** (Safari or PWA) | yes | yes | yes | **no** |

**There is no iOS app.** The web app loads on iOS and video, voice and chat
work, but **`getDisplayMedia` does not exist on iOS Safari**, so screen
sharing is impossible from an iPhone or iPad in any browser, including
Chrome and Firefox for iOS, which are Safari underneath. Sharing an iOS
screen needs a native app using ReplayKit, which is not built.

This is also why the Android client is native rather than a browser tab:
mobile browsers cannot reliably share a screen, and screen sharing is half
the point.

## Background blur, and what it is not

Blur is **on by default** the first time you enable your camera, and the
control to turn it off sits directly under the camera toggle. That default is
one constant, `BLUR_ON_BY_DEFAULT` in `src/video-effects.ts`. The reasoning:
the failure mode of blur-on is a slightly soft background and some battery,
and the failure mode of blur-off is publishing your living room to a room of
people, which is a thing that has actually happened to this project.

What it does not do:

- **Segmentation is a guess.** It is worst at hair, at held objects, in low
  light and under fast movement, and every one of those failures publishes a
  piece of the real room for a frame or two. Treat it as making a room harder
  to read, not as a guarantee nobody can see it.
- **It costs CPU and battery.** Measured on an M4 Max in Chromium at
  640x480 and 30fps: 8.2ms of work per frame and 28% of the renderer's main
  thread, against 0.3ms and 3% with the effect off. A slower machine will
  drop frame rate before it drops the effect.
- **It is a first-use download.** MediaPipe's segmenter is 11.7MB of WASM
  (3.4MB gzipped) plus a 250KB model. Nothing is fetched until you turn an
  effect on, and it is served from the same origin as the app rather than
  from Google's CDN, so enabling blur does not announce you to a third party.
- **If it fails, the camera passes through unmodified** rather than going
  black or taking the call down, and the control says so in red. That is
  deliberate: a broken effect must not end a call. It does mean a failure
  shows the room, so the message is worded to be acted on.

Background *replacement* offers three bundled abstract images. There are no
uploads, because a user-supplied picture is a file-handling surface and can
itself leak - a holiday photo, an office, a name badge.

The risky moment is a camera flip or a device change, where a naive
implementation publishes a few hundred milliseconds of unblurred frames.
KithMoot publishes the canvas rather than the camera, so a flip changes only
what feeds the canvas: the published track is the same object before and
after, nothing renegotiates, and the effect is told the source is changing
before it changes. From that instant every frame is blurred whole until the
new camera produces a mask. `test/effects.spec.ts` swaps the camera four
times and asserts that not one frame took the unmodified route.

## Voice masking, and what it is not

**It is masking, not anonymity.** It shifts your pitch and moves the
resonances of your voice separately from it, which is enough that someone who
knows your voice will not place it straight away.

It will **not** stop anyone holding a recording of your voice who wants to
match it, and it does not survive a forensic comparison. Do not lean on it
where being identified would matter. The words "anonymous" and
"unidentifiable" appear nowhere in the interface, deliberately.

Four presets - off, lower, higher, neutral - rather than free sliders, so the
result is predictable and every option stays intelligible on a bad line.
"Hear yourself" records three seconds of the outgoing audio and plays it
back, so you hear what the room hears rather than what your own skull tells
you.

Measured added latency, at 48kHz: **0ms on off** (a real bypass, not the
vocoder configured to do nothing) and **16ms on every other preset**
(15.5ms to 18.5ms by onset measurement, against a 16.0ms algorithmic
figure). The budget was 50ms. Formant shifting is what makes this more than
a chipmunk: a pitch shift alone is undone by shifting back, whereas moving
the excitation and the envelope by different factors is not a
one-parameter inverse.

## What does not work yet

Stated plainly, before anyone else finds it:

- **No iOS app.** See above. It is the largest gap.
- **Forwarder trees are two levels deep.** Enough for a room of about 21;
  beyond that nobody has measured anything.
- **No browser-as-forwarder.** It needs WebRTC Encoded Transform, which is
  solid in Chrome and patchy in Safari, so it stays opportunistic and never
  load-bearing. The reference forwarder is a small Node process.
- **Android consumes forwarders, it cannot act as one.**
- **Encrypted media costs an extra encode/decode pass** and interacts badly
  with some hardware codec paths. It is only *needed* once a forwarder is in
  the path; pure mesh is already end-to-end via DTLS-SRTP.
- **Kind numbers are provisional** (`src/kinds.ts`) and will change once the
  spec is written.
- **No background effects or voice masking on Android yet.** The web app has
  both; the native client does not. The Android client is the one most likely
  to be used somewhere sensitive, so this is the gap that matters most.
- **No face blurring, and no redaction of other people in shot.** The
  segmenter finds one person and treats everything else as background, so a
  second person behind you is blurred rather than hidden.
- **No user-uploaded backgrounds**, on purpose. See above.

## Running it

```bash
npm install
npm run build:lib # the forwarder and its tests import the library from dist/
npm test          # 713 tests, in-process relay simulator, no network
npm run test:live # wire format against real public relays
npm run test:e2e  # the acceptance tests, in a real browser, over live relays
E2E_RELAYS=local npm run test:e2e  # the same, against test/ws-relay.mjs: what CI runs
npm run typecheck
npm run demo       # HTTPS dev server for driving the app by hand, phone included
npm run build      # production PWA build, to app/dist
```

`npm run build:lib` comes first on a fresh clone. `server/forwarder.mjs` and
two of the test files import the library from `dist/`, which is a `tsc` output
and is not committed; without it `npm test` quietly loads 391 tests instead of
454, because three suites fail to resolve their imports rather than failing an
assertion. Once `dist/` exists it stays, which is why this is easy to miss
locally and impossible to miss in CI.

`npm run test:live` and `npm run test:e2e` need the network, and real relays
have real weather, so both are excluded from `npm test`. The acceptance
specs also run in CI on every push, against a NIP-01 relay of their own
(`test/ws-relay.mjs`, started by `playwright.config.ts` when
`E2E_RELAYS=local`): two or three browser contexts in a room, measured off
the decoded pixels and the audio energy rather than the DOM. That gate
exists because the unit suite once passed 685 tests while the shipped app
negotiated media perfectly and put none of it on screen. The relay also
takes `RELAY_OK_DELAY_MS`, which delivers an event at once and acknowledges
it late: a slow public relay made deterministic, which is how the case where
the joiner could not see or hear whoever started the room is pinned down on
a loopback socket that would otherwise never show it.

`npm run demo` and `vite preview` both serve the app under `/j/` rather than at
the root, because `base` in `app/vite.config.ts` matches where it is
published. The asset URLs, the web manifest and the service worker's scope
all derive from it.

`npm run demo` serves the app over HTTPS with a self-signed certificate
(`@vitejs/plugin-basic-ssl`): `getUserMedia` and `getDisplayMedia` both
require a secure context, and a phone reaching your laptop over its LAN IP
isn't one without TLS. Your browser will warn about the certificate; accept
it to proceed. The terminal prints a `Network:` URL for the phone to use, with
the `/j/` already on it.

## The nostr-tools version guard

`nostr-tools` versions `>=2.23.11 <2.24.2` silently killed long-lived
subscriptions
([nbd-wtf/nostr-tools#539](https://github.com/nbd-wtf/nostr-tools/issues/539)),
and a conference room is nothing but long-lived subscriptions. That issue
is closed, and we now depend on `^2.25.0` with no exact pin. A test in
`src/nostr-tools-version-guard.test.ts` still fails the build if a future
install resolves back into the broken range.

## The acceptance test

This is the whole of the product's claim, checked by hand and, since stage 2,
repeated on every run by `npm run test:e2e` against live public relays:

1. On a **laptop**, open the app, click **Start a room**, then **Screen
   share**. Pick a window, and click **Join room**.
2. Click **Add a device**. Copy that link, not the plain room link above
   it, and send it to a **phone**. Leave the laptop page open: it is what
   answers the phone, and closing it retires the link.
3. On the phone, open the pairing link. The laptop asks you to confirm the
   new device; say yes. The phone then waits for its credential: **Join
   room** stays greyed out until it arrives. Once it lights up, click
   **Microphone**, **Camera**, then **Join room**.
4. On a **third** browser (a different device, or a private window with a
   fresh profile), open the plain room link from step 1, and click **Join
   room**.

The pairing link grants a credential for **that room only**, expiring after
twelve hours. It does not carry your identity. The participant key never
leaves the laptop, and if you signed in with Nostr it was never on the
laptop either, so a pairing link that goes astray costs one room for an
afternoon, not your Nostr identity for ever. Step 4 comes last on purpose:
the roster rides an ephemeral kind, so the third browser learns who is
already there because they answer its arrival, not because a relay stored
anything (see `docs/decisions.md`).

Expected, on the third browser: **one** tile group, reading "2 devices" with
a "one person" badge, carrying live screen video from the laptop and live
camera video and audio from the phone. Muting on the phone mutes you
everywhere. Nothing echoes, because only one device holds the mic role at a
time. That tile is the product; everything else on the page is scaffolding
to show it.

## Publishing

Live at [kithmoot.forgesworn.dev](https://kithmoot.forgesworn.dev/), served by
Caddy from a Hetzner box. `deploy/deploy.sh` builds the app, assembles `site/`
at the root with `app/dist` under `j/`, rsyncs it into a timestamped release
directory and flips a `current` symlink at it. A rollback is one symlink
change; nothing is ever built in place, and nothing is deleted without
`--prune`.

`DEPLOY_HOST` has no default and the script refuses to run without it. That is
deliberate: this repository is public, so the box's address is not written down
in it, and there is no host to deploy to by accident.

```bash
export DEPLOY_HOST=deploy@your-box   # required; no default
deploy/deploy.sh                  # build, ship, flip the symlink
deploy/deploy.sh --install-caddy  # also install the vhost, validate, reload
deploy/deploy.sh --dry-run        # build and assemble, touch nothing remote
deploy/deploy.sh --prune 5        # keep the five most recent releases
```

The published layout:

```
/var/www/kithmoot/
  releases/<ts>/            one deploy: site/ at the root, app/dist under j/
  current -> releases/<ts>  what Caddy's root points at
  apk/                      outside the releases, so a rollback of the site
                            does not take the downloads with it
```

`deploy/Caddyfile.kithmoot` is the vhost, installed as an additive drop-in at
`/etc/caddy/conf.d/kithmoot.forgesworn.dev.Caddyfile`. It never touches another
tenant's directory, unit or vhost, and `--install-caddy` validates the whole
config before reloading, because a broken drop-in would take every site on the
box down with it.

Two things in there are load-bearing and easy to get quietly wrong:

- **The app's headers are set by a matcher, not by overriding a base block.**
  A base `header` block containing `-Server` or a `?` set is deferred by Caddy
  to response-write time, so it runs *after* every matched block whatever the
  file order says. `Content-Security-Policy` and `Permissions-Policy` are
  therefore set by two blocks with disjoint matchers, `/j /j/*` and everything
  else. Get this wrong and the app inherits the marketing page's
  `default-src 'none'` and `camera=()`: it loads as a blank page with the
  camera disabled, and nothing in the server logs says so.
- **The app's CSP is derived from what `app/src/main.ts` does**, not copied
  from another site. It needs `connect-src wss:` for relays a join link names,
  `img-src https:` for kind-0 profile pictures, and `style-src 'unsafe-inline'`
  because `signet-login` builds its signer picker with a `<style>` element.

DNS is a plain `A` record for `kithmoot` in `forgesworn.dev`, grey cloud rather
than proxied, so Caddy issues and renews the Let's Encrypt certificate itself.

The APKs are served from `/apk/`, with `kithmoot-latest.apk` symlinked at the
newest so the page never needs editing when a build lands. `deploy.sh` picks up
whatever is under `kithmoot-android/app/build/outputs/apk/` and skips cleanly
when there is nothing there. No APK is committed to this repository.

## Licence

MIT
