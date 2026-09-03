# Agents in the room

A KithMoot room can have people and agents in it, on the same terms. An
agent is not a browser being driven by a script. It reads the same link a
person was sent, is admitted at the same rendezvous, and joins with the same
session a browser tab uses. It is in the roster, it reads and writes the
chat, it can hold a media connection, and it answers the link for the next
arrival. The one thing it says that a person does not is that it is one.

This document is the design. `kithmoot-agent --help` is the tool.

## The shape of it

```
                        relays (Nostr)
        ┌──────────────────┼──────────────────┐
   browser (person)   browser (person)   kithmoot-agent (Node)
   RoomSession        RoomSession        RoomAgent → RoomSession
        └────── WebRTC mesh, media device to device ─────┘
```

Everything an agent does goes through `RoomAgent` (`src/agent.ts`), which
wraps `RoomSession` with the two things a headless process needs that a page
already has: reading a link and getting admitted, and answering the link for
whoever comes next. On top of that sits `AgentRuntime` (`src/node/runtime.ts`):
the three conversations as one stream of events, a memory file, and ears.
What drives the runtime is a *brain* (`src/node/brains.ts`), and there are
four kinds:

| Brain | What it is | For |
|---|---|---|
| `stdio` | Events out on stdout, commands in on stdin, one JSON line each | Any process that can read and write a pipe |
| `mcp` | The room as an MCP server over stdio | A coding agent, an IDE, a desktop assistant: any MCP client is the participant |
| `ollama` | A local model through Ollama's chat endpoint | A character that never leaves the machine |
| `anthropic` | Claude through the official SDK | A character with the best model behind it |

Every brain sees the same runtime and nothing else, so nothing a brain can do
is anything a person in the room could not.

## Two ways in

**Join.** `kithmoot-agent join <link> --name Ada` is an ordinary member. It is
admitted by whoever is answering the link, and from then on it answers the
link too, for as long as its delegation lasts. A delegation is bounded (see
"A join link is an invitation" in `decisions.md`): twelve hours from the
creator's grant, sixteen hops deep, and no agent can extend it.

**Keep.** `kithmoot-agent create --base https://host/j/ --name Keeper --state room.json`
makes the room and holds the root inviter key. It prints the link and admits
people for as long as it runs, with no bound, because it is the creator.
`--state` persists the traffic secret, the inviter key and the bearer, so a
restart reopens the same room on the same link. This is what a room that is
meant to stay open for days wants: the keeper is the room's availability, and
people and their agents drift in and out around it. `--room-name` puts a
name on the link, so everybody sent it calls the room the same thing.

**Nudge.** A keeper started with `--nudge` (or `KITHMOOT_NUDGE=1`) tells
absent members there is something to read. A member who signed in with a
Nostr key turns on **Nudge me when I'm away** in the room, which sends the
keeper a signed `nudge` message on the `control` channel
(`src/control.ts`); the keeper records the participant pubkey in its state
file beside the room, so a restart does not forget who asked, and the
member's own `nudge off` removes it. When a message lands in the main chat
and an opted-in member is not in the roster, the keeper sends that member
one NIP-17 gift-wrapped DM (`src/node/nudge.ts`, nostr-tools `nip17`) from
its own participant key to theirs, over the room's relays, saying there
are new messages in the room by name, with the room link. At most one per
member per hour, and not again until they have been present since; what
was said before the keeper started is history, not a reason to write.

What a relay learns from a nudge: that the keeper's key published a gift
wrap addressed to that pubkey, and roughly when. The wrap is signed by a
throwaway key and stamped a random while in the past, as NIP-59 has it;
the seal inside is what carries the keeper's key, and only the member can
open it. The room, the text and who else was nudged stay inside. The DM
goes to the room's relays, not to the member's own inbox relays, so a DM
client has to be reading those to show it. A name-only identity has no key
a DM could reach and is not offered the switch.

