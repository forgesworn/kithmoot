# Browser MLS disposable witness lab

`playwright.mls-live.config.ts` drives the production browser storage,
coordinator, enrolment controls and pinned Link/MLS WASM against a real
`bothyd` process. The keeper commands use that daemon's CLI. Each test creates
fresh private data and independent witness directories, then removes them
and stops its processes. It never opens an existing Bothy data directory.

The lab is opt-in and separate from offline CI:

```sh
# In an up-to-date Bothy checkout:
cargo build --locked -p bothyd

# In this checkout, with an explicitly chosen WebPKI Link relay:
BOTHYD=/absolute/path/bothy-node/target/debug/bothyd \
LAB_RELAY=wss://your-lab-relay.example/link \
npx playwright test -c playwright.mls-live.config.ts
```

The Vennel lab's `lab/services.mjs` provides `linkRelay(checkout, port)` for
a loopback relay with the lab's existing WebPKI certificate. It must remain
running for the test command. This run used that loopback service; it did not
use a public relay or production witness. The daemon disables direct paths
and its loopback HTTP listener, and points Nostr at an unused loopback port.

The browser page is served by a real loopback HTTP server, a secure browser
context. A synthetic route-fulfilled origin was rejected by Chromium's
local-network access checks; no browser network permission checks or TLS
validation are disabled to make this lab work.

Pairing capabilities remain in memory. Daemon stdout is discarded, the CLI's
pairing output is captured without logging, and Playwright traces, screenshots
and video are disabled. The UI clears the password input on submission.
Assertions and documentation contain no live pairing capability or key.

## Coverage and limits

| Case | Mechanism |
| --- | --- |
| Enrolment controls | Prepare, real witness-only pairing, saved keeper command, refusal before CLI enrolment, fresh signed confirmation after enrolment |
| W01–W03 | Chromium's whole process group receives SIGKILL after completed IndexedDB staging, an actual accepted advance, or completed promotion; fresh processes recover the exact candidate without returning the interrupted effect |
| W04 | A real accepted advance reply is discarded at the test adapter; pending returns without an effect, then a new process reconciles |
| W05–W06 | Restore either Chromium's IndexedDB directory or its entire stopped profile from an older copy, including MLS records, keys and markers; the separately retained witness fences it |
| Witness rollback / retained duty | Restore the stopped daemon's independent witness directory behind the browser; the browser fences, retains its retirement duty through offline clear/reload, refuses a keeper-assertion override, then resolves the duty only after a fresh signed reply |
| W08 | Two copied profiles prepare different candidates for the same predecessor, then fresh independent processes contend; transport supersession may hold an operation, but reconciliation permits one candidate and fences the other |
| W09 | Stop/restart the daemon, then retire the subject using the keeper CLI; an outage holds state, retirement fences, and explicit recovery permits fresh identities |
| W10 | Capture a real signed read and substitute it under a later challenge; also damage a real receipt signature; neither permits the proposed mutation |
| W11–W12 | Remove the staged objects after an accepted but discarded reply, or remove the inner key; reload fences without fresh genesis or a new effect |

The process-kill, filesystem rollback and clone cases currently run only in
Chromium. Firefox and WebKit run the real pairing/UI, receipt, missing-stage
and missing-key cases; they explicitly skip the two Chromium process tests.
The fault hooks are in test code only. Receipts otherwise come from Bothy's
real SQLite witness through its live witness-only pairing slot and real Link
sessions, with no injected endpoint or receipt signer.
Vault and session mutations contain synthetic byte records; these tests do
not create an MLS room or exchange chat messages.

This does not close every W01–W12 acceptance requirement: wrong-key receipt
signing remains fixture evidence (the live lab damages an existing signature).
It also does not prove physical-browser persistence, a full-app account/mode
transition during pairing, MLS vault migration, room behaviour or production
peer delivery. The panel is mounted in a small lab page, while the existing
full-app preview tests cover host lifecycle wiring separately. The subsequent
[client security review](browser-mls-security-review.md) approves only the
production-disabled foundation merge; production integration and its review
remain open.

## Rehearsal inputs, 9 October 2026

Result: **17 live checks passed**, with four explicit Firefox/WebKit skips
for the two Chromium process tests. The main run passed 14 checks; the
additional restored-witness retirement run passed all three browser projects.
Typecheck passed. These are additional acceptance tests; production code did
not change from the preceding 180-case browser/3,399-test unit checkpoint.

- Bothy source: `6f25f9f0b8d84071257437fed22cf3d5bd5aa4cd`, built locally
  with Rust 1.94.1 and `cargo build --locked -p bothyd`. Binary SHA-256:
  `61a7d01e0b814ee6adc5666571901ac86492420b0ec7f6e9a3a3ddb65af6997a`.
- Browser MLS WASM: `d91a23d1978ef08c22709181e16ab158d95c98cd`;
  browser Link WASM: `5537c4d29f85b3d1c1275809e14d7d9459cd8b08`,
  both the existing pinned assets in this repository.
- Existing loopback relay binary SHA-256:
  `81fd3389bc472e726279760b04beec6c2445dd971e64b453b4412e8acbe5bead`;
  relay checkout HEAD: `d363a30e5e0cae6628f0ed413d49ac68fba91817`.
- macOS, Node 24.13.0, Playwright 1.62.1. Browser versions come from that
  Playwright installation. No physical handset or deployed daemon was used.
