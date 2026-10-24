# FIPS call transport experiment

This is a local packet-path experiment, separate from the application. It
does not add a call setting, server default, room service or dependency to
the released web or Android clients. It uses synthetic media only.

Upstream is `jmcorgan/fips` at
`4cab546c6117ce5dfd28b86a4ddcd4cd943978f5`. The fork used by Nostr VPN has
not been substituted. No FIPS source or binary is redistributed here.

## Run

Requires Rust 1.94.1 or later, Python 3, Node 22.13 or later, the repository's
Playwright dependency and its Chromium installation. Tested on macOS arm64.
The native API also has upstream Linux/FreeBSD support; this fixture has not
been qualified there or on Android.

From the repository root, prepare the upstream checkout and build:

```sh
git clone https://github.com/jmcorgan/fips .fips-source
git -C .fips-source checkout 4cab546c6117ce5dfd28b86a4ddcd4cd943978f5
cargo build --manifest-path .fips-source/Cargo.toml --locked --bin fips --jobs 2
```

Reuse that checkout's `target/`; do not set a separate `CARGO_TARGET_DIR`.
Keep `.fips-source/` out of commits. The fixture verifies its source revision
and tracked-file cleanliness, and records the binary hash. That does not
cryptographically attest that an arbitrary supplied binary was built from it.

Run the media test with an explicit transport MTU:

```sh
node test/fips-call/run.mjs .fips-source/target/debug/fips 1472
```

If reusing an existing Playwright installation, set
`FIPS_PLAYWRIGHT_MODULE` to its absolute `@playwright/test` module path.
Otherwise use the repository's normal dependency preparation and
`npx playwright install chromium`.

Omitting the final argument exercises FIPS's 1280 MTU default. That case
failed at DTLS in the recorded run and exits non-zero with JSON diagnostics:

```sh
node test/fips-call/run.mjs .fips-source/target/debug/fips
python3 test/fips-call/leaf-probe.py .fips-source/target/debug/fips
```

The leaf probe reports observations. A zero process exit does not mean the
no-transit property passed: inspect `transitDelivered`.

The fixture creates private temporary directories, ephemeral test identities
and loopback sockets. It disables TUN, DNS, Nostr discovery and the control
API, and starts no public listener. Its `finally` blocks stop its daemons
and browser, close descriptors and remove temporary keys/logs. Interrupting
the Node runner with an uncatchable kill cannot guarantee cleanup; inspect
its child processes before abandoning such a run. No recordings are made.

## What the media fixture does

One Chromium page creates four independent synthetic audio/video sources.
It first connects two sources, then adds the other five pairings for a
four-source full mesh: six pairs, twelve receiving RTCPeerConnections.
This does not exercise real KithMoot room creation or four independent apps.

Each of four FIPS caller nodes has one configured neighbour: a separate
transit node. The callers have `leaf_only: true`; the transit has it false.
The topology, rather than proven enforcement of that flag, limits callers
to one neighbour in this experiment. All outer links use loopback UDP.

For each WebRTC pair, `mesh.py` opens two connected native FIPS datagram
flows with matching application ports. The browser fixture removes all
original ICE candidates and supplies only the corresponding local helper
UDP sockets. The bridge accepts packets from the expected local endpoint
and copies opaque ICE, DTLS and SRTP datagrams to the native flow. It never
terminates DTLS/SRTP or reads media keys. Oversized datagrams are counted
and dropped rather than truncated or silently fragmented.

The test requires decoded video frames and increasing received audio energy
at every receiving connection, then observes continued media for four
seconds per phase. It probes flow isolation with an expected peer and a
different authenticated node trying the same held destination port.
Finally it stops the transit and requires delivery counters to stop after
a two-second drain window. This is evidence against direct-path bypass.

Source descriptions of the native API and its platform limits:
[native API](https://github.com/jmcorgan/fips/blob/4cab546c6117ce5dfd28b86a4ddcd4cd943978f5/docs/reference/native-api.md),
[platform matrix](https://github.com/jmcorgan/fips/blob/4cab546c6117ce5dfd28b86a4ddcd4cd943978f5/README.md),
[configuration](https://github.com/jmcorgan/fips/blob/4cab546c6117ce5dfd28b86a4ddcd4cd943978f5/docs/reference/configuration.md).

## Recorded result and adoption gates

See [the assessment](../../docs/research/fips-call-prototype-20261023.md)
and its linked evidence. The larger-MTU local media case passed, but neither
the default-MTU case nor an enforced leaf-only boundary is qualified.
No production migration follows from this result.