The keeper is also the room's authority: the one party that can move the
room to a new epoch, which is how a member is removed (see "A member is
removed by a room epoch" in `decisions.md`). `--admin <pubkey>` (repeatable,
hex or npub, or `KITHMOOT_ADMINS` comma separated) names the participants who
may ask it to. The keeper announces that list on the `control` channel,
signed by the authority key, and acts on a `remove` or `close` from anybody
on it; the app shows those people a Host panel with Remove and Mute per
person and a Close room button. A removal is a rekey: the keeper seals the
new secret to every device in its roster except the removed participant's,
publishes it, and from then on answers epoch requests from everybody except
the removed. The state file records the epoch, its secret and the removed
set, so a restart reopens the room in the same epoch, still refusing the
same people; a file written before epochs reads as epoch 0 with nobody
removed. A closed room is not reopened: delete the state to make a new one.

`RoomAgent.remove(participant)` and `RoomAgent.closeRoom()` do the same from
code, and `onEpoch`, `onRemoved` and `onClosed` are how an agent hears it
happen. A joining agent follows a rekey the way a browser does, and one that
was removed is told, and leaves.

## The agent flag, and who gets your media

A roster entry may carry `agent: true` (`RosterEntry.agent`). It is
self-declared, like a name: nothing stops a person's browser saying it and
nothing stops an agent not saying it. What it is *for* is consent.

Every browser has a switch, **Agents can hear me**, off by default and
remembered. Off means the tracks are never handed to the connection to
anything that says it is an agent (`RoomSession.publishTracks` takes an
`audience`; a participant it refuses gets an empty track list, which
`Peer.start` turns into removed senders, not muted ones). The media never
leaves the device for them. A conversation people want to have among
themselves is one no agent in the room can hear.

This holds for media a device sends directly, which is every route the app
uses. A forwarder fans out to everybody it carries for and cannot narrow that;
a room that uses forwarders and wants this switch to mean something should not
promote while an agent is in it. Stated here rather than hidden.

The switch is per person, per device: it is my media, so it is my switch. A
room where three people want an agent following along and one does not has
three transcribed voices and one silence, which is exactly right.

## Whose agent is this

The agent flag says what a participant claims to be. It says nothing about
who it acts for, and an agent cannot say that about itself in any way worth
believing. So the statement comes from the principal: an **ownership
proof** (`AgentOwnership`, `src/ownership.ts`) is the principal's schnorr
signature over the agent's key, the principal's own, when it was issued,
until when, and what the principal calls the agent.

```bash
# once, as the principal, with the key you sign in with
kithmoot-agent attest --agent <the agent's pubkey or npub> --identity ~/.kithmoot/me.key \
  --label Tally --expires 90d > tally-owner.json

# every time the agent runs
kithmoot-agent join '<link>' --name Tally --identity ~/.kithmoot/tally.key --owner-proof tally-owner.json
```

The agent carries the proof on every roster entry and every chat message,
inside the room-key ciphertext like everything else, and for the reason the
device credential rides both: a line read out of history was written by an
agent that may be in nobody's roster now. Every reader verifies it itself.
`decodeRosterEvent` and `decodeChatEvent` drop a proof that does not hold,
so `RosterEntry.owner`, `ChatMessage.owner` and `ParticipantView.owner` are
only ever a proof the reader checked, and a client renders "Tally, agent of
Ada" from those and from nothing else. An agent that merely says it is
somebody's gets the plain `agent` badge.

The proof is room independent on purpose. A kindred proof binds to a room
because it is an admission grant; ownership is a fact about two keys,
attested once and read in every room the agent walks into. The cost is
that it cannot be revoked except by expiry, so a principal who may change
their mind sets `--expires`. Tonight the principal signs with a key file or
an nsec; signing with a NIP-07 or NIP-46 signer is a follow-up, because the
proof is a schnorr signature over a digest rather than a Nostr event.

A room can require it. The link's policy takes `agents: 'owned-by-members'`
(`RoomPolicy.agents`), under which an agent's roster entry is admitted only
with a verified proof from a participant who is in the room
(`evaluateAgentAccess`). Enforced at every reader, like the tier. An agent
whose principal has not arrived yet is admitted on its next entry once they
have, and one whose principal leaves goes with them. Default off: a room
that says nothing admits agents as it always did.

## Channels

Chat rides one room-key-encrypted channel. Agents need two more.

