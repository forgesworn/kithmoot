# Local node call endurance

This opt-in test models six people using seven independent web profiles. The
creator uses two profiles on the same synthetic account; the other five are
independently admitted guests. It uses the real node supervisor, private
Shelter relay, Spry TURN service and production client code. Keys, room state,
capture and traffic are disposable fixtures. No real room or public relay is
used.

Prepare the pinned native backend executables and normal npm dependencies,
then run:

```sh
E2E_NODE_ENDURANCE=local-only \
E2E_NODE_SPRY_BINARY=/absolute/path/to/spry-node \
E2E_NODE_SHELTER_BINARY=/absolute/path/to/bothyd \
E2E_NODE_ENDURANCE_SECONDS=2700 \
npm run test:node-endurance
```

The sibling `spry-turn` executable must be alongside `spry-node`. Record their
source commits, locked build commands and binary hashes with the results.
The default pin in `scripts/build-spry-node-fixture.sh` includes the bounded
group budget from [Spry PR39](https://github.com/forgesworn/spry-turn/pull/39).
An older backend that fails the current readiness contract is a fixture
failure, not a passed or failed media call.

The direct authenticated TURN test first establishes the allocation budget:
seven devices need at least 42 allocations. The previous 32-port profile
admitted 32 and refused 10. The group fixture explicitly configures 256
allocation ports, 32 allocations per credential and 256 TCP connections,
leaving room for replacement connections during credential renewal. Its
aggregate bandwidth remains 2,000,000 bytes per second. Existing installations
retain their 32-port default unless the operator configures the larger range;
this test does not qualify the old profile for seven devices. Use a compatible
Spry build that accepts the explicit group budget.

`E2E_PORT` and `E2E_RELAY_PORT` move the local preview and companion relay.
The default duration is 120 seconds, bounded between 120 seconds and three
hours. A longer run exercises normal credential expiry and renewal. Tests
remain serial and opt-in; ordinary CI must not count a skipped endurance test
as a completed call qualification.

Every checkpoint maps the SDP origin of each connected peer to the opposite
device. Each of the 42 directed paths must advance video and expected audio
within four 2.5-second windows, comparing counters only within one native
connection generation. Independent device renewals need not leave the whole
call on unchanged generations at once. Every pair must still have a connected
transport at the final sample; relay counters accompany each checkpoint. Selected local
and remote ICE candidates must both be relays. Expected speaking devices
must show increasing received audio energy, while every active audio sender
must advance RTP packets. An inactive own-account monitor is not an echo
requirement. The creator keeps one active microphone. The test moves the listening role
to the creator's second device, then back.
Rendered remote pictures must keep moving. The test also checks a camera
stop/restart, a guest network interruption, final seven-way chat delivery and
absence of room-event publications on account relays.

Playwright attaches per-connection samples, credential request counts and
errors to `node-endurance.json`, including a final sample on failure. It
closes its contexts, browser and native fixture resources afterwards. The
caller must stop any independently started emulator and remove task-owned
source/build staging after preserving the result.

The fixture maps only its synthetic node ICE hostnames to loopback after the
client validates the node configuration; credentials, ports, transports and
relay-only policy are preserved. This avoids platform ICE DNS differences but
does not qualify public DNS or TLS. Invitations open in a fresh tab of each
signed-in profile. Same-document invitation navigation remains a separate
acceptance case.

This is browser and loopback evidence. It does not establish a physical
GrapheneOS, packaged desktop, separate-network, VPN, Wi-Fi/cellular, acoustic
or perceived-camera result. Use `test/kithmoot-node-cross-client.spec.ts` for
the separately guarded native-device qualification; finish with the actual
owner and peer devices before calling the live call accepted.

For a separately guarded Linux backend check, set `E2E_NODE_GROUP_BUDGET=256`
when running `test/kithmoot-node-backends.mjs`. It holds 42 admitted allocations
across UDP, TCP and TLS before exercising removal, isolation and closure.
This native protocol check does not measure perceived audio/video quality.
