# Ordinary browser storage inventory

This is the production source inventory for the protected-state integration
branch, following main `7eec830` and local composition `0831a0c`. It is not
evidence that the application has switched persistence or that DG08 is complete.
The approved migration contract still requires complete coherent validation,
the actual all-client version fence, awaited retention before effects, and
coordinated forget. Individual validators below are offline custody checks.

Run the repeatable source audit from this checkout:

```sh
node scripts/inventory-ordinary-storage.mjs ./release/ordinary-storage-sites.json
```

Create the destination directory first. The report binds source files by SHA256
and records typed `Storage`/`DeviceStore` calls, syntactically apparent storage
calls, computed member calls and namespace literals, including template heads.
It deliberately includes `main.ts`, independently loaded `text-size.ts` and
dynamic `channel-checks.ts`. The parent commit alone does not identify uncommitted
source; use the file hashes. A literal-only search missed several live families.
Detached methods, runtime aliases, external SDK internals, inline/worker code
and desktop host windows still need the separate embedding audit. A source audit
does not establish runtime inventory completeness.

`H` below is a lowercase 64-character hex identifier, not a membership proof.
`A` is the explicit physical account or `visitor` where the actual writer permits
it. Key grammar and value validation belong to each family; a generic account
wrapper must not silently reassign global or observer-scoped rows.

## Private legacy Storage families

Every family here belongs in protected custody, including preferences that name
people, rooms, projects, devices, destinations or consent. The complete composite
must reject unclassified names, malformed versions, partial rows and unsupported
scope placements before key creation or cleanup. Do not run permissive/pruning
loaders as migration validators. Preserve exact original bytes or hold intact.

