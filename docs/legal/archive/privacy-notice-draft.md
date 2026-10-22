# Privacy notice

> **DRAFT for legal review, 25 September 2026.** It has not been reviewed
> by a lawyer and it is not legal advice. HTML comments name the code
> behind each statement; remove them when the page is built.
>
> Changed 19 October 2026: the parties the app's defaults contact
> (profile relays, picture hosts, Nostr address checks when turned on,
> and for the desktop app our site, GitHub and Google), update checks
> from the desktop app, and the default relay count. Later the same day:
> desktop 0.1.91 stops the Google dictionary download.
>
> Changed 20 October 2026: the web app no longer suggests our file store,
> and asks people who accepted that suggestion to choose again (4.2). It
> lists one public file server run by somebody else, which a person may
> choose (section 8).
>
> Changed 21 October 2026: notes in sections 3 and 4.3 on what we can read
> and on the drop tier, pending a revision (risk assessment, section 8).
>
> Changed 22 October 2026, drafted from the code at `243af551` on
> `design/files-public-first`: files now go by default to a public file
> server run by somebody else, named in a one-time notice before the first
> upload (sections 2 and 8); our file store takes no new uploads (4.2);
> the file choice kept on the device (section 8); deleting your own files
> (section 7). This replaces the 20 October entry's "lists one public file
> server, which a person may choose": it is now the default.
>
> Changed 22 October 2026, from the code at `edf32cd0` on `main`: the
> corrections of 28 September 2026 that still hold are carried in. Rooms
> kept on a keeper we run (2, 3, 4.7, 5, 6), what the app keeps on the
> device (3), payments (3), agents (8), and the right to complain to us (7).
>
>
> Changed 22 October 2026, later: our meeting code service is stopped
> (3); TURN is closing and our STUN stays (4.1); coturn keeps no log
> (4.1, 5); file reads end on 23 October 2026 (4.2); the relay we also run
> takes writes only from keys we allow (4.4). Pending changes are marked
> as pending.
>
> What a notice must contain is written up in
> [the online services law note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md), sections 3.2 and 3.3.

## 1. Who we are

KithMoot is run by **ForgeSworn**. `[DECISION: who the controller is in
law; a project name that is not a registered legal person cannot be one
(law note 9, [U]), and the notice must give the controller's identity
(law note 3.2).]` For UK data protection law we are the
controller of the personal data described here, to the extent described
below (most of what happens in a room is not something we hold at all;
see section 2). Contact us about anything in this notice at
`abuse@safety.forgesworn.dev`.

`[DECISION: whether ForgeSworn pays the ICO data protection fee: £52 at
tier 1, £78 at tier 2, £5 less by direct debit; running a public online
service is not on the exempt list (law note gb/online-services 3.4,
verified 28 September 2026, [P]).]`

## 2. The short version

- KithMoot's rooms are end-to-end encrypted. For a room we do not keep,
  we do not hold, and cannot read, your messages, your files, or your
  calls. A room kept on a keeper we run is different: the keeper holds
  that room's key, so we can read that room the way any member can
  (section 4.7). Section 3 notes one other exception.
- Joining a room needs only its link. We do not run accounts, and most
  people never give us anything we would call personal data.
- In the web app and the desktop app, files you send go to a public file
  server run by somebody else, unless
  you choose another server or none. They are encrypted on your device
  first, so that server cannot open them (section 8).
- Our default infrastructure (a STUN server; a TURN server, until it
  closes; a file store that takes no new files and serves the ones it
  holds until 23 October 2026 (pending); and, for rooms whose links name it, a relay
  we also run, which takes writes only from keys we allow) sees
  connection-level information, such as device keys, IP addresses, timing
  and sizes, while helping your room connect, and is designed to keep as
  little of it as possible.
- We keep no server-side account, session or membership record for a
  room we do not keep. There is nothing to delete on request because
  there is nothing held. A keeper we run is a member of its room and sees
  who is in it, as any member does (section 4.7).
- Some defaults make your device contact other parties: relays asked for
  people's public profiles and the hosts of their profile pictures, and,
  for the desktop app, our site for updates and GitHub (section 8).
  Desktop versions before 0.1.91 also contacted Google. You can turn the
  profile lookups off.
