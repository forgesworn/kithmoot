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
people and their agents drift in and out around it.

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

## Channels

Chat rides one room-key-encrypted channel. Agents need two more.

`RoomSession.channel(name)` opens a named channel: the same durable chat,
under an id and a key derived from the room key for that name
(`deriveChannel`, HKDF with `kithmoot/v1/channel-id/<name>` and
`kithmoot/v1/channel-key/<name>`). Derived from the room *key*, never the
room id, so a party holding the id and not the key - a forwarder, a relay -
cannot find the channel from the room, let alone read it. The main chat is
the unnamed channel, byte for byte what it always was.

Two names are reserved:

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

Neither channel is a secret from the room. They are places in it.

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

# a keeper: the room's availability
node bin/kithmoot-agent.mjs create --base https://kithmoot.forgesworn.dev/j/ \
  --name Keeper --state ~/.kithmoot/standing-room.json --identity ~/.kithmoot/keeper.key

# a character, on a local model
node bin/kithmoot-agent.mjs join '<link>' --name Ada --brain ollama --model qwen3:32b \
  --persona docs/personas/example.md --memory ~/.kithmoot/ada --identity ~/.kithmoot/ada.key

# the same, listening
python3 server/whisperx/server.py &
node bin/kithmoot-agent.mjs join '<link>' --name Ada --brain ollama --model qwen3:32b --listen

# a coding agent as the participant: point an MCP client at this
node bin/kithmoot-agent.mjs mcp '<link>' --name Ada
```

The MCP server offers `room_status`, `describe_room`, `chat_read`,
`chat_say`, `backchannel_say`, `wait_for_activity` and `leave_room`, and the
three logs as resources. `wait_for_activity` is the ears: a client calls it
in a loop and is woken by the next message on the conversations it named.

## What is checked

- `src/agent.test.ts`: a keeper makes a room, an agent joins from the link
  and is marked as one, a second agent is admitted by the first after the
  keeper has gone, keeper state reopens the same room, the `agents` channel
  is readable by a person, a pairing link is refused.
- `src/node/runtime.test.ts`: the event stream, history versus news, waiting
  for activity, the listening pipeline from a track to a transcript line, a
  model brain speaking when named and whispering when told, the bound on
  agents talking among themselves, the stdio protocol.
- `src/node/utterances.test.ts`: the splitter and the arithmetic.
- `test/agent.spec.ts`: a real browser and a real Node agent over a real
  relay socket and a real WebRTC stack. The agent is admitted, chats,
  whispers into the panel the person can read, hears nothing until the
  person allows it, and then hears the fake microphone's tone as utterances
  that come back as transcript lines.

## What is not done

- **WhisperX is not bundled.** `server/whisperx/` is a Python server that
  needs `pip install whisperx`; the Node side is checked against a fixed
  transcriber. The interface is one method, so anything that takes a WAV
  works.
- **A delegate cannot extend its own delegation.** Only the creator can, so
  a long-lived room wants a keeper. Member removal - a room epoch change -
  is the separate work `decisions.md` already names.
- **An agent cannot yet speak aloud.** It has no track to publish; a voice
  would be a text-to-speech source behind the same `publishTracks`.
- **Attachments.** A message is text. Dropping something shared through
  Wildbloom into the chat - the kind-1063 event, the Blossom URL, the hash
  and the recovery key, all inside the room-key ciphertext, rendered inline
  by the browser - fits the message shape and the trust model, and is the
  obvious next field.
