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

File uploads are off until you choose a server, in the panel beside the
message box under **Choose where files go**.

### A public server run by somebody else

The app lists public file servers we have checked: the operator is named,
publishes terms, and an encrypted upload, download and delete worked from
the app. Today that is one.

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
[deploy/README.md](../deploy/README.md). Then type its address in the file
panel.

If you deploy KithMoot itself on your own domain, build it with
`VITE_KITHMOOT_FILE_SERVER` set to your server's address and the app will
suggest it. Each person still chooses whether to use it.

## Relays

Rooms start on three public relays run by other people unless you change
them: relay.primal.net, nostr.oxtr.dev and relay.nostr.net. To add your
own, open **Settings**, **Connections**, **Nostr relays**. A room you start
keeps the relays you had at the time, and every member uses them for that
room, whatever else they have set.

| Relay | Run by | Quiet rooms | Checked |
|---|---|---|---|
| relay.primal.net | Primal Public Relay | Yes | 21 October 2026 |
| nostr.oxtr.dev | 0xtr relay | Yes | 21 October 2026 |
| relay.nostr.net | relay.nostr.net | No | 21 October 2026 |
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
host), relays that name no contact, relays that ask for payment or sign-in,
relays that did not answer or errored, and purplepag.es, which holds
profiles only.

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

## Planned

A switch in the desktop app to keep a group's files on your own computer,
closed to everyone but the group, with other members' computers holding
extra copies if they choose.