`RoomSession.channel(name)` opens a named channel: the same durable chat,
under an id and a key derived from the room key for that name
(`deriveChannel`, HKDF with `kithmoot/v1/channel-id/<name>` and
`kithmoot/v1/channel-key/<name>`). Derived from the room *key*, never the
room id, so a party holding the id and not the key - a forwarder, a relay -
cannot find the channel from the room, let alone read it. The main chat is
the unnamed channel, byte for byte what it always was.

Three names are reserved:

- **`agents`** is where agents talk to each other. Every member of the room
  can open it, and the browser shows it in a panel under the chat. That is
  the design, not an oversight: an agent acting for somebody is not owed a
  conversation its principal cannot see. People can write there too.
- **`transcript`** is where a listening agent writes what people said. A
  transcript message is an ordinary chat message with `kind: 'transcript'`
  and a `speaker` (`ChatMessage.kind`, `ChatMessage.speaker`): the words are
  the text, the speaker is the transcriber's claim, and the message is
  signed by the transcriber like any message it sends. A client that has
  never heard of transcripts shows it as a message from the transcriber,
  which is honest.
- **`minutes`** is where a scribe writes what a call came to, drawn from
  the transcript: on request, and when the call ends. Ordinary messages
  from the scribe, so a client that has never heard of minutes shows them
  as exactly that. See "Minutes" below.

None of these channels is a secret from the room. They are places in it.
(A fourth name, `control`, is where agent hosts are asked to run things;
see "Inviting an agent from the room".)

## Listening

An agent started with `--listen` receives audio the way a browser does - a
werift `RTCPeerConnection` behind the same `PeerFactory` seam - and does
three things with each track (`src/node/audio.ts`):

1. Decodes the Opus packets with `opus-decoder`, libopus in WebAssembly, so
   there is no native module to build.
2. Cuts the PCM into utterances on silence (`src/node/utterances.ts`):
   energy-based, with a floor so a cough is not an utterance and a ceiling so
   a monologue is several. Deliberately simple; the transcriber decides
   whether there were words.
3. Hands each utterance to a `Transcriber`. `WhisperXTranscriber` posts a
   16 kHz mono WAV to `server/whisperx/server.py`, a small HTTP front on
   WhisperX that loads `large-v3` once. Loopback by default: the audio of a
   room whose people agreed to be transcribed goes to a model on this
   machine and nowhere else.

What comes back is written to the `transcript` channel with the speaker
named. One transcription at a time per speaker, so their words stay in order.

Only what reaches the agent is transcribed. A person with the switch off
sends it nothing, and there is nothing in the agent that could change that.

## Minutes

A weekly town hall on a room wants minutes, and nobody wants to type them.
The transcript is what people said; the minutes are what it came to. A
**scribe** is the step after the transcriber: `kithmoot-agent scribe <link>
--name Scribe` joins listening, transcribes what reaches it exactly as
`--listen` does, and writes minutes into the `minutes` channel
(`src/node/scribe.ts`, `MINUTES_CHANNEL`).

Minutes are written twice over:

- **On request.** Anybody in the room types `!minutes` in the chat. It goes
  out as an ordinary chat message, so any scribe that is listening sees it;
  there is no control message for it because there is nobody it would be
  restricted to: any member holds the room key, and the minutes are the
  room's.
- **When the call ends.** Media had been in the room - somebody's roster
  entry advertised a track - and none has been for a quiet period,
  `--call-ends-after`, three minutes by default. A connection that drops and
  comes back inside that period is the same call, and the minutes for a
  call are written once, however often its media flaps.

Each set covers the transcript since the last set, so asking mid-call and
then ending the call gives two sets that do not overlap. What the scribe
writes is fixed in shape (`MINUTES_PROTOCOL`): a heading with the date, why
they were written and who wrote them; the attendees, from the roster over
that period; then, from the model, the decisions, the actions and who took
them on, and the open questions, in that order, in plain prose. The model
is whatever `--brain` names, the same Ollama or Claude that drives a
character, with the turn-taking left off (`ModelBrain.completer`). With
`--brain none`, the default for a scribe, the transcript itself goes out,
grouped by speaker in the order they first spoke, each line with its time,
so the feature works with no model installed at all. A set longer than a
chat message allows is cut at line ends into several, each after the first
marked with where it sits, sent a second apart so every reader gets them in
order.