- We do not sell your data, we do not show adverts, and we do not run
  analytics or tracking.

## 3. Things we never collect

- **Your private key.** Never sent to us in any KithMoot flow.
- **Room content**, for a room we do not keep. Messages, files and call
  media are end-to-end encrypted; the traffic key lives in the room's own
  link, not on our servers. The exception is a room kept on a keeper we
  run (section 4.7).
  <!-- docs/protocol.md, "Identities and trust boundaries"; deploy/keeper@.service:13 "this process DOES hold the room key" -->

  *Note, 21 and 22 October 2026.* Until 22 October 2026 one other thing we
  ran was an exception. Our meeting code service stored the full
  invitation link for a code made without a password; for a room with no
  waiting room, that link let the service enter the room while the code
  lived. On 22 October 2026 the service was stopped and disabled, and
  `/codes` answers 410 (the host's report; the repository's Caddy file and
  the web app still name `/codes`). `[INPUT: whether the links it stored
  were deleted.]`
  <!-- deploy/README.md "Meeting codes"; docs/meeting-codes.md "Trust model"; deploy/Caddyfile.kithmoot:158-163; app/src/main.ts:2091 -->
- **A membership list**, for a room we do not keep. There is no
  server-side record of who is in a room. The room's own capability, held
  only by its members' devices and clients, is what "membership" means
  here. A keeper we run holds that capability for its room.
- **Card or bank details.** The KithMoot app never asks for them and takes
  no payments: nobody is asked to pay to be in a room.
  <!-- src/node/l402.ts: "A participant is never asked to pay to be in a room"; app/src/main.ts:855 DONATION_RECIPIENT is empty, so the donor ring in src/donations.ts is dark -->

**What the app keeps on your device.** To work, the web and desktop app
stores these in your browser's storage for the site:

- keys: the device key and credential it uses in each room, and, if you
  sign in with Nostr, which account and sign-in method you last used;
- settings: text size, call devices and effects, notification and sound
  choices, your relay list, the profile lookup switches (section 8), and
  where files go, with the server your choice names (section 8);
- saved rooms: the rooms you have been in, with their links and what this
  device needs to rejoin them, and how far you have read;
- history: an encrypted archive of the signed, still room-encrypted
  events of rooms you have been in, and an encrypted index of any history
  you import;
- your contacts and projects.

This stays on your device. We never receive it. Two things leave it: if
you sign in with a Nostr account, your saved rooms and read positions are
published to your relays, encrypted, so your other devices can find them;
and a room's relay that has lost some of that room's events can be handed
back the original encrypted copies. Clearing the site's data in your
browser removes it from the device. `[INPUT: what the Android app keeps
on the device; it is built from another repository.]`
<!-- app/src/device-store.ts (device keys and credentials in localStorage); app/src/rooms-store.ts (saved rooms); app/src/relay-settings.ts (relays, profile and address switches); app/src/file-storage.ts:6 FILE_STORAGE_KEY 'kithmoot.file-storage.v1'; app/src/room-archive.ts and app/src/history-index.ts (IndexedDB, AES-GCM under a non-extractable device key); app/src/room-bookmarks.ts:25 (kind 30078, NIP-44) and src/read-position.ts; app/src/room-archive.ts reseedRelays. The list is grouped from the storage keys in app/src and src, not a reading of every storage call. -->

## 4. What our default infrastructure sees, and why

If you use the default services we run (rather than a room configured to
use only other relays and stores), each does the following, and no more:

### 4.1 The default TURN server (`/turn`), and our STUN server

**Closing, not yet closed.** On 22 October 2026 `/turn` still gives a
credential to anyone who asks. It and its credential service close once
Android 0.6.103 and the matching web release are both live; after that our
server answers STUN only, and its TLS port, 5349, closes. Until then, what
follows applies.

**What.** When your call cannot connect device to device, your browser
asks `/turn` for a short-lived credential, then relays media through
coturn if needed. Minting a credential is unauthenticated: anyone who can
reach the URL gets one.
<!-- server/turn-credentials.mjs: "GET /turn is, as shipped, unauthenticated" -->

