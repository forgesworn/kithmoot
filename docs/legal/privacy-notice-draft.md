# Privacy notice

> **DRAFT for legal review, 28 September 2026.** It has not been reviewed
> by a lawyer and it is not legal advice. HTML comments name the code
> behind each statement; remove them when the page is built.
>
> Changed 28 September 2026: rooms kept on a keeper we run, what the app
> keeps on the device, profile lookups, address checks, profile pictures,
> update checks, agents, the default relay count, payments, and the right
> to complain to us.
>
> What a notice must contain is written up in the jurisdiction kit's UK
> online services note, sections 3.2 and 3.3:
> https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md

## 1. Who we are

KithMoot is run by **ForgeSworn**. For UK data protection law we are the
controller of the personal data described here, to the extent described
below (most of what happens in a room is not something we hold at all —
see section 2). Contact us about anything in this notice at
`abuse@safety.forgesworn.dev`.

`[DECISION: whether ForgeSworn pays the ICO data protection fee.]`

## 2. The short version

- KithMoot's rooms are end-to-end encrypted. For a room we do not keep,
  we do not hold, and cannot read, your messages, your files, or your
  calls. A room kept on a keeper we run is different: the keeper holds
  that room's key, so we can read that room the way any member can
  (section 4.6).
- Joining a room needs only its link. We do not run accounts, and most
  people never give us anything we would call personal data.
- Some defaults in the app make your device contact other parties: relays
  asked for people's public profiles, the domains in people's Nostr
  addresses, and the hosts of their profile pictures (section 8). You can
  turn this off.
- Our default infrastructure (a TURN server, a file store, a drop tier,
  and, for rooms whose links name it, a relay we also run) sees connection-level information —
  device keys, IP addresses, timing, sizes — while helping your room
  connect or store a sealed file, and is designed to keep as little of it
  as possible.
- We keep no server-side account, session or membership record for a
  room we do not keep. There is nothing to delete on request because
  there is nothing held. A keeper we run is a member of its room and sees
  who is in it, as any member does (section 4.6).
- We do not sell your data, we do not show adverts, and we do not run
  analytics or tracking.

## 3. Things we never collect

- **Your private key.** Never sent to us in any KithMoot flow.
- **Room content**, for a room we do not keep. Messages, files and call
  media are end-to-end encrypted; the traffic key lives in the room's own
  link, not on our servers. The exception is a room kept on a keeper we
  run (section 4.6).
  <!-- docs/protocol.md, "Identities and trust boundaries"; deploy/keeper@.service: "this process DOES hold the room key" -->
- **A membership list**, for a room we do not keep. There is no
  server-side record of who is in a room. The room's own capability, held
  only by its members' devices and clients, is what "membership" means
  here. A keeper we run holds that capability for its room.
- **Card or bank details.** The KithMoot app never asks for them and takes
  no payments: nobody is asked to pay to be in a room.
  <!-- src/node/l402.ts: "A participant is never asked to pay to be in a room"; app/src/main.ts DONATION_RECIPIENT is empty, so the donor ring in src/donations.ts is dark -->

**What the app keeps on your device.** To work, the web and desktop app
stores these in your browser's storage for the site:

- keys: the device key and credential it uses in each room, and, if you
  sign in with Nostr, which account and sign-in method you last used;
- settings: text size, call devices and effects, notification and sound
  choices, your relay list, and the profile lookup switch (section 8);
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
<!-- app/src/device-store.ts (device keys and credentials in localStorage); app/src/rooms-store.ts (saved rooms); app/src/relay-settings.ts profilePreference; app/src/room-archive.ts and app/src/history-index.ts (IndexedDB, AES-GCM under a non-extractable device key); app/src/room-bookmarks.ts and src/read-position.ts (kind 30078, NIP-44 encrypted); room-archive.ts reseedRelays. The list is from the storage keys in app/src and src, not a reading of every one of the inventory's 84 storage calls. -->

## 4. What our default infrastructure sees, and why

If you use the default services we run (rather than a room configured to
use only other relays and stores), each does the following, and no more:

### 4.1 The default TURN server (`/turn`)

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
TURN works, not a KithMoot-specific choice, and coturn's own logs go to
`stdout` under our journald retention policy (section 5).

**Quotas**, not identity, are what stands between an unauthenticated
credential and abuse of our bandwidth: per-username and total allocation
caps, and a per-allocation bandwidth cap.
<!-- deploy/coturn/turnserver.conf: user-quota, total-quota, max-bps -->

### 4.2 The default file store (Blossom)

**What.** A file you choose to drop into a room's chat, after you
explicitly opt in to shared storage, is sealed in your browser first, then
uploaded as an opaque encrypted blob, authorised by a signed request from
your device's key.
<!-- deploy/README.md, "Running a Blossom server"; deploy/blossom.yml upload.requireAuth: true -->