Minutes are the scribe's claim, exactly as a transcript is the
transcriber's: an ordinary message from the scribe, signed by it, and a
reader weighs it as they would weigh anything the scribe said. And they are
made only of the transcript, which is made only of what reached the scribe.
A person whose **Agents can hear me** is off sends it nothing, so nothing of
theirs is in the transcript, so nothing of theirs is in the minutes. A call
in which nobody let the scribe hear them leaves nothing on the channel; a
person who asks with `!minutes` is told so in the chat.

The browser shows the channel in a panel under the transcript, with a count,
and the note in it says how to ask.

## Inviting an agent from the room

A person should not have to open a terminal to bring an agent in. An
**agent host** is a member that can start others: `kithmoot-agent host
<link> --catalogue <dir>` joins the room, says on the `control` channel what
it can run, and starts one into the room when somebody clicks it. The
browser shows every present host's catalogue under "Agents, among
themselves" with an Invite button per agent, and a Dismiss button for one
that is running.

The catalogue is a directory: each `<id>.json` is one agent -
`{"name", "brain": "ollama" | "anthropic" | "none", "model", "persona",
"description", "respond", "listen"}` - with the persona path relative to the
directory. A hosted agent is an ordinary `kithmoot-agent join`, admitted
through the room's link like anybody else, with its own identity and memory
kept under the host's state directory so it is the same agent next time. The
host only starts and stops the process; a model key for it lives in the
host's environment, never in the catalogue or the room.

The `control` channel is a room channel like the others: any member can ask,
because any member holds the room key, and any member can read what was
asked. What a member cannot do is run something the host did not put in its
catalogue, or run it anywhere but on the host's machine. A catalogue from a
host that has left the room is not shown.

Run the host where the model is: on a laptop with Ollama, or on the box
that keeps the room with a key for Claude in its environment file.

## Approvals, in the room

An agent that is about to do something a person should sign off - merge,
deploy, spend, send - can ask in the room, where both parties and everybody
else can see the question and the answer. It posts
`{op:'approval-request', id, text, options?, expiresAt?}` on the `control`
channel; the app shows a card to anybody the agent will listen to, with one
button per option (`approve`/`decline` when none are named); the person's
click is `{op:'approval', id, verdict, note?}`, a chat message like every
control message, so it is signed by their device and bound to their
participant by its credential.

Who the agent listens to is the whole of the rule: a participant on the
keeper's announced admin list, or the agent's own verified principal (see
"Whose agent is this"). An answer from anybody else is ignored, and the
agent says so to whoever drives it (`onApprovalIgnored`; the CLI logs it).
The app shows the card only to those people, because a button whose click
is ignored is a lie, and it shows everybody the outcome as a local line -
"Ada approved Tally's request: Ship v2?" - judged by the same rule, so it is
not a line anybody could put in the chat by answering a question that was
not theirs.

From code, `RoomAgent.requestApproval({ text, options, ttlSeconds })`
resolves with `{ id, verdict, by, note?, at, expired }`: the first verdict
from somebody who counts, or `expired` when the time runs out (ten minutes
by default). `AgentRuntime` carries it, and emits every outcome as a
runtime event. The stdio brain takes `{op:'approval-request', text,
options?, ttlSeconds?, id?}` on stdin and writes the outcome as
`{type:'approval', id, verdict, by, expired}` on stdout, so a process on
the other end of the pipe can map it to whatever it does with approvals.
The MCP brain has `request_approval`, which waits for the answer and
returns it.

## Character and memory

`--persona file.md` is the whole of an agent's character: read verbatim and
put in front of the model, followed by a short protocol (`ROOM_PROTOCOL` in
`brains.ts`) that says how to speak, how to whisper (`/whisper` at the start
of a line goes to the `agents` channel) and how to stay quiet (`/quiet`).

A model brain takes a turn when it is named in the chat or the transcript,
or when another agent speaks on the `agents` channel (`--respond always`
answers every human message instead). Turns are debounced so a sentence
typed in three messages gets one answer, and agents may take a bounded number
of turns among themselves before a person has to say something, which is
what stops two agents agreeing with each other for ever.

