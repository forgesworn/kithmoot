# Illegal content risk assessment

> **DRAFT for legal review, 25 September 2026.** Drafted from the code on
> `main` for the owner to check, complete and sign. It is not legal advice
> and it has not been reviewed by a lawyer. HTML comments name the code
> behind each statement. Risk levels are **provisional** until the evidence
> marked `[INPUT]` is added and the named person approves them.
>
> Changed 21 October 2026: section 8 records a significant change in
> progress (20 and 21 October 2026). Sections 1 to 7 still describe the
> service that runs today and are not rewritten.

## How this record is laid out

It follows Ofcom's four steps and the contents Ofcom lists for a written
record:

- Ofcom, *Risk Assessment Guidance and Risk Profiles* (16 December 2024),
  Part 2 (the four steps), Part 3 section 1 (the U2U Risk Profile) and
  section 3 (Risk Level Tables).
  <https://www.ofcom.org.uk/siteassets/resources/documents/online-safety/information-for-industry/illegal-harms/risk-assessment-guidance-and-risk-profiles.pdf>
- Ofcom, *Record-Keeping and Review Guidance* (24 April 2025).
  <https://www.ofcom.org.uk/siteassets/resources/documents/online-safety/information-for-industry/illegal-harms/record-keeping-and-review-guidance.pdf>
- Ofcom, *Quick guide to illegal content risk assessments*.
  <https://www.ofcom.org.uk/online-safety/information-for-industry/guide-for-services/risk-assessments>
- Ofcom, *Illegal content Codes of Practice for user-to-user services*.
  Check the version in force when signing.
  <https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/statement-protecting-people-from-illegal-harms-online>

This record does not repeat every priority-offence kind Ofcom lists; it
covers the kinds that this service's own surfaces make plausible, and marks
the rest low or negligible with a short reason.

## Record details (Record-Keeping Guidance 3.6)

| Item | Entry |
| --- | --- |
| Service | KithMoot, at `kithmoot.forgesworn.dev`: the web app (`/j`), the desktop and Android clients, the default TURN server (`/turn`), the default Blossom store, and the default drop tier (`/drops`) |
| Provider | ForgeSworn |
| Date completed | `[date signed]` (draft of 25 September 2026) |
| Date reviewed or updated | Draft review of 21 October 2026, before a significant change: section 8. Not yet signed |
| Completed by | Drafted from the code by an AI assistant; checked by `[name]` |
| Named person responsible | `[DECISION: the role accountable for the illegal content safety duties and the reporting and complaints duties, e.g. "the maintainer on call". A role, not a name.]` |
| Approved by | `[Operator]` |

## 1. Why the Act applies, and when this must be done

**User-to-user service.** A room's members exchange messages, files and
calls that other members of that room encounter. Rooms can also carry
agents (bots) as members. That makes KithMoot a user-to-user service under
section 3 of the Online Safety Act 2023.

**UK links.** The operator is in the UK. `[INPUT: whether any material
number of users are in the UK. KithMoot is a small, mostly technical/early
audience today.]`

**Size.** Small, self-hosted, invitation-link based. `[INPUT: any usage
figures the operator holds.]` Far below Ofcom's threshold for a "large"
service.

**Not a pornography service, not a search service.** KithMoot publishes no
content of its own; it carries rooms members create. It has no content
discovery, indexing or recommendation surface: there is nothing to find
except the room you were given a link to, or a public relay's own listing
of KithMoot event kinds if someone chooses to query one directly (see
section 2.3).

**Timing.** The service already runs with real users, so on our reading it
is in scope now and this assessment is due.

**Copyright and intellectual property.** Excluded from "illegal content"
under the Act (section 59) and not covered here.

## 2. The service as it is today (evidence from the code)

### 2.1 What a room actually is

A room's traffic key derives from a secret carried only in the URL
fragment after `#`, which browsers never send to a server
(`docs/protocol.md`, "Room links and admission"). Chat, files exchanged in
chat, and call signalling are end-to-end encrypted with that key or a
key derived from it; a relay, a forwarder, a TURN server or the operator
sees ciphertext, device public keys, room selectors, timing and size, never
plaintext content.
<!-- docs/protocol.md kind table (1460 chat, 1462 rekey, 1463 group invitation, 20462 KithMoot signal); "Relays see event kinds, event authors, recipient/room selectors, sizes and timing... Encryption hides payloads, not these observations" -->

This is the central fact this assessment turns on: **the operator cannot
read messages, files or calls on any room**, by design, even under a court
order, short of compromising a member's device. The Act's illegal content
duties still apply to a user-to-user service that cannot read its own
traffic (Ofcom's guidance addresses E2EE services directly: technical
inability to view content does not remove the duties, though it does shape
which measures are proportionate and possible). Everything this record can
act on is **metadata**: who reported what, an event id, a file hash, a
room link, a pubkey, not the plaintext itself.