| Physical family | Actual producer / retained meaning | Required treatment |
| --- | --- | --- |
| `kithmoot.participant`, `.name`, `.last-nostr-account`, `.last-nostr-method`, `.profiles.lastKnownName.v1` | `main.ts`: local identity, signer selection and display names | Existing identity check; signer/account reconciliation before use |
| `signet:login.*` | Signet SDK login, auth event, bunker/client scalars and pending redirects | Existing required async Signet adapter; audited published SDK pin still needed |
| `kithmoot.device.H`, `.device-owner.*`, `.credential.H`, `.own-credential.H`, `.own-seal.H` | `device-store.ts`: room keys, credentials, complete seal history | Existing strict checks and awaited adapter; account conversion must preserve explicit ownership |
| `kithmoot.device`, `.credential` | Previous shared-device layout | Hold/recovery under explicit legacy policy; do not silently remove at startup |
| `kithmoot.room.H`, `.rooms.v1`, `.account.H.kithmoot.room.H` | `rooms-store.ts` / `room-bookmarks.ts`: room links and account-scoped room metadata | Existing room-access/bookmark validation; signer must compare cached plaintext with authenticated decrypt |
| `kithmoot.bookmarks.H.H` | `room-bookmarks.ts`: signed/encrypted bookmark records and pending retries | Existing bookmark custody validation; durable retention before signing/publishing |
| `kithmoot.invitation-owner.v1.H`, `.admission-kept.v1.H`, `.admission.v1.H` | `invitation-store.ts`, `device-store.ts`, `main.ts`: ownership and kept/temporary admissions | Existing strict access checks; no current authority from cache |
| `kithmoot.room-epoch.v1.H`, `.room-epoch.v2.H` | `room-epoch-store.ts`: epoch roots and rekey evidence | Existing strict epoch snapshot; actual required before-transition async library/runtime boundary remains open |
| `kithmoot.quiet.v1.H` | `quiet-store.ts`: counter/queue state | Existing snapshot check needs mandatory same-image binding and retention before emission |
| `kithmoot.cadence-lease.v1.*` | `cadence-store.ts`: lease/state/receipt/retry history | Existing snapshot check needs same-image keys/account/device/room/epoch/grant binding and live reconciliation |
| `kithmoot.pending.H` and supported account-scoped successor | `pending-sends.ts`: exact prepared outgoing events and file references | Awaited browser/tab adapter exists; production startup/consumers still need full root integration |
| `kithmoot.contact.v1.H`, `.rendezvous.v1` | `contact-store.ts`: contact and Link cache, own rendezvous scalar | Existing strict contact custody; absent first-use/rotation never generates a key during validation |
| `kithmoot.verified.H`, `.checks.v2.H.kithmoot.verified.H` | `verified-store.ts`: global and observer-scoped human comparison observations | Existing strict contact/observation custody; no inferred account assignment or verification authority |
| `kithmoot.contacts.v2.H.*` | `granted-contacts-client.ts`: pairing and bounded projection/replay state | Separate strict parser/binding audit; retain before accepting replay floors or external effects |
| `kithmoot.channel-checks.v1.H.H` | `channel-checks.ts`: private nonce, request/acceptance/reveal and sent/checked history | Rebuild primary deterministic protocol state; await retention before flush/send |
| `kithmoot.box-discovery.v1.H.H` | `box-discovery.ts`: revision, retained signed cards/claims/status/conflict history | Preserve stale/replay history; authenticated fresh reads before discovery effects |
| `kithmoot.uploads.v1.H`, `.blob-deletes.v1` | `blob-deletion.ts`: upload URL/hash pairs and signed deletion retry authorisation | Exact signed event/hash/URL correlation; retention before deletion/forget; no guessed target |
| `kithmoot.context.v1.H` | `context-panel.ts`: signer-encrypted account context | Hide outer account key; owner CAS and authenticated signer decrypt before effects |
| `kithmoot.assignments.v1.H.H` | `assignment-panel.ts` and `main.ts`: encrypted assignment journal | Strict primary journal binding and awaited retention; audit both read and write embeddings |
| `kithmoot.shared-projects.v1.H` | `shared-projects.ts`: account project journal | Strict primary project journal binding; current async save wraps a synchronous store write |
| `kithmoot.project.v1.A.H` | `room-projects.ts`: personal project label | Metadata snapshot checks exact physical scope/name; no membership authority |
| `kithmoot.notification-scopes.v1.` + JSON `[A,kind,id]` | `notification-scopes.ts`: account/project/room alert settings | Metadata snapshot checks canonical tuple and `all`/`off`; no notification permission authority |
| `kithmoot.pinned-rooms.v1` | `room-pins.ts`: sorted private room IDs | Metadata snapshot preserves exact sorted unique list, including real empty list |
| `kithmoot.volume.v1.H` | `volume-store.ts`: participant-keyed audio level | Metadata snapshot validates finite actual non-default writer values; never defaults malformed rows |
| `kithmoot.room-relays.v1.H`, `.relays.v1`, `.circle.v1`, `.room-relays-fixed.v1` | `main.ts`, `relay-settings.ts`: actual routing choices and room destinations | Strict producer validation; retain before pool/route changes |
| `kithmoot.room-name.v1.H`, `.room-logo.v1.H` | `main.ts`, `room-logo-store.ts`: cached room name/image/epoch | Preserve exact cache; missing original signed metadata event means cache is not current authority |
| `kithmoot.history-recovery.v1.H.H` | `history-recovery-progress.ts`: relay/class EOSE cursors | Validate physical account/node binding and exact windows; no completeness claim or pruning |
| `kithmoot.file-storage.v1`, `.blossom-server` | `file-storage.ts`: explicit shared-store consent, legacy suggested URL | Keep consent distinct from suggestion; private Bothy file path remains open |
| `kithmoot.destructed.v1`, `.destruct-heads-up.H` | `self-destruct.ts`, `main.ts`: UI dismissal/history timestamps | Preserve without time pruning; these are not permanent owner/deletion fences |
| `kithmoot.knock.v1.H`, `.invited.v1.H`, `.nudge.H` | `main.ts`: room-bound choices and notification markers | Private room metadata; exact scope/value validation and awaited dependent effects |
| `kithmoot.conversation.v1.A.H`, `.room-switch.v1`, `.way-back`, `.notice` | `main.ts`: tab channel/room navigation and notice state | Distinct protected tab owner; preserve supported existing lifetime and exact bytes |
| `kithmoot.home.fold.*` | `main.ts`: section state, including dynamic project labels | Private selector metadata; not a generic visual-prefix exception |
| `kithmoot.call.cameraDeviceId`, `.call.micDeviceId`, `.call.background` | `call-prefs.ts`: device identifiers and background selection | Protected metadata; do not exempt all `call.*` preferences |
| `kithmoot.call.voicePreset`, `.call.effectMode`, `.call.blurStrength`, `.callProfile` | `call-prefs.ts`, `call-profile.ts`: media preferences and selected call diagnostic profile | Protected unless separately reviewed; profile can affect runtime media/routing |
| `kithmoot.agents-hear`, `.notify`, `.notify-text`, `.send-delay`, `.profiles.enabled` | `main.ts`, `notify.ts`, `relay-settings.ts`: consent, disclosure and send behaviour | Protected settings; durable commit before dependent changes |
| `kithmoot:emoji:recents`, `kithmoot:emoji:skinTone` | `chat-art-picker.ts`, `emoji-picker.ts`: usage history and identity-associated selection | Protected metadata; colon namespaces must be included |
| Other recognised finite visual keys below | Individual UI writers | Exempt only after explicit exact-key/value review; no prefix exemption |
| Unknown/new `kithmoot` / Signet login names | Future, malformed or unclassified state | Select and hold until explicitly classified; never silently leave outside migration |

