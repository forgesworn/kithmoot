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
>
> Changed 22 October 2026, drafted from the code at `243af551` on
> `design/files-public-first`: the public file server becomes the apps'
> default for web and desktop, and ForgeSworn's file store takes no new
> uploads (8.2 to 8.7).
>
> Changed 22 October 2026, from the code at `edf32cd0` on `main`: the
> corrections of 28 September 2026 that still hold are carried into the
> body. The claim that the operator cannot read any room is narrowed to
> rooms it does not keep (2.1); the deadline is dated and the record is
> kept, not filed (1); the duty to report child sexual abuse content to the
> NCA is added (6.1); what exists for payments is stated (3, row 11 in 4).
>
> Changed 22 October 2026, significant change: section 9 records the
> owner's decision to be outside the Online Safety Act, meeting codes
> retired, uploads off, file reads ending 23 October 2026, coturn keeping
> no log, the relay the operator also runs closed to strangers' writes, and
> TURN pending closure with STUN kept.
>
> Changed 22 October 2026, for adoption (plan L0): sections 1 to 7 now
> describe the service as it runs on 22 October 2026, with the corrections
> listed in 8.7 and 9.4 made in the body. Markers that needed no decision
> are closed with the evidence. What is left needs the owner's decisions,
> facts only the owner has, and a date on or before 24 November 2026.