### 2.2 Who can do what

| Action | Who | Where in the code |
| --- | --- | --- |
| Create a room, invite others | Anyone who opens the app; no account needed | `app/src/main.ts`; `docs/protocol.md` "Room links and admission" |
| Read and post in a room | Anyone holding the room's link (the part after `#`), which is never sent to a server | as above; the app has no server-side membership list to check against |
| Add an agent (bot) as a room member | A room member, following the agent contract | `docs/agents.md` |
| Drop a file into a room's chat | A room member, once they explicitly opt in (uploads are off by default; the app asks before enabling them) | `deploy/README.md`, "Running a Blossom server" ("New browser uploads are off by default... the person must explicitly accept public retrieval of encrypted bytes before uploads are enabled") |
| Make or receive a call, screen-share | Room members, device to device where possible, via TURN when not | `app/src/main.ts`; `server/turn-credentials.mjs` |
| Sign in with a persistent Nostr identity | Optional. Without it, a room is joined pseudonymously with a per-device, per-room key | `docs/protocol.md` "Identities and trust boundaries" |
| Mint a TURN credential | **Anyone who can reach `/turn`, unauthenticated** | `server/turn-credentials.mjs` (see its own "SECURITY NOTE": "GET /turn is, as shipped, unauthenticated") |
| Post a kind 1059 gift wrap to the default drop tier | **Anyone who can reach `wss://kithmoot.forgesworn.dev/drops`, no auth, no proof of work** | `deploy/Caddyfile.kithmoot` ("Unauthenticated by design"); bothy-node README, "The drop tier" |
| Upload a blob to the default Blossom store | Any key that can produce a valid signed BUD-01 upload authorisation (kind 24242); there is nobody to allowlist, because a device key is generated on-device and registered nowhere | `deploy/blossom.yml` (`upload.requireAuth: true`); `deploy/README.md` "Running a Blossom server" ("Uploads are open to any key, because there is nobody to allowlist") |
| Read a blob from the default Blossom store | Anyone who has the hash. Only `application/vnd.forgesworn.encrypted` is accepted; the store never sees the plaintext or its type | `deploy/blossom.yml` |

### 2.3 Things that lower risk

- **End-to-end encryption everywhere it matters**, described above. The
  operator has no plaintext to review, mis-serve or leak.
- **No content discovery.** There is no feed, search, trending list or
  recommendation surface. A person reaches a room, a file, or a relay
  event only by already holding a link or a hash. This removes most of the
  amplification mechanics Ofcom's guidance treats as raising risk (a
  content recommender system, a search function, hyperlinking within the
  service).
- **Rooms are closed by default.** Admission needs the link (its capability
  is never sent to a server) or, for a kept room, a keeper's admission
  decision. There is no public room directory.
- **Blossom's accepted media type is a sealed envelope, not a file
  format.** `application/vnd.forgesworn.encrypted` is opaque bytes under a
  key the store never sees; an image, video or document upload is refused
  outright, so the default store cannot be hot-linked as media and nothing
  it holds can be viewed without the room's key.
  <!-- deploy/README.md: "An image, a video or a page is refused, so this is not a general file host and nothing on it can be hot-linked as media" -->
- **Uploads to the shared Blossom store are opt-in per person**, not a
  silent default, and the person is told what they are enabling.
- **Bounded, expiring storage.** The default Blossom store: 270 MiB per
  blob, a fixed-size quota (20 GiB by default), 90-day expiry from last
  fetch. The default drop tier: 1 GiB, oldest-out, 30-day maximum age,
  per-connection rate limits.
- **TURN's relay target is fenced.** coturn denies relaying to private,
  loopback, link-local and reserved address ranges, so a minted credential
  cannot be used to probe the operator's own private network.
  <!-- deploy/coturn/turnserver.conf denied-peer-ip list -->
- **No advertising, no engagement-optimised feed, no algorithmic
  amplification of anything.**
- **A user-initiated public deletion tool.** A member can ask their own
  signed events to be deleted from a chosen list of public relays (NIP-09,
  kind 5), with a per-relay result shown back to them.
  <!-- app/src/public-deletion-relay-writer.ts -->

### 2.4 Things that raise risk (gaps)

1. **No age check of any kind**, anywhere (see the children's access
   assessment).
