# Android 0.6.110 delivery, 24 October 2026

Android 0.6.110/code 133 is published on GitHub, both website hosts and the
existing Zapstore listing. It restores the existing headset/speaker choice
when Android changes communication output/mode and adds bounded native ICE
restart/rebuild recovery for a sustained failed profile-1 transport.

The [receipt](../evidence/android-0.6.110-publication-20261024.json) records:

- Android source `9908de74370555800fe786f5a51f6110927843ad`, PR #324 merged as
  `fc58d7163d832f76c3828cf0747cba17546f0fd9`, with an identical tree.
- All 17 executed Android jobs passed in run `40092336960`. The unchanged
  native-rekey process-death fixture initially timed out waiting for its
  original handoff. One targeted retry passed with the same source and
  assertions; the first failure remains in the record.
- Website PR #566 merged as `fea83dcda0307f3c6969f59a6279b21e13abf84f` with a
  tree identical to its qualified head; all 45 executed website jobs passed
  in run `40093908779`. The optional diagnostic was skipped by its normal
  workflow condition. Desktop 0.1.103 and older Android downloads remain.
- Production certificate and preview lineage retained; all 787 ZIP payloads
  match the unsigned input. APK SHA-256:
  `8899e1283d34586be634db22819162fa14e2356d99d07c37d165cdcae0b03ea1`.
- All 43 public responses matched the deployed files and signed APK, including
  full GitHub and website downloads. Independent Zapstore readback verified
  publisher signatures, latest main release, its asset reference and the
  advertised full APK download.

The owner instructed us to keep the current Pixel call running. This task
installed no APK and changed no phone profile, route or volume. Physical
GrapheneOS echo, sustained two-way speech/video and network-change acceptance
remain open. A connected-but-one-way transport is outside this recovery
ladder. The experimental realtime SDK is not integrated into Android calls.
No call server or operator service was deployed by this release.

Zapstore signing used the command-line publisher and its existing cached
NIP-46 client session. The expected publisher was resolved before signing,
then all three event signatures and the APK reference were independently
verified before publication. A fresh client's rejected connection does not
establish that the CLI's existing session has expired; check that session
before asking the owner to reconnect. No publisher private key was exported.
