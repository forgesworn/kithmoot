# Finding public call relays over Nostr

Design, 25 October 2026. Both KithMoot change gates (soundness review, and
legal cover against `docs/legal/call-transport-position.md`) have passed;
their changes are recorded below and bind the build.

## What it is

Some independent people run a Spry relay and choose to open it to anyone.
Spry's public mode (spry-turn `docs/public-mode.md`, profile v1) lets them
sign an advert, kind 31478, and publish it to Nostr relays they pick.

This feature lets a KithMoot user find those relays and use one for a call,
the same way they can already enter a TURN relay by hand. It is off until
the user turns it on.

KithMoot ships no list of call relays, no discovery relay, no directory
and no ranking service. It does ship default Nostr relays, run by others
(`data/public-relays.json`), and for a user who has not changed them those
are where adverts are read. The publisher runs nothing for this and learns
nothing from it.

## How it works

1. **Off by default.** Connections gets a switch: "Find public call relays
   on my Nostr relays". The text says that these relays are run by
   strangers, that KithMoot does not check or vouch for them, and that the
   relay sees the call's IP addresses, timing and volume but not its
   content.
2. **Only the user's relays.** When on, the app asks the device's read
   relays for kind 31478, `#d` `spry-turn`, with a `limit` of 64. No other
   relay is contacted for discovery, and no relay is added for it.
   Decided 25 October 2026: the read relays are the device's default
   Connections list (`relayConnections.personal('default')`, entries marked
   read), skipping any that `health('default')` reports failing. Not a
   room's own relays and not invitation hints. This is design (b) for a user
   on the shipped defaults.
3. **Same rules as Spry.** Each advert is checked with the client rules in
   spry-turn `docs/public-mode.md` (signature, expiry, size, freshness,
   replay watermark, hostname rules). The TypeScript check must pass
   spry-turn's `docs/fixtures/public-advert-v1.json`, so the two
   implementations agree.