The law this record applies is written up, with its sources and evidence
marks, in [the online services law note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md), verified 28 September 2026
and due for review by 28 March 2027. This record holds only this project's
facts and decisions.

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
| Service | KithMoot, at `kithmoot.forgesworn.dev`: the web app (`/j`), the desktop and Android clients, and what the operator runs for them on 22 October 2026: STUN, the TURN server and its credential path (`/turn`, closing, 9.3), its file store (no uploads; reads until 23 October 2026, pending), the relay it also runs (closed to strangers' writes), and any keeper it runs. The drop tier (not reachable from outside since 21 October 2026) and meeting codes (stopped 22 October 2026) are recorded in sections 8 and 9 |
| Provider | ForgeSworn. `[DECISION: who the provider is in law; a project name that is not a registered legal person cannot be one (law note 9, [U]).]` |
| Date completed | `[date signed]`, on or before 24 November 2026 (draft of 25 September 2026) |
| Date reviewed or updated | Draft reviews of 21 and 22 October 2026, before a significant change: sections 8 and 9. Not yet signed |
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
is in scope now. A new service has three months from launch to carry out
this assessment (law note 2.4, `[P]`). Counting from the first deploy
commit in the repository, 24 August 2026, three calendar months run to
**24 November 2026**. `[INPUT: the date the service launched to users other
than the maintainers. If it is not 24 August 2026, count three months from
that date instead.]`
<!-- git log: first deploy commit 2026-08-24, "feat: add deploy kit for a default TURN server and PWA hosting" -->

**Kept, not filed.** The assessment is carried out and recorded, and the
record is kept (section 7). Nothing read for the law note asks a small
service to send it to Ofcom unless Ofcom asks for it; the note marks that
unchecked `[U]` (law note 2.3).

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
read messages, files or calls in a room it does not keep**, by design,
short of compromising a member's device. The relays, TURN server, file
store and drop tier it runs see ciphertext only.

**The exception is a kept room.** A keeper is the process that holds a
standing room open and answers its link. It made the room, so it holds the
room's traffic secret and root inviter key and sits in the room as a
member. Whoever runs the machine a keeper runs on can read that room the
way any member can: its messages, the files shared in its chat and its
member list. If the operator runs a keeper for a room, the operator can
read that room. A keeper as shipped is started without `--listen`, so it
does not listen to calls unless it is set up to.
<!-- deploy/keeper@.service:6-17 ("It holds the room's traffic secret and the root inviter key"; "this process DOES hold the room key"); deploy/keeper@.service:62 ExecStart ... create --brain none, no --listen; src/node/cli.ts:150 --listen, default false at :306; deploy/README.md, "Running a keeper" -->
`[INPUT: whether the operator runs keepers for rooms that people other than
the maintainers use, and for which rooms.]`

A key the operator holds is one it can be required to disclose, under
section 49 of the Regulation of Investigatory Powers Act 2000 (law note
[5.4](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md), `[P]`).

The Act's illegal content duties still apply to a user-to-user service that
cannot read its own traffic (Ofcom's guidance addresses E2EE services
directly: technical inability to view content does not remove the duties,
though it does shape which measures are proportionate and possible). For
every room the operator does not keep, everything this record can act on
is **metadata**: who reported what, an event id, a file hash, a room link,
a pubkey, not the plaintext itself. For a room the operator keeps, the
operator is a member and can also act as the room's keeper does: remove a
member by moving the room to a new key, or close the room.
<!-- deploy/README.md, "Hosts: who may remove people": a keeper is the room's authority and the only party that can remove a member -->

### 2.2 Who can do what

| Action | Who | Where in the code |
| --- | --- | --- |
| Create a room, invite others | Anyone who opens the app; no account needed | `app/src/main.ts`; `docs/protocol.md` "Room links and admission" |
| Read and post in a room | Anyone holding the room's link (the part after `#`), which is never sent to a server | as above; the app has no server-side membership list to check against |
| Add an agent (bot) as a room member | A room member, following the agent contract | `docs/agents.md` |
| Drop a file into a room's chat | A room member. In the web and desktop apps the file goes, sealed on the device, to a public file server somebody else runs, after a one-time notice that names it; the person can choose another server or none. Nothing goes to the operator's store | `app/src/file-storage.ts` (`defaultFileServer`, `resolveFileDestination`; no ForgeSworn host is ever a destination); `app/src/main.ts` `fileNoticeBody`; 8.3 |
| Make or receive a call, screen-share | Room members, device to device where possible, via TURN when not. The operator's TURN is closing (9.3); its STUN stays | `app/src/main.ts:815`; `server/turn-credentials.mjs`; `src/ice-defaults.ts:137-140` |
| Sign in with a persistent Nostr identity | Optional. Without it, a room is joined pseudonymously with a per-device, per-room key | `docs/protocol.md` "Identities and trust boundaries" |
| Mint a TURN credential | **Anyone who can reach `/turn`, unauthenticated** | `server/turn-credentials.mjs` (see its own "SECURITY NOTE": "GET /turn is, as shipped, unauthenticated") |
| Post a kind 1059 gift wrap to the drop tier | Nobody from outside the box since 21 October 2026, when the `/drops` route was removed. Until then, anyone, with no auth and no proof of work | `deploy/Caddyfile.kithmoot:166-172` ("No /drops here"); 8.4 |
| Upload a blob to the operator's Blossom store | Nobody since 09:42Z on 22 October 2026: `/upload` answers 410 (the host's report; `deploy/Caddyfile.kithmoot:203-210` has not caught up). Until then, any key with a signed BUD-01 authorisation | `deploy/blossom.yml` (`upload.requireAuth: true`); 8.4 |
| Read a blob from the operator's Blossom store | Anyone who has the hash, on the public host and its onion front, until reads end on 23 October 2026 (pending, 9.3). Only `application/vnd.forgesworn.encrypted` was accepted; the store never saw the plaintext or its type | `deploy/blossom.yml`; `deploy/Caddyfile.kithmoot:216-218`, `:389-412` |
| Get a meeting code, or resolve one | Nobody since 22 October 2026: the service is stopped and `/codes` answers 410 (the host's report; the Caddy file and the web app still name it) | `deploy/Caddyfile.kithmoot:158-163`; `app/src/main.ts:2091`; 9.3 |
| Write to the relay the operator also runs | Only keys on its allowlist, since 10:58Z on 22 October 2026 (the host's report) | 9.3 |

### 2.3 Things that lower risk

- **End-to-end encryption everywhere it matters**, described above. For
  rooms it does not keep, the operator has no plaintext to review,
  mis-serve or leak. For a room it keeps, it holds the key (2.1).
- **No content discovery.** There is no feed, search, trending list or
  recommendation surface. A person reaches a room, a file, or a relay
  event only by already holding a link or a hash. This removes most of the
  amplification mechanics Ofcom's guidance treats as raising risk (a
  content recommender system, a search function, hyperlinking within the
  service).
- **Rooms are closed by default.** Admission needs the link (its capability
  is never sent to a server) or, for a kept room, a keeper's admission
  decision. There is no public room directory.
- **The operator stores no new files.** Its Blossom store takes no
  uploads from 22 October 2026 and serves none after 23 October 2026
  (pending). While it serves, it holds only the sealed envelope type
  `application/vnd.forgesworn.encrypted`, opaque bytes under a key the
  store never sees, so it cannot be hot-linked as media.
  <!-- deploy/blossom.yml; deploy/README.md: "An image, a video or a page is refused, so this is not a general file host and nothing on it can be hot-linked as media" -->
- **Files are sealed on the device and sent elsewhere.** What the app
  uploads is encrypted and padded on the device before it leaves, and goes
  to a server somebody else runs, named in a one-time notice. That server
  is a general file host, and what it holds from other people is its own
  operator's service, not a surface the operator provides (8.3, `[U]`).
  <!-- packages/context/src/blossom.ts paddedPlaintextLength; app/src/file-storage.ts -->
- **Bounded, expiring storage.** The drop tier, while it took mail from
  outside: 1 GiB, oldest-out, 30-day maximum age, per-connection rate
  limits; what it held ages out within 30 days of 21 October 2026.
- **Strangers cannot write to the relay the operator also runs**, since
  22 October 2026 (9.3).
- **TURN's relay target is fenced.** coturn denies relaying to private,
  loopback, link-local and reserved address ranges, so a minted credential
  cannot be used to probe the operator's own private network, for as long
  as TURN stays open (9.3).
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
3. **The open TURN credential endpoint has no removal path**, by design,
   until it closes (9.3). It is unauthenticated; see its own file header
   for the operator's acknowledgement of this ("none of that is a
   substitute for real access control, and it is a deliberate, documented
   trade"). The drop tier, which keeps no index of a wrap's recipient,
   sender or id and so allows no targeted removal, has not been reachable
   from outside since 21 October 2026.
4. **Group messaging, at scale, on a service with no membership review.**
   A "kith" or "kin" tier room can hold many members; nothing here vets
   who joins beyond holding the link.
5. **File sharing is a default of the apps**, through a general file host
   somebody else runs. KithMoot's own uploads there are sealed, but that
   host serves viewable media from anybody, under its own operator's rules
   (8.3). The operator's own store took only sealed envelopes and serves
   nothing after 23 October 2026 (pending).
6. **A relay the operator also runs, no longer a default.** The relays
   the app suggests by default are independent public relays. Until
   September 2026 one of the three defaults was a relay the operator runs,
   and room links written before then still name it. On that relay, and
   only that one, the operator has relay-operator-level control (it can
   refuse to store or serve particular events); on the default relays, and
   on any relay a room's creator adds instead, the operator has no control
   at all. Since 22 October 2026 that relay takes writes only from keys on
   its allowlist. This record does not name that relay's address.
7. **No content the operator can review exists for any of this**, by
   design, except in a room the operator keeps (section 2.1). Outside such
   rooms, "swift takedown of illegal content" as Ofcom's Codes measures
   describe it cannot mean removing a message's *content* here. It can
   only mean acting on metadata: refusing a hash, blocking a pubkey where
   the software supports it, taking a room or credential endpoint offline,
   or referring a report to the police. See
   `docs/legal/report-handling.md`.
8. **A room the operator keeps is readable by the operator.** That is a
   control as well as a risk: in such a room the operator can see what is
   reported and remove a member. It is also a store of readable content
   on a machine the operator runs, and a key it can be required to
   disclose (2.1).

## 3. Step 1: Ofcom's Risk Profile

Outcome of the U2U Risk Profile questionnaire, as it applies to KithMoot's
own default, operator-run surfaces (a self-hosted keeper's own box is that
keeper's own operation, not covered by this record; a keeper the operator
runs is the operator's, and is covered).

| Risk factor | Applies? | Why |
| --- | --- | --- |
| 1e Discussion forums and chat rooms | **Yes** | A room is exactly this |
| 1g File-storage and file-sharing service | **Partly, ending** | The operator's store takes no uploads and serves its sealed envelopes only until 23 October 2026 (pending). The apps' default file server is somebody else's general file host (8.3) |
| 2 Child users | **Possible, unproven either way** | No age check anywhere; see the children's access assessment |
| 3b Anonymous user profiles, or users without accounts | **Yes** | The normal case, not an exception |
| 4b User groups | **Yes** | Rooms with several members |
| 5a Group messaging | **Yes** | As above |
| 5c Direct messaging | **Yes** | A room of two ("a word in private") |
| 5d Encrypted messaging | **Yes** | End to end, by design |
| 5f Posting images or videos | **Within a room only** | A member can send an image or video to a room; it is sealed on the device and only the room's members can open it. Nothing the operator runs serves viewable media |
| 7a Content searching | No | No search across other people's content; search is local to a room a member already has |
| 8a Content recommender systems | No | None exist |
| User base | `[INPUT: how many people use KithMoot, and roughly where.]` | |
| Business model | No advertising. Nothing in the default service takes payment. The repository holds a kit for a separately hosted, paid TURN endpoint and a donor ring that ships switched off (row 11 in section 4) | `[INPUT: whether either is switched on anywhere.]` |
| Commercial profile | Small; `[INPUT: operator capacity for moderation]` | |

**Multi-risk factors present:** encrypted messaging, anonymous users,
group messaging, direct messaging and no age assurance are all present at
once. Ofcom's guidance treats this combination as a materially higher-risk
shape even where the service is small, because several of the factors that
usually let a provider detect and act on harm (visible content, identity,
account history) are absent simultaneously and by design. Visible content
is the exception in a room the operator keeps (2.1).

## 4. Step 2: risk levels

Ofcom's scale: negligible, low, medium, high. Impact reflects the severity
of the harm to a person; likelihood reflects this service's actual design.

| # | Kind of priority illegal content | Level | Reasoning |
| --- | --- | --- | --- |
| 1 | Terrorism | Low | Nothing here can be viewed or found by anyone but a room's own members; a room cannot be discovered, browsed or recommended. The drop tier and the relay we run carry unreadable ciphertext only |
| 2 | CSEA: grooming | **Medium** | Private, encrypted, one-to-one and small-group messaging with anonymous, throwaway identity by default is close to the shape Ofcom's guidance treats as the clearest grooming risk. What lowers it from higher: KithMoot is invitation-based, not a public discovery surface a stranger can use to find and approach a child with no prior link at all; there is no public profile browsing or "people near you" feature |
| 2 | CSEA: image-based CSAM | Low, provisional | Nothing the operator runs serves a viewable file (2.3): its store takes no uploads and serves only sealed envelopes, until 23 October 2026 (pending). Files a member sends go sealed to a server somebody else runs, readable only by the room's members. The risk inside a room is exchange between members who already share its link, which the operator cannot see outside a room it keeps (2.1) |
| 3 | Hate | Low | No public or discoverable surface for it to reach beyond a room's own members |
| 4 | Harassment, stalking, threats and abuse | **Medium** | Direct messaging plus anonymous, throwaway identity plus no admin action available within a room (see 6.1) is a real route to sustained one-to-one harassment, made harder to escalate because there is no persistent account to block system-wide, only a room to leave |
| 5 | Controlling or coercive behaviour | Low | Same shape as 4, but this Act priority mainly concerns targeted, sustained relationships, which is harder to sustain through a per-device, per-room identity that does not follow a person between rooms |
| 6 | Intimate image abuse | Low, provisional | As image-based CSAM (row 2) |
| 7 | Extreme pornography | Low, provisional | As above |
| 11 | Fraud and financial services offences | Low | No marketplace, and nothing in the default service takes payment. Two payment-related pieces exist in the repository. `deploy/l402/` is a kit for a second, separately hosted TURN endpoint that charges a keeper, never a participant, a few satoshis per credential; its client, `src/node/l402.ts`, is imported by nothing outside its own tests. `src/donations.ts` sums public zap receipts to draw a ring on a profile picture; it takes no payment, and the app ships it switched off, because its recipient key is empty. `[INPUT: whether the paid TURN endpoint or the donor ring is switched on anywhere.]` If either is, revisit this row and the law note's section 8 <!-- deploy/l402/README.md, "What this does not change" and "Who pays"; src/node/l402.ts has no importer outside its test; app/src/main.ts:847 DONATION_ADDRESS is set, app/src/main.ts:855 DONATION_RECIPIENT = '', and both are required --> |
| 15 | Suicide and self-harm | Low | Text and voice/video calls between room members only; no public or broadcast surface |
| 18 | Cyberflashing | Low | No unsolicited image delivery mechanism to a stranger; a person only receives what a room they joined sends, and there is no directory to find a stranger through |
| n/a | Abuse of the unauthenticated `/turn` endpoint for purposes unrelated to illegal *content* (bandwidth theft, using the box as a relay, denial of service) | Low as an illegal-content matter, but an operational and cost risk until `/turn` closes (9.3) | Out of scope for this content risk assessment; tracked as an infrastructure risk |

**Outcome:** grooming and harassment/abuse are the two kinds this
assessment rates medium. Both trace to the same root cause: private,
anonymous, group-capable messaging with no in-room way to remove a person
or a message, and no persistent identity to act against across rooms. Every
other kind is low, mainly because KithMoot has no discovery, search or
recommendation surface for anyone to find content through, and nothing the
operator runs serves viewable media.

**Effect of narrowing the "cannot read" claim.** No level above rests on the
operator being unable to read a room: the low levels rest on the absence of
discovery and on what the file store accepts, and the two medium levels on
anonymous, private messaging. In a room the operator keeps, content is
visible to the operator and a member can be removed, which makes detection
and action possible there and weakens the "absent by design" point in
section 3 for those rooms only. On this evidence no level changes; all
remain provisional for the owner.

## 5. Existing controls and how they changed the levels

- **No content discovery surface** is the single biggest reason most
  kinds sit at low rather than medium: nothing here can be found, only
  reached by a link a member already has.
- **No file store of the operator's takes uploads**, and its store serves
  nothing after 23 October 2026; with sealing on the device, this is why
  image-based and video-based harms sit at low.
- **The drop tier is closed to outside traffic**, and what it held ages
  out within 30 days.
- **coturn's peer-address denylist**, while TURN stays open, limits the concrete abuse a minted
  TURN credential can do to this operator's own infrastructure; it does
  not add any content moderation capability.

## 6. Step 3: measures

### 6.1 Codes measures that apply to every service, and their state

| Measure | What it asks | State today | Action |
| --- | --- | --- | --- |
| ICU A2 | A named person (role) accountable for illegal content and for reporting and complaints | None named | `[DECISION]`: name a role |
| ICU C1/C2 | A content moderation function; swift takedown of illegal content | No content exists to moderate (E2EE); metadata-level actions exist per surface, unevenly (`docs/legal/report-handling.md`) | Confirm and communicate the honest limit: this is a metadata-and-referral function, not a content-review function |
| ICU D1/D2 | Let users and affected people report content and complain, in a way that is easy to find and use | The `abuse@safety.forgesworn.dev` mailbox (set up 25 September 2026, `docs/legal/README.md`) and the `/report/` page (`site/report/index.html`); neither needs an account | `[OWNER TO DO: send the mailbox a test message and confirm reports are read.]` |
| ICU D7 | Act on complaints about suspected illegal content | Not yet written down | `docs/legal/report-handling.md` |
| ICU G1/G3 | Terms say, clearly, how people are protected from illegal content | Drafted (`docs/legal/terms-draft.md`) and shown on the site as a draft (`site/terms/index.html`); not yet adopted | Adopt with this record |
| ICU H1 | Remove accounts of proscribed organisations | No accounts exist to remove in the ordinary sense (per-device, per-room keys); a room or link can be shut down | Add to the report-handling runbook |
| Section 66 (law note 2.6) | Report child sexual exploitation and abuse content the service becomes aware of to the National Crime Agency, in force 7 April 2026 `[P]` | Written up in the report-handling runbook, section 6, with registration left as a decision there (6.1) | `docs/legal/report-handling.md` |

The duty to report child sexual exploitation and abuse content to the
National Crime Agency applies to this service whatever its size (law note
[2.6](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md), `[P]`); it does not require the service to detect or scan for
anything. `docs/legal/report-handling.md` sets out how the operator does it.

### 6.2 Measures worth building, in priority order

1. **A working, well-publicised report route that needs no account and no
   room membership**: the `/report/` page and the `abuse@` mailbox. Both
   exist (6.1); what is left is confirming that reports are read.
2. **An operator-side way to stop serving a specific Blossom hash.**
   Settled by D5: the store serves nothing after 23 October 2026, so no
   override is to be built. Until then, removal is the manual host-level
   action in `docs/legal/report-handling.md`, section 3.2. Revisit only if
   the operator opens a store again.
3. **The drop tier's absence of an id or pubkey index.** Settled by the
   route's removal on 21 October 2026: the tier takes nothing from outside
   the box, so the limit no longer bears on a public surface. Revisit only
   if the tier is fronted again.
4. **A published policy for shutting down abuse of `/turn`** at the
   network level (IP block, rate-limit tightening, or taking the endpoint
   down) when a report cannot be acted on any other way. Settled by D2:
   `/turn` closes (9.3); until then, `docs/legal/report-handling.md`,
   section 3.1, is the policy.
5. **Terms language that says plainly what the operator can and cannot
   see and do**, so a reporter's expectations match reality (this is also
   a User Rights / transparency point, not only a safety one).

## 7. Step 4: report, review and update

- **Report:** the named role signs this record, and the operator approves
  it.
- **Keep:** this file, in version control, dated. Keep earlier versions for
  at least three years.
- **Review:** at least once a year, and before any significant change to
  default surfaces: opening a new default service, changing the default
  file server, opening any store, relay or drop tier of the operator's to
  outside traffic, or the closures pending in 9.3 landing.

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
| The apps (web, desktop, Android) | Publisher with defaults that point only at servers other people run: three public relays, and one default public file server | No app-wide default names a ForgeSworn server. Today the web app asks its own origin for `/turn` and for meeting codes, and Android pre-fills ForgeSworn's file store and names ForgeSworn's host for STUN and TURN |
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
relay.primal.net, nostr.oxtr.dev and relay.ditto.pub. ForgeSworn chose them and controls
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

**The default public file server (22 October 2026).** In the web app, and
the desktop app that loads it, files go by default to
blossom.yakihonne.com, run by Yakihonne LLC, a Wyoming company in the
United States. The first time a device sends a file, a notice names the
server and what it sees; pressing Send uploads the file and records the
choice on that device. Settings › Privacy › Where files go offers another
server, the person's own, or Nowhere. This is now a default in the full
sense, so 2.2's middle reading is the one in play `[U]`: ForgeSworn chose
the default and controls nobody's admission to it; Yakihonne controls who
can use its server and is its provider (section 226 `[P]`). What the
reading still owes is the privacy notice's account of the recipient and
what it learns (law note 3.2 `[P]`), which `privacy-notice-draft.md`
section 8 gives.
<!-- app/src/file-storage.ts PUBLIC_FILE_SERVERS, defaultFileServer, resolveFileDestination, acceptDefaultFileServer; app/src/main.ts fileNoticeBody; app/index.html #fileWhere; desktop/policy.mjs HOME. Location from https://yakihonne.com/terms, "Last updated: July 15, 2026", fetched 22 October 2026. -->

Why this server: it has a named operator, published terms, and a round
trip that passed on 20 October 2026: an encrypted upload, a fetch by hash
from the app's origin, and a delete. Servers that named no operator or
published no terms were left out. The code forbids any ForgeSworn host as
a default or a choice, and a self-hoster's build can set its own default
with `VITE_KITHMOOT_FILE_SERVER`. A choice given to the default names that
server, so a later change of default shows the notice again.

What does not carry across from ForgeSworn's store: the rule in 2.3 that a
store accepts only the sealed envelope type, and the reasoning in 2.4 and 4
that rests on it (risk factor 1g; rows 2 image-based CSAM, 6 and 7). The
default server's own status page, read on 22 October 2026, lists accepted
types `text/* image/* video/* model/* *` with media optimisation on: it is
a general file host. What KithMoot uploads is sealed and padded on the
device, so KithMoot's own uploads stay unreadable there, but the server
would serve viewable media uploaded by anyone; that is Yakihonne's
service, not a surface ForgeSworn provides `[U]`.
<!-- packages/context/src/blossom.ts paddedPlaintextLength; https://blossom.yakihonne.com/ "Accepted types" -->

`[DECISION: whether pressing Send after the one-time notice is the act of
choice the owner relies on ("Send is the act").]`
`[DECISION: how often the default server is checked again, and what removes
it from the list.]`

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
  names, domains and boxes. Decided 22 October 2026 (D4, revised the same
  day): the owner's private host serves only the people working on the
  project, volunteers included, under the internal business reading above.
  The weekly chat is part of that work (building, testing and running
  KithMoot), not a social group, and nobody who is not working on the
  project is admitted (9.2). `[LEGAL REVIEW: whether an unpaid open-source
  project meets the "business" and "internal resource or tool" limbs.]`
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
on 21 October 2026 with that go (8.5, step 1). The state on 22 October 2026
is in 9.3.

| Surface | State on 20 October 2026 |
| --- | --- |
| TURN credentials, `GET /turn` | An anonymous request got working TURN credentials |
| Drop tier, `wss://kithmoot.forgesworn.dev/drops` | On (`BOTHY_DROPS_ENABLED=true`), and served a stored kind 1059 wrap to an anonymous query. It was switched off on 9 September 2026 pending the agreement of the drop tier software's joint maintainer; who switched it back on is not known. No app default names it. **21 October 2026:** no longer fronted. The `/drops` route was removed from the Caddy file and a WebSocket upgrade to it gets 404 from outside. The tier still runs on the box's loopback, reachable only from the box, because the box's cadence work will not start without it, and the box no longer advertises its address |
| Blossom file store | Uploads accepted from any key with a signed BUD-01 authorisation; reads by hash open to anyone; a read-only onion front serves the same store. **22 October 2026, from the host's report:** uploads switched off at 09:42Z with the owner's go; PUT, HEAD and OPTIONS on `/upload` answer 410. Reads by hash and owners' deletes still work. Not checked by the drafter, and the repository's Caddy file has not caught up |
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

On branch `design/files-public-first`, not merged: the public server becomes
the web default behind a one-time notice, and a saved choice naming any
ForgeSworn host is removed (8.3). Android was not checked for this change.

### 8.5 The switch-off order

From the plan's section 10. Before each step, a client release removes the
matching default, and the app tells people. The notice comes first; the
route goes after.

| Step | Notice first | Then | Plan's end state | Owner's end state |
| --- | --- | --- | --- | --- |
| 0 | None | Verify each surface (done on 20 October 2026 except the keepers' rooms and the Link relay) | | |
| 1. Drop tier | Release note | Switch the tier off; remove the `/drops` route. Held wraps age out within 30 days. **Route removed 21 October 2026**; the tier stays on loopback while the box's cadence work needs it | Removed | Removed |
| 2. New Blossom uploads | On the file picker: ForgeSworn's shared storage has closed to new files; set up the group's own storage or send files directly. Gives the read-window date (step 5) | Web and Android releases with no pre-filled ForgeSworn server; then remove the upload route; stop archive enrolment. **Upload route answering 410 from 22 October 2026** (host's report). The web release that names no ForgeSworn host is on `design/files-public-first`; its notice says "KithMoot no longer sends files to ForgeSworn's storage." and gives no read-window date | Removed | `[DECISION: a closed store for the owner's rooms behind grants (S2 to S4), or none]` |
| 3. Meeting codes | "Meeting codes are going. Share the room link instead." | Refuse new codes; let live codes run out (at most 7 days); keep the 30-day tombstones; then remove the route and service. **Service stopped and `/codes` answering 410 from 22 October 2026** (9.3) | Removed (D6) | Retired, 22 October 2026 |
| 4. Open `/turn` mint | In a call with no relay: "Some calls need a relay. Your group has none, so this call may not connect on some networks." | Clients take ICE servers from the room or group only; then remove `/turn` and the KithMoot credential service. coturn stays, with its separate secret, for the owner's own Wildbloom direct send | Removed | `[DECISION: TURN for the owner's rooms through a grant-checked issuer the room carries (plan S9), or none]` |
| 5. Blossom reads | Announced at step 2 and repeated: "Files shared before <date> will disappear on <date>. Save any you want to keep." | **Owner, 22 October 2026: reads and the onion front end on 23 October 2026, replacing the 90-day window below (9.3).** After the read window (D4: a fixed window from the stop date; 90 days matches the store's rule), remove the blob route, the onion front, the service and its store; retire the archive nodes (D5) | Removed | Removed for files other people sent. `[DECISION: whether a closed store for the owner's rooms replaces it]` |
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
- Until the web release, the live web app still suggests ForgeSworn's store,
  whose upload route has answered 410 since 22 October 2026 (8.4), so an
  upload there fails.
  Until kithmoot-android PR #295 is released, Android still pre-fills it and
  names ForgeSworn's host for STUN and TURN.
- The report route, `abuse@safety.forgesworn.dev` and the `/report/` page,
  stays.

### 8.7 Statements in sections 1 to 7 that this section corrects

Left in place so the record shows what was assessed. On 22 October 2026
each correction below was made in sections 1 to 7; the keeper exception is
in 2.1, and the meeting code exception is recorded as retired.

- **"The operator cannot read messages, files or calls on any room"
  (2.1).** Not true of a room whose keeper the operator runs, or a room
  whose meeting code was made without a password, while the code lives
  (8.2).
- **"The default drop tier" (record details, 2.2, 2.3, 2.4).** No app names
  the drop tier. It is open infrastructure the operator runs, not a default
  of the apps. It is still a surface the operator provides.
- **Meeting codes are missing.** Sections 2 to 4 did not cover `/codes`.
  Retired on 22 October 2026 under step 3, and recorded in 2.2 (9.3).
- **"The default Blossom store".** From the web release after 20 October
  2026 it is no longer the web app's suggestion. It stays Android's until PR
  #295 is released. From 22 October 2026 it takes no new uploads (8.4).
- **"Uploads are off by default" and "opt-in per person" (2.2, 2.3, row 18
  in 4).** From the `design/files-public-first` release, files go to the
  default public server after a one-time notice at Send. The rows that
  relied on an off-by-default switch are to be revised with the rest.
- **The envelope rule as a reason for low levels (2.3, 1g in 3, rows 2, 6
  and 7 in 4, 5).** True of ForgeSworn's store only. The default server is a
  general file host run by somebody else (8.3).

### 8.8 Decisions and sign-off

Open in this section on 22 October 2026: the decision markers in 8.3 on
the default file server (two) and in 8.5 on stores and TURN for the
owner's rooms (three), the legal review marker on the provider limb of
paragraph 7, and the input markers on the keepers' rooms and the launch
date. The decisions on family and friends and on meeting codes, and the
owner's to-do on meeting codes, were closed on 22 October 2026 (section
9).

| Item | Entry |
| --- | --- |
| Change recorded | Planned position and switch-off order, 20 and 21 October 2026 |
| Drafted by | An AI assistant, from the code at `d7571f69` and the owner's checks of 20 October 2026 |
| Reviewed by | `[name]` |
| Approved by | `[Operator]` |
| Date signed | `[date signed]` |

## 9. Significant change, 22 October 2026

> **Draft, 22 October 2026.** Drafted by an AI assistant from the code at
> `edf32cd0` on `main`, the owner's decisions of 22 October 2026, and the
> report of the session that runs the box, the same day. Not legal advice;
> no lawyer has read it. Law note verified 28 September 2026; its marks are
> kept. Where this section says the repository has not caught up, the
> live state rests on the host's report and was not checked by the drafter.

### 9.1 Why this is recorded

Ofcom recommends reviewing this assessment before any significant change
(law note 2.3, `[P]`). On 22 October 2026 the owner decided that ForgeSworn
is to be outside the Online Safety Act always, and several surfaces in 8.4
closed or were given a closing date. This section records what changed,
what is still open, and what is pending. Nothing pending is presented as
done.

### 9.2 Position

**Today: a public operator.** On 22 October 2026 `GET /turn` still answers
200 and mints a working TURN credential for anyone, coturn answers TURN and
STUN for anyone, and the file store still serves reads by hash, on the
public host and through its read-only onion front. One open endpoint is
enough for this position (8.2).
<!-- deploy/Caddyfile.kithmoot:131-132 handle /turn; app/src/main.ts:815 TURN_CREDENTIAL_ENDPOINT = '/turn'; deploy/Caddyfile.kithmoot:216-218 blob reads; deploy/Caddyfile.kithmoot:389-412 onion front. /turn answering 200 on 22 October 2026: the host's check, confirmed to the drafting session -->

**Aimed at, as the owner decided on 22 October 2026:**

| Deployment | Position aimed at | What the move still takes |
| --- | --- | --- |
| The apps and the public host | Publisher with defaults that point at servers other people run, plus ForgeSworn's own STUN (D1) | Close `/turn`, its credential service and the TLS listener on 5349 (pending, 9.3); end file reads and the onion front (23 October 2026, pending); remove the `/turn` default and the meeting code client from the app (`app/src/main.ts:815`, `app/src/main.ts:2091`); bring `deploy/Caddyfile.kithmoot` into line with the live box |
| The relay ForgeSworn also runs | Closed: the owner's own relay | Done for writes (9.3). Reads: decided 22 October 2026 that every request, for every kind, needs relay authentication (NIP-42) from an allowlisted key, with only the relay information document left public. Pending: the change on each relay-like endpoint ForgeSworn runs. A closed service should have no endpoint that serves content to whoever finds it (law note 2.10, `[U]`) |
| The owner's private host (D4) | Closed: the people working on the project, volunteers included (law note 2.10, Schedule 1 paragraph 7 `[P]`) | Admit nobody who is not working on the project. That host is not described in this record and is not one of the surfaces it covers |

**STUN kept (D1).** After TURN closes, the app still asks the host that
served it for STUN on port 3478, and coturn answers anyone. STUN tells a
device its own public address; it carries no user's content to anybody
else. The law note does not say whether a server that carries no content
between users, such as STUN, bears on the user-to-user position (not
covered; not checked). It is still processing of IP addresses, which the
privacy notice describes (section 4.1 there).
<!-- src/ice-defaults.ts:137-140 originStunGuess returns stun:<host>:3478 for an https origin; src/ice-defaults.ts:93 stunFromTurnUrl; deploy/coturn/turnserver.conf:17 listening-port=3478, no no-stun -->
`[LEGAL REVIEW: whether answering STUN for anyone who loads the app keeps
ForgeSworn a provider of anything under the Act, given that STUN carries no
content between users.]`

### 9.3 State of each surface on 22 October 2026

| Surface | State | Done or pending |
| --- | --- | --- |
| Meeting codes, `/codes` | Answers 410; the meeting code service is stopped and disabled. The repository has not caught up: the Caddy file still proxies `/codes` and the web app still calls it | Done on the box (host's report). `[INPUT: whether the stored invitation links and the 30-day tombstones were deleted.]` <!-- deploy/Caddyfile.kithmoot:158-163; app/src/main.ts:2091 --> |
| File store uploads, `/upload` | Answer 410 since 09:42Z | Done on the box (host's report, 8.4) |
| File store reads by hash, and the onion front | Still served | **Pending:** end on Friday 23 October 2026 (owner, D5). This replaces the 90-day read window in 8.5, step 5. Once reads end, a file card in the web app reads "This file is no longer on" the host <!-- app/src/attachment-card.ts:79 --> |
| TURN credentials, `GET /turn`, and TURN relaying | Open: answers 200 and mints credentials | **Pending:** `/turn` and its credential service close once Android 0.6.103 and web PR #525 are both live; then coturn serves STUN only and 5349 closes. D2: no TURN on the public app |
| coturn's log | No log kept since about 10:30Z. The repository has not caught up: `deploy/coturn/turnserver.conf:214` still logs to stdout, kept by the container's json-file driver (`deploy/coturn/docker-compose.yml:55-59`) | Done on the box (host's report) |
| STUN on 3478 | Open to anyone, kept (D1) | Stays |
| Drop tier, `/drops` | Route removed 21 October 2026; the tier runs on the box's loopback only | Done (8.4) |
| The relay ForgeSworn also runs | Kept as the owner's own closed relay. Writes allowlist-only since 10:58Z; strangers' data and old backups purged. A key not on the allowlist can no longer post to it from an old room link | Done for writes (host's report). Reads: see the input marker in 9.2 |
| Keepers on the box | Last checked 20 October 2026: two instances, crash-looping (8.4) | `[INPUT: whose rooms they serve, and whether they are to keep running.]` |

### 9.4 What this changes in sections 1 to 8

- **Meeting codes** are retired, so the second exception to "cannot read"
  (8.2, 8.7) applies only to links stored before the service stopped, and
  only if they were kept (the input marker in 9.3). The owner's to-do in
  8.7 and the decision in 8.5, step 3 are closed by retirement.
- **The family and friends decision in 8.3** is closed by D4: the
  owner's private host serves only the people working on the project, so
  the unchecked family-and-friends row no longer applies to it.
- **File reads.** From 23 October 2026, the rows that rest on ForgeSworn's
  store (risk factor 1g in 3; rows 2, 6 and 7 in 4; the removal measures in
  6.2, items 2 and 3) describe a store that no longer serves anything.
  Until then they stand.
- **TURN.** Every mention of `/turn` in sections 2 to 6 stands until the
  pending closure lands, and is to be revised then.
- **coturn's log.** The privacy notice's account of coturn's log is
  corrected (its section 4.1).

### 9.5 Sign-off

| Item | Entry |
| --- | --- |
| Change recorded | Owner's decisions and surface states of 22 October 2026 |
| Drafted by | An AI assistant, from the code at `edf32cd0` and the host's report of 22 October 2026 |
| Reviewed by | `[name]` |
| Approved by | `[Operator]` |
| Date signed | `[date signed]` |

## Decisions for the owner

1. The named role accountable (ICU A2).
2. Whether to build any operator-side removal capability beyond what the
   underlying software already exposes (section 6.2, items 2 and 3).
3. Confirm the `abuse@safety.forgesworn.dev` mailbox exists and is monitored
   before relying on this record or the terms that reference it.
4. The decisions and sign-off for the change in progress (section 8.8),
   and for the change of 22 October 2026 (section 9.5).

Still to do: the evidence marked `[INPUT]`.