The project and notification APIs have permissive test inputs. The metadata
snapshot validates the production physical account/room grammar and preserves
project selector strings as inert metadata. It returns counts only. Unsupported
wrappers, relocation into tab custody, invalid or noncanonical rows hold intact;
completed custody does not waive those checks.

## Candidate visual exception, not yet production-wired

The only proposed initial visual exception is the exact browser key
`kithmoot.textSize` with `standard`, `large` or `huge`, from independently loaded
`text-size.ts`. It contains no identifier and only selects a root-font scale.
Invalid values must not be silently normalised during the strict preflight.
The exception must be reviewed and its embedding verified before release.

Other identifier-free keys currently written by layout modules include
`kithmoot.call-chat-panel`, `.call-chat-divider`, `.call-view`,
`.call-self-corner`, `.call-hide-self`, `.call-hide-no-video`,
`.desktopChatDrawerOpen`, `.desktopProjectsRailOpen`, `.desktopProjectsRailWidth`,
`.fish.enabled`, `.camera.framing`, `.mirror-self`, `.zen-bell` and `.desktop-bell`.
They remain protected in the proposed scope until an explicit exact-value
allowlist is reviewed. A name containing `call` or `home` is insufficient.

## Coordination and adjacent encrypted stores

| Surface | Actual storage / boundary | Required embedding work |
| --- | --- | --- |
| `kithmoot.call-tab-lock.msg` | Plaintext Storage fallback includes `roomId\|devicePubkey`, tab ID, timestamp and claim/release/probe | Remove the metadata-leaking fallback or replace it with reviewed protected coordination; moving the row alone breaks its storage-event protocol |
| `kithmoot.call-tab-lock`, `kithmoot.room-tabs`, route-ready/client-version channels | BroadcastChannel/Web Locks/message names, not automatically Storage records | Actual discovery/version fence still required; voluntary old-tab leave is not that fence |
| `kithmoot.mls-coordinated-vault.revision` | Random UUID revision signal for a separate witnessed encrypted owner | Audit exact opaque value and coordination separately; not room/account metadata or a visual preference |
| `kithmoot-mls-vault-v1.revision`, `kithmoot-rendezvous-vault-v1:revision` | Default encrypted-vault names with random UUID revision signals | Include dash-prefixed names in the source audit; preserve synchronous invalidation semantics until reviewed replacement |
| MLS/persona/grant/room/link/rendezvous/history-index/archive stores | Separate IDB stores, opaque keys, encrypted frames and witnessed custody | Retain their own authority/anti-rollback gates; do not mistake a record AAD or DB name for a raw ordinary Storage key |
| `kithmoot.ordinary-tab.v1` | Opaque random temporary-owner marker in sessionStorage | Existing bounded lifetime/clone fencing applies; never place participant/room IDs here |
| Draft and scroll state | `drafts.ts` and `chat-scroll.ts` currently keep in-memory state | Pending signed sends/file references are separate; do not invent persisted draft keys from map operations |

The remaining work is the unsupported family validators, complete same-image
classification and binding, actual startup/client fence, every awaited consumer,
quiet/epoch before-effect library hooks, authenticated restoration, and full
forget/recovery. The current raw production startup still runs before migration.
No helper, audit report or focused browser result closes that composition gap.
