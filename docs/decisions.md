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

**A stored entry is a durable public record of room activity.** The room id is
derived from a secret and the roster is encrypted to the room key, but a relay
still sees the opaque id, timing, volume and device pubkeys on events it
carries. An addressable event would preserve that metadata indefinitely.
Keeping presence ephemeral bounds the record; it does not make metadata
invisible.

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

## A join link is an invitation, not the room traffic secret

The original v1 fragment carried the 32-byte room secret directly. That made
joining wonderfully simple, but it also made the link permanent cryptographic
membership: copying it once was enough to decrypt and publish room traffic for
as long as that room secret lived. Calling a replacement URL "rotated" could
not change that fact.

New links are version 2. They carry a random bearer plus a fresh root inviter
pubkey. A prospective member publishes an ephemeral request encrypted under a
key derived from the bearer. A current responder answers with the room secret
in a NIP-44 envelope encrypted to the requester's one-use pubkey. Its event
signature is authenticated by a delegation chain rooted at the inviter key in
the link. Possessing the link is enough to be admitted, but it is not enough
to nominate a responder or passively derive the room traffic key.

The creator answers directly. Every accepted grant also delegates the
requester's one-use key for this invitation, so that browser or Android device
quietly answers the next arrival. The chain is bound to both the
bearer-derived invitation id and the derived room id, so a delegated member
cannot substitute a different room secret for a newcomer. It is capped at
sixteen hops, expires no later than twelve hours after the creator-rooted
grant, and never carries the creator's private key. The
creator can therefore leave without making itself an admission server, while
delegation remains bounded rather than silently permanent. A long-lived room
needs the creator to refresh the public invitation before that horizon or
before the depth cap is reached.

Rotation uses the missing half of that design: a regular, stored retirement
event signed by the root inviter. Online delegated responders stop as soon as
they receive it; an offline responder sees the tombstone from a relay when it
reconnects and retires rather than intentionally reviving the old link. This
is cooperative retirement, not cryptographic eviction: anyone already
admitted holds the room secret and can always disclose it outside KithMoot.

The root inviter's private key and room secret are kept locally for twelve
hours so the creator can reload or reopen the room without stranding links
already sent. A joining tab caches its granted room secret and delegated
responder key only for that tab's session. Legacy v1 links remain accepted
during migration and retain their old security properties.

**Rotation has a deliberately narrow meaning.** It tombstones the old
rendezvous, forgets its local inviter key, and starts a fresh one while the
live room keeps the same traffic key. Cooperative current clients stop
answering the old link. Anyone already admitted has necessarily learned the
current room key, so rotation cannot stop a malicious former member sharing
that key and does not remove them. Member removal requires a room epoch
change; that remains separate work.

**The metadata is explicit.** A relay sees the invitation id, the one-use
requester pubkey, each responder event pubkey, timing and event volume. The
request, response, delegation chain and room secret are encrypted. The HTTP server and ordinary
link-preview fetchers receive none of the fragment. The messaging platform
carrying the link still sees it unless that conversation is end-to-end
encrypted; the fragment is not a defence against the channel a person chose
to send the capability through.

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

**Enforcement is member-side and capability-wide.** Every member evaluates
every other member's tier before accepting its roster entry, durable chat or
room descriptor. A signal can only act on a peer created from that admitted
roster; an assist request performs the membership check directly because it
acts without creating a peer. The joiner's own check at `join()` is a courtesy
that fails fast; it proves nothing to anybody else, because a modified client
can skip it. The gate is meaningful only because every receiving boundary
checks independently.

A kindred proof is signed over the participant, room id, tier, expiry and a
random nonce. It is therefore a room-scoped grant, not a bearer relationship
statement reusable in another room. Durable chat checks the proof at the
message's signed send time, just as it checks the device credential then, so
valid history does not become unverifiable merely because both grants later
expire.

## Pairing transfers a credential, never the participant key

A device credential names the device it authorises, so the primary device
cannot mint one until it knows the second device's pubkey. That makes pairing
a two-step exchange rather than a link.

The link carries the ordinary bearer invitation plus a one-off **pairing
code**, and nothing secret to the person. The secondary first obtains the
room secret through the invitation rendezvous, then generates its own keypair
and publishes a request on the room-key channel proving it holds the code;
the primary confirms with the person, then publishes a room-scoped credential
that expires in twelve hours.

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

## Departure is a stated fact, not a guess from an empty entry

The wire format had no departure message. A leaving device published an
entry claiming nothing and publishing nothing, which released a singular
role at once, and everybody else waited out `PRESENCE_TTL_SECONDS` before
the tile went. Seventy-five seconds is not only slow to look at: for that
whole time every other device's mesh was escalating its route ladder - a
volunteer, then a forwarder, then TURN - chasing a device that had gone.

