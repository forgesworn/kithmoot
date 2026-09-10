# Shared projects

A shared project identifies a particular owner and project ID. Its name is a
label: two projects called “Research” remain separate even when the same account
owns both. The PWA Projects panel creates and edits directories, reviews received
invitations and adds joined projects to home, room switching and desktop navigation.
A room can appear in several projects. Existing personal room labels are retained;
no label is silently published or converted into shared membership.

The owner chooses people, agents and persistent room invitations. Each recipient
receives an encrypted signed directory. Joining is a separate personal choice,
signed and encrypted to that account, so another device using the same account can
restore the choice. Receiving or joining a project does not open rooms or launch
agents. Opening a room still performs its admission flow and checks that the
admitted room matches the directory's room ID before starting the session.

## Authority and removal

Only the named owner edits a project's directory. Members can join or hide their
own view. A new or re-added member receives a new membership epoch; an older
personal join cannot activate the new invitation. Removing a member sends a
minimal withdrawal notice rather than the project's updated people or rooms.
Pending withdrawal notices survive later edits and exact outbox retries.

The directory is **not** a room admission policy, tool permission, context grant
or execution mandate. Removing a directory member does not revoke an invitation
or an already admitted room session. Room access and running work must be revoked
through their respective authority. Previously received copies cannot be recalled.
Temporary meetings, legacy traffic-key links and device-pairing links are excluded
from shared project room selection and from signed-record validation.

`projectAuthority` hashes the owner/project identity, archived state, membership
keys/kinds/epochs, selected room IDs and authority revision. Metadata-only changes
keep this digest. The directory writer advances authority when eligibility changes,
including archive/restore and remove/re-add cycles. Reconciling conflicting names
with identical eligibility preserves authority. This digest can be pinned alongside
an executor's separately granted mandate; it is not a permission by itself.

Oathrun must explicitly map this project identity to its own project, selected
room and permitted principals/agents before using it for execution. It must retain
revocation history, check current authoritative state and enforce task/tool/context
permissions independently. Directory receipt, an agent appearing in two projects,
or a newer owner-signed revision must never revive a revoked execution mandate.
That runtime mapping and native Android directory integration are separate work;
the PWA directory does not claim to have supplied them.

## Signed wire contract

Implementation: [`src/projects.ts`](../src/projects.ts) and
[`src/project-directory.ts`](../src/project-directory.ts).

Inner events are signed kind 30078 records with exactly these tags:

```json
[["d", "<64-character project ID>"], ["l", "kithmoot.projects.v1"]]
```

Every body contains `v: 1`, `op`, `project`, `revision`, `request` and `parents`.
Revision 1 has no parents; later revisions name one to eight previous heads.
Requests are 16–80 ASCII letters, digits, underscores or hyphens. Operations:

| Operation | Additional fields | Author and permitted recipient |
| --- | --- | --- |
| `snapshot` | `definition`: name, members, rooms, archived, authorityRevision | Owner signs; only listed members receive it. Each member has pubkey, person/agent kind, epoch and optional name. Each room has room ID, name and persistent HTTPS invitation. |
| `withdraw` | `recipient` | Owner signs; only the removed member receives it. |
| `follow` | owner, joined, membership, invitation | The member signs and encrypts only to themself. It records their reviewed invitation head and membership epoch. |

Signatures are reverified without trusting a cached verification symbol. The
record validator checks exact fields, recipient binding, size and revision bounds,
owner inclusion, uniqueness, display names and supported invitation links. Invalid
outgoing bodies are rejected before invoking an external signer. Signer responses
must match the requested identity, timestamp, tags and content exactly.

A fresh ephemeral key NIP-44-encrypts each signed record to each recipient and
signs a kind 1059 gift wrap. Only `p:recipient` and `l:kithmoot.projects.v1` appear
in its public tags. Timestamp jitter uses cryptographic randomness. NIP-59 permits
wrapping any signed event; this application does not claim NIP-17 direct-message
semantics. Relays can observe recipients, application use and traffic timing.
They do not receive plaintext project names, membership lists or room invitations.

Limits: 32 KiB inner content, 100,000-character encrypted payload, 64 members,
32 rooms, 128 project namespaces, up to eight retained same-revision heads,
1,024 pending sends, 4,096 request receipts and a 32 MiB decrypted cache. These
bounds limit accepted state; they are not relay spam prevention or a global
consensus guarantee. Revisions and membership epochs are positive integers up to
one million. Inner timestamps more than 60 seconds ahead are rejected.

## Recovery and concurrent edits

Higher owner revisions replace older known state. Distinct records at the same
highest revision are visible conflicts: there is no usable canonical definition
until the owner submits a reviewed replacement against the current known heads.
An editor captures its initial heads. Incoming updates never silently change a
pending edit or the invitation being reviewed; stale saves require another review.

Relay end-of-history gates new changes but does not establish that all updates or
revocations have arrived. A relay can omit history. Consumers needing execution
authority must add their own freshness/revocation checks, not infer current global
state from one subscription's completion.

The directory persists before showing or publishing a local change. Its journal
stores exact signed records, recipient ciphertexts and request-intent receipts.
Retry uses the original ciphertext and request identity. A lost acknowledgement
can cause duplicate delivery of the same event; it cannot create a new project
change. Relay acceptance does not prove that every member's device has received it.

The browser cache uses the existing Wildbloom encrypted envelope. A random cache
key is NIP-44 sealed to the account only when there is actual state to save; opening
an empty directory does not prompt for cache encryption. Restoring rechecks signed
records and recipients. Corrupt or wrong-account storage is not replaced with an
empty directory. Save failure disables further local edits until recovery.

A Web Lock provides one writer per account/cache in a browser. A second tab reports
that the directory is open elsewhere and offers retry after that tab closes.
Another physical device has an independent encrypted cache and synchronises over
the relay. Restart restores pending sends but requires an explicit Retry instead
of automatically publishing an uncertain old effect. Closing while signing cannot
commit or publish the pending change.

## Verification boundary

Unit and local-relay tests exercise signed input rejection, three overlapping and
disjoint memberships, explicit joins on another device, encrypted cache recovery
without relay history, foreign-owner rejection, concurrent edits, removal/re-add,
archive/restore authority, immutable exact retries, signing cancellation and failed
storage. Browser acceptance creates three shared projects, reviews an invitation,
restores that account on a fresh phone-width browser, obtains real persistent room
admission, sends a message and switches desktop rooms with preserved drafts.

These use synthetic identities and controlled relays. They do not prove physical
Android directory parity, background push, production live-agent migration,
complete relay history or the full multi-project acceptance in G9.
