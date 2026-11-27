# Automatic Spry standby in relay-only browser calls

27 November 2026

Two browser clients recovered the same room call after a Spry process
stopped and after a local proxy silently discarded its traffic. Each
client reviewed and saved one login per relay through Settings. Both
faults passed in three runs each. The standby received no connection
before the fault.

| Fault | Audio recovery observed | Video recovery observed |
| --- | --- | --- |
| Primary stopped | 611–631 ms in both directions | 611–631 ms in both directions |
| Silent loss | 8,802–8,809 ms in the unmuted direction | 8,802–9,429 ms in both directions |

The time starts just before the fixture cuts the route. The receiver
must select a new relay/relay candidate pair using TLS and show growing
inbound counters. During silent loss one participant kept their mic
muted. After the switch their audio sender stayed disabled and the
receiver's audio energy stayed flat in the test window. Audio resumed
368–396 ms after the participant deliberately unmuted.

Chat flowed during the outage and after recovery. Participants kept
their room links, page instances and saved settings. The receiver
displayed fresh protected share frames with the private marker covered
after switching. Each peer configuration used exactly one of that
device's approved logins and retained the relay-only policy. The browser
fixture denied external HTTP and WebSocket traffic and observed no
attempt.

## Reproduce

The test used Playwright 1.62.1 Chromium on macOS arm64. Two Spry
processes shared the same loopback host and used separate certificates
and authentication secrets. The test Chromium ignores fixture
certificate errors. The Spry source was
[`0ef20ce`](https://github.com/forgesworn/spry-turn/tree/0ef20ce652be08572b71d717c58c85baed6fa528).
The SHA-256 of its local TLS-enabled binary was
`d14548beb4c4a987b6693fc3595d95bca3607072609817f5e96c871cb24e51cc`.

Build Spry with `cargo build --locked --release --features tls --bin spry-turn`.
Run the test from KithMoot after installing the locked npm dependencies
and Playwright Chromium.

```sh
E2E_SPRY_RELAY_BINARY=/absolute/path/to/spry-turn npm run test:spry-failover -- --repeat-each 3
```

The browser test covers established calls using a device's saved relay
settings. Public certificate validation, separate networks, fresh guest
bootstrap and physical handset handover have their own acceptance steps.
[Independent call requirements](call-independence-requirements.md)
