# KithMoot

**A town hall nobody owns.**

KithMoot is a conference room protocol built on Nostr. Rooms have no server: no
account to register, no operator who can see the guest list, nothing to run
except the relays that already exist. A room is a secret, held by whoever has
the link. Anyone holding it can join; nobody outside it can even tell the room
exists.

## The claim

A person, not a device, is the unit that joins a room. Bring a phone for
camera and mic and a laptop for a screen share, and everyone else sees **one
participant** with three tracks — not two strangers who happen to share a
room.

Every incumbent gets this wrong, Jitsi included: identity is per-connection,
so the same person joining from a laptop and a phone shows up as two separate
tiles, two names, two mute buttons. KithMoot groups by participant instead of
by connection. That's the whole product; everything else in this repo exists
to make that one thing true.

## What works today

- Room creation and join by URL — a room is a 32-byte secret carried in the
  link's fragment, never seen by whatever's serving the page.
- Kindred-gated access tiers (`open` / `ken` / `kith` / `kin`), built on the
  `kindred` primitive. A room can admit anyone with the link, or require
  proof of anything up to a mutually-verified bond.
- A participant-grouped roster: every device's presence is grouped by who it
  belongs to, and singular roles (`mic`, `monitor`) are arbitrated
  deterministically so two devices under one identity can never both claim
  the live microphone.
- Mesh WebRTC — video, voice and screen share, negotiated directly between
  devices with no media server in the path. SDP/ICE signalling travels
  wrapped in a NIP-59-style gift wrap addressed to one peer, so a relay
  carrying it never reads it.
- Room-key-encrypted chat (NIP-44), durable across a relay restart so it's
  there for anyone who joins late.
- **Names, and optionally a real Nostr identity.** Type a name and join, or
  sign in with a key you already have. See below.
- An installable PWA — add it to a home screen or dock; a service worker
  carries the shell offline.
- **Forwarders**, so a room can outgrow the mesh. The room names them the way
  it names its TURN servers: a plural, swappable list. Promotion happens on
  *measured capacity*, never on headcount — two people sharing legible 1080p
  screens can need a forwarder while twenty on audio-only do not.
- **Media a forwarder cannot read.** A forwarder is given the room *id* and
  never the room *key*. Media is encrypted under a separately derived key, so
  it routes ciphertext it cannot decrypt and cannot forge attribution for.
- **A native Android app** (`forgesworn/kithmoot-android`) — a second,
  independent implementation, written against the published vectors without
  reading this codebase.
- **53 published interop vectors** (`vectors/`), which both implementations
  are checked against.

## Names, and who you are

Two ways in, one participant model.

**Type a name.** The default, and the whole of it: the app generates a
participant key, you type what people should call you, and you join. The
name is **self-asserted** — anyone can type any name, including yours — so
it never stands alone. A short pubkey renders beside it everywhere, on
tiles and in chat, and the full npub is on the element's title. Two people
who both typed "Darren" are visibly two people.

