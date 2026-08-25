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

## Forwarders and ICE ride a room descriptor event, not the join URL

The access-policy decision above closed by saying the descriptor question
should be reopened in stage 3, "when forwarders and TURN lists need to change
while a call is running". Reopened, and answered: **they do, so they get a
descriptor.**

The two pieces of config are not alike, and the difference is what decides it.
The access policy has to be *agreed*: if two members disagree about who may
enter, the one who disagrees hardest wins, so agreement has to be structural
and the URL - which everybody who joins holds identically - is the only place
that is free. Forwarders and ICE servers have to be *current*: a forwarder
that has gone away, or one somebody stood up ten minutes into the call,
cannot be fixed by sending everybody a new link and asking them to rejoin.

So `KINDS.DESCRIPTOR` (20465), encrypted to the room key, ephemeral for the
same reason the roster is - a stored descriptor is a durable public record
that the room exists. A relay sees the room id and nothing else.

**Who may write one.** Any device holding a valid, unexpired credential for
the room. Last valid writer wins, ordered on `updatedAt` with the roster's
clock-skew bound so nobody can pin their own list in with a year-3000 stamp.

That is deliberately weaker than naming a host, and the weakness is stated
rather than hidden: **any member can point the room at a forwarder of their
choosing.** What stops that mattering is the next decision - media through a
forwarder is encrypted under a key derived from the room key, and no
forwarder is ever given the room key. The worst a member wins by winning this
race is the choice of whose bandwidth pays, not access to anyone's media. A
host role would narrow it further, but it would have to name a host pubkey in
the URL, and that is a larger change to the capability model than this config
is worth.

## A forwarder entry cannot carry the room key, structurally

`ForwarderRef` is `url`, optional `pubkey`, optional `label`. Both
`encodeDescriptorEvent` and `decodeDescriptorEvent` **project** every entry
onto exactly those three fields rather than validating them.

The difference matters. A validation - "reject an entry with a `roomKey`
field" - only works if somebody thought of that field name. A projection
copies out three named fields and physically cannot carry a fourth, whatever
it is called, whoever wrote it, and whichever implementation produced it.

The `roomDescriptor/forwarder-extra-fields-stripped` interop vector exists to
hold a second implementation to this: its plaintext genuinely carries the
room key inside a forwarder entry, and a decoder that passes the JSON object
through returns it. That decoder passes every other vector in the file.

## An identity is a pubkey and one `signEvent`, and that is the whole of it

The participant key signs exactly one thing: a device credential, one small
event per room. The device key signs the roster entries and the gift-wrapped
signalling; the room key encrypts the roster, the chat and the descriptor.
Nothing else ever needs the participant.

That narrowness is what makes an external signer practical, so
`ParticipantIdentity` is deliberately that shape and nothing more: a pubkey
and an async `signEvent`. A locally generated key (`localIdentity`) and a
signer reached over NIP-07, NIP-46 or NIP-55 both satisfy it, and no other
part of the protocol can tell which it has.

`signEvent` returns a promise because a remote signer is a round trip: an
extension prompt, a relay hop to a bunker, a tap on a phone. That rippled
through `createDeviceCredential`, `RoomSession.issueDeviceCredential` and
`hostPairing`, all of which became asynchronous rather than blocking. In
`hostPairing` specifically the mint runs off the subscription handler, so a
signer that refuses or never answers leaves the request unanswered rather
than throwing inside a relay callback. The secondary re-sends until it times
out, which is the recovery a dropped grant already had.

**What comes back from a signer is checked against what was asked for.** A
signer is trusted to hold the key, not to be correct: `createDeviceCredential`
compares the returned event's signing key, kind, content and tags against the
template, and verifies the signature, before it will call the result a
credential. `created_at` is deliberately not compared: some signers stamp
their own, it is inside the signature either way, and nothing decides
anything on it. The `expiration` tag is what bounds a credential, and that is
compared.

## A display name is a label on a pubkey, never a substitute for one

Rendering a participant as `2f74cb07ca1a…` is unusable by people, so a roster
entry carries a `name`. It is **self-asserted**: anyone can type anything,
nothing checks it, and there is no way to make it otherwise without inventing
a registry, which is the thing this project exists not to have.

Three consequences follow:

**A name never renders alone.** A short pubkey goes beside it everywhere, on
tiles and in chat. Without that, two people called "Darren" are
indistinguishable and impersonation is free. With it, impersonation is
visible, which is the most a system with no registry can offer.

**A name is attacker-controlled text.** `sanitiseDisplayName` strips every
Unicode "other" character (controls, bidirectional overrides, zero-width
padding), collapses whitespace and caps the result at 32 code points, on
encode *and* on decode. Encode, so this implementation never publishes one;
decode, because no other implementation is obliged to have bothered.

**Markup is kept as literal text, on purpose.** A filter that strips `<`
would mangle a name somebody will legitimately type, and would still be the
wrong defence: what makes markup safe is that a name never reaches
`innerHTML`. That is held by a guard test over `app/src/main.ts`, in the same
shape as the `Buffer` guard, rather than by a filter pretending to be one.

The name rides with a chat message as well as in the roster, for the same
reason the credential does: chat is durable and the roster is ephemeral, so a
message read out of history was sent by somebody who may be in nobody's
roster now.

## A kind-0 profile is a fact about a key, not a check on a name

Nothing on the wire distinguishes a real Nostr identity from a participant
key a browser generated a moment ago. The two are the same 32 bytes, and no
protocol change could tell them apart without a registry.

What *can* be observed is whether a key has published a kind-0 profile. The
app looks one up for every participant, and marks a key that has one `nostr`.
That is a fact about the key, so the label says what it is and no more.

It is deliberately never called "verified". A kind-0 `name` is self-asserted
in exactly the way a typed name is. It says "the holder of this key calls
themselves Darren", and the only difference is that the key is persistent and
has a history. That is worth something. It is not proof of a person, and
the interface does not imply it is.