**IP addresses.** The credential-minting service keeps an in-memory,
per-IP rate-limit counter only: a token bucket that resets to full on
every process restart and is never written to disk.
<!-- server/turn-credentials.mjs createRateLimiter: an in-memory token bucket, "This resets to full capacity every time the process restarts" -->

**During a relayed call**, coturn itself necessarily sees both sides' IP
addresses, because that is what a TURN relay does; this is inherent to how
TURN works, not a KithMoot-specific choice.

**coturn's log.** Until about 10:30Z on 22 October 2026 coturn logged to
its container's log, capped at three files of 10 MB each. Since then it
keeps no log (the host's report; the repository's configuration has not
caught up and still logs).
<!-- deploy/coturn/turnserver.conf:214 log-file=stdout, :215 simple-log; deploy/coturn/docker-compose.yml:55-59 json-file, max-size 10m, max-file 3 -->

**STUN, which stays.** When a room names no call servers of its own, the
app asks the site that served it for STUN on port 3478. STUN tells your
device its own public address, so two devices can try to reach each other
directly. Our STUN server sees your device's IP address and port and the
time of each request. It carries nothing you say or send.
<!-- src/ice-defaults.ts:137-140 originStunGuess: stun:<host>:3478 for an https origin; src/ice-defaults.ts:93 stunFromTurnUrl; deploy/coturn/turnserver.conf:17 listening-port=3478 -->

**Quotas**, not identity, are what stands between an unauthenticated
credential and abuse of our bandwidth: per-username and total allocation
caps, and a per-allocation bandwidth cap.
<!-- deploy/coturn/turnserver.conf: user-quota, total-quota, max-bps -->

### 4.2 Our file store (Blossom)

**No new uploads.** From 22 October 2026 our file store takes no new
uploads, and the web app and the desktop app no longer send files there. Files already there
are still served to anyone with their link, and the device that sent one
can still delete it, until reads end on Friday 23 October 2026 (pending
on 22 October). After that a file there reads as no longer available in
the app. `[INPUT: whether the stored files are deleted when reads end, and
when.]`
<!-- app/src/attachment-card.ts:79 "This file is no longer on {host}." -->
<!-- app/src/file-storage.ts storedFileServer, usableFileServer, chooseFileServer and retireForgeSwornConsent: no ForgeSworn host is ever a destination. Server side: the host's report of 22 October 2026 that PUT, HEAD and OPTIONS on /upload answer 410 from 09:42Z, with Blossom reads and owners' deletes still working. Not verified from code: deploy/Caddyfile.kithmoot in this tree still passes /upload to the store, and is not the live state. -->

**What.** A file sent to the store before then was sealed in the sender's
browser first, then uploaded as an opaque encrypted blob, authorised by a
signed request from the device's key.
<!-- deploy/README.md, "Running a Blossom server"; deploy/blossom.yml upload.requireAuth: true -->

**What the store holds.** The encrypted bytes, their size, and the device
key that signed the upload. Not the file's name, type or contents: those
are inside the encrypted envelope, which the store cannot open. The device
key is generated per device, per room, and is not linked to any account of
yours.

**How long.** 90 days from the blob's last fetch, not its upload; sooner
if the store's fixed-size quota fills, in which case old, unfetched blobs
are pruned to make room.
<!-- deploy/blossom.yml: rules -> expiration: 90 days; deploy/README.md "the quota" -->

**Its own request logs** are the upstream Blossom server's own, not
something this project adds; see section 5 for what happens to them.

**A device that used it.** The app removes a saved choice that names our
store, says once that KithMoot no longer sends files there, and shows the
notice for the default server in section 8 before the next upload. Typing
our store's address in Settings is refused.
<!-- app/src/file-storage.ts retireForgeSwornConsent, FORGESWORN_STORAGE_CLOSED; app/src/main.ts fileNoticeClosed -->

### 4.3 The default drop tier (`/drops`)

**What.** A bounded relay for one Nostr event kind (kind 1059, an
encrypted "gift wrap"), accepted from any connection with no
authentication.
<!-- bothy-node README, "The drop tier" -->

