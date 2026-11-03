# KithMoot node delivery candidate

3 November 2026. Private implementation and review candidate. No public signed
node release, live node installation or UI approval is claimed.

The [design](design/2026-11-02-kithmoot-node.md) is committed on main. The
Google STUN correction and documentation drift fixes are merged; the corrected
web deployment was read back. The existing public `/turn` stays available for
ordinary rooms. Installing this candidate does not replace those rooms.

## Delivered code and evidence

| Stage | Candidate and acceptance evidence | Remaining gate |
| --- | --- | --- |
| N0 | Design PR668 and STUN/docs PR669/670/672 merged | Candidate decisions below require owner adoption before public release |
| N1 | Spry PR33/34 merged; short credentials, cached-auth revocation, live call teardown, resource bounds and fail-closed leases | Public signed dependency distribution; internet/media qualification |
| N2 | Private Shelter PR13 merged; room-scoped NIP42, addressed ask door, write-time room partitions and secure purge | Source/binary publication decision and recipient-accessible notices |
| N3 | Fold 0.17.0 published and integrity read back; matching signed port-aware vectors pass on web and Android; Wildbloom design updated | Released client pins and UI acceptance |
| N4 | Supervisor and private standalone Linux installer merged through PR678. Actual offline Debian/systemd install/update/rollback/killed-resume/uninstall and all four TURN allocations passed. [Installer receipt](evidence/kithmoot-node-installer-20261102.json), [host-profile receipt](evidence/kithmoot-node-host-profile-20261102.json) | Public CA issuance/renewal and another-network reachability; signed public distribution |
| N5 | Web/desktop [PR675](https://github.com/forgesworn/kithmoot/pull/675). Actual Chromium room lifecycle and Electron renderer paired/enrolled with ports 34790/53499. [Review pack](kithmoot-node-ui-review.md) | Maintainer approval, then merge/release |
| N6 | Android foundation PR391 merged. Port-aware core PR393 merged as `dcf78bbb` after all 17 CI checks passed, separately from held UI [PR392](https://github.com/forgesworn/kithmoot-android/pull/392). Final local UI matrix: 4,014 tests passed, one opt-in skip; both lints and debug/unsigned-release/test APK builds passed | Maintainer approval, physical GrapheneOS |
| N7 | Offline host allocation on UDP34790/TCP on port 34790/TLS53499/TLS443, revocation, room purge and cold proof passed. A real browser/native guest exchanged video both ways for 300 seconds through renewal, then removal and purge; [cross-client receipt](evidence/kithmoot-node-ui-20261102/cross-client-proof.json) records relay candidates and selected TCP on port 34790. This is local evidence | Web/Android sustained media in both directions forced over publicly trusted TLS443; independent networks; four-URL per-peer allocation/capacity measurement; physical no-Play phone |
| N8 | Private Archy [PR53](https://github.com/forgesworn/archipelago-apps/pull/53). Unprivileged image, setup/pair/status/pause/delete UI, host TLS routing and coexistence, empty/partial-init deletion across restart qualified offline | Complete Archy daemon runtime, actual install/app gate/signer, reboot/FIPS and maintainer approval |
| N9 | [Legal-cover gap check](legal/kithmoot-node-release-gate.md) and candidate privacy/terms drafts prepared; four Chromium site checks passed, including 320/390/1440 widths with JavaScript disabled under production CSP | Owner adoption of actual operator/publication arrangements; publish only with the corresponding released behaviour |

These are separate evidence classes. A green local build or hosted CI does
not establish a physical phone test, a public service, a signed distribution
or maintainer acceptance.

## Section 7.3 candidate choices

These choices make the implementation reviewable. They record what this
candidate does, not a claim that every owner decision has been adopted.

| Design item | Candidate choice |
| --- | --- |
| 1. Home connection | Require rented/away-from-home confirmation and an assigned publicly routable IPv4. Refuse private/reserved/carrier-NAT addresses. No claim to identify an ISP or detect every home connection. |
| 2. TLS front | Standalone in-process SNI TLS front; Archy uses its existing host-owned Rust TLS/native router. App reads no Archy TLS private key. |
| 3. One list | Durable supervisor ledger, kind27541 projection to both children; admission completes after both acknowledge. |
| 4. Enrolment | Paired owner's body-bound signed enrolment of the room authority. |
| 5. Device identity | Room device key signs Spry requests; no independent bearer credential grants room admission. |
| 6. Link | Version6 ask-only descriptor; old links retain their semantics. |
| 7. Ask transport | Separate addressed ask door on the room's Shelter; no public relay fallback. |
| 8. Admitting device | Keeper authority devices answer asks. No delegated-member admission in this candidate. |
| 9. Removal | Revoke removed devices, stop their calls, process signed removal/wipe and rekey remaining members. Preserve the remaining room's messages. |
| 10. Keeper process | None on the node; no room or keeper signing keys are supplied. |
| 11. Defaults | Self-destruct on; room end optional and bounded by the protocol horizon. |
| 12. Close/retention | Durable delivery deadline bounded to two minutes; no success until both child teardowns/purge finish. Signed completion/cold proof retained for 30 days; anti-replay tombstones have the grant horizon and clock margin. |
| 13. NIP40 | Rolling 30-day maximum, shortened by the room end. |
| 14. Promise | Name the chosen node/operator. Distinguish running-node purge from offline device wipe, copied content and provider snapshots. |
| 15. Call routing | Relay-only through the room's node. No direct or public-relay fallback. |
| 16. Files | Off in node rooms. Ordinary-room file settings remain separate. |
| 17. ForgeSworn `/turn` | Retained. No switch-off or migration is performed. |
| 18. Shelter publication | Not performed. Owner must decide permitted source/binary publication and signed distribution before any public one-command installer is offered. |
| 19. ZAT | Standing gate applies to named Archy and KithMoot integration screens. General ship instructions do not approve the revision. |

## Concrete next approvals and qualification target

The owner can pass the three PR review packs to the maintainer. Each names
screens, exact source/build, setup, expected results, evidence and limitations.
No maintainer has been messaged. After a material UI change, review the new
revision again.

Maintainer must review and approve UI work on the Archy install, launch,
pairing hand-off, delete-everything and status screens, and on KithMoot's
Settings → Calls → Your KithMoot node, room hosting, guest ask/wait/admit and
Room details → Hosted on with removal/close, before merging or approval.
ZAT pending.

A live qualification needs an owner-authorised rented-server/away-from-home
Archy target, its actual operator, public DNS/certificates, firewall access,
and a no-Play GrapheneOS phone on another network. The private Archy image
and exact host source are in PR53's review pack; loading/installing it and
changing a live certificate or route are not performed by this handover.

A public release additionally needs the owner to authorise Shelter source
and binary distribution and choose the release-signing arrangement. Hash
inventories alone are not publisher signatures. The existing private bundles
remain private; no approval to publish their contents is inferred.
