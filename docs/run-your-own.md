# Running your own servers

KithMoot needs no server of ours. A room runs on Nostr relays, a file goes
to a file server you choose, and a call goes from device to device, through
a relay server when a network needs one. For each of these you can use a
public server somebody else runs, or your own.

A room you start carries your choices to the people you invite. Its relays
are the ones you had when you made it, and the call servers you set are
handed to everyone who joins. Carrying your file server to the room in the
same way is planned; for now each device chooses its own.

## Before you run one for other people

If anyone besides you uses a server you run, you are its operator. The law
where you and they are applies to you, not to the people who wrote the
software. In the UK, a server that takes content from whoever finds it is a
service to the public under the Online Safety Act. One used only by you, or
by people you invite, is in a different position, and the law has not
settled how it treats a small private group. The project's notes on UK law
are in
[jurisdiction-kit's GB note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md).
They are notes, not legal advice.

One limit today: KithMoot signs a room's file uploads and relay events with
a key made for that device in that room and registered nowhere, so your
server cannot yet tell your group's devices from anybody else's. A file
server or relay you run for KithMoot has to accept any key, and anyone who
learns its address can use it. Keep the address within your group, and give
the server a quota and an expiry. Group grants, which let a server accept
only the devices of people admitted to your rooms, are planned.

## Files

KithMoot seals a file on your device before it leaves, so a file server
only ever holds encrypted bytes. Anyone with a file's link can download the
encrypted copy; only the people in the room hold the key that opens it. The
server sees your device's address, when files are uploaded and fetched, and
how big they are.

Files go to the first public server below unless you choose otherwise. The
first time a device sends a file, a notice above the message box names the
server and says what it sees, and pressing **Send** uploads the file and
remembers the choice. Nothing is sent to it before that. If a later release
changes the default server, the notice appears again naming the new one.
**Settings > Privacy > Where files go** changes it: a public server, your own
server, or nowhere (you can still open files other people send).

### A public server run by somebody else

The app lists public file servers we have checked: the operator is named,
publishes terms, and an encrypted upload, download and delete worked from
the app. Today that is one, and it is the default.

| Server | Run by | Largest file | Checked |
|---|---|---|---|
| blossom.yakihonne.com | Yakihonne LLC, United States | 200 MB | 20 October 2026 |

Its operator, not KithMoot, decides what it keeps and for how long. Other
public Blossom servers may work; type one in. On 20 October 2026 Primal's
and nostr.build's servers refused KithMoot's encrypted files.

### Your own file server

Any [Blossom](https://github.com/hzrd149/blossom) server works if it:

- takes uploads signed as BUD-01 describes, of the type
  `application/vnd.forgesworn.encrypted`;
- lets the app's site upload and download across origins (CORS);
- serves a file by its hash, and deletes it on a signed BUD-02 request, so
  **Leave and tidy up** can remove what your device shared.

KithMoot's deploy kit sets one up on a Linux box: blossom-server-ts behind
Caddy, with a fixed-size quota, a 270 MiB cap per file and an expiry 90 days
after a file was last fetched. See "Running a Blossom server" in
[deploy/README.md](../deploy/README.md). Then type its address under
**Settings > Privacy > Where files go > My own server** and press **Use this
server**. People who open your files connect to your server.

If you deploy KithMoot itself on your own domain, build it with
`VITE_KITHMOOT_FILE_SERVER` set to your server's address and it becomes that
build's default, in place of the public server. It is never a ForgeSworn
host, and a person still sees the one-time notice naming it before anything
is uploaded.

## Relays

Rooms start on three public relays run by other people unless you change
them: relay.primal.net, nostr.oxtr.dev and relay.ditto.pub. To add your
own, open **Settings**, **Connections**, **Nostr relays**. A room you start
keeps the relays you had at the time, and every member uses them for that
room, whatever else they have set.

| Relay | Run by | Quiet rooms | Checked |
|---|---|---|---|
| relay.primal.net | Primal Public Relay | Yes | 21 October 2026 |
| nostr.oxtr.dev | 0xtr relay | Yes | 21 October 2026 |
| relay.ditto.pub | Ditto Relay | Yes | 21 October 2026 |
| offchain.pub | offchain.pub | No | 21 October 2026 |
| relay.damus.io | damus.io | No | 21 October 2026 |

The first three are the defaults. All are free, name a contact, support
NIP-40 expiry and held KithMoot's room messages when read on 21 October
2026. "Quiet rooms" means the relay held and served gift wraps without
sign-in. On 1 October Primal kept a room invitation for under a day; a room
writes to all of its relays, and the device that made a link signs its
invitation again while the room is open. The list and its criteria are in
`src/public-relays.ts`.

Left out on 21 October 2026: nos.lol and nostr.mom (unreachable, and one
host), relay.nostr.net (stopped answering hours after it became a default),
relays that name no contact, relays that ask for payment or sign-in, relays
that did not answer or errored, and purplepag.es, which holds profiles only.

Most relay software keeps events of any kind unless told otherwise, which
is what KithMoot needs; [strfry](https://github.com/hoytech/strfry) and
[nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay) are two. Keep
one public relay beside your own: a member who cannot reach yours still
finds the room, and a quiet room hides its traffic among a public relay's.

The limit above applies here too: for now your relay has to accept any key.

## Calls

Most calls go straight between devices. Some networks need a relay server
(TURN) in between, and without one roughly one call in five may not
connect.

Under **Settings**, **Connections**, **Call servers** you can name your own
STUN servers, and rooms you start hand them to everyone who joins. A TURN
server needs a credential for each device, which that field cannot carry
yet. KithMoot's deploy kit has coturn and a credential service for a
deployment of your own: see "Deploying coturn and the credential service" in
[deploy/README.md](../deploy/README.md). Letting a room carry its own TURN
server, with credentials only for its members, is planned.

## Group storage nodes (experimental)

A room's keeper can be told of a group's own storage nodes, so that a node
serves only the devices the keeper has admitted. A node is `wildbloomd`
started with `--group-mode` and `--group-keeper <authority key>:<ceiling>`,
and `--server-name` set to its host name; the keeper is started with
`--group-node <https://that-host>` (`http` only for a node on the same machine) and `--group-bytes <n>`, and `--state`
(see `agents.md`, "Group storage grants", for what it signs and when). The
contract both sides follow is wildbloom-node's `docs/GROUP-GRANTS.md`.

The nodes are also listed in the room. The keeper signs them, in the order
given and at most eight, into the room's invitation and into a `storage` control
op; a restart with different flags changes the list, and with none refuses to
start while the room (or `<state>.grants`) still names nodes. To stop listing
them, start the keeper with `--group-withdraw` (with `--state`, not with
`--group-node` or `--group-bytes`; add `--group-reset` to move an unreadable
ledger aside): it signs an empty list, mints and renews nothing more, and still
revokes at the nodes in `<state>.grants` when somebody is removed. Do not run
an older keeper on a state that has used group nodes: it drops the list from
the state, and the nodes then go unrenewed and unrevoked.

The list is the rule for clients: a client that implements group storage keeps
a listed room's files on its nodes, keeps them off when the list is empty, and
never falls back to a public file server. The library (`GroupStorage`) and the
web and desktop apps do; agents do not upload files yet.

In the web and desktop apps, a room that lists nodes sends every file to the
first listed node that takes it, with no notice about a public server and no
choice written down, whatever the person chose for their own files. A device
needs a grant from the keeper first. Until it has one, or while every node is
down, the file is sealed and held in the page's memory, the message waits in the
outbox as "Waiting for the group's storage.", and the page warns before it is
closed (a held file is not kept across a reload). An app uses `https` nodes only:
a node on `localhost`, on a LAN address or behind an onion address cannot be used
from a browser, so a group that wants to share files from browsers needs a node
with a TLS name. An app also refuses a node that answers a read without a token,
and says so. A room whose list is empty (`--group-withdraw`) keeps files off with
"This group has no storage right now."

The keeper does not run a node, and nothing here makes a node public: a node in
group mode refuses everyone the keeper has not named, and every read needs a
signed token. A node must answer a browser's preflight (`Authorization`,
`Content-Type`, `X-SHA-256`, `Range`; `GET, HEAD, PUT, DELETE`) and expose
`X-Reason`, which `wildbloomd` group mode does.

## Planned

A switch in the desktop app to keep a group's files on your own computer,
closed to everyone but the group, with other members' computers holding
extra copies if they choose.