**What it deliberately does not hold.** No index of a wrap's sender,
recipient or id. Its database "retains only [a] two-value ingress class,
never a peer, address, key or recipient, so the rule survives restart
without creating a contact log." A request that tries to filter by
recipient or author is refused outright, because the tier has nothing to
filter by.
<!-- bothy-node README, "The drop tier": exact quotation of the design intent -->

**How long.** Bounded by total size (1 GiB by default), a 30-day maximum
age, and each wrap's own expiry; oldest-out when the bound is reached.

*Note, 21 October 2026.* No app names the drop tier. From 21 October 2026
it is no longer reachable from outside the box; what it already held ages
out within 30 days.
<!-- deploy/Caddyfile.kithmoot:166-172 "No /drops here" -->

### 4.4 A relay we also run

The relays KithMoot suggests by default are independent public relays we
do not operate. Until September 2026 one of the defaults was a relay we
run, and a room whose link was written then still names it. On that relay
we can see, for events that pass through it: event kinds, device public
keys, opaque room selectors, timing and message size, never plaintext
content, which is encrypted before it reaches any relay. We do not name
that relay's address in this notice; a room's link shows it, and a room's
creator can remove it from the room's relays.

From 10:58Z on 22 October 2026 it accepts writes only from keys we allow,
and other people's data on it, and its old backups, were deleted (the
host's report). A room whose link names it can no longer post there unless
its key is allowed. `[INPUT: whether it still serves reads to anyone.]`

### 4.5 Access and error logs on our web server

Our web server (Caddy) is configured to discard access logs for the
KithMoot site.
<!-- deploy/Caddyfile.kithmoot: "log { output discard }", and the comment explaining the intent -->

**Known gap, stated honestly.** Caddy's automatic redirect from plain HTTP
to HTTPS may still be recorded by the operating system's own connection
logging (the system journal) even though the site's own access log is
discarded, because that redirect can happen before Caddy's site-specific
logging configuration applies. We have not independently verified this is
fully suppressed, and we say so rather than claim a guarantee we have not
checked.

### 4.6 Update checks from the desktop app

**What.** Every desktop build except the Debian package checks our site
for updates, 30 seconds after it starts and then on a timer:

- the signed app for Macs with Apple silicon fetches an update feed every
  ten minutes;
- the Windows ZIP and the Linux tar.gz fetch a signed release list every
  hour.

When there is an update, the app downloads it from our site too. The
Debian package does not check by itself: the system's package manager
fetches its updates from the project's GitHub releases (section 8).
There is no setting to turn the checks off.
<!-- desktop/updater.mjs: UPDATE_FEED on the KithMoot site, enabled only when packaged && darwin && arm64, initialDelayMs 30_000, intervalMs 10 minutes; site/downloads/updates/darwin/arm64/RELEASES.json names the download on the same site. desktop/archive-updater.mjs: UPDATE_ORIGIN https://kithmoot.forgesworn.dev, initialDelayMs 30_000, intervalMs 60 minutes, manifest 'downloads/release.json' (desktop/update-manifest.mjs MANIFESTS.desktop), download archiveUrl `${origin}/apk/desktop/${version}/${filename}`. desktop/main.mjs: a Debian install (kithmoot-version stamp) uses desktop/package-updater.mjs, which reads a local file and fetches nothing -->

**What our web server sees.** Each check is an ordinary web request: the
address it came from, the time, and the file it asked for, which says
what kind of build is asking. The site's access log is discarded
(section 4.5), so these requests are not kept.

### 4.7 A room kept on a keeper we run

**What.** A keeper is a program that holds a standing room open, so the
room keeps admitting people who present its link while nobody else is
online. It made the room, and it holds the room's key: its traffic secret
and its root inviter key, kept on the box's disk and in memory.
<!-- deploy/keeper@.service:6-17, :25 room.json "the room: secret, inviter key, bearer", mode 0600 -->

