# Report handling runbook

> **DRAFT for legal review, 25 September 2026.** The operator's own runbook
> for acting on a notice of illegal content or abuse connected with
> KithMoot. Checked against the code on `main`. Where a removal capability
> does not exist, this says so plainly and does not promise it in the
> terms or elsewhere. **This is not legal advice.**

## 1. How a notice arrives

- **Email: `abuse@safety.forgesworn.dev`.** `[OWNER TO DO: create this mailbox
  before this runbook, the terms or the privacy notice can be relied on.
  Nothing in this repository creates it.]`
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

**We cannot see room content.** Chat, files and calls are end-to-end
encrypted; nothing served by our default infrastructure is readable
without the room's own key, which we never hold
(`docs/legal/online-safety-risk-assessment-draft.md`, section 2.1). A
notice to us is therefore always **metadata plus the sender's own account
of what happened**, never content we can independently view to verify.

Ask the sender for, and act on:

- **A room link**, if they can share one. We cannot decrypt it, but it
  identifies which relay(s) and TURN server, if any, are involved, and
  whether our default infrastructure is in the path at all.
- **An event id**, if they have one (visible to a technical user through
  their own client or a relay's own tooling). Relevant to the relay
  we operate (section 3.4).
- **A file hash**, if the notice concerns something shared through the
  default Blossom store. Relevant to section 3.2.
- **A description of what happened and why it is illegal or against the
  terms.**
- **Whether it involves a child**, so it is routed correctly (section 6).

## 3. What we can actually do, surface by surface

This section states the **verified** technical capability of each piece
of software this project deploys by default, not what would be convenient.
Anything not verified is marked `[UNVERIFIED]` rather than assumed.

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

### 3.2 The default file store (Blossom, `blossom-server-ts` 5.2.0)

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
`[UNVERIFIED: whether blossom-server-ts 5.2.0 supports a separate
admin/root pubkey override that could authorise a delete regardless of who
uploaded it. This is a common feature of comparable Blossom servers, but
was not confirmed for this project's deployed configuration
(deploy/blossom.yml sets no admin pubkey), so it must not be assumed
present. Check the pinned version's own documentation before relying on
it.]`

**What we can actually do today:** because the operator controls the box
the blob is stored on, we can manually remove the blob's file from
`${BLOSSOM_STATE}/blobs` and its row from the sqlite metadata database
directly, on the host, outside the server's own API. This is a **manual
operator action, not a supported feature of the deployed software**, and
should be logged as such (section 5) precisely because it bypasses the
server's own authorisation model.

**Block a pubkey from future uploads:** `[UNVERIFIED]`. `deploy/blossom.yml`
sets `upload.requireAuth: true` and `requirePubkeyInRule: false`, with no
allowlist or denylist of pubkeys configured. Whether blossom-server-ts
5.2.0 supports a pubkey denylist at all was not confirmed. Until verified,
treat this as **not possible** without either a software change or a
reverse-proxy rule matching the specific signed-auth-event pubkey, which
Caddy, as configured, does not currently inspect.

**Gap, stated for the terms and the risk assessment:** operator-initiated
removal of a specific file, and blocking a specific abuser from future
uploads, both rely on manual, undocumented, host-level intervention today,
not on a feature of the deployed store. `[DECISION: whether to invest in
a supported removal path, for example a denylist file the deploy scripts
install, if the upstream project supports reading one.]`

### 3.3 The default drop tier (`/drops`, bothy-node)

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
from what the relay stores and serves. Refusing future writes from a
specific pubkey needs the relay's write-policy ban list, which is drafted
but not yet deployed: until it is, a ban means deleting that key's events
and repeating. `[INPUT: update this once the ban list is live.]`

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

## 4. Timescales

`[DECISION: target response times. Suggested starting point, for the
owner to confirm:]`

- Acknowledge a notice: within 2 working days.
- A decision on what we can and cannot do, communicated back: within 5
  working days for our own default infrastructure; immediately, with an
  honest "we cannot act on this" and any onward referral, where the
  notice concerns a relay or store we do not operate.
- Suspected CSAM, or anything suggesting a child is at immediate risk: see
  section 6, acted on as fast as physically possible, not on the ordinary
  timescale above.

## 5. Record keeping

Keep, for each notice: the date, what was reported (room link, event id
or hash, as given), the sender's account of it, what we checked, what
action we took (or why none was possible), and who took it. Where an
action was a **manual, undocumented host-level intervention** (section
3.2), record that explicitly, since it bypasses the deployed software's
own authorisation and audit trail. `[DECISION: where this record is kept
and for how long. A reasonable starting point is at least three years,
matching the risk assessment's own record retention.]`

## 6. Child sexual abuse material (CSAM)

**Do not view, download, forward, store or otherwise handle suspected
CSAM beyond what is unavoidable to receive a notice of it.** This is a
matter of UK law, not only good practice: possessing or distributing such
material is itself an offence, with narrow exceptions.

If a notice describes, or you otherwise encounter, suspected CSAM:

1. **Do not attempt to verify it by viewing the material.** Act on the
   sender's description and any metadata (room link, event id, hash)
   alone.
2. **Report it to the relevant authority without delay:**
   - The **National Crime Agency (NCA)**, via the **CEOP** reporting
     route: <https://www.ceop.police.uk/safety-centre/> (for anyone,
     including a child, to report abuse or exploitation of a child).
   - The **Internet Watch Foundation (IWF)**, for reporting a URL or
     online location believed to host CSAM: <https://report.iwf.org.uk/>.
   `[LEGAL REVIEW: confirm the correct routing given this is a small UK
   operator rather than a hosting platform with an existing IWF or NCA
   relationship, and whether direct engagement with either body ahead of
   time is advisable.]`
3. **Take the narrowest infrastructure action available** (section 3) to
   stop our default infrastructure continuing to relay or store the
   material, without inspecting it further than necessary to identify
   what to act on (a hash or event id given in the notice is normally
   enough).
4. **Do not discuss the material's content** in any internal record beyond
   what is needed to identify it (a hash, an id, the sender's own words).
   Do not describe or reproduce it.
5. **Preserve, do not delete, our own metadata about the notice itself**
   (not the material) pending any request from the NCA or IWF, unless told
   otherwise by them.

This runbook deliberately does not describe how to examine, categorise or
triage the material itself. That is not this project's or this operator's
role; it is the NCA's and the IWF's.

## 7. Who does this

`[DECISION: name the role, matching ICU A2 in the illegal content risk
assessment. A role, not a name.]` Until named, `abuse@safety.forgesworn.dev`
should be monitored by whoever the owner designates, and this document
updated once it is.