**What the store holds.** The encrypted bytes, their size, and the device
key that signed the upload. Not the file's name, type or contents — those
are inside the encrypted envelope, which the store cannot open. The device
key is generated per device, per room, and is not linked to any account of
yours.

**How long.** 90 days from the blob's last fetch, not its upload; sooner
if the store's fixed-size quota fills, in which case old, unfetched blobs
are pruned to make room.
<!-- deploy/blossom.yml: rules -> expiration: 90 days; deploy/README.md "the quota" -->

**Its own request logs** are the upstream Blossom server's own, not
something this project adds; see section 5 for what happens to them.

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

### 4.4 A relay we also run

The relays KithMoot suggests by default are independent public relays we
do not operate. Until September 2026 one of the defaults was a relay we
run, and a room whose link was written then still names it. On that relay
we can see, for events that pass through it: event kinds, device public
keys, opaque room selectors, timing and message size — never plaintext
content, which is encrypted before it reaches any relay. We do not name
that relay's address in this notice; a room's link shows it, and a room's
creator can remove it from the room's relays.

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

### 4.6 A room kept on a keeper we run

**What.** A keeper is a program that holds a standing room open, so the
room keeps admitting people who present its link while nobody else is
online. It made the room, and it holds the room's key: its traffic
secret and its root inviter key, kept on the box's disk and in memory.

**What holding the key means.** Whoever runs a keeper can read that room
the way any member can: its messages, the files shared in it, and who is
in it. The keeper is also the room's admission desk and the only party
that can remove a member. A keeper as we ship it publishes no media and
joins no call. It can be set up to listen to calls or to keep a memory.
`[INPUT: whether any keeper ForgeSworn runs is set up to listen or to
keep a memory.]` If we run the keeper for a room, we can read that room.
<!-- deploy/keeper@.service: "Unlike the forwarder, this process DOES hold the room key"; state files room.json (secret, inviter key) under /var/lib/kithmoot-keeper, mode 0600; ExecStart ... create --brain none; deploy/README.md "Running a keeper": "the box holds the room key ... the operator of the box can read that room the way any member can"; "A keeper is the room's authority, and the only party that can remove a member" -->

A room whose creator runs their own keeper, on their own machine, is
their business, not ours; this section is about keepers we run.

`[INPUT: whether ForgeSworn runs keepers for rooms that other people use,
and if so which rooms and how their members are told.]`

### 4.7 Update checks from the desktop app

**What.** The signed desktop app for Macs with Apple silicon checks our
site for updates, 30 seconds after it starts and then every ten minutes,
by fetching an update feed from our web server. When there is an update,
it downloads it from our site too. Other desktop builds do not check.
There is no setting to turn this off.
<!-- desktop/updater.mjs: UPDATE_FEED on the KithMoot site, enabled only when packaged && darwin && arm64, initialDelayMs 30_000, intervalMs 10 minutes; site/downloads/updates/darwin/arm64/RELEASES.json names the download on the same site -->

**What our web server sees.** Each check is an ordinary web request: the
address it came from, the time, and the feed it asked for, which says
that it is the Mac app on Apple silicon. The site's access log is
discarded (section 4.5), so these requests are not kept.

`[INPUT: whether the Android app checks for updates, where, and how
often; it is built from another repository.]`

## 5. How long we keep information

We hold almost nothing described in section 4 for long, by design:

- TURN rate-limit counters: in memory only, gone on every restart.
- The default file store: up to 90 days from last fetch (section 4.2).
- The default drop tier: up to 30 days, or sooner under its size bound
  (section 4.3).
