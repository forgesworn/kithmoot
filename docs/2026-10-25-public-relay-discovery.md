# Finding public call relays over Nostr

Design, 25 October 2026. Not built. Both KithMoot change gates (soundness
review, then legal cover against `docs/legal/call-transport-position.md`)
must pass before any code lands.

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
   `[DECISION: which set counts as the device's read relays: the
   Connections list (the shipped defaults for most people), the signed-in
   account's own relay list (kind 10002), or only relays the user has added
   by hand. The first makes this design (b) for a user on the defaults; the
   last keeps it (a) for everyone.]`
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
   chosen relay's credential endpoint for a 10-minute login and renews it at
   two thirds of its life. The login stays on the device, as hand-entered
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

- Soundness review: the advert check, the hostname and address checks
  (no requests to private addresses), credential handling and relay-only
  behaviour.
- Legal cover, KithMoot only, as above; then update
  `docs/legal/call-transport-position.md` and the privacy page in the same
  change that ships it.
- Android parity is a separate change with the same rules.
