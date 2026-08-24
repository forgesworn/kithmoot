# KithMoot

**A town hall nobody owns.**

KithMoot is a conference room protocol built on Nostr. Rooms have no server: no
account to register, no operator who can see the guest list, nothing to run
except the relays that already exist. A room is a secret, held by whoever has
the link. Anyone holding it can join; nobody outside it can even tell the room
exists.

The idea it is built around: **a person, not a device, is the unit that joins
a room.** Bring a phone for camera and mic and a laptop for a screen share,
and everyone else sees one participant with three tracks - not two strangers
who happen to share a room.

## Stage 1 - what this is, right now

This is the multi-device proof of concept. It proves the identity and roster
model over real relays. It does **not** yet move any media.

**What it does:**

- Derives a room from a 32-byte secret carried in a URL fragment, so the host
  serving the page never learns which room you're in.
- Signs each device into the room with a credential from a separate
  participant key, so relays never see who a device belongs to - only that
  it's authorised.
- Publishes presence as a roster event encrypted to the room key (NIP-44), so
  an outsider holding the wrong secret sees nothing, not even that the room
  is occupied.
- Groups every device's roster entry by participant, so a phone and a laptop
  under one identity appear as **one** participant with the union of their
  advertised tracks.
- Arbitrates singular roles (`mic`, `monitor`) deterministically across a
  participant's devices, so two devices can't both claim the live microphone.
- Wraps SDP/ICE signalling in a NIP-59-style gift wrap addressed to one peer,
  so a relay carrying the signal never reads it.
- Ships a browser demo that makes the multi-device claim visible: local video
  previews, a live roster, and a pairing link for adding a second device to
  your own identity.

**What it does not do yet:**

- **No media flows.** Nothing streams camera, mic, or screen contents between
  devices. Stage 1 proves who's in the room and what they're offering, not
  the call itself. WebRTC negotiation is stage 2.
- **No kindred-gated access tiers.** The name commits to `open`/`ken`/`kith`/
  `kin` tiers built on the `kindred` primitive; stage 1 is a flat room with a
  single secret. That's the first item on the stage 2 plan.
- **No mesh routing or forwarders.** Every device talks to the relay pool
  directly. Topology and bandwidth-aware forwarding are stage 2/3 work.
- **No proper device pairing UX beyond a link.** "Add a device" produces a
  URL carrying your participant secret. That's honest about the protocol,
  not yet a polished flow - there's no QR code, no expiry, no revocation.

## Running the tests

```bash
npm install
npm test          # 55 tests, in-process relay simulator, no network
npm run typecheck
```

A second suite exercises the wire format against real public relays
(`relay.damus.io`, `nos.lol`, `relay.primal.net`). It's excluded from `npm
test` because it needs the network and real relays have real weather:

```bash
npm run test:live
```

## Running the demo

```bash
npm run demo
```

This serves `demo/` over HTTPS with a self-signed certificate (via
`@vitejs/plugin-basic-ssl`) - `getUserMedia` and `getDisplayMedia` both
require a secure context, and a phone reaching your laptop over its LAN IP
isn't one without TLS. Your browser will warn about the certificate; accept
it to proceed. The terminal output prints a `Network:` URL for the phone to
use.

### The acceptance test

This is the whole of stage 1's claim, checked by hand:

1. On a **laptop**, open the demo, click **Start a room**, then **Screen
   share**. Pick a window.
2. Under "This link is you," click **Add a device**. Copy that link - not the
   plain room link above it - and send it to your **phone** only.
3. On the phone, open the pairing link (same LAN; accept the certificate
   warning) and click **Camera + mic**.
4. On a **third** browser - a different device, or a private window with a
   fresh profile - open the plain room link from step 1 and click
   **Observer**.

Expected, on the observer: **one** participant box, reading "2 devices," with
three track chips - `camera`, `mic` (marked *live mic*), and `screen` - each
naming a different device. That box is the product. Everything else on the
page is scaffolding to show it.

## Licence

MIT