**What holding the key means.** Whoever runs a keeper can read that room
the way any member can: its messages, the files shared in it, and who is
in it. The keeper is also the room's admission desk and the only party
that can remove a member. A keeper as we ship it starts with no agent
brain and joins no call. It can be set up to listen to calls (`--listen`)
or to keep a log of everything it sees and says (`--memory`). If we run the keeper for a room, we can read that room.
<!-- deploy/keeper@.service:62 ExecStart ... create --brain none; src/node/cli.ts:140 --memory, :150 --listen; deploy/README.md "Running a keeper" and "Hosts: who may remove people" -->

`[INPUT: whether any keeper ForgeSworn runs is set up to listen or to keep
a memory, whether ForgeSworn runs keepers for rooms that other people use,
and if so which rooms and how their members are told.]`

A room whose creator runs their own keeper, on their own machine, is
their business, not ours; this section is about keepers we run.

## 5. How long we keep information

We hold almost nothing described in section 4 for long, by design:

- TURN rate-limit counters: in memory only, gone on every restart.
- coturn: no log since about 10:30Z on 22 October 2026 (section 4.1).
- Our file store: a file already sent, served until 23 October 2026
  (pending on 22 October; section 4.2).
- The default drop tier: up to 30 days, or sooner under its size bound
  (section 4.3).
