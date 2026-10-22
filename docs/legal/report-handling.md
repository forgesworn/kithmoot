# Report handling runbook

> **DRAFT for legal review, 25 September 2026.** The operator's own runbook
> for acting on a notice of illegal content or abuse connected with
> KithMoot. Checked against the code on `main`. Where a removal capability
> does not exist, this says so plainly and does not promise it in the
> terms or elsewhere. **This is not legal advice.**
>
> Changed 21 October 2026: notes in sections 2 and 3.2, pending a revision
> (risk assessment, section 8).
>
> Changed 22 October 2026, from the code at `243af551` on
> `design/files-public-first`: our file store takes no new uploads (3.2),
> and files from the app go by default to a server we do not run (3.6).
>
> Changed 22 October 2026, from the code at `edf32cd0` on `main`: the
> corrections of 28 September 2026 that still hold are carried in. Child
> sexual abuse content goes to the NCA's Industry Reporting Portal under
> the statutory timing (sections 4 to 6), the abuse mailbox is recorded as
> existing (1), and a room we keep is named as the exception to what we can
> see (2).
>
> Changed 22 October 2026, later: meeting codes stopped (2), TURN closing
> (3.1), file reads ending 23 October 2026 (3.2), and the relay we also run
> taking writes only from allowed keys (3.4). Pending changes are marked
> as pending.

## 1. How a notice arrives

- **Email: `abuse@safety.forgesworn.dev`.** The mailbox exists (email
  routing to the owner's inbox, set up 25 September 2026; see
  `docs/legal/README.md`). `[OWNER TO DO: send it a test message and confirm
  reports sent to it are read, before this runbook, the terms or the privacy
  notice can be relied on.]`
- **The `/report/` page** (`site/report/index.html`, this PR), which tells
  someone what to send and to that same address. It needs no account.
- There is no in-app button for this, because there is no in-app content
  the operator can see to attach one to (section 2). Building a
  "flag this message" control would need either breaking end-to-end
  encryption for flagged content, or the control submitting only metadata
  the person types by hand -- which is exactly what the email route and
  `/report/` page already do, more flexibly, without adding attack
  surface to the app itself.

## 2. What we can act on

**We cannot see room content, except in a room we keep.** Chat, files and
calls are end-to-end encrypted; nothing served by our default
infrastructure is readable without the room's own key
(`docs/legal/online-safety-risk-assessment-draft.md`, section 2.1). For a
room we do not keep, a notice to us is therefore always **metadata plus the
sender's own account of what happened**, never content we can
independently view to verify.

A keeper we run for a room holds that room's key, because it created the
room, so we are a member of that room and can see it. That does not change
the rule in section 6 against viewing reported material.
<!-- deploy/keeper@.service:13 -->

