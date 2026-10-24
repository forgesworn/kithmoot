# Realtime SDK preview delivery

24 October 2026. [Experimental release 0.5.5-realtime.1](https://github.com/forgesworn/kithmoot/releases/tag/v0.5.5-realtime.1)
ships the combined SDK, browser assets and independently runnable operator.
It does not select this SDK for normal website or Android calls.

## Source and qualification

- [KithMoot #561](https://github.com/forgesworn/kithmoot/pull/561), merged as `71c972c81493e1968fcb9f3834bad710976e0f77`.
- [RelaySwarm #21](https://github.com/forgesworn/relayswarm/pull/21), merged as `7fee40c649ad3d26ec852484118b3dccf4dbca00`.
- [Sapflow #5](https://github.com/forgesworn/sapflow/pull/5), merged as `748bdb8b098e12b7223a367f2343ab5d760d3e32`.

The SDK source revision is `c4890f29609c40ee8b678f7b4d69953b71494deb`.
Its merged tree is identical to the qualified tree. Dependency source pins
are the isolated public revisions in `realtime-sources.json`; unrelated
peer-margin, native-broadcaster and camera work was preserved.

[Full KithMoot CI](https://github.com/forgesworn/kithmoot/actions/runs/40083034237)
passed all 45 executed jobs; its optional prior-lease diagnostic was skipped.
The separate [combined realtime gate](https://github.com/forgesworn/kithmoot/actions/runs/40083034244)
passed actual native/WASM builds and forwarded/mesh 2/4/8 generated-media cases.
RelaySwarm's native Linux/macOS and wider suites, and Sapflow's complete suite,
also passed. Exact runs, hashes and native receipts are in the
[release evidence](../evidence/realtime-release-20261024.json).

Earlier Linux fixture failures and startup retries remain recorded. Source
tone generators now use processing-only contexts; portrait layout checks
poll the actual uncovered picture instead of waiting a fixed 500 ms.
The strict-network automatic-call case had two hosted startup failures that
did not reproduce in the local/isolated Linux startup probes. Its cause is
unconfirmed. Bounded pre-call diagnostics were added; the final complete
hosted run passed without retries. This is not a claim that a production
startup defect was found and corrected.

## Published artefacts and website

The prerelease includes the Linux x64 SDK/operator, browser runtime, qualified
macOS arm64 native sidecar, dependency notices/source patches, generated-media
results and checksums. Both required unpublished workspace dependencies are
included as package archives. Installing all three package archives into a
clean application succeeded, the realtime SDK imported and npm audit reported
zero vulnerabilities. The release notes contain the exact install command.

All ten release downloads matched the local qualified bytes. The checksum
file was also fetched without GitHub authentication. The static website was
deployed atomically from `71c972c8` to the existing host; no server, credential
issuer or reverse-proxy configuration was changed. Thirty canonical HTTPS
responses across `kithmoot.app` and `kithmoot.forgesworn.dev` matched the built
page, entry script, service worker, browser runtime and signed update metadata.
See the [publication readback](../evidence/realtime-publication-20261024.json).

The Android download remains 0.6.108/code 131 with its existing APK hash.
No Android update is included. The owner has reported severe loudspeaker
echo, a dropped call around a VPN change and asymmetric audio/video between
Android devices; these are being investigated separately. Browser SDK
qualification does not establish Android call acceptance.

The three temporary dependency worktrees were removed after ancestry,
push and cleanliness checks. The temporary Linux diagnostic container, image
and copied source, and its local browser trace, were removed. Named historic
generated-media evidence remains under `test-results/realtime/` as described
in the original qualification record.

## Open gates

Normal call-screen integration, physical GrapheneOS acceptance of this SDK,
Android/Swift interoperability, independent client networks, blocked-UDP
fallback, longer calls, battery and production latency remain open. The
earlier public eight-person picture-age p95 of 1.431 seconds remains a quality
concern. The native experimental backend supports TURN/UDP only.

The legal assessment remains unresolved. Publishing this software establishes
no Online Safety Act exemption or absence of host/provider metadata.