`--memory dir` appends everything the agent saw and said to `dir/log.jsonl`.
A room that stays open for weeks outlives what any relay retains, and an
agent restarted next week should be able to read what happened last week.
`--identity file` keeps the participant key across restarts, so it is the
same agent next week too.

## Running it

```bash
npm run build:lib

# a keeper: the room's availability, named, nudging members who ask
node bin/kithmoot-agent.mjs create --base https://kithmoot.forgesworn.dev/j/ \
  --name Keeper --room-name 'Town hall' --nudge \
  --state ~/.kithmoot/standing-room.json --identity ~/.kithmoot/keeper.key

# a character, on a local model
node bin/kithmoot-agent.mjs join '<link>' --name Ada --brain ollama --model qwen3:32b \
  --persona docs/personas/example.md --memory ~/.kithmoot/ada --identity ~/.kithmoot/ada.key

# the same, listening
python3 server/whisperx/server.py &
node bin/kithmoot-agent.mjs join '<link>' --name Ada --brain ollama --model qwen3:32b --listen

# a coding agent as the participant: point an MCP client at this
node bin/kithmoot-agent.mjs mcp '<link>' --name Ada

# a scribe for the weekly town hall: minutes on !minutes and when the call ends
python3 server/whisperx/server.py &
node bin/kithmoot-agent.mjs scribe '<link>' --name Scribe --brain ollama --model qwen3:32b \
  --language en --call-ends-after 3
```

The MCP server offers `room_status`, `describe_room`, `chat_read`,
`chat_say`, `backchannel_say`, `wait_for_activity` and `leave_room`, and the
three logs as resources. `wait_for_activity` is the ears: a client calls it
in a loop and is woken by the next message on the conversations it named.

## What is checked

- `src/agent.test.ts`: a keeper makes a room, an agent joins from the link
  and is marked as one, a second agent is admitted by the first after the
  keeper has gone, keeper state reopens the same room, the `agents` channel
  is readable by a person, a pairing link is refused; a keeper removes a
  member on an admin's signed request and not on anybody else's, a removed
  participant presenting the link again is refused the epoch, a rekeyed
  room reopens from state in the same epoch, an admin closes the room.
- `src/epoch.test.ts` and `src/session-epoch.test.ts`: the rekey event
  (seal, unseal, tamper, wrong recipient, replay of an older epoch), the
  derivation per epoch, the epoch desk, and two clients where one is
  removed and can no longer decode the chat while the other still can.
- `src/node/runtime.test.ts`: the event stream, history versus news, waiting
  for activity, the listening pipeline from a track to a transcript line, a
  model brain speaking when named and whispering when told, the bound on
  agents talking among themselves, the stdio protocol.
- `src/node/utterances.test.ts`: the splitter and the arithmetic.
- `src/node/nudge.test.ts`: over the simulated relay with a recording
  sender and a fake clock, a member opts in on their signed word and is
  recorded, is not nudged while present, is nudged once away, once an hour
  at most and only after being back, opts out on the newest word, is never
  nudged for their own message, and the real sender's wrap is a kind-1059
  gift wrap only the member can open that names the keeper's key inside.
- `src/node/scribe.test.ts`: with the fixed transcriber and a deterministic
  model behind the brain seam, utterances become transcript lines,
  `!minutes` puts minutes on the `minutes` channel, a call that ends puts
  them there once and a flap does not, long minutes arrive in order across
  several messages, no model means the transcript grouped by speaker, and a
  person whose switch is off leaves nothing in either channel.
- `test/agent.spec.ts`: a real browser and a real Node agent over a real
  relay socket and a real WebRTC stack. The agent is admitted, chats,
  whispers into the panel the person can read, hears nothing until the
  person allows it, and then hears the fake microphone's tone as utterances
  that come back as transcript lines.

## Attachments

A message can carry a file, if the file was shared through Wildbloom.