- System logs across the box that runs our default services (including
  any service logs that are not discarded, such as the TURN and Blossom
  services' own operational logs) are bounded by our journald retention
  policy: two weeks, or 500 MB, whichever comes first.
  <!-- deploy/journald-kithmoot.conf: MaxRetentionSec=2week, SystemMaxUse=500M -->
- A keeper we run: the room's key for as long as the keeper keeps the
  room (section 4.6).
  <!-- deploy/keeper@.service: state files "reused on every restart, so the same link reopens the same room" -->

We keep no server-side account record to delete, because we do not run
accounts. If you have contacted us by email (for a report or a complaint),
that correspondence is kept in that mailbox for as long as we reasonably
need it, and you can ask us to delete it (section 7).

## 6. Our lawful bases

`[LEGAL REVIEW: proposed bases.]`

| Purpose | Basis |
| --- | --- |
| Running the default TURN, file store, drop tier and relay | Legitimate interests, in providing infrastructure the room asked for |
| Rate limiting, quotas and abuse prevention on default infrastructure | Legitimate interests; legal obligation under the Online Safety Act 2023 |
| Reports and complaints | Legal obligation under the Online Safety Act 2023 |
| Keeping a room on a keeper we run (section 4.6) | `[LEGAL REVIEW: basis, if we keep rooms other people use.]` |

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

**Content in a room.** We cannot delete a message, a file, or a call
recording (if a keeper's own setup makes one) from a room, because we
never held it; a keeper we run holds a room's key, not its messages. If
you want something removed from a room you are in, leave
the room, ask a keeper who runs it to remove you or close it, or, for your
own signed public events, use the in-app tool that asks relays to delete
them (results depend on each relay's own cooperation, and are shown to you
per relay).
<!-- app/src/public-deletion-relay-writer.ts: a NIP-09 kind-5 deletion request, sent to relays you choose, with a per-relay accepted/refused/timed-out/unknown result -->

**Complaints.** You have the right to complain to us about how we use
your personal data. Email `abuse@safety.forgesworn.dev`; no form or
account is needed. We will acknowledge your complaint within 30 days and
answer it without undue delay.

You can also complain to the Information Commissioner's Office
(ico.org.uk). We would like the chance to put things right first.

## 8. Who else receives data

- **Public Nostr relays**, including the independent relays the app
  suggests by default and any a room's creator adds, receive the
  ciphertext, device keys and timing any room necessarily produces to
  function, wherever those relays are operated.
  <!-- app/src/main.ts DEFAULT_RELAYS: nos.lol, relay.primal.net, nostr.mom, none run by the project -->
- **Our hosting provider**, `[hosting provider]`, which hosts the box our
  default TURN server, file store, drop tier and relay run on.

The app also makes your device contact the following, because of
defaults it ships. Each learns your device's IP address and the time, as
any web request does.

- **Relays asked for public profiles.** To show people's chosen names
  and pictures, the app asks for the public Nostr profile of each person
  in the room. It asks the room's own relays and four public relays that
  are not the room's: purplepag.es (a relay that gathers profiles),
  relay.damus.io, nos.lol and relay.primal.net. Each learns the public
  keys asked about, which are the keys of the people in the room, and the
  address the question came from. The room itself keeps those keys inside
  its encryption; this lookup is what hands them to relays in the clear,
  and a relay that also carries the room can link them to it.
  <!-- app/src/main.ts PROFILE_RELAYS; app/src/profiles.ts header: "That hands all of those relays the participant pubkeys of everybody in the room, in the clear, as a query"; ProfileBook.want subscribes with { kinds: [0], authors } -->
- **The domain in a Nostr address.** If a person's profile names a Nostr
  address (name@domain), the app asks that domain to confirm it. The
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

These three are **on by default**. Turn them off under Settings,
Connections, "Profile pictures and names" (also in a room's menu), by
clearing "Show public profile pictures, names and Nostr addresses". The
choice is saved on your device. Turning it off stops further lookups and
removes loaded profiles and pictures; it cannot recall a request already
sent.
<!-- app/src/relay-settings.ts profilePreference: on unless 'kithmoot.profiles.enabled' is 'false'; app/index.html #lookupProfiles checked, buttons #appProfileSettings and #roomProfileSettings; ProfileBook.setEnabled aborts checks and closes subscriptions -->

**Agents.** A room can have agents (programs) as members. An agent reads
what any member of the room can read, and hears a call if it is set to
listen. The person who runs the agent decides where that goes: to a model
on their own machine, to a model provider such as Anthropic, to another
program of their choosing, or, for a listening agent, to a transcriber
they choose, on their own machine by default. We are not that person
unless we run the agent, and we do not see what an agent run by somebody
else sends.
  <!-- src/node/brains.ts: StdioBrain (a program the runner names), OllamaBrain (default http://127.0.0.1:11434, url configurable), AnthropicBrain (@anthropic-ai/sdk messages.create); src/node/transcriber.ts DEFAULT_WHISPERX_ENDPOINT http://127.0.0.1:8765, endpoint configurable; src/node/cli.ts --brain stdio|ollama|anthropic|none -->

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
2. The hosting provider's name (a fact to fill in).
3. Independent verification of the HTTP-to-HTTPS redirect logging gap
   named in section 4.5, rather than relying on our own reading of the
   Caddy configuration.
4. A general contact address for anything outside content, safety and
   reports (the terms draft leaves this as a placeholder too).
5. Whether ForgeSworn runs keepers, or agents, in rooms other people use
   (sections 4.6 and 8), and a basis for keeping rooms if it does
   (section 6).
6. What the Android app keeps on the device and whether it checks for
   updates (sections 3 and 4.7); it is built from another repository.
