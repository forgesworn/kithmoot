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

## 1. Who we are

KithMoot is run by **ForgeSworn**. For UK data protection law we are the
controller of the personal data described here, to the extent described
below (most of what happens in a room is not something we hold at all —
see section 2). Contact us about anything in this notice at
`abuse@safety.forgesworn.dev`.

`[DECISION: whether ForgeSworn pays the ICO data protection fee: £52 at
tier 1, £78 at tier 2, £5 less by direct debit; running a public online
service is not on the exempt list (law note gb/online-services 3.4,
verified 28 September 2026, [P]).]`

## 2. The short version

- KithMoot's rooms are end-to-end encrypted. We do not hold, and cannot
  read, your messages, your files, or your calls. Two exceptions are
  noted in section 3.
- Joining a room needs only its link. We do not run accounts, and most
  people never give us anything we would call personal data.
- In the web app and the desktop app, files you send go to a public file
  server run by somebody else, unless
  you choose another server or none. They are encrypted on your device
  first, so that server cannot open them (section 8).
- Our default infrastructure (a TURN server, a file store that takes no
  new files, a drop tier,
  and, for rooms whose links name it, a relay we also run) sees connection-level information —
  device keys, IP addresses, timing, sizes — while helping your room
  connect or store a sealed file, and is designed to keep as little of it
  as possible.
- We keep no server-side account, session or membership record for a
  room. There is nothing to delete on request because there is nothing
  held.
- Some defaults make your device contact other parties: relays asked for
  people's public profiles and the hosts of their profile pictures, and,
  for the desktop app, our site for updates and GitHub (section 8).
  Desktop versions before 0.1.91 also contacted Google. You can turn the
  profile lookups off.
- We do not sell your data, we do not show adverts, and we do not run
  analytics or tracking.

## 3. Things we never collect

- **Your private key.** Never sent to us in any KithMoot flow.
- **Room content.** Messages, files and call media are end-to-end
  encrypted; the traffic key lives in the room's own link, not on our
  servers.
  <!-- docs/protocol.md, "Identities and trust boundaries" -->

  *Note, 21 October 2026.* Two things we run are exceptions. A keeper we
  run for a room holds that room's key, because it created the room. Our
  meeting code service stores the full invitation link for a code made
  without a password; for a room with no waiting room, that link lets the
  service enter the room while the code lives. This notice does not yet
  describe the meeting code service.
  <!-- deploy/keeper@.service; deploy/README.md "Meeting codes"; docs/meeting-codes.md "Trust model" -->
- **A membership list.** There is no server-side record of who is in a
  room. The room's own capability, held only by its members' devices and
  clients, is what "membership" means here.
- **Card or bank details.** KithMoot has no payments functionality.

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

### 4.2 Our file store (Blossom)

**No new uploads.** From 22 October 2026 our file store takes no new
uploads, and the web app and the desktop app no longer send files there. Files already there
are still served to anyone with their link, and the device that sent one
can still delete it, until they expire.
<!-- app/src/file-storage.ts storedFileServer, usableFileServer, chooseFileServer and retireForgeSwornConsent: no ForgeSworn host is ever a destination. Server side: the host's report of 22 October 2026 that PUT, HEAD and OPTIONS on /upload answer 410 from 09:42Z, with Blossom reads and owners' deletes still working. Not verified from code: deploy/Caddyfile.kithmoot in this tree still passes /upload to the store, and is not the live state. -->

**What.** A file sent to the store before then was sealed in the sender's
browser first, then uploaded as an opaque encrypted blob, authorised by a
signed request from the device's key.
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

*Note, 21 October 2026.* No app names the drop tier. It is a service we run
that anyone can reach, not a default of the apps.

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

## 5. How long we keep information

We hold almost nothing described in section 4 for long, by design:

- TURN rate-limit counters: in memory only, gone on every restart.
- Our file store: a file already sent, up to 90 days from last fetch
  (section 4.2).
- The default drop tier: up to 30 days, or sooner under its size bound
  (section 4.3).
- System logs across the box that runs our default services (including
  any service logs that are not discarded, such as the TURN and Blossom
  services' own operational logs) are bounded by our journald retention
  policy: two weeks, or 500 MB, whichever comes first.
  <!-- deploy/journald-kithmoot.conf: MaxRetentionSec=2week, SystemMaxUse=500M -->

We keep no server-side account record to delete, because we do not run
accounts. If you have contacted us by email (for a report or a complaint),
that correspondence is kept in that mailbox for as long as we reasonably
need it, and you can ask us to delete it (section 7).

## 6. Our lawful bases

`[LEGAL REVIEW: proposed bases.]`

| Purpose | Basis |
| --- | --- |
| Running the default TURN, file store, drop tier and relay | Legitimate interests, in providing infrastructure the room asked for |
| Choosing the default file server the app sends files to (section 8) | `[LEGAL REVIEW: whether ForgeSworn is a controller at all for uploads it chose the destination of but never receives; if it is, which basis applies]` |
| Rate limiting, quotas and abuse prevention on default infrastructure | Legitimate interests; legal obligation under the Online Safety Act 2023 |
| Reports and complaints | Legal obligation under the Online Safety Act 2023 |

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
never held it. If you want something removed from a room you are in, leave
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

You can complain to the Information Commissioner's Office (ico.org.uk). We
would like the chance to put things right first.

## 8. Who else receives data

- **Public Nostr relays**, including the independent relays the app
  suggests by default and any a room's creator adds, receive the ciphertext, device keys and timing
  any room necessarily produces to function, wherever those relays are
  operated.
- **Our hosting provider**, `[hosting provider]`, which hosts the box our
  default TURN server, file store, drop tier and relay run on.
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
5. The default file server (section 8): "Send is the act" as the choice,
   whether ForgeSworn is a controller for it, any transfer question, and
   the device storage exception. Yakihonne's own privacy policy has not
   been read.
6. Our file store's closure to new uploads rests on the host's report of
   22 October 2026; the Caddy file in the repository still shows the
   upload route and must catch up before this notice is published.
