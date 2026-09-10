# Verified box discovery

The contact-card relay hint is a Link transport address. A Nostr message
endpoint must come from the box's signed status and be bound to the claim
endorsed by the contact card. The existing manual relay marks do not supply
that automatic discovery proof.

`src/box-status.ts` verifies that chain without network access. It checks the
contact's exact claim id, the claim's node/master/stash bindings, the box's
status signature and exact claim reference, the pinned Link node and card,
serial and status replay protection, required status fields and optional
endpoint shape. Status older than three publication intervals is stale;
card and event expiry can shorten that validity. A byte-identical card may
be re-announced only when its previously accepted bytes are available.

The source reference is Bothy's event draft V1/V2, inspected at design
commit `ef051af`, and `bothy-node`'s status reader at `b89cf9b`. The latter
already carries an optional URL as the third item of `drops on`. This
reader supports that existing daemon extension; it does not alter the
shared wire format or approve enabling the public drop tier. The design
draft also accepts `charge-control=mains`, while the inspected daemon enum
has not yet added it. The client accepts the documented value.

The browser integration in `app/src/box-discovery.ts` is opt-in for each
contact box. “Check box status” explains that the configured default read
relays will see the box key and keeper claim. No Link hint or advertised
endpoint is dialled by discovery, and room routing is unchanged. A verified
endpoint labels an already configured matching relay; it is not automatically
added as a room relay. The ordinary roster relay remains necessary.

The reader fetches the exact endorsed claim, then follows the latest claim
under that verified master and node. Retirement is terminal in the saved
history. Contact replacement resets consent; forgetting deletes the discovery
record and makes late callbacks inert. A confirmation is bound to the card
that was displayed. Stop closes the reads even if saving the preference
fails, and this process will not restart them without fresh consent. Saved
card bytes, serials, signed
status watermarks and conflict timestamps protect against rollback across
restart. Signed malformed newer statuses also invalidate an older grant.
Saved records alone never restore a trusted label.

`BoxRelayReader` completes history only on actual EOSE frames from every
configured read relay. Timeout, a closed live history or disconnect removes current trust
and restarts all reads. It is read-only, caps the three subscriptions per box,
limits frame size and traffic, and bounds concurrent box watches. These
client-side bounds do not supply the box daemon's pending flood protection.
An untrusted relay can withhold statements; signed freshness and independent
configured relays bound this exposure but cannot prove universal absence of
a retirement. Status is accepted for at most three hours, shortened by Link
card or event expiry.

Attribution is checked when a transport describes its lane, including while
a sleeping tab has missed its expiry timer. Trust changes do not reconnect
room transports. Explicit keeper-confirmed relay marks remain independent.

The draft includes verifier and lifecycle unit tests, real EOSE/timeout and
reconnect tests, and browser acceptance for explicit discovery, endpoint
attribution, drops off, retirement and forgetting. The work is not yet a
published feature or a completed Vennel production gate. Hosted three-browser
checks, independent Android parity, real Bothy interoperability and physical
owned-box journeys remain required. No public drop tier is enabled by this
change, and the Bothy design disagreements above remain open.

The 34 signed status and 8 claim cases in `vectors/box-discovery.json` are
also checked by the native Android verifier. Regenerate with Node 24 using
`npm run build:lib && node vectors/generate-box-discovery.mjs`; expected
acceptance is explicit in the generator and checked before writing. These
client-generated cases do not replace interoperability with a running Bothy.

Eight additional cases in `vectors/bothy-issued-discovery.json` come from
Vennel's Rust interoperability harness: Bothy's production claim/status
builders, `CardIssuer` over a real loopback Link endpoint, and its real Link
verifier. Bothy validity and freshness are recorded separately. Web and
Android consume the exact bytes for drops off/on, endpoint discovery, stale
status, an expired card in a fresh status, Link rotation, a bad Link signature
inside a valid box signature, and an endorsed retired claim. The generator
checks source and dependency-lock provenance before running. This advances
implementation interoperability; it is not a running bothyd or owned-box
network/device journey.

An exact full-event-id lookup may receive `CLOSED` after that relay's real
`EOSE`: those bytes are immutable, and the initial lookup is finished. This
does not complete other relays, does not apply to prefix ids or a closure
before EOSE, and does not apply to live status or keeper-claim history. The
real Bothy local-relay UI run exposed this normal NIP-01 completion pattern;
web and native now test it, including the remaining refusal paths.
