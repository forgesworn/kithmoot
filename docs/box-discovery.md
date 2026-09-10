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

This is the verification primitive, not a completed discovery flow. Before
automatic sheltered attribution is enabled, the client still needs:

- An explicit discovery action which explains the public relay query and
  fetches signed events from the person's configured read relays.
- The latest claim under its verified master and node, so a retired or
  rotated claim cannot be replaced by an old event fetched only by id.
- Stored card bytes and monotonic pins; a result cannot overwrite a card
  replaced or forgotten while the request was running.
- Live invalidation on claim retirement, status `drops off`, changed
  endpoints, expiry and lost verification. Lane classification must check
  validity at use time, including after a browser wakes from sleep.
- Browser acceptance covering discovery, expiry, restart and revocation,
  plus the independent Android implementation and box interoperability.

Until those steps are implemented and verified, automatic relay attribution
remains closed in both clients. A parser test is not evidence that a live
conversation used an owned box.