The fix could have been "an empty entry means gone". It is not, because a
device that joins with its camera and microphone off publishes exactly the
same empty entry and is very much in the room. So the farewell carries
`left: true`, inside the ciphertext with everything else, and only a JSON
`true` is one. A receiver drops the device at once and remembers when it
left, so an entry from before the farewell that a slower relay delivers
afterwards cannot bring it back; an entry stamped after it is a genuine
rejoin, and is answered as an arrival. A client that does not know the
field sees an ordinary answer carrying nothing and evicts the device on the
timeout, as every client did before. The `farewell` interop vector pins the
shape.

The app says goodbye from its Leave button and on `pagehide`, so a closed
tab is a departure too. Best effort on the second: one small publish over
sockets that are already open, and the page is gone whatever happens.

## A connection that was up gets one ICE restart before the ladder moves

A phone crossing from Wi-Fi to mobile, a laptop lid, a router hiccup: ICE
reports `disconnected`, and a few seconds later `failed`. The mesh used to
treat both as the rung failing and move the pair down the ladder, which
costs a volunteer, then a forwarder, then TURN, for a path that would have
come back on its own. Jitsi and Signal survive the same blip by restarting
ICE on the connection they have.

So `Peer` owns the blip. A connection that has reached `connected` and
reports `disconnected` is given `ICE_RESTART_GRACE_MS` to heal, then
`restartIce()`; one that reports `failed` is restarted at once. Neither is
reported to the mesh until the restart has had `ICE_RESTART_TIMEOUT_MS` and
not brought the connection back, at which point the failure is real and the
ladder takes over. One restart per episode, an episode ending at the next
`connected`. A connection that never came up gets no restart: the route
timer and the ladder own that, and are faster.

## Signalling is lossy, so a device listens before it announces and an unanswered offer is re-sent

A signal is an ephemeral event on a public relay. It reaches whoever is
subscribed at the instant it arrives and is kept for nobody; nothing is
replayed. Perfect negotiation assumes a channel that delivers, and two
places assumed it here.

The first was the order of `join()`. It announced, waited for every relay
to acknowledge, and only then built the mesh - which is what subscribes to
signals. Everybody already in the room answers an arrival by opening a
connection and offering the instant the announcement reaches them, so the
first offer was in flight a full relay round trip before the joiner was
listening for it. On the CI relay that round trip is under a millisecond
and the window never opens; on three public relays the joiner waits for the
slowest acknowledgement while the fastest relay has already delivered the
host's offer to nobody. Seen on a real call: the person who started the
room could see and hear whoever joined, and the joiner could not see or
hear them, because the offer carrying the host's media was the one that was
lost. So the mesh is built, and subscribed, before the announcement goes
out. The regression test acknowledges late, the way nostr-tools does.

The second is that nothing re-sent an offer. Only the offerer can tell an
offer was lost, and only by the silence: the far end never knew it was
sent. If the far end then offers in turn, and the offerer is the impolite
side, perfect negotiation says to ignore that offer in favour of its own -
which nobody has - and the pair is stuck until the route timer tears it
down ten seconds later and rebuilds it a rung lower. So `Peer` re-sends an
offer that has waited `OFFER_RETRY_MS` with no answer, up to
`MAX_OFFER_RETRIES` times. What goes out again is the connection's own
current local description - the same session, the same ICE credentials,
now carrying every candidate gathered so far - not a fresh offer. To a far
end that never heard it, it is the offer; to one whose answer was what went
missing, a renegotiation that changes nothing and prompts the answer again;
to one with its own offer out, the glare perfect negotiation already
resolves. The answer clears it, a rollback clears it, and so does `close()`.
Bounded, because a peer that never answers is a peer that has gone, and
that is the route ladder's decision.

## Device keys are per room

A relay learns every device pubkey in a room from the roster events it
carries, because those are signed by the device key. One device key for
every room a browser ever joins would let a relay follow one person from
room to room and across time, whatever the ciphertext hid. So the app keeps
a fresh device key per room, and the credential that names it per room too,
which costs the protocol nothing: a credential was already minted per room.
The participant key, the one that identifies a person, only ever rides
inside the room-key ciphertext and is unaffected.

This is the reasoning behind ForgeSworn Link's rendezvous-tag routing - the
relay must learn no stable pseudonym - applied to what can be fixed in the
app without a wire change. The wire-level version, roster and signalling
addressed by a pair-scoped per-epoch tag rather than by pubkey, belongs to
the spec.

## Relays keep the roster after all, so an entry older than the window is refused

The roster rides an ephemeral kind on the assumption that relays do not
keep it. Measured on 2 September 2026: every relay this project points at
by default stores kind 20461 and replays the last few dozen entries to a
new subscriber. The design's reasoning stands - a stored roster is a
durable record of the room, and we still do not *rely* on replay - but the
consequence had to be handled: a new joiner is handed the final heartbeat
of every device that ever died without a farewell.