**Sign in with Nostr.** Optional, behind a disclosure so it never gets in
the way. Uses [`signet-login`](https://www.npmjs.com/package/signet-login)
for the whole picker — NIP-07 extensions, NIP-46/NostrConnect, bunker URIs,
Amber on Android, and an nsec fallback — and the participant key becomes
your real Nostr identity, held wherever it already lives.

**This is a security improvement, not only a feature.** On the signer path
there is **no participant secret in `localStorage` at all**. The reason it
works is that the participant key signs exactly one thing: a device
credential, one small event per room. Everything else already runs on other
keys — the device key signs the roster and the gift-wrapped signalling, the
room key encrypts the roster and the chat. So the whole surface an identity
has to cover is a pubkey and an async `signEvent`, which is
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
  the only signal that exists — nothing on the wire distinguishes a real
  Nostr key from one this browser generated a moment ago, and nothing
  could.
- **A kind-0 name is also self-asserted.** It says "the holder of this key
  calls themselves Darren", which is the same kind of claim as a typed
  name; the difference is that the key is persistent and has a history.
  It is never labelled "verified", because it is not.
- **Names are sanitised at both ends.** `sanitiseDisplayName`
  (`src/display-name.ts`) strips every Unicode "other" character —
  controls, bidirectional overrides, zero-width padding — collapses
  whitespace, and caps the result at 32 code points. Applied on encode so
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
| **Android** — native app | yes | yes | yes | yes |
| **Android** — browser / PWA | yes | yes | yes | unreliable |
| **iOS / iPadOS** — Safari or PWA | yes | yes | yes | **no** |

**There is no iOS app.** The web app loads on iOS and video, voice and chat
work, but **`getDisplayMedia` does not exist on iOS Safari**, so screen
sharing is impossible from an iPhone or iPad in any browser — including
Chrome and Firefox for iOS, which are Safari underneath. Sharing an iOS
screen needs a native app using ReplayKit, which is not built.

This is also why the Android client is native rather than a browser tab:
mobile browsers cannot reliably share a screen, and screen sharing is half
the point.

## What does not work yet

Stated plainly, before anyone else finds it:

- **No iOS app.** See above — and it is the largest gap.
- **Forwarder trees are two levels deep.** Enough for a room of about 21;
  beyond that nobody has measured anything.
- **No browser-as-forwarder.** It needs WebRTC Encoded Transform, which is
  solid in Chrome and patchy in Safari, so it stays opportunistic and never
  load-bearing. The reference forwarder is a small Node process.
- **Android consumes forwarders, it cannot act as one.**
- **Encrypted media costs an extra encode/decode pass** and interacts badly
  with some hardware codec paths. It is only *needed* once a forwarder is in
  the path — pure mesh is already end-to-end via DTLS-SRTP.
- **Kind numbers are provisional** (`src/kinds.ts`) and will change once the
  spec is written.

## Running it

```bash
npm install
npm test          # 454 tests, in-process relay simulator, no network
npm run test:live # wire format against real public relays
npm run test:e2e  # the acceptance test below, automated, over live relays
npm run typecheck
npm run demo       # HTTPS dev server for driving the app by hand, phone included
npm run build      # production PWA build, to app/dist
```

`npm run test:live` and `npm run test:e2e` need the network, and real relays
have real weather — both are excluded from `npm test` for that reason. `npm
run demo` serves the app over HTTPS with a self-signed certificate
(`@vitejs/plugin-basic-ssl`): `getUserMedia` and `getDisplayMedia` both
require a secure context, and a phone reaching your laptop over its LAN IP
isn't one without TLS. Your browser will warn about the certificate; accept
it to proceed. The terminal prints a `Network:` URL for the phone to use.

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
2. Click **Add a device**. Copy that link — not the plain room link above
   it — and send it to a **phone**. Leave the laptop page open: it is what
   answers the phone, and closing it retires the link.
3. On the phone, open the pairing link. The laptop asks you to confirm the
   new device; say yes. The phone then waits for its credential — **Join
   room** stays greyed out until it arrives. Once it lights up, click
   **Microphone**, **Camera**, then **Join room**.
4. On a **third** browser — a different device, or a private window with a
   fresh profile — open the plain room link from step 1, and click **Join
   room**.

The pairing link grants a credential for **that room only**, expiring after
twelve hours. It does not carry your identity: the participant key never
leaves the laptop — and if you signed in with Nostr it was never on the
laptop either — so a pairing link that goes astray costs one room for an
afternoon, not your Nostr identity for ever. Step 4 comes last on purpose —
the roster rides an ephemeral kind, so the third browser learns who is
already there because they answer its arrival, not because a relay stored
anything (see `docs/decisions.md`).

Expected, on the third browser: **one** tile group, reading "2 devices" with
a "one person" badge, carrying live screen video from the laptop and live
camera video and audio from the phone. Muting on the phone mutes you
everywhere. Nothing echoes, because only one device holds the mic role at a
time. That tile is the product; everything else on the page is scaffolding
to show it.

## Licence

MIT
