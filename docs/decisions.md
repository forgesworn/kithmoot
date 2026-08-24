# Decisions

Design questions the implementation had to settle, and why it settled them
that way. Recorded here because the reasoning is not recoverable from the
code, and a later reader deserves the trade-off rather than the outcome.

## The roster stays on an ephemeral kind

`KINDS.ROSTER` is 20461, inside NIP-01's ephemeral range. Relays are not
required to store it, and the ones we use do not.

The alternative was an addressable kind (30xxx, keyed on the device pubkey
and the room id), which relays do store and replay, so a device joining late
would simply be sent everything it missed.

We kept it ephemeral for two reasons.

**Presence is live state.** A stored roster entry is a claim that somebody is
in a room they left an hour ago. Nothing about a stored entry expires on its
own, and the device that published it may be off, asleep or gone. Replaying
it is not history, it is a lie about the present.

**A stored entry is a durable public record that the room existed.** The
design's position is that nothing about a room is public: the id is derived
from a secret, the roster is encrypted to the room key, and the join URL
keeps the secret in the fragment so no server ever receives it. An
addressable event undoes the last part of that - not its contents, but its
existence, its timing and the device pubkeys involved, kept on a public relay
indefinitely.

The cost is that a late joiner is never sent what it missed, so the roster
has to make up for it in the protocol: **arriving devices announce, devices
already present answer.** An answer carries `reply: true` inside the
ciphertext and never provokes another answer; a device we already knew about
is not an arrival; and our own entry echoing back is not one either. Answers
are jittered so a large room does not stampede a relay when somebody joins,
and coalesced so twenty simultaneous arrivals cost each existing device one
answer rather than twenty.

This is the pattern the sibling RelaySwarm project settled on for the same
question.

## The access policy rides the join URL, not a room descriptor event

The design's open question 5 asked whether room config should live in an
addressable descriptor event encrypted to the room key, or wholly in the URL.
For the access policy, it is the URL.

**Agreement has to be structural.** A policy that is a per-client constructor
argument is not a gate: two members can simply disagree about it, and the one
who disagrees hardest wins. The URL is the capability - everyone who joins
holds the same fragment, therefore the same policy bytes - so agreement costs
nothing and depends on no relay.

**A descriptor raises a trust question we cannot yet answer.** If the policy
lives in an event, something has to say who may sign and replace it. That
means naming a host pubkey, which would have to travel in the URL anyway - at
which point the descriptor's only remaining value is being changeable
mid-room.

**And it would be another durable artefact**, for the same reason the roster
avoids one.

The cost, stated plainly: **the policy cannot change mid-room.** A different
rule means a different link. That is acceptable while rooms are ephemeral and
the config is small. It stops being acceptable in stage 3, when forwarders
and TURN lists need to change while a call is running - so the descriptor
question should be reopened then, for that config, on its own merits.

**Enforcement is member-side.** Every member evaluates every other member's
tier against the policy before admitting them to its own roster view, using
the kindred proof carried inside the roster entry's ciphertext. The joiner's
own check at `join()` is a courtesy that fails fast; it proves nothing to
anybody else, because a modified client - or one simply constructed without a
policy - skips it. The design's claim that kith-gating is "cryptographically
meaningful, not a social-graph guess" is only true because of the member-side
check, not the self-check.

Known limitation, unchanged: a kindred proof carries no room binding, so it
is a bearer token valid in every room that trusts its issuer until it
expires. Defensible - kindred is a relationship, not a room grant - but it is
a decision, not an oversight.

## Pairing transfers a credential, never the participant key

A device credential names the device it authorises, so the primary device
cannot mint one until it knows the second device's pubkey. That makes pairing
a two-step exchange rather than a link.

The link carries the room secret and a one-off **pairing code**, and nothing
secret to the person. The secondary generates its own keypair and publishes a
request on the room-key channel proving it holds the code; the primary
confirms with the person, then publishes a room-scoped credential that
expires in twelve hours.

The code is sent as `sha256(domain : code : roomId : device)` rather than in
the clear, because everybody in the room holds the room key and can read the
request. A member who intercepts it learns a hash over somebody else's device
pubkey and cannot produce the equivalent for their own.

Whoever holds the link can pair - that is what a link is for. What they get
is one room for a few hours, not the participant's Nostr identity for ever.