*Note, 21 and 22 October 2026.* The meeting code service stored the full
invitation link for a code made without a password, which was the other
exception. It was stopped and disabled on 22 October 2026, and `/codes`
answers 410 (the host's report).
<!-- deploy/README.md "Meeting codes" -->

Ask the sender for, and act on:

- **A room link**, if they can share one. We cannot decrypt it, but it
  identifies which relay(s) and TURN server, if any, are involved, and
  whether our default infrastructure is in the path at all.
- **An event id**, if they have one (visible to a technical user through
  their own client or a relay's own tooling). Relevant to the relay
  we operate (section 3.4).
- **A file hash or file link**, if the notice concerns a shared file. The
  link's host says whose server it is on: our store (section 3.2) or a
  server somebody else runs (section 3.6).
- **A description of what happened and why it is illegal or against the
  terms.**
- **Whether it involves a child**, so it is routed correctly (section 6).

## 3. What we can actually do, surface by surface

This section states the **verified** technical capability of each piece
of software this project deploys by default, not what would be convenient.
Anything not verified is marked as unverified rather than assumed.

### 3.1 The default TURN server (`/turn`, coturn)

**Delete/block by id:** not applicable; TURN carries live call media, not
stored content.

**Block a pubkey:** not applicable; TURN credentials carry no identity, by
design -- they are HMAC-derived, time-limited, and the label attached to
one is random, never tied to a person (`server/turn-credentials.mjs`,
`mintName`).

**What we can do:** take `/turn` offline entirely (stops all calls using
our default TURN, not just an abusive one), or block a source IP address
at the network or Caddy level. Neither is targeted at a specific abuser
beyond their current IP.

**Closing.** On 22 October 2026 `/turn` is still open. It and its
credential service close once Android 0.6.103 and the matching web release
are both live (pending); after that coturn answers STUN only, which carries
no content, and this section has nothing left to act on.

### 3.2 Our file store (Blossom, `blossom-server-ts` 5.2.0)

**No new uploads from 22 October 2026.** The web app and the desktop app
no longer send files here, and the upload route answers 410 (host's
report, 22 October 2026, 09:42Z). Reads by hash and owners' deletes still
work until reads end on Friday 23 October 2026 (pending on 22 October), so
until then what follows still applies to files already stored.
<!-- app/src/file-storage.ts: no ForgeSworn host is ever a destination. deploy/Caddyfile.kithmoot in this tree still passes /upload and is not the live state. -->

**Delete by hash:** blossom-server-ts implements a `DELETE` route per
BUD-02, but it is **owner-authorised**: the request must be signed by the
key that uploaded the blob (or, per BUD-02, another key the store
recognises as an owner of it). This route is exposed only on loopback
(`127.0.0.1:8092`), never through Caddy to the public internet
(`deploy/README.md`, "Running a Blossom server": "list, delete, mirror,
the admin page and the landing page answer on loopback only").

**What this means in practice:** we cannot ask blossom-server-ts itself to
delete a reported blob unless we hold the uploading key (we do not, and
should not, since device keys are per-device and never given to us).
`deploy/blossom.yml` sets no admin pubkey, so no override is configured;
whether the pinned version supports one was not checked, and with reads
ending on 23 October 2026 (D5) it need not be.

**What we can actually do today:** because the operator controls the box
the blob is stored on, we can manually remove the blob's file from
`${BLOSSOM_STATE}/blobs` and its row from the sqlite metadata database
directly, on the host, outside the server's own API. This is a **manual
operator action, not a supported feature of the deployed software**, and
should be logged as such (section 5) precisely because it bypasses the
server's own authorisation model.

*Note, 21 October 2026.* This applies only to the store we run. A file on
a public server the app uses by default, or on one a person names, is on a
server we do not operate (section 3.6).
<!-- app/src/file-storage.ts PUBLIC_FILE_SERVERS -->

**Block a pubkey from future uploads:** not needed. Since 09:42Z on 22
October 2026 the upload route answers 410 to everybody (the host's report).
`deploy/blossom.yml` configures no pubkey allowlist or denylist.

**Gap, stated for the terms and the risk assessment:** until reads end on
23 October 2026, operator-initiated removal of a specific file relies on
the manual host-level action above, not on a feature of the deployed
store. No supported removal path is to be built, because the store is
closing (D5; risk assessment, 6.2, item 2). Revisit if a store of ours
reopens.

### 3.3 The default drop tier (`/drops`, bothy-node)

**Not reachable from outside since 21 October 2026.** The `/drops` route was
removed and the tier runs on the box's loopback only; what it held ages out
within 30 days. What follows applies only to wraps it took before then.
<!-- deploy/Caddyfile.kithmoot:166-172 "No /drops here" -->

**Delete by id, block a pubkey: not possible, by design, and this is a
verified, deliberate property of the software, not a gap that was merely
missed.** The tier's own documentation states it directly:

> "The database retains only that two-value ingress class, never a peer,
> address, key or recipient, so the rule survives restart without creating
> a contact log. The tier keeps no index of a wrap's `p` tag, so a `REQ`
> that picks by tag or author is `CLOSED` with the reason: the box holds
> no list of who receives mail here."

There is no sender, recipient or event-id index anywhere in the tier's
storage to query, let alone delete from. This is not an omission we can
fix with a config change: it is the tier's stated purpose, a dead-drop
that cannot itself become a contact log. **This means a single reported
gift wrap cannot be individually removed, and a specific pubkey cannot be
blocked from posting to the drop tier, by any means the deployed software
offers.**

**What we can actually do:** take the whole tier offline (`/drops` returns
nothing until re-enabled), which removes everything currently held, not
just the reported item, or reduce its retention bound (`drops.enabled`,
the size, age and rate settings) going forward. Neither is a targeted
response to one notice.

**This is the sharpest gap in the whole picture and must not be
misdescribed in the terms.** State it as what it is: an unauthenticated
surface with no targeted removal capability at all, covered only by an
untargeted "take it offline" option.

### 3.4 The relay we also run

The relay we operate (never named by hostname in these documents) is no
longer a default, but rooms whose links were written before September 2026
still name it. It runs strfry. We can delete a specific event by id with
`strfry delete --filter '{"ids":["<id>"]}'` on the host, which removes it
from what the relay stores and serves. From 10:58Z on 22 October 2026 the
relay takes writes only from keys on its allowlist, and other people's
data and its old backups were deleted (the host's report), so a key not on
the list cannot write to it at all. `[INPUT: whether it still serves reads
to anyone.]`

On the independent default relays, and on any relay a room's creator
adds instead, **we have no control of any kind.** A notice naming content
on a relay we do not operate can only be forwarded to that relay's own
abuse contact, if it has one, or answered with the fact that we cannot act
on it.

### 3.5 Self-hosted keepers and rooms

A room run by a self-hosted keeper, or using entirely third-party relays
and stores, is **outside this runbook and outside our control.** We can
say this plainly and, where we can identify who runs it, suggest the
sender contact that operator directly. We hold no list of self-hosted
deployments.

### 3.6 Files on a server somebody else runs

The web app, and the desktop app that loads it, send files by default to
blossom.yakihonne.com, run by Yakihonne LLC. A person may also choose
their own server. **We cannot delete, block or inspect anything on these
servers.** Only the device that uploaded a file, or the server's own
operator, can remove it. Tell the sender so, and point them to that
operator: for the default server, the contact in Yakihonne's published
terms (https://yakihonne.com/terms). What KithMoot uploads is encrypted
before it leaves the device, so the server's operator cannot read a
KithMoot file either.
<!-- app/src/file-storage.ts PUBLIC_FILE_SERVERS, defaultFileServer; app/src/blob-deletion.ts (BUD-02 delete by the uploading device's room key) -->

For suspected CSAM on such a server, section 6 applies unchanged: report
the file link to the NCA as section 6.2 sets out.

## 4. Timescales

`[DECISION: target response times. Suggested starting point, for the
owner to confirm:]`

- Acknowledge a notice: within 2 working days.
- A decision on what we can and cannot do, communicated back: within 5
  working days for our own default infrastructure; immediately, with an
  honest "we cannot act on this" and any onward referral, where the
  notice concerns a relay or store we do not operate.
- Suspected child sexual abuse content: none of the timescales above
  apply. The report to the NCA follows the statutory timing in section 6
  (immediately where a child faces an immediate threat), and any
  infrastructure action is taken as fast as it can be.

## 5. Record keeping

Keep, for each notice: the date, what was reported (room link, event id
or hash, as given), the sender's account of it, what we checked, what
action we took (or why none was possible), and who took it. Where an
action was a **manual, undocumented host-level intervention** (section
3.2), record that explicitly, since it bypasses the deployed software's
own authorisation and audit trail. `[DECISION: where this record is kept
and for how long. A reasonable starting point is at least three years,
matching the risk assessment's own record retention.]` A report to the
NCA carries its own statutory retention periods, set out in section 6.2.

## 6. Child sexual abuse material (CSAM)

**Do not view, download, copy, forward, store or otherwise handle
suspected CSAM beyond what is unavoidable to receive a notice of it.**
Possessing or distributing such material is itself an offence, and the law
note's guidance is not to view, copy or forward it to check a report
(marked `[U]` in the note).

A regulated user-to-user service must report child sexual exploitation and
abuse content it becomes aware of to the National Crime Agency (Online
Safety Act 2023, section 66, and SI 2026/268, in force 7 April 2026,
`[P]`); see [law note section 2.6](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md). The duty covers content we become
aware of however that happens, including a report sent to the abuse
mailbox. It does not require us to detect or scan for anything, and
nothing here asks us to.

### 6.1 Before any report arrives

The provider must register with the NCA before submitting its first report
(regulation 4). `[DECISION: whether to register with the NCA's Industry
Reporting Portal now, in advance, so that a first report is not delayed by
registration.]`

### 6.2 When a notice describes, or you otherwise encounter, suspected CSAM

1. **Do not attempt to verify it by viewing the material.** Act on the
   sender's description and any metadata (room link, event id, hash)
   alone.
2. **Report it to the NCA through its Industry Reporting Portal.** This is
   the statutory route for a provider. Timing (regulation 6):
   - **immediately** where a child faces an immediate threat;
   - **as soon as reasonably practicable** where there is a risk of serious
     harm;
   - otherwise **without undue delay**.

   If a child is in immediate danger, also call the police on 999.
3. **Report only what we actually hold, and nothing we have not checked
   is true.** Reporting false information is a criminal offence. A report
   is meant to include the detected content and its metadata, but outside
   a room we keep we cannot see room content, and we must not view such
   material to verify it. In practice what we hold is:
   - the reporter's own account, in their words;
   - a room link, if they gave one;
   - an event id, if they gave one;
   - a file hash, if they gave one;
   - whatever our own servers logged about that item (for example the
     stored, encrypted blob on our file store, or the event on the relay
     we operate), without opening or decrypting it.

   `[LEGAL REVIEW: what a report to the NCA should contain, and whether the
   duty is met, when the provider holds no readable content and cannot see
   the material without committing an offence; and whether a small UK
   operator with no existing NCA relationship should contact the NCA
   before its first report.]`
4. **Take the narrowest infrastructure action available** (section 3) to
   stop our default infrastructure continuing to relay or store the
   material, without inspecting it further than necessary to identify
   what to act on (a hash or event id given in the notice is normally
   enough). How this interacts with the retention in step 5 is an open
   legal question, marked there.
5. **Keep what the regulations require** (regulation 8): the NCA's report
   reference number for five years; the content, the information submitted
   and the user data for one year. `[LEGAL REVIEW: how "the content" is to
   be retained for a year when we hold only encrypted blobs or events we
   cannot read and must not copy or view, and whether removing an item
   under step 4 conflicts with that retention.]`
6. **Do not discuss the material's content** in any internal record beyond
   what is needed to identify it (a hash, an id, the sender's own words).
   Do not describe or reproduce it.
7. **Preserve, do not delete, our own metadata about the notice itself**
   (not the material) pending any request from the NCA, unless told
   otherwise by them.

### 6.3 What to tell a member of the public

CEOP and the Internet Watch Foundation are routes for the public, not the
provider's statutory route. When a member of the public reports child
abuse to us, tell them they can also report it directly:

- to **CEOP**, part of the NCA, for anyone, including a child, to report
  abuse or exploitation of a child: <https://www.ceop.police.uk/safety-centre/>;
- to the **Internet Watch Foundation**, for a URL or online location
  believed to host such material: <https://report.iwf.org.uk/>;
- to the police on 999 if a child is in immediate danger.

Tell them not to send the material itself to us.

This runbook deliberately does not describe how to examine, categorise or
triage the material itself. That is not this project's or this operator's
role; it is the NCA's.

## 7. Who does this

`[DECISION: name the role, matching ICU A2 in the illegal content risk
assessment. A role, not a name.]` Until named, `abuse@safety.forgesworn.dev`
should be monitored by whoever the owner designates, and this document
updated once it is.