So an entry stamped before the presence window opened is refused at
ingest, whoever sent it. A live device's entries are never that old - the
heartbeat is a third of the window - and a replayed one nearly always is.
The price is a device whose clock runs more than the window behind ours,
which is never admitted where it used to be admitted and evicted five
seconds later, for ever. Refused is honest; flickering was not.

## Presence is judged by this device, and media is presence

Two rules for when a remote device has lapsed, and both used to be wrong in
the same direction: towards closing a connection that was carrying good
video.

**By this device's clock.** An entry lapses when it was last *heard* longer
ago than the presence timeout, by the receiver's clock. It used to lapse on
the sender's `updatedAt`, which is the sender's clock: a phone two minutes
slow had lapsed before it arrived, was evicted at the next sweep, had its
peer closed and its tile torn down, and was re-admitted as a stranger on its
next heartbeat, to go through it all again. `updatedAt` still orders two
entries from one device, which is a comparison between that device's own
stamps.

**Media is presence.** A device whose peer connection reports itself
connected is heard from by that fact, whatever the relay has carried lately.
A tab in the background has its timers throttled; a relay drops a socket and
takes a while to come back; a phone's radio hands over between cells. Through
all of those the peer connection carries on, and closing it because a
heartbeat had not arrived through a third party's relay was the room tearing
down a working call to chase a rumour. The connection is the authority on its
own health: when it really goes, ICE says so within tens of seconds, the
route stops reading connected, and the ordinary timeout takes over.

`test/soak.spec.ts` takes the relay away for ninety seconds under a live
call. Before this, the far tile went at seventy-six seconds.

## A rung that ran out is retried, and a pair with nothing to carry never starts

Exhaustion of the route ladder used to be final. A pair that lost direct,
assist, forwarder and TURN in one bad minute stayed lost for the rest of the
call, however long, until one side rejoined. In a room meant to stay open for
days that is a tile gone blank for good. So an exhausted route rests
(`EXHAUSTED_RETRY_MS`) and starts again at `direct` with a clean slate.

Which exposed the other half: a pair with nothing to carry in either
direction never negotiates - an offer with no media in it negotiates nothing
- and so never connects, and was treated as a rung that failed. Two people
with their cameras off, or a person and an agent here to read the chat,
walked to TURN and were declared unreachable, and with retry would have done
it every thirty seconds. The connection is kept, because it costs nothing
idle and it is where the media goes the moment either side has some, but the
clock on it does not start until there is something for it to carry.

## A credential is renewed before it lapses

A credential was minted once, at join, for twelve hours. A room open longer
than that lost every member at the mark: their heartbeats still arrived and
were refused, because the proof inside them had expired. A primary device
now re-mints halfway through and restates itself under the new one, as an
answer, because nothing has arrived. A secondary cannot: its credential was
issued by the primary, and a new one is a new pairing.

## An agent says it is one, and the switch is on the sender

`RosterEntry.agent` is self-declared, like a name, and what it is for is
consent. A member chooses whether anything that says it is an agent is sent
its media - `RoomSession.publishTracks` takes an audience - and a
participant the audience refuses gets an empty track list on that
connection, which removes the senders rather than muting them. The media
never leaves the device for them.

The switch is on the sender because that is the only place it can be
enforced. A flag asking agents not to listen would be a request; not sending
is a fact. It is per person, per device, because it is that person's media.
And it is a switch rather than a room policy because the people in a room
differ: three want an agent following along and one does not, and that room
should have three transcribed voices and one silence.

## Channels are derived from the room key, and the agents' channel is not a secret from the room

A named channel is the same durable chat under an id and a key derived from
the room key for that name. Derived from the key, not the id, so a party
holding the id alone cannot find it. The unnamed channel is the main chat,
byte for byte as before.

Agents talk to each other on `agents`, and every member can open it. An
agent acting for somebody is not owed a conversation its principal cannot
see, and a room where the agents could confer out of sight is a room the
people in it should not trust. A listening agent writes on `transcript`, as
messages marked `kind: 'transcript'` naming a `speaker`: the words are the
text, the speaker is the transcriber's claim beside a key, and a client that
has never heard of transcripts shows an ordinary message from the
transcriber, which is honest.

## The masking graph is clocked by the speaker, so a stopped speaker must not stop the microphone

An `AudioContext` renders at the pace of the machine's audio OUTPUT device.
Measured on a Mac mini whose output had wedged: the context reported
`running`, the worklet loaded, the destination track was `live`, unmuted
and enabled, and `currentTime` advanced ten milliseconds in a second and a
half. The masked microphone track produced no samples, WebRTC sent no audio
packets, and nobody in the room heard the person, with nothing on their
screen to say why. Every symptom looked like an application fault.

The raw microphone track is clocked by the input device and carries on. So
`MicPipeline` watches its own clock, and when it has stopped for two checks
running it hands the raw track over, says so in red, and the app republishes
it. Masking is lost; the voice is not. The acceptance harness launches
Chromium with `--disable-audio-output`, a fake sink with a real-time clock,
so a test machine's speaker is never what a media assertion measures.
