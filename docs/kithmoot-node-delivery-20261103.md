# KithMoot node delivery candidate

3 November 2026. The owner-authorised private demo node is installed and paired
at `demo.forgesworn.dev`; the web client is deployed. Public signed node
distribution and Archipelago maintainer approval remain open.

The [design](design/2026-11-02-kithmoot-node.md) is committed on main. The
Google STUN correction and documentation drift fixes are merged; the corrected
web deployment was read back. The existing public `/turn` stays available for
ordinary rooms. Installing this candidate does not replace those rooms.

## Delivered code and evidence

| Stage | Candidate and acceptance evidence | Remaining gate |
| --- | --- | --- |
| N0 | Design PR668 and STUN/docs PR669/670/672 merged | Candidate decisions below require owner adoption before public release |
| N1 | Spry PR33/34 merged; short credentials, cached-auth revocation, live call teardown, resource bounds and fail-closed leases | Public signed dependency distribution; independent-network and capacity qualification |
| N2 | Private Shelter PR13 merged; room-scoped NIP42, addressed ask door, write-time room partitions and secure purge | Source/binary publication decision and recipient-accessible notices |
| N3 | Fold 0.17.0 published and integrity read back; matching signed port-aware vectors pass on web and Android; Wildbloom design updated | Released client pins and UI acceptance |
| N4 | Supervisor and private standalone Linux installer merged through PR678. Actual offline Debian/systemd install/update/rollback/killed-resume/uninstall and all four TURN allocations passed. [Installer receipt](evidence/kithmoot-node-installer-20261102.json), [host-profile receipt](evidence/kithmoot-node-host-profile-20261102.json). Private demo has public CA certificates and reachable TLS443 calls | Unattended renewal, independent-network qualification and signed public distribution |
| N5 | Web/desktop [PR675](https://github.com/forgesworn/kithmoot/pull/675) merged and web deployed. Owner confirmed pairing and ready status in the web app. Subsequent browser recovery fixes are described in the [network report](kithmoot-node-network-recovery.md). Local Electron pairing remains distinct from a packaged release | Packaged desktop and physical mobile qualification; Archy integration UI remains in its separate review pack |
| N6 | Android 0.6.133/code156 delivers the hosted-room UI from [PR392](https://github.com/forgesworn/kithmoot-android/pull/392), on merged foundation PR391 and port/lease core PR393. The versioned APK retains the production certificate and preview upgrade lineage. PR392 supplies its versioned CI; the [release](https://github.com/forgesworn/kithmoot-android/releases/tag/v0.6.133) identifies distributed artefacts. Earlier local UI matrix: 4,014 tests passed, one opt-in skip | Physical GrapheneOS, public Android TLS443 and independent-network qualification; ZAT applies only to official Archy submission |
| N7 | Offline host allocation on UDP34790/TCP on port 34790/TLS53499/TLS443, revocation, room purge and cold proof passed. A real browser/native guest exchanged video both ways for 300 seconds through renewal, then removal and purge; [cross-client receipt](evidence/kithmoot-node-ui-20261102/cross-client-proof.json) records relay candidates and selected TCP on port 34790. The latest [actual production browser proof](evidence/kithmoot-node-renewal-continuity-20261104.json) passed 442 seconds over publicly trusted TLS443, VPN on/off and an outage, including 310 seconds after final recovery across the prior login expiry; recovery took 18.006/16.736/2.100 seconds, with no zero-progress steady samples during credential renewal | Android publicly trusted TLS443; independent networks; four-URL per-peer allocation/capacity measurement; physical no-Play phone |
| N8 | Private Archy [PR53](https://github.com/forgesworn/archipelago-apps/pull/53). Unprivileged image, setup/pair/status/pause/delete UI, host TLS routing and coexistence, empty/partial-init deletion across restart qualified offline. Private demo runtime installed; owner completed signer-backed pairing and confirmed ready | Reboot/FIPS, official upstream submission and maintainer approval remain open; PR53 stays draft/unmerged |
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
| 19. ZAT | Owner clarified that the gate applies to official Archy submission and its named screens. Standalone KithMoot web/Android delivery does not claim or require Archipelago maintainer approval. General ship instructions do not approve the Archy revision. |

## Concrete next approvals and qualification target

The Archy review pack names screens, exact source/build, setup, expected
results, evidence and limitations. The owner clarified that ZAT is needed for
submission back to the official Archy repository. Private PR53 remains draft
and unmerged; no maintainer has been messaged. Refresh the pack and obtain
explicit approval for the reviewed revision before merging Archipelago UI work.

Maintainer must review and approve UI work on the Archy install, launch,
pairing hand-off, delete-everything and status screens before merging or
approval. ZAT pending. The review pack includes KithMoot's Settings → Calls →
Your KithMoot node and Room details → Hosted on as integration context; the
web release does not claim Archipelago maintainer approval.

The authorised rented-server demo, public DNS/certificates and web pairing
are now in use. The [network report](kithmoot-node-network-recovery.md) separates
controlled public-node browser evidence from physical acceptance. A no-Play
GrapheneOS phone on another network, independent commercial VPNs, packaged
desktop clients, reboot/FIPS and capacity remain open. Exact private Archy image and
host source revisions are recorded in PR53's review pack.

A public release additionally needs the owner to authorise Shelter source
and binary distribution and choose the release-signing arrangement. Hash
inventories alone are not publisher signatures. The existing private bundles
remain private; no approval to publish their contents is inferred.
