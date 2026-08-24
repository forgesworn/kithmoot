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
- An installable PWA — add it to a home screen or dock; a service worker
  carries the shell offline.

## What does not work yet

Stated plainly, before anyone else finds it:

- **No forwarders.** Every device talks to every other device directly,
  which puts a hard ceiling on room size — mesh is practical to roughly 8
  people. Past that, the upload arithmetic bites: a legible 1080p screen
  share to 20 peers needs 30–50 Mbps up, and no domestic connection has
  that. Forwarding is stage 3.
- **No end-to-end encryption through a forwarder yet — because there is no
  forwarder yet.** Pure mesh is already end-to-end via DTLS-SRTP; that
  property has to be re-earned once media starts passing through something
  else.
- **No Android app yet.** Native Kotlin, and the interop proof it needs to
  ship with, are stage 4.
- **No published test vectors yet.** Also stage 4.
- **Kind numbers are provisional** (`src/kinds.ts`) and will change once the
  spec is written.

## Running it

```bash
npm install
npm test          # 98 tests, in-process relay simulator, no network
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

## The nostr-tools pin

`nostr-tools` is pinned at exactly `2.23.9` — not a range. Versions
`>=2.23.11` silently kill long-lived subscriptions
([nbd-wtf/nostr-tools#539](https://github.com/nbd-wtf/nostr-tools/issues/539)),
and a conference room is nothing but long-lived subscriptions. Don't widen
this pin without checking that issue is closed.

## The acceptance test

This is the whole of the product's claim, checked by hand and, since stage 2,
repeated on every run by `npm run test:e2e` against live public relays:

1. On a **laptop**, open the app, click **Start a room**, then **Screen
   share**. Pick a window.
2. Click **Add a device**. Copy that link — not the plain room link above
   it — and send it to a **phone** only.
3. On the phone, open the pairing link, then click **Microphone** and
   **Camera**.
4. On a **third** browser — a different device, or a private window with a
   fresh profile — open the plain room link from step 1, and click **Join
   room**.

Expected, on the third browser: **one** tile group, reading "2 devices" with
a "one person" badge, carrying live screen video from the laptop and live
camera video and audio from the phone. Muting on the phone mutes you
everywhere. Nothing echoes, because only one device holds the mic role at a
time. That tile is the product; everything else on the page is scaffolding
to show it.

## Licence

MIT
