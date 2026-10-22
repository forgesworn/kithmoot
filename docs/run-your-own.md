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
They are notes, not legal advice. The deploy kit says the same at the top
of its guide:
[Whoever deploys it runs it](../deploy/README.md#whoever-deploys-it-runs-it).

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

Under **Settings**, **Connections**, **Call relay (TURN)** you can enter
your own relay's addresses, username and password on each device. Save,
then leave and reopen the room; existing invitations work. Credentials stay
on the device and are never added to the room link. The separate STUN
field supplies address-discovery servers to rooms you create.

See [Your own relay for a one-to-one call](private-call-relay.md) for a
small private coturn setup and local transport checks. The full deploy kit
also supports TLS and a credential service: see "Deploying coturn and the
credential service" in [deploy/README.md](../deploy/README.md). Distributing
member-specific relay credentials through the room is still future work.

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
never falls back to a public file server. Today only the library does
(`GroupStorage`); the web app does not yet, and still uploads to the member's
own file server.

What exists today is the keeper's side and the node's side, and the library a
client uses to upload to and read from the listed nodes (`GroupStorage`). The
web app does not yet use it (a later phase), so setting this up does not change
where a person's files go in the app. The keeper does not run a node, and nothing
here makes a node public: a node in group mode refuses everyone the keeper has
not named, and every read needs a signed token.

## Planned

A switch in the desktop app to keep a group's files on your own computer,
closed to everyone but the group, with other members' computers holding
extra copies if they choose.