2. **Anonymous and throwaway identity is the normal case, not an edge
   case.** A per-device, per-room key is the default; a persistent Nostr
   identity is optional. This is a deliberate privacy property, and it is
   also exactly the factor Ofcom's risk profile flags as raising several
   priority harms (grooming, CSAM distribution, fraud, harassment):
   nothing here identifies a returning bad actor across rooms or devices.
3. **Two of the three unauthenticated, default-on public surfaces have no
   removal path at all**, by design:
   - The default drop tier keeps **no index of a wrap's recipient, sender
     or id** ("the box holds no list of who receives mail here": bothy-node
     README). An operator cannot remove one gift wrap by id, and cannot
     block a pubkey, because the software holds nothing to match either
     against. See `docs/legal/report-handling.md` for what this means in
     practice.
   - The default TURN credential endpoint is unauthenticated by design; see
     its own file header for the operator's acknowledgement of this
     ("none of that is a substitute for real access control, and it is a
     deliberate, documented trade").
4. **Group messaging, at scale, on a service with no membership review.**
   A "kith" or "kin" tier room can hold many members; nothing here vets
   who joins beyond holding the link.
5. **File sharing exists as a default surface** (the shared Blossom store),
   even though what it accepts cannot itself be illegal content in the
   ordinary sense (see 2.3). The risk it actually carries is abuse of the
   store as free, anonymous, expiring bulk storage — not as a way to
   publish or view illegal media through KithMoot, since nothing it holds
   is servable as media.
6. **A relay the operator also runs, no longer a default.** The relays
   the app suggests by default are independent public relays. Until
   September 2026 one of the three defaults was a relay the operator runs,
   and room links written before then still name it. On that relay, and
   only that one, the operator has relay-operator-level control (it can
   refuse to store or serve particular events); on the default relays, and
   on any relay a room's creator adds instead, the operator has no control
   at all. This record does not name that relay's address.
7. **No content the operator can review exists for any of this**, by
   design (section 2.1), so "swift takedown of illegal content" as Ofcom's
   Codes measures describe it cannot mean removing a message's *content*
   here. It can only mean acting on metadata: refusing a hash, blocking a
   pubkey where the software supports it, taking a room or credential
   endpoint offline, or referring a report to the police. See
   `docs/legal/report-handling.md`.

## 3. Step 1: Ofcom's Risk Profile

Outcome of the U2U Risk Profile questionnaire, as it applies to KithMoot's
own default, operator-run surfaces (a self-hosted keeper's own box is that
keeper's own operation, not covered by this record).

| Risk factor | Applies? | Why |
| --- | --- | --- |
| 1e Discussion forums and chat rooms | **Yes** | A room is exactly this |
| 1g File-storage and file-sharing service | **Partly** | The default Blossom store accepts only sealed, opaque envelopes; it cannot serve viewable media, but it is still open, anonymous bulk storage |
| 2 Child users | **Possible, unproven either way** | No age check anywhere; see the children's access assessment |
| 3b Anonymous user profiles, or users without accounts | **Yes** | The normal case, not an exception |
| 4b User groups | **Yes** | Rooms with several members |
| 5a Group messaging | **Yes** | As above |
| 5c Direct messaging | **Yes** | A room of two ("a word in private") |
| 5d Encrypted messaging | **Yes** | End to end, by design |
| 5f Posting images or videos | **No, as designed** | The default store accepts only opaque encrypted envelopes, never a viewable media type |
| 7a Content searching | No | No search across other people's content; search is local to a room a member already has |
| 8a Content recommender systems | No | None exist |
| User base | `[INPUT]` | |
| Business model | No advertising, no revenue mechanism identified in the code | |
| Commercial profile | Small; `[INPUT: operator capacity for moderation]` | |

**Multi-risk factors present:** encrypted messaging, anonymous users,
group messaging, direct messaging and no age assurance are all present at
once. Ofcom's guidance treats this combination as a materially higher-risk
shape even where the service is small, because several of the factors that
usually let a provider detect and act on harm (visible content, identity,
account history) are absent simultaneously and by design.

## 4. Step 2: risk levels

Ofcom's scale: negligible, low, medium, high. Impact reflects the severity
of the harm to a person; likelihood reflects this service's actual design.

| # | Kind of priority illegal content | Level | Reasoning |
| --- | --- | --- | --- |
| 1 | Terrorism | Low | Nothing here can be viewed or found by anyone but a room's own members; a room cannot be discovered, browsed or recommended. The drop tier and the relay we run carry unreadable ciphertext only |
| 2 | CSEA: grooming | **Medium** | Private, encrypted, one-to-one and small-group messaging with anonymous, throwaway identity by default is close to the shape Ofcom's guidance treats as the clearest grooming risk. What lowers it from higher: KithMoot is invitation-based, not a public discovery surface a stranger can use to find and approach a child with no prior link at all; there is no public profile browsing or "people near you" feature |
| 2 | CSEA: image-based CSAM | Low | The default Blossom store cannot serve a viewable file of any kind (2.3); an uploaded envelope is meaningless bytes without the room's key. The risk that remains is the store being used as anonymous bulk storage for material intended for exchange entirely outside KithMoot, which is a real but different risk from CSAM being viewed or distributed *through* the service |
| 3 | Hate | Low | No public or discoverable surface for it to reach beyond a room's own members |
| 4 | Harassment, stalking, threats and abuse | **Medium** | Direct messaging plus anonymous, throwaway identity plus no admin action available within a room (see 6.1) is a real route to sustained one-to-one harassment, made harder to escalate because there is no persistent account to block system-wide, only a room to leave |
| 5 | Controlling or coercive behaviour | Low | Same shape as 4, but this Act priority mainly concerns targeted, sustained relationships, which is harder to sustain through a per-device, per-room identity that does not follow a person between rooms |
| 6 | Intimate image abuse | Low | As image-based CSAM (row 2): the store cannot serve viewable media |
| 7 | Extreme pornography | Low | As above |
| 11 | Fraud and financial services offences | Low | No payments, no marketplace, no financial functionality identified in the code |
| 15 | Suicide and self-harm | Low | Text and voice/video calls between room members only; no public or broadcast surface |
| 18 | Cyberflashing | Low | No unsolicited image delivery mechanism to a stranger; a person only receives what a room they joined sends, and files require the recipient's own opt-in to accept shared storage |
| — | Abuse of the unauthenticated `/turn` and `/drops` endpoints for purposes unrelated to illegal *content* (bandwidth theft, using the box as a relay, denial of service) | Low as an illegal-content matter, but a live operational and cost risk in its own right | Out of scope for this content risk assessment; tracked as an infrastructure risk |

**Outcome:** grooming and harassment/abuse are the two kinds this
assessment rates medium. Both trace to the same root cause: private,
anonymous, group-capable messaging with no in-room way to remove a person
or a message, and no persistent identity to act against across rooms. Every
other kind is low, mainly because KithMoot has no discovery, search or
recommendation surface for anyone to find content through, and the default
file store cannot serve viewable media.

## 5. Existing controls and how they changed the levels

- **No content discovery surface** is the single biggest reason most
  kinds sit at low rather than medium: nothing here can be found, only
  reached by a link a member already has.
- **The Blossom envelope format** (opaque, encrypted, one accepted type)
  is why image-based and video-based harms sit at low rather than
  reflecting the raw risk of "anyone can upload any file anonymously."
- **Bounded, expiring storage** on both default stores limits how long
  abuse of them as anonymous bulk storage can persist unnoticed.
- **coturn's peer-address denylist** limits the concrete abuse a minted
  TURN credential can do to this operator's own infrastructure; it does
  not add any content moderation capability.

## 6. Step 3: measures

### 6.1 Codes measures that apply to every service, and their state

| Measure | What it asks | State today | Action |
| --- | --- | --- | --- |
| ICU A2 | A named person (role) accountable for illegal content and for reporting and complaints | None named | `[DECISION]`: name a role |
| ICU C1/C2 | A content moderation function; swift takedown of illegal content | No content exists to moderate (E2EE); metadata-level actions exist per surface, unevenly (`docs/legal/report-handling.md`) | Confirm and communicate the honest limit: this is a metadata-and-referral function, not a content-review function |
| ICU D1/D2 | Let users and affected people report content and complain, in a way that is easy to find and use | An `abuse@safety.forgesworn.dev` mailbox, once created (item 7 of this record's README), plus the `/report/` page | Build/confirm; keep it reachable without an account |
| ICU D7 | Act on complaints about suspected illegal content | Not yet written down | `docs/legal/report-handling.md` |
| ICU G1/G3 | Terms say, clearly, how people are protected from illegal content | No terms today | `docs/legal/terms-draft.md` |
| ICU H1 | Remove accounts of proscribed organisations | No accounts exist to remove in the ordinary sense (per-device, per-room keys); a room or link can be shut down | Add to the report-handling runbook |

### 6.2 Measures worth building, in priority order

1. **A working, well-publicised report route that needs no account and no
   room membership**: the `/report/` page and the `abuse@` mailbox
   (deliverables of this PR). This is the single highest-value fix,
   because it is the one thing missing on every surface at once.
2. **An operator-side way to at least stop serving a specific Blossom
   hash**, even though blossom-server-ts's `DELETE` route is
   owner-authorised (BUD-02) and loopback-only, not operator-authorised;
   see `docs/legal/report-handling.md` for the exact, verified gap.
   `[DECISION: whether to add an operator override, e.g. a denylist file
   the server checks before serving a hash, or to rely on manual file
   removal on the box.]`
3. **Reconsider whether the default drop tier's complete absence of an id
   or pubkey index is the right trade for a default-on, unauthenticated,
   internet-facing surface**, given it removes even the *possibility* of
   targeted removal. This is a considered design choice recorded in
   bothy-node's own documentation (it exists specifically so the tier
   cannot become a contact log), and undoing it would change what the
   tier is for. `[DECISION: accept this as a permanent limit and say so
   plainly in the report-handling runbook, or scope a bounded exception.]`
4. **A published policy for shutting down abuse of `/turn` and `/drops`**
   at the network level (IP block, rate-limit tightening, or taking the
   endpoint down) when a report cannot be acted on any other way, since
   neither surface offers a narrower tool.
5. **Terms language that says plainly what the operator can and cannot
   see and do**, so a reporter's expectations match reality (this is also
   a User Rights / transparency point, not only a safety one).

## 7. Step 4: report, review and update

- **Report:** the named role signs this record, and the operator approves
  it.
- **Keep:** this file, in version control, dated. Keep earlier versions for
  at least three years.
- **Review:** at least once a year, and before any significant change to
  default surfaces (opening a new default service, changing what the
  default Blossom store accepts, changing the drop tier's bounds or
  indexing).

## 8. Significant change in progress, 20 and 21 October 2026

> **Draft, 21 October 2026.** Drafted by an AI assistant from the code at
> `d7571f69` on `main`, the owner's plan of 20 October 2026, and the owner's
> read-only checks of the live box on 20 October 2026. Not legal advice; no
> lawyer has read it. The law is from jurisdiction-kit
> `law/gb/online-services.md`, verified 28 September 2026, and its marks are
> kept: `[P]` primary source read, `[S]` secondary, `[U]` unchecked. A `[U]`
> is a reading, not settled law.

### 8.1 Why this is recorded now

Ofcom recommends reviewing this assessment before any significant change to
the service (law note 2.3) `[P]`. On 20 October 2026 the owner accepted a
plan for ForgeSworn to stop running a public user-to-user service and to be a
software publisher. Part of it is merged; none of it is released or
deployed. This section records the change as it stands. It is not a new
assessment: sections 1 to 7 describe the service that runs today and stay
in force for each surface until its step in 8.5 lands.

### 8.2 The position today, and the one planned

**Today: a public operator.** ForgeSworn runs servers open to whoever finds
them (8.4). On the cautious reading in 2.2, an operator that runs default
infrastructure treats itself as the provider of what it runs; the provider
is whoever controls who can use the user-to-user part (section 226) `[P]`.
One open endpoint is enough for this position.
<!-- deploy/Caddyfile.kithmoot: handle /turn, handle /drops ("Unauthenticated by design"), Blossom upload and blob routes, meeting codes proxied to its loopback port; server/turn-credentials.mjs "GET /turn is, as shipped, unauthenticated" -->

**Planned: two positions, taken separately.**

| Deployment | Planned position | What it takes |
| --- | --- | --- |
| The apps (web, desktop, Android) | Publisher with defaults that point only at servers other people run: three public relays, and one listed public file server | No app-wide default names a ForgeSworn server. Today the web app asks its own origin for `/turn` and for meeting codes, and Android pre-fills ForgeSworn's file store and names ForgeSworn's host for STUN and TURN |
| ForgeSworn's own box | Closed operator: serves only the members of the owner's rooms, admitted by grants the room's keeper issues and revokes, and carried to members by the room as its relays are | Every open surface in 8.4 closes (8.5), and grants exist (plan S2 to S4) before anything reopens for the owner's rooms |
<!-- app/src/main.ts TURN_CREDENTIAL_ENDPOINT = '/turn'; app/src/meeting-codes.ts; plan section 1.1 for Android MediaComposer.kt and CallIceServers.kt (not read here) -->

**Does anything the operator runs hold a key to content? Yes.** A keeper
holds its room's traffic secret, because it created the room. The meeting
code service stores the full invitation link for a code made without a
password, and for a room with no waiting room that link lets the service
enter the room while the code lives. Section 2.1's "the operator cannot read
messages, files or calls on any room" is not true of those rooms (8.7).
<!-- deploy/keeper@.service lines 6 to 13; deploy/README.md "Meeting codes": "It stores those full links, so it can read every invitation it holds"; docs/meeting-codes.md "Trust model" -->

### 8.3 Reasoning, surface by surface

Whichever reading is taken, 2.2 asks that the reasoning be written down,
kept, and revisited before shipping a default, adding discovery, search, a
feed or presence, or starting to run a server.

**Chat relays (D2).** The apps keep three public relays as defaults:
relay.primal.net, nostr.oxtr.dev and relay.nostr.net. ForgeSworn chose them and controls
nobody's admission to them. Section 226 turns on control over who can use
the service `[P]`, and Ofcom says a user who operates a decentralised
service may be its provider `[P]`. On that footing each relay's operator
is the provider of that relay, and ForgeSworn is not a provider for chat:
the middle reading in 2.2 `[U]`. No Ofcom guidance on
where publishing software ends and providing a service begins was found
`[U]`. What this reading still owes: the privacy notice names the defaults
and what they learn (law note 3.2) `[U]`; `privacy-notice-draft.md` section
8 does so, and covers the profile relays the same way. When a group runs its
own relay, the room adds it to its fixed relays; that relay's provider is
the member who runs it.
<!-- app/src/main.ts DEFAULT_RELAYS; app/src/main.ts PROFILE_RELAYS -->

**The listed public file server.** The web app lists one public file
server, blossom.yakihonne.com, run by Yakihonne LLC in the United States.
Uploads stay off until the person chooses a server; they may name any
other, their own included. The same middle reading applies `[U]`: the
listed server's operator controls who can use it and is its provider.

Why a short vetted list and not none: with no list, a person must find a
working server unaided, and most would not, so the feature would not work
on first use. A suggested list may still be read as a default (the plan's
own reading, section 7), and the note says the software reading weakens
once a default server is shipped (2.2) `[U]`, so neither choice removes the
question. What the list does is keep the
suggestion to a server with a named operator, published terms, and a
round trip that passed on 20 October 2026: an encrypted upload, a fetch by
hash from the app's origin, and a delete. Servers that named no operator or
published no terms were left out. The code forbids any ForgeSworn host on
the list, and a self-hoster can suggest their own server with
`VITE_KITHMOOT_FILE_SERVER`. What the app uploads is sealed before it leaves
the device; the rule in 2.3 that a store accepts only the sealed envelope
type is a rule of ForgeSworn's store, not of the listed server.
`[DECISION: how often the listed server is checked again, and what removes
it from the list.]`
<!-- app/src/file-storage.ts PUBLIC_FILE_SERVERS (line 49), the comment on what qualifies and what was left out, "No ForgeSworn host may ever appear here (the test suite checks)"; suggestedFileServer; docs/run-your-own.md -->

**ForgeSworn's own servers, for the owner's rooms.** The owner's position,
given after the plan: a room the owner starts may use the owner's servers
and defaults. So the target is not that the box goes, but that it serves
only the members of the owner's rooms, and that the room, not the app,
tells a member's device where those servers are. Admission is by grant from
the room's keeper (plan S2 to S4; D7, keeper only). Controlling the grants
makes ForgeSworn the provider of a closed service (section 226 `[P]`; law
note 2.10). Whether the Act's duties attach turns on who the members are.

- *Rooms whose members work on ForgeSworn's projects.* Exempt as an internal
  business service, Schedule 1 paragraph 7 `[P]`, if all three hold:
  - it is "an internal resource or tool for a business", where business
    includes any "concern (whether or not carried on for profit)" `[P]`; an
    unpaid open-source project is a concern in that sense `[U]`;
  - the person carrying on the business is the provider. A project name is
    not a legal person; the person behind it is (law note 9) `[U]`. So the
    person who carries on ForgeSworn's work must be the one who runs these
    servers and controls the grants. `[LEGAL REVIEW: whether ForgeSworn, as
    it is constituted, meets this limb.]`
  - it is "available only to a closed group": the provider, people who work
    for the provider "(including as employees or volunteers)", and others
    authorised "for the purposes of any activities of the business", such
    as a contractor `[P]`. A grant goes only to such a person. A friend, a
    relative or a guest who is not working on the project breaks the
    condition for the servers that admit them.

  People who work for the provider, volunteers included, are not users
  when acting in the course of its business (section 227(3)) `[P]`.
- *Rooms of family and friends.* No exemption names this. It is regulated
  only if it has links with the UK (2.1); no decision on a closed service of
  a handful of people was found `[U]`. For data protection, processing for a
  purely personal or household activity is outside UK GDPR `[P]`, and closed
  servers for private life are outside both it and the fee `[U]` (3.9);
  "purely" is the limit, and servers also used for a project's work are not
  household `[U]`. Plan D8 recommended keeping such a group off ForgeSworn's
  names, domains and boxes. `[DECISION: whether family and friends rooms use
  ForgeSworn's box, given that putting them beside project rooms weakens
  both the internal business reading and the household reading.]`
- *Closed means closed.* A closed deployment should carry no public page
  that shows user content, no open sign-up, and no endpoint that takes
  content from whoever finds it `[U]` (2.10). While `/turn`, `/drops`,
  Blossom uploads and `/codes` stay open on the same box, the closed
  readings above are not available to it. The open surfaces close first;
  the closed ones open after, and only behind grants.
- *A leaked room link.* Anyone holding a room's link can join its chat on
  the public relays, which is those relays' business. The box still serves
  only devices the keeper granted.

**The web app and the APKs (D10).** They stay on `kithmoot.forgesworn.dev`.
Serving a static app and its downloads is publishing software, on the
first reading in 2.2 `[U]`, provided no default points back at the same host
for content; today `/turn` and meeting codes do, which steps 3 and 4 of 8.5
end. Publishing
general-purpose software does not make the publisher a party to an offence
somebody else commits with it; the offences of encouraging or assisting
need intent or belief, and foreseeability is not intent (Serious Crime Act
2007 ss.44 and 45) `[P]`. What would change that: presenting the software
as a means to break the law, or helping a particular person in the belief
that they are committing an offence `[U]` (6.1). Published open-source
cryptography is released from export control while it stays published
without restriction (article 18(2)) `[P]`. The web host's own records stay a
privacy notice matter (3.1, 3.2); Caddy discards the site's access log.

### 8.4 What is live today

Checked on 20 October 2026, from outside and read-only on the box. Each
switch-off needs the owner's explicit go; the drop tier's route was removed
on 21 October 2026 with that go (8.5, step 1).

| Surface | State on 20 October 2026 |
| --- | --- |
| TURN credentials, `GET /turn` | An anonymous request got working TURN credentials |
| Drop tier, `wss://kithmoot.forgesworn.dev/drops` | On (`BOTHY_DROPS_ENABLED=true`), and served a stored kind 1059 wrap to an anonymous query. It was switched off on 9 September 2026 pending the agreement of the drop tier software's joint maintainer; who switched it back on is not known. No app default names it. **21 October 2026:** no longer fronted. The `/drops` route was removed from the Caddy file and a WebSocket upgrade to it gets 404 from outside. The tier still runs on the box's loopback, reachable only from the box, because the box's cadence work will not start without it, and the box no longer advertises its address |
| Blossom file store | Uploads accepted from any key with a signed BUD-01 authorisation; reads by hash open to anyone; a read-only onion front serves the same store |
| Meeting codes, `/codes` | Live, and stores full room links |
| Keepers on the box | Two keeper instances, both crash-looping since 19 October 2026: with the box's Node 22 and nostr-tools 2.25.2, a relay that times out (two of the default relays were unreachable) sends the relay client into unbounded recursion. They hold no room open while they fail. `[INPUT: whose rooms they serve.]` |

Not checked on 20 October 2026, from the plan (section 1.1): two archive
nodes on the owner's own machines mirror files from this store (plan D5),
and a ForgeSworn Link relay on the same box is described as a default for
other people's boxes, which needs the joint maintainer's agreement.

Merged but not released: the web app no longer suggests ForgeSworn's store,
lists the public server above, and asks anyone who accepted the old
suggestion to choose again, with a notice that names no host (PR #489). The
matching Android change is open (kithmoot-android PR #295).

### 8.5 The switch-off order

From the plan's section 10. Before each step, a client release removes the
matching default, and the app tells people. The notice comes first; the
route goes after.

| Step | Notice first | Then | Plan's end state | Owner's end state |
| --- | --- | --- | --- | --- |
| 0 | None | Verify each surface (done on 20 October 2026 except the keepers' rooms and the Link relay) | | |
| 1. Drop tier | Release note | Switch the tier off; remove the `/drops` route. Held wraps age out within 30 days. **Route removed 21 October 2026**; the tier stays on loopback while the box's cadence work needs it | Removed | Removed |
| 2. New Blossom uploads | On the file picker: ForgeSworn's shared storage has closed to new files; set up the group's own storage or send files directly. Gives the read-window date (step 5) | Web and Android releases with no pre-filled ForgeSworn server; then remove the upload route; stop archive enrolment | Removed | `[DECISION: a closed store for the owner's rooms behind grants (S2 to S4), or none]` |
| 3. Meeting codes | "Meeting codes are going. Share the room link instead." | Refuse new codes; let live codes run out (at most 7 days); keep the 30-day tombstones; then remove the route and service | Removed (D6) | `[DECISION: retire as D6, or keep for the owner's rooms only behind grants]` |
| 4. Open `/turn` mint | In a call with no relay: "Some calls need a relay. Your group has none, so this call may not connect on some networks." | Clients take ICE servers from the room or group only; then remove `/turn` and the KithMoot credential service. coturn stays, with its separate secret, for the owner's own Wildbloom direct send | Removed | `[DECISION: TURN for the owner's rooms through a grant-checked issuer the room carries (plan S9), or none]` |
| 5. Blossom reads | Announced at step 2 and repeated: "Files shared before <date> will disappear on <date>. Save any you want to keep." | After the read window (D4: a fixed window from the stop date; 90 days matches the store's rule), remove the blob route, the onion front, the service and its store; retire the archive nodes (D5) | Removed | Removed for files other people sent. `[DECISION: whether a closed store for the owner's rooms replaces it]` |
| 6. Keepers for other people's rooms, if any | In the room, from the keeper | Hand each to a member, or end it | Ended or handed over | Keepers for the owner's rooms stay; they hold those rooms' keys as members |
| 7. Legal records | Updated terms and privacy pages | Revise this record and the children's access assessment; keep old versions for three years | | |

Steps 1 to 3 do not depend on the group work and can go first. Plan S9
should land before step 4, so a group that cares about calls has somewhere
to go. Nothing reopens for the owner's rooms until the open surface it
replaces has closed and grants work.

### 8.6 What stays the same until each step lands

- Each open surface in 8.4 keeps its description in sections 2 to 6 of this
  record, its entry in the report runbook and its section in the privacy
  notice until its step lands. Nothing above is gone yet.
- While any open surface runs, ForgeSworn is, on the cautious reading, its
  provider (2.2), and owes what 2.3 lists, among them: this assessment
  made, recorded and kept `[P]`; a children's access assessment `[S]`; a
  report route and complaints procedure `[P]`; and reports to the National
  Crime Agency of child sexual exploitation and abuse content it detects
  (2.6) `[P]`.
- The deadline for a service newly in scope is three months after launch
  `[P]` for this assessment and three months `[S]` for the children's
  access assessment (law note 2.4). Counted from the first deploy commit,
  24 August 2026, since the owner has not given a launch date, that is 24
  November 2026. `[INPUT: the launch date, if different.]`
- Until the web release, the live web app still suggests ForgeSworn's store.
  Until kithmoot-android PR #295 is released, Android still pre-fills it and
  names ForgeSworn's host for STUN and TURN.
- The report route, `abuse@safety.forgesworn.dev` and the `/report/` page,
  stays.

### 8.7 Statements in sections 1 to 7 that this section corrects

Left in place so the record shows what was assessed; to be revised when the
change is complete (plan section 10 step 7, and S13).

- **"The operator cannot read messages, files or calls on any room"
  (2.1).** Not true of a room whose keeper the operator runs, or a room
  whose meeting code was made without a password, while the code lives
  (8.2).
- **"The default drop tier" (record details, 2.2, 2.3, 2.4).** No app names
  the drop tier. It is open infrastructure the operator runs, not a default
  of the apps. It is still a surface the operator provides.
- **Meeting codes are missing.** Sections 2 to 4 do not cover `/codes`, a
  live surface open to anyone that stores full room links. `[OWNER TO DO:
  add it to 2.2, 2.4 and 3, or retire it under step 3 first.]`
- **"The default Blossom store".** From the web release after 20 October
  2026 it is no longer the web app's suggestion. It stays Android's until PR
  #295 is released, and it stays open to anyone who names it until step 2.

### 8.8 Decisions and sign-off

Open in this section: the six `[DECISION]` markers in 8.3 and 8.5, the
`[LEGAL REVIEW]` on the provider limb of paragraph 7, and the `[INPUT]` on
the keepers' rooms and the launch date, and the `[OWNER TO DO]` on meeting
codes in 8.7.

| Item | Entry |
| --- | --- |
| Change recorded | Planned position and switch-off order, 20 and 21 October 2026 |
| Drafted by | An AI assistant, from the code at `d7571f69` and the owner's checks of 20 October 2026 |
| Reviewed by | `[name]` |
| Approved by | `[Operator]` |
| Date signed | `[date signed]` |

## Decisions for the owner

1. The named role accountable (ICU A2).
2. Whether to build any operator-side removal capability beyond what the
   underlying software already exposes (section 6.2, items 2 and 3).
3. Confirm the `abuse@safety.forgesworn.dev` mailbox exists and is monitored
   before relying on this record or the terms that reference it.
4. The decisions and sign-off for the change in progress (section 8.8).

Still to do: the evidence marked `[INPUT]`.