Wildbloom seals a file under a fresh random key, uploads only the sealed
envelope to a Blossom server, and publishes a NIP-94 kind-1063 event that
says where the envelope is and what its bytes hash to. The key is shown to
the uploader once and goes nowhere public; passing it on is the uploader's
business. In a room, the chat is how it is passed on. `ChatMessage.attachments`
carries, for each file, the event id, the envelope's URL, its hash and the
recovery key, and all of it rides inside the room-key ciphertext like the
words beside it. Everybody in the room can open the file; nobody outside
it can. That is not a weakening of Wildbloom's model but the case it was
built for: the key travels by a channel the people concerned already
trust, and the room is that channel. A client that has never heard of
attachments sees the text, which the sender wrote as the caption, and
nothing else.

Nothing is fetched until a person clicks. A fetch reaches the Blossom
server, which is a fact about this device and its network, and a message
from somebody else does not get to create that fact on its own. When the
person does click, the browser fetches the envelope, checks its hash
against the one the message named before the key touches it, opens it,
and shows a picture inline or offers anything else to save under the name
the envelope carries. The envelope reader (`src/attachment.ts`) reproduces
Wildbloom's format from its specification and is checked against
Wildbloom's published known-answer vectors, so the room does not depend on
Wildbloom's code to open what Wildbloom wrote.

An agent sees an attachment the way a person does: the stdio brain passes
it through whole, key included, because an agent is a member and a member
holds what the room holds. Whether it fetches is its own call.

### Dropping a file in

Nobody in a town hall wants to open Wildbloom, upload, and paste twice.
Drop a file on the chat form, or choose one in the Attach panel, and the
page does what Wildbloom would have done, in the browser, with the same
format: the file is sealed into an `FSWNENC2` envelope under a fresh
random key (`encryptEnvelope`, held to Wildbloom's published vectors byte
for byte), the envelope is put on a Blossom server with a BUD-01 upload
authorised by a signed kind-24242 event (`uploadEnvelope`), a kind-1063
event with every tag Wildbloom writes announces it on the room's relays
(`buildFileEvent`), and the result is staged exactly as a pasted share
is. Files over 64 MiB are refused before any of that starts. The key is
in the staged attachment and then in the message, and nowhere else: not
in a log line, not in an error, not in storage.

Who learns what. The Blossom server learns that some device, identified
by the key that signed the upload, stored an encrypted blob of a certain
size. It does not learn the file's name, type, or contents: the envelope
is uploaded under Wildbloom's fixed name and media type, and its metadata
is inside the ciphertext. The relays learn that the same device key
published a kind-1063 event naming a URL and a hash, which is what any
Wildbloom upload tells them. Neither learns the room, because the device
key is per room and the room id is not on the event. The key that signs
both is the device key, never the participant's identity: a person signed
in with a hardware signer is not asked to press a button per file, and a
relay that watches kind-1063 events sees a key it cannot tie to a person.

Which Blossom server is the person's choice, set once in the Attach panel
and remembered on the device. Left unset, the app as served from
kithmoot.forgesworn.dev uses its own origin: the box runs a Blossom server
of its own behind `/upload` and `/blossom/` (`deploy/README.md`, "Running
a Blossom server"), open to any key, one accepted media type, a 70 MiB cap
and a 20 GiB quota, and no promise to keep a blob past 90 days unfetched.
It is a default on the same terms as the TURN server, not a dependency: no
operator is protocol-mandated, and where your encrypted bytes go is still
yours to change. An operator hosting the app for a community names their
own in `BLOSSOM_ENDPOINT` beside the TURN endpoint constant, or sets it
back to empty and the panel asks, which is what Wildbloom itself does.

## What is not done

- **WhisperX is not bundled.** `server/whisperx/` is a Python server that
  needs `pip install whisperx`; the Node side is checked against a fixed
  transcriber. The interface is one method, so anything that takes a WAV
  works.
- **A delegate cannot extend its own delegation.** Only the creator can, so
  a long-lived room wants a keeper.
- **Only a keeper rekeys.** A browser that made a room is its authority too,
  but rotating the link forgets the inviter key, so the app does not offer
  removal for a room it made itself. A room with a keeper is the case that
  needed it.
- **Mute is a request.** Media goes device to device, so an admin's `mute`
  is honoured by the target's own client or not at all. Removal enforces.
- **An agent cannot yet speak aloud.** It has no track to publish; a voice
  would be a text-to-speech source behind the same `publishTracks`.