4. **The user chooses.** The app lists what it found: hostname, the
   operator's own region claim and note, marked as the operator's claims,
   and a reachability check the user starts for a relay they have
   selected, never for the whole list (at most 3 operators for one call,
   per Spry's client rules). It may sort them on this device only, for
   example by the user's last good relay. It never picks one silently the
   first time. Adverts, the replay watermark and the last good relay are
   kept on the device only; they are never published, shared or served.
5. **Credentials come from the operator.** For a call, the app asks the
   chosen relay's credential endpoint for an hour-long login and renews it
   on the call's ICE refresh (review change 1). The login stays on the device, as hand-entered
   logins do today. It is never put in a room link, an invitation or a
   Nostr event.
6. **Relay-only keeps its promise.** If the user picked relay-only mode, a
   failing public relay does not fall back to a direct connection.
7. **Nothing goes back.** No choice, failure, latency or usage is sent to
   ForgeSworn, the operator or anyone else. The chosen operator sees only
   the reachability check, the credential request and the relayed packets:
   the device's IP address, timing, volume and the `Origin` of the app that
   asked. The request carries no cookies or referrer and follows no
   redirect. The device's read relays see the IP address and that a search
   for call relays was made.

A room still names its own STUN and TURN servers as it does today. A
hand-entered device relay still wins over a discovered one.

## Changes from the soundness review

The soundness review on 25 October 2026 found the design sound with these
changes, which bind the build. Code references are to `origin/main` that
day.

1. **Logins last an hour.** Spry's relay caps an allocation at the login's
   remaining life and refuses Refresh after it expires, so a short login
   cuts a call. Spry's public logins now last 3600 seconds. The call's
   existing ICE refresh (`ICE_REFRESH_MS`, `app/src/main.ts`) fetches a fresh
   login from the same operator and applies it with `setConfiguration` and
   `restartIce`, through the same WebKit `transport=tcp` filter as
   `callRelayPeerConnection`; a failure there is shown, not swallowed.
   Renewal runs only while this session has a call, never for someone who
   is only in the room, with jitter, and retries a 429 before the deadline.
2. **A separate login fetcher.** Not `fetchTurnCredential`. It sends
   `POST` with body exactly `{"v":1}` and `Content-Type: application/json`
   (forcing a CORS preflight), with `mode:'cors'`, `credentials:'omit'`,
   `redirect:'error'`, `referrerPolicy:'no-referrer'`, `cache:'no-store'`, a
   4 s timeout and a 4 KiB streaming cap; it needs a 200 with
   `application/json`. Every returned URL must exactly equal one from the
   verified advert, or is dropped. `username` must match
   `^\d+:pub-[0-9a-f]{24}$` with the prefix equal to `expiresAt`;
   `credential` is base64 of at most 64 characters; `expiresAt` is an
   integer in `(now, now+3600+60]`.
3. **Relay-only stays closed.** After a login lapses the relay is dropped
   and relay-only refuses, as today. Failover goes only to relays the user
   chose for this call, at most 3 operators counting the check. No fresh
   discovery mid-call, no direct fallback. The user sees "call relay lost",
   not the generic notice.
4. **What a browser can check.** It cannot resolve DNS, so the rule is:
   the hostname rules ported from Spry, an extra suffix denylist (`arpa`,
   `lan`, `home`, `localdomain`, `onion`, `alt`, `example`, plus Spry's), TURN
   ports 3478, 5349 or 443 only, and no TURN packet to a host until a login
   fetch to the same hostname over HTTPS has succeeded. Never probe in the
   background. What remains (DNS rebinding on plain `turn:`, internal hosts
   with valid public certificates) is bounded by the user's selection and
   the 3-operator cap.
5. **Storage.** A discovered login is held in memory for one call and
   dropped when it ends. It never goes through `saveCallRelay` or fills the
   hand-entered fields. Persisted: the last good relay (transport key and
   hostname) and replay watermarks (at most 1024, pruned after two hours).
   Adverts are kept in memory only. Turning the switch off clears all of it.
   With a Spry pairing or a hand-entered relay present, no discovery query
   or login request is made.
6. **Precedence**, tested: Spry pairing, then hand-entered relay, then the
   room's own TURN or Spry offer, then a discovered relay, then the default.
   A discovered relay never suppresses `SpryRoom` and never enters adverts,
   claims, a room descriptor, settings or an invitation. It goes through
   `callRelayPeerConnection`.
7. **The verifier is a port of spry-link `advert.rs`**, tested against
   spry-turn `docs/fixtures/public-advert-v1.json` plus the Rust unit-test
   table for destinations. Size is the UTF-8 length of the seven-field JSON,
   checked first; shape limits as Rust; id and signature through
   `verifyEventUncached` (`src/verify.ts`) on a fresh object; safe-integer
   numbers; exactly one two-element tag per name; `expiration` 1 to 16 ASCII
   digits; content with no unknown fields; credential URL with
   `new URL(s).href === s` plus Rust's label checks; TURN URLs parsed by hand,
   ASCII only, ASCII case fold; note at most 140 bytes. Verify before
   advancing the watermark, with one watermark book across relays.
8. **Display.** Strip bidi, zero-width, BOM and line-separator characters
   from the note; render with `textContent` inside `<bdi>`, two lines at
   most. Show the ASCII hostname (leave `xn--` encoded) and a short transport
   key, and flag a known hostname under a new key. Label the note and region
   "the operator says"; show the region as a code, not a flag. Keep these
   apart from the Nostr relay list.
9. **One query, through the existing pool.** `kinds:[31478]`,
   `#d:["spry-turn"]`, `limit:64`, `since` two hours ago, when the picker opens
   or a call needs it; closed at end of stored events or after 5 s. No
   standing subscription. A pool connection signed in to a relay (NIP-42)
   tells it which key searched, so use a connection that is not signed in,
   or the privacy wording must say so.
10. **Metadata statement additions.** Renewals let the operator link a
    call's logins by IP and timing, so it learns call length. The check
    makes two allocations, so it can tell a test. Other call members see the
    relay in this device's candidates, as with a hand-entered relay. Reuse
    the check's login for the call while it is valid.

The CSP needs no change (`connect-src` already allows `https:` and
`wss:`; TURN is not governed by CSP).

## Legal shape, for the legal-cover gate

This is design (a) in jurisdiction-kit's online-services note, section 2.13,
for a user who has chosen their own relays, and design (b) for a user still
on the shipped default Nostr relays: operators publish their own signed
adverts to relays they choose, and the client reads them from the device's
relays. On either reading the publisher provides nothing for discovery,
each Nostr relay's operator answers for that relay, and each relay operator
for their own TURN service `[U]`. Under (b) the privacy page must still
account for the defaults (note 3.2). The legal check should confirm that
nothing here adds a default relay, list, directory or ranking, and should
say what the privacy page must add (the device's relays now carry discovery
queries; the chosen operator sees the check and the credential request).

Things that would change the answer, and are therefore out of scope:

- shipping or fetching a curated or default list of relays (design c or d);
- a ForgeSworn-run relay, index, cache or "recommended" badge, or any
  ForgeSworn hostname as a discovery or credential source;
- a discovery relay added to the defaults for this feature, or a
  publisher-set ordering, preference or block list of operators;
- any count or report of which relays people use.

## Gates before building

- Soundness review: done 25 October 2026; its changes are above.
- Legal cover, KithMoot only: done 25 October 2026 (wording fixes folded
  in above). Then update
  `docs/legal/call-transport-position.md` and the privacy page in the same
  change that ships it.
- Android parity is a separate change with the same rules.