- System logs across the box that runs our default services (including
  any service logs that are not discarded, such as the TURN credential
  and Blossom services' own operational logs) are bounded by our journald
  retention policy: two weeks, or 500 MB, whichever comes first. coturn
  runs in a container and logged to the container's own log, not the
  journal (section 4.1).
  <!-- deploy/journald-kithmoot.conf: MaxRetentionSec=2week, SystemMaxUse=500M -->
- A keeper we run: the room's key for as long as the keeper keeps the
  room (section 4.7).
  <!-- deploy/keeper@.service: state files "reused on every restart, so the same link reopens the same room" -->

We keep no server-side account record to delete, because we do not run
accounts. If you have contacted us by email (for a report or a complaint),
that correspondence is kept in that mailbox for as long as we reasonably
need it, and you can ask us to delete it (section 7).

## 6. Our lawful bases

`[LEGAL REVIEW: proposed bases.]`

| Purpose | Basis |
| --- | --- |
| Running the default STUN and TURN, file store, drop tier and relay | Legitimate interests, in providing infrastructure the room asked for |
| Choosing the default file server the app sends files to (section 8) | `[LEGAL REVIEW: whether ForgeSworn is a controller at all for uploads it chose the destination of but never receives; if it is, which basis applies]` |
| Rate limiting, quotas and abuse prevention on default infrastructure | Legitimate interests; legal obligation under the Online Safety Act 2023 |
| Reports and complaints | Legal obligation under the Online Safety Act 2023 |
| Keeping a room on a keeper we run (section 4.7) | `[LEGAL REVIEW: basis, if we keep rooms other people use.]` |

## 7. Your rights

Because we hold so little that identifies anyone, most requests will come
back "we do not hold that", which is itself the answer to a subject access
request, not a failure to respond to one. Where we do hold something
identifiable to you (for example, an email you sent us), you can ask us to:

- give you a copy;
- correct it;
- delete it;
- restrict or stop using it.

Write to `abuse@safety.forgesworn.dev`. We will answer within one month.

**Content in a room.** For a room we do not keep, we cannot delete a
message, a file, or a call recording from it, because we never held it.
For a room we keep, we can do what its keeper can: remove a member or
close the room, which does not erase what members already received
(section 4.7). If you want something removed from a room you are in, leave
the room, ask a keeper who runs it to remove you or close it, or, for your
own signed public events, use the in-app tool that asks relays to delete
them (results depend on each relay's own cooperation, and are shown to you
per relay).
<!-- app/src/public-deletion-relay-writer.ts: a NIP-09 kind-5 deletion request, sent to relays you choose, with a per-relay accepted/refused/timed-out/unknown result -->

**Files you sent.** When you leave a room with "Leave and tidy up", or a
room you are in self-destructs, the app asks the file server to delete the
files your device sent to that room. Only your device can ask, and only for
its own files. Whether the server deletes them is up to the server.
<!-- app/src/blob-deletion.ts: a BUD-02 kind 24242 delete authorisation signed by the room's device key, sent only to a server this app uploads to -->

**Complaints.** You have the right to complain to us about how we use
your personal data. Email `abuse@safety.forgesworn.dev`; no form or
account is needed. We will acknowledge your complaint within 30 days and
answer it without undue delay.
<!-- law note 3.3: Data Protection Act 2018 s164A, in force 19 June 2026 [S]; the notice must mention the right [P] -->

You can also complain to the Information Commissioner's Office
(ico.org.uk). We would like the chance to put things right first.

## 8. Who else receives data

- **Public Nostr relays**, including the independent relays the app
  suggests by default and any a room's creator adds, receive the ciphertext, device keys and timing
  any room necessarily produces to function, wherever those relays are
  operated. The app also lists two public relays a person may pick,
  offchain.pub and relay.damus.io; neither is used unless chosen. A room
  made before the current defaults may name nos.lol, a former default, in
  its link, and the app gives such a room the current third default
  alongside.
  <!-- src/public-relays.ts:67-71 (default: true for three; offchain.pub and relay.damus.io default: false); app/src/relay-settings.ts:20 LEGACY_PUBLIC_RELAYS and :21 PUBLIC_FALLBACK_RELAY -->
- **Our hosting provider**, `[INPUT: the provider's legal name and the
  country the box is in. The repository's README says the site is served
  "from a Hetzner box"; that is prose, not configuration, and was not
  checked against the box in use today.]`, which hosts the box our STUN
  and TURN server, file store, drop tier and relay run on.
  <!-- app/src/main.ts DEFAULT_RELAYS (src/public-relays.ts): relay.primal.net, nostr.oxtr.dev, relay.ditto.pub, none run by the project -->

The app also makes your device contact the following. Each learns your
device's IP address and the time, as any web request does.

- **A public file server, when you send a file.** In the web app, and the
  desktop app that loads it, files you send go to blossom.yakihonne.com, a public server run by Yakihonne LLC in the
  United States, unless you choose another server, or "Nowhere", under
  Settings, Privacy, "Where files go". The first time your device sends a
  file, the app names the server and says what it sees, and nothing goes
  to it until you press Send. Your file is encrypted and padded on your
  device first, so the server cannot open it. The server receives the
  encrypted file; its size, rounded up so it is not exact; the upload, signed by a key made for your device in that
  room, which lets the server tell that uploads in one room came from the
  same device; your IP address; and when files are uploaded and opened.
  Anyone who opens the file, the people in your room included, connects to
  the same server, which learns their IP addresses too. Yakihonne, not us,
  decides what it keeps and for how long; its terms are at
  https://yakihonne.com/terms. Your choice, and the address of the server
  it names, are saved on your device so the app does not ask again. If a
  later version changes the default server, the app asks again before
  sending anything to the new one. A copy of KithMoot built by somebody
  else may use its own default server instead, and the app names that
  server in the same way.
  <!-- app/src/file-storage.ts PUBLIC_FILE_SERVERS (Yakihonne LLC, checked 2026-10-20), defaultFileServer (VITE_KITHMOOT_FILE_SERVER, never a ForgeSworn host), resolveFileDestination (a 'default' consent naming a server that is no longer the default falls through to the notice), acceptDefaultFileServer (Send writes kithmoot.file-storage.v1 with via 'default'); app/src/main.ts fileNoticeTitle and fileNoticeBody; app/index.html #fileWhere; packages/context/src/blossom.ts paddedPlaintextLength (power-of-two buckets up to a chunk, then whole chunks); app/src/blob-deletion.ts "signed by the room's device key". Desktop: desktop/policy.mjs HOME loads https://kithmoot.forgesworn.dev/j/, so the same default applies once that web build is deployed. Location: https://yakihonne.com/terms, "Last updated: July 15, 2026", fetched 22 October 2026: "Yakihonne LLC, a Wyoming limited liability company", governed by the laws of the United States. Yakihonne's privacy policy page rendered no text without JavaScript and was not read. -->

  `[DECISION: whether pressing Send after the one-time notice is the act of
  choice the owner relies on ("Send is the act"), or whether a separate
  explicit choice is wanted.]`
  `[LEGAL REVIEW: whether that act is enough for this recipient, and
  whether a default recipient in the United States is a transfer by
  ForgeSworn (law note 3.8) when the person's own device makes the upload
  and ForgeSworn never receives the file.]`
  `[LEGAL REVIEW: which Schedule A1 exception covers the saved choice
  (kithmoot.file-storage.v1); the draft treats it as strictly necessary
  for the upload the person asked for (law note 4, [P]).]`
  `[INPUT: the Android app was not checked for this change; this bullet
  describes the web app and the desktop app.]`

- **Relays asked for public profiles.** To show people's chosen names
  and pictures, the app asks for the public Nostr profile of the people
  it shows you: those in a room, in your private chats list and in People,
  and, if you already know them, whoever sent you an invitation. It asks
  three public relays that are not the room's: purplepag.es (a relay that
  gathers profiles), relay.damus.io and relay.primal.net. For the people
  in the room you have open it also asks that room's own relays. Each
  learns the public keys it was asked about and the address the question
  came from. The room itself keeps those keys inside its encryption; this
  lookup is what hands them to relays in the clear, and a relay that also
  carries the room can link them to it. A key your browser made for itself
  when you joined with only a name is never asked about.
  <!-- app/src/main.ts PROFILE_RELAYS, wantProfiles (scope 'room' for the chat log and call tiles of the open room, 'public' for everyone else); app/src/profile-lookups.ts routeLookups; app/src/profiles.ts header: "That hands all of those relays the participant pubkeys of everybody in the room, in the clear, as a query"; ProfileBook.want subscribes with { kinds: [0], authors } -->
