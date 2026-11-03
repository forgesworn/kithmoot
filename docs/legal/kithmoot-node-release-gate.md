# Hosted KithMoot node: release gap check

Draft, 3 November 2026. Not legal advice; not reviewed by a lawyer. Factual
review of KithMoot candidate `d18b0c57d8f97a6cac9789515143878b4fcbecff`,
its merged backend/installer at `10de6eef7deef18658a0f576af163038e8006426`,
Android candidate `d0b7a74e3404cdf8414e76c88f844375748ec30d`, Spry
`f9823b74da4f6ec51649fe725f4e2c200e17283d`, private Shelter
`611a150d1ec2185c97b7f54c3739e91a18623204`, and the separate Archy review
pack. Repository state is not proof of a live deployment or installed update.

The law remains in jurisdiction-kit's
[GB online-services note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md),
verified 28 September 2026, review due 28 March 2027; section 2.11 has primary
sources read 23 October 2026. Its marks remain: `[P]` primary text read,
`[U]` unresolved application. The watch list was read; this check adds no
new determination about the law and does not update that shared note.

## Position and keys

ForgeSworn remains a software publisher that also runs the existing public
TURN service and credential issuer. This candidate does not close that
service, change its ordinary-room defaults, or deploy a ForgeSworn room node.
The separate closed project Nostr relay retains its existing position and
conditions. The historical/current split in
[call-transport-position.md](call-transport-position.md) still applies.

The new optional node is operated by whoever installs it on a rented server
or an away-from-home Archy. Its keeper controls room admission on a client;
the operator controls hosting, resource limits, network access and availability.
An operator must assess their actual room service and infrastructure roles
separately (note 2.2 and 2.11, application `[U]`). Authentication, encryption,
away-from-home hosting and calling it a private node do not establish a legal
exemption. A household-purpose test concerns the actual activity (3.9), not
where the server stands. No new duty, deadline, fee or identity disclosure
is asserted solely because this code exists.

**Inventory question 7:** the node supervisor, its Spry and Shelter profiles,
and the Archy controller receive no room-content key, WebRTC session key or
keeper signing key. The existing optional `keeper@.service` is different:
if separately deployed it holds a room key. This candidate neither deploys
that keeper nor claims a key-holding keeper cannot read its room.

## Facts the release copy must cover

| Data or action | Implemented boundary and evidence |
| --- | --- |
| Admission | A v6 link permits an addressed ask. Enrolment and grants require the keeper's signatures and acknowledgements from both backends. `src/kithmoot-node.ts`, `src/node/kithmoot-node/supervisor.ts`, `app/src/node-room-runtime.ts:102` |
| Access metadata | Node state records opaque room identifiers, authority/device public keys, signed grants, access expiry and pending operations. The relay associates events with a room at write time. IP addresses, timing and traffic volume are visible to the network operator. `src/node/kithmoot-node/ledger.ts:68`; private Shelter room-relay profile |
| Calls | Node rooms use only their node's authenticated TURN, including TLS443; logins last at most 300 seconds. There is no automatic ordinary/public relay fallback. `src/kithmoot-node.ts:283`, `src/node/kithmoot-node/runtime.ts:204`; Android `media/NodeCallLease.kt` |
| Files | Off for node rooms. The public Blossom default describes ordinary rooms. `src/node/kithmoot-node/http.ts:59`, `app/src/node-room-runtime.ts` |
| Logs | Candidate services discard child output and expose no request/access log. Archy's node ingress disables activity access logs. Provider network records, snapshots and operator modifications remain outside that setting. `src/node/kithmoot-node/runtime.ts`, `deploy/node`; separate Archy host evidence |
| Retention | Signed node-room events have a rolling 30-day maximum horizon, bounded by any room end. Closing purges its relay partition; completed operation receipts and cold signed closure proofs expire after 30 days. Salted anti-replay markers remain for the maximum grant horizon plus clock margin. Pending operations persist for recovery. `src/node/kithmoot-node/ledger.ts:212`, `src/node/kithmoot-node/supervisor.ts`; Fold 0.17 vectors |
| Removal versus closure | Removal revokes the affected devices and rekeys the remaining room. Closure revokes all grants, purges the room and provides a signed statement for device wipe. A receipt proves the node operation, not every device or provider copy. `src/node/kithmoot-node/supervisor.ts`, `app/src/node-room-runtime.ts:135`; Android `node/NodeDeviceAccess.kt` |
| Device state | Account-scoped node pairing, private room/device custody, keeper state and interrupted operations persist locally; call logins and their monotonic deadlines stay in memory. Post-wipe public references allow completion checks. `app/src/node-rooms.ts`; Android `node/NodeStore.kt`, `media/NodeCallLease.kt` |

The privacy and terms page drafts now explicitly call this an unpublished
private candidate. They explain these boundaries without promising that a
provider deletes snapshots, an offline client has already wiped, or another
participant cannot copy content. Node rooms do not disable unrelated profile,
update or account lookups; those existing disclosures still apply.

## Open release gates, in order

| Gap | Evidence and action | Who decides |
| --- | --- | --- |
| Public dependencies and notices | Private bundles have complete file hashes, not publisher signatures. Shelter source and binaries remain private. Prepare approved signed distribution, corresponding source and complete recipient-accessible notices before offering a one-command public installer. `deploy/node/build-release.mjs`, `docs/kithmoot-node-install.md` | Owner, including Shelter publication rights; publication remains unapproved |
| Actual operator and hosting | No live target is installed by this change. Provider logs/snapshots, controller/contact details, purpose, retention policy and applicable service role depend on the chosen deployment. Note 3.2 requires the relevant privacy information `[P]`; the software publisher cannot supply another operator's facts. | Deploying operator; `[INPUT: target and operator arrangements]` |
| Classification | A room relay with actual application-admission records differs from a generic blind packet relay. Reassess the combined service under 2.2/2.11 rather than automatically inheriting the public TURN argument; applicability remains `[U]`. | Actual operator; `[LEGAL REVIEW: only if the unresolved role changes the chosen deployment]` |
| Network and devices | Offline allocation on all four TURN transports and local browser/native media do not establish public trust, independent NATs, sustained TLS443 cross-client media, capacity or physical GrapheneOS acceptance. | Engineering and owner, using named test evidence |
| UI | Exact web/desktop, Android and Archy review packs exist. No maintainer approval is recorded. | Maintainer ZAT; owner passes on the review packs |

No payment, registration, regulator contact, public Shelter disclosure or new
live service is performed by this gap check. It identifies no new present
statutory deadline or cost for the unpublished candidate. Existing operated
services retain their separately documented questions and obligations. This
is a release gate record, not a finding of compliance or adoption of terms.
