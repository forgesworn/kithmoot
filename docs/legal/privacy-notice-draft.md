# Privacy notice

> **DRAFT for legal review, 25 September 2026.** It has not been reviewed
> by a lawyer and it is not legal advice. HTML comments name the code
> behind each statement; remove them when the page is built.

## 1. Who we are

KithMoot is run by **ForgeSworn**. For UK data protection law we are the
controller of the personal data described here, to the extent described
below (most of what happens in a room is not something we hold at all —
see section 2). Contact us about anything in this notice at
`abuse@forgesworn.dev`.

`[DECISION: whether ForgeSworn pays the ICO data protection fee.]`

## 2. The short version

- KithMoot's rooms are end-to-end encrypted. We do not hold, and cannot
  read, your messages, your files, or your calls.
- Joining a room needs only its link. We do not run accounts, and most
  people never give us anything we would call personal data.
- Our default infrastructure (a TURN server, a file store, a drop tier,
  and one of three default relays) sees connection-level information —
  device keys, IP addresses, timing, sizes — while helping your room
  connect or store a sealed file, and is designed to keep as little of it
  as possible.
- We keep no server-side account, session or membership record for a
  room. There is nothing to delete on request because there is nothing
  held.
- We do not sell your data, we do not show adverts, and we do not run
  analytics or tracking.

## 3. Things we never collect

- **Your private key.** Never sent to us in any KithMoot flow.
- **Room content.** Messages, files and call media are end-to-end
  encrypted; the traffic key lives in the room's own link, not on our
  servers.
  <!-- docs/protocol.md, "Identities and trust boundaries" -->
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

### 4.4 One default relay we also run

Of the relays KithMoot suggests by default, two are independent public
relays we do not operate, and **one is operated by us.** On that relay we
can see, for events that pass through it: event kinds, device public keys,
opaque room selectors, timing and message size — never plaintext content,
which is encrypted before it reaches any relay. We do not name that
relay's address in this notice; it is disclosed in the app itself, and a
room's creator can choose not to use it.

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

## 7. Your rights

Because we hold so little that identifies anyone, most requests will come
back "we do not hold that", which is itself the answer to a subject access
request, not a failure to respond to one. Where we do hold something
identifiable to you (for example, an email you sent us), you can ask us to:

- give you a copy;
- correct it;
- delete it;
- restrict or stop using it.

Write to `abuse@forgesworn.dev`. We will answer within one month.

**Content in a room.** We cannot delete a message, a file, or a call
recording (if a keeper's own setup makes one) from a room, because we
never held it. If you want something removed from a room you are in, leave
the room, ask a keeper who runs it to remove you or close it, or, for your
own signed public events, use the in-app tool that asks relays to delete
them (results depend on each relay's own cooperation, and are shown to you
per relay).
<!-- app/src/public-deletion-relay-writer.ts: a NIP-09 kind-5 deletion request, sent to relays you choose, with a per-relay accepted/refused/timed-out/unknown result -->

You can complain to the Information Commissioner's Office (ico.org.uk). We
would like the chance to put things right first.

## 8. Who else receives data

- **Public Nostr relays**, including the two independent defaults and any
  a room's creator adds, receive the ciphertext, device keys and timing
  any room necessarily produces to function, wherever those relays are
  operated.
- **Our hosting provider**, `[hosting provider]`, which hosts the box our
  default TURN server, file store, drop tier and relay run on.

We do not use an email marketing service, an analytics company or an
error-tracking company for this site.

## 9. Children

`[DECISION: KithMoot has not yet set a minimum age; see
docs/legal/childrens-access-assessment-draft.md.]` We do not knowingly
collect personal information from children, and in practice we hold
almost no personal information from anyone (section 2). If you think a
child has given us personal information through a report or an email,
contact us at `abuse@forgesworn.dev` and we will delete it.

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