- **The domain in a Nostr address, if you turn checking on.** If a
  person's profile names a Nostr address (name@domain) and you have ticked
  "Verify Nostr addresses", the app asks that domain to confirm it. The
  domain learns the name asked about and the address the question came
  from, and can infer that somebody is looking at that person. No cookies
  or referrer are sent.
  <!-- app/src/profiles.ts #checkAddress: fetch https://${domain}/.well-known/nostr.json?name=..., credentials: 'omit', referrerPolicy: 'no-referrer' -->
- **The host of a profile picture.** A picture named in a person's
  profile is loaded from whatever host that person chose. The host learns
  the address it was fetched from and when, and so that somebody is
  looking at that person. No referrer is sent. The picture's owner may
  run that host.
  <!-- app/src/main.ts pictureOf: img.src = profile picture, referrerPolicy 'no-referrer'; app/src/profiles.ts safePicture allows http: and https: -->

Profile lookups and pictures are **on by default**. Turn them off under
Settings, Privacy, "Show public profile pictures and names", by clearing
"Show public profile pictures, names and Nostr addresses". The choice is
saved on your device. Turning it off stops further lookups and removes
loaded profiles and pictures; it cannot recall a request already sent.
Checking Nostr addresses is **off by default**, under "Verify Nostr
addresses" in the same place.
<!-- app/src/relay-settings.ts profilePreference: on unless 'kithmoot.profiles.enabled' is 'false'; nip05VerifyPreference: off unless 'kithmoot.nip05.verify' is 'true'; app/index.html #lookupProfiles checked, #verifyAddresses unchecked, buttons #appProfileSettings and #privacyProfiles; ProfileBook.setEnabled aborts checks and closes subscriptions -->

The desktop app also makes your device contact:

- **Our site, for updates**, as section 4.6 describes.
- **GitHub, for the Debian package.** If you install the Debian or Ubuntu
  package, your system's package manager fetches KithMoot's updates from
  the project's releases on GitHub, on your system's own update schedule.
  GitHub learns your device's address, the time, and that it is fetching
  KithMoot.
  <!-- desktop/linux apt source: the project's GitHub releases, signed Release with Origin: KithMoot; site/downloads/index.html Linux section -->
- **Google, in desktop versions before 0.1.91, on Windows and Linux.**
  The spellchecker built into Electron, the framework the desktop app
  runs on, downloaded a dictionary for your language from a Google
  server, which learned your device's address, the time and the language
  asked for. Electron's documentation says nothing you type was sent.
  From 0.1.91 the app switches that download off, so it no longer
  contacts Google for spelling, and it has no spelling check on Windows
  and Linux. The app updates itself as section 4.6 describes, and the
  Debian package updates with your system. The Mac app uses the macOS
  spellchecker, which downloads nothing.
  <!-- desktop/spellcheck.mjs keepSpellingLocal, applied in desktop/main.mjs whenReady to the default session and persist:kithmoot-desktop-v1: download URL http://127.0.0.1:9/, no languages, spelling off, not on darwin; docs/decisions.md "Nothing goes to Google", 19 October 2026 -->

Every connection the desktop app makes, and a command to check each one,
is listed at https://kithmoot.app/check/.

**A shared board link.** When a member shares a board in a room, the app
posts a link to girnel.app in the chat. Opening it loads Girnel, a separate
app; nothing is sent there unless somebody opens the link.
<!-- app/src/room-boards.ts:181 new URL('https://girnel.app/app/') with the invitation in the fragment -->

Hosts named in the code that the app does not contact: Google's STUN
server (stun.l.google.com) is named only so that links from before 13
September 2026 that carry it are moved to the site's own STUN; a short
invitation module names z1p.app but nothing in the app uses it; and the
Zapstore hosts (relay.zapstore.dev and cdn.zapstore.dev) are used by the
maintainers' release tooling, not by the app.
<!-- src/ice-defaults.ts:46 LEGACY_DEFAULT_ICE_URLS and :62 isDefaultIceUrls; app/src/short-invitation-envelope.ts:4, imported by no other file in app/src; deploy/zapstore-downloads.mjs:9, deploy/verify-zapstore-publication.mjs:31 -->

**Agents.** A room can have agents (programs) as members. An agent reads
what any member of the room can read, and hears a call if it is set to
listen. The person who runs the agent decides where that goes: to a model
on their own machine, to a model provider such as Anthropic, to another
program of their choosing, or, for a listening agent, to a transcriber
they choose, on their own machine by default. We are not that person
unless we run the agent, and we do not see what an agent run by somebody
else sends.
<!-- src/node/brains.ts:122 StdioBrain (a program the runner names), :590 OllamaBrain (default http://127.0.0.1:11434, url configurable), :638 AnthropicBrain (@anthropic-ai/sdk messages.create); src/node/transcriber.ts:36 DEFAULT_WHISPERX_ENDPOINT http://127.0.0.1:8765, endpoint configurable; src/node/cli.ts --brain -->

`[INPUT: whether ForgeSworn runs any agent in rooms other people use, and
if so where it sends what it reads.]`

We do not use an email marketing service, an analytics company or an
error-tracking company for this site.

## 9. Children

`[DECISION: KithMoot has not yet set a minimum age; see
docs/legal/childrens-access-assessment-draft.md.]` We do not knowingly
collect personal information from children, and in practice we hold
almost no personal information from anyone (section 2). If you think a
child has given us personal information through a report or an email,
contact us at `abuse@safety.forgesworn.dev` and we will delete it.

## 10. Automated decisions

We make no decisions about you by automated means that have legal or
similarly significant effects. Rate limits on default infrastructure slow
or refuse requests automatically, for short periods, based on connection
volume, not on anything about you personally.

## 11. Changes

If we change this notice, we will say so on the site.

---

## Open points in this notice

1. The ICO fee decision (section 1).
2. The hosting provider's legal name and the box's country (section 8).
3. Independent verification of the HTTP-to-HTTPS redirect logging gap
   named in section 4.5, rather than relying on our own reading of the
   Caddy configuration.
4. A general contact address for anything outside content, safety and
   reports (the terms draft leaves this as a placeholder too).
5. The default file server (section 8): "Send is the act" as the choice,
   whether ForgeSworn is a controller for it, any transfer question, and
   the device storage exception. Yakihonne's own privacy policy has not
   been read.
6. Our file store's closure to new uploads rests on the host's report of
   22 October 2026; the Caddy file in the repository still shows the
   upload route and must catch up before this notice is published.
7. Whether ForgeSworn runs keepers, or agents, in rooms other people use
   (sections 4.7 and 8), and a basis for keeping rooms if it does
   (section 6).
8. What the Android app keeps on the device (section 3); it is built from
   another repository.
