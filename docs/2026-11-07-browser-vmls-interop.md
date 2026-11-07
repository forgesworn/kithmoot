# Browser scoped VMLS interoperability

Status: **scoped local interoperability pass; non-shipping dependency exception approved; PR review and hosted CI pending**

## Source and artefact identity

- Shared contract/vectors: standalone `forgesworn/vmls-core` `1c0adece2ec71ccfca0d98cafc7e3ddb0ebf33a2`, crate 0.1.2.
- Browser engine source: Vennel `c154087ecfc43ee9404fa4d548cdc94c0789afef` (including `9ceaf3317ed2fd28f0abb4073dfd4e4e6258c6ab`). Vennel-only invitation/admin modules and record variants remain separate from the public standalone crate.
- KithMoot base: `3dee09bd4d23ddf6bfb720cdb7fd1cb6259e5482`.
- Browser package: Rust 1.94.1, wasm-bindgen 0.2.129, `--target web`.
- `vmls_wasm.js`: 80,757 bytes, SHA-256 `25a9f7dca37e6dc2320d1dabb74b5f3b64b34d52cd43f1edb55ae0230c43c02d`.
- `vmls_wasm.d.ts`: 38,845 bytes, SHA-256 `60eb73438adaf3c582f33855b4f06d147036898e4c54c28e67b6613c17ad5007`.
- `vmls_wasm_bg.wasm`: 2,306,049 bytes (721,194 deterministic gzip bytes), SHA-256 `7f2544dcfdacfa7aa350b077969aebc0c9f8879fd5a80edc83404dafefbd2faf`.
- The TypeScript binding fixture is byte-identical to the standalone fixture and covers 43 cases, including duplicate `d` with missing scope and expired/future-dated precedence.

The loader and manifest name the same Vennel commit. `node scripts/check-vmls-wasm.mjs` verifies that relationship and all three asset hashes.

## Verification completed locally

- Vennel: both core feature modes pass 61 tests each; both Rust 1.87 library modes pass; full `npm run check` passes; native/WASM adapters pass 28 tests; the dependency graph target matrix passes. All 11 shared vector files regenerate byte-identically to standalone `1c0adec`. Changed-attempt and poisoned-expectation negative controls both reject as required.
- KithMoot: 44 TypeScript binding tests pass, including the two new cases. The final pinned room-creation smoke suite passes 28 Chromium tests. Typecheck, production build, `npm audit --omit=dev`, and all four app lifecycle/production-gate browser tests pass.
- All 623 Chromium and all 623 Firefox `playwright.mls.config.ts` tests pass with no failures. The one-hour combined process then timed out before WebKit began. Host WebKit fails during page creation with `Unknown setting: PushAPIEnabled`; an unmodified baseline at `3dee09b` fails identically, confirming a pre-existing host protocol mismatch rather than a VMLS regression. All remaining 623 WebKit tests pass in the exact pinned Playwright CI container (45.8 minutes), completing 1,869/1,869 tests. The isolated full `npm test` run passes 8,942 tests with eight skipped and one file skipped. An earlier attempt had 16 timeout failures while the browser and Vennel suites ran concurrently; the isolated result supersedes that infrastructure-limited attempt.

## Scenario evidence and limits

| Scenario | Local result | Evidence class and remaining limit |
|---|---|---|
| 1. Binding lifecycle | **pass (scoped)** | Independent TypeScript reader agrees with the Rust fixture outcomes; actual browser device-authentication fixtures pass. The unsigned signer view cannot itself check a carrying leaf, so that part remains a Rust reference/vector check rather than a second independent browser implementation. |
| 2. Capability and Welcome | **pass (fixture)** | VMLS vectors, WASM adapter Add/Welcome/replay cases, and real-browser membership fixtures. No live external mailbox service. |
| 3. Every record kind | **pass (upstream vector/adapter)** | All record vectors, padding boundaries and hostile adapter inputs pass. A separate end-to-end Browser exchange for every kind is **not run**. |
| 4. Record retry/replay | **pass (fixture)** | Exact retry, conflicting resealing, pending-Add redeposition, lost answers and durable outbox fixtures. No public-network replay test. |
| 5. Commit slots | **pass (fixture)** | Ordered/void attempts, exact receipts, contradictory and reordered evidence through the real engine and browser room fixtures. No live box service. |
| 6. Witness transitions | **pass (fixture)** | Real browser storage/WASM with a disposable signer covers advance, conflict, retirement, wrong challenge/subject/status, sequence and restore cases. Not a real external witness deployment. |
| 7. Allocation forwarding | **pass (scoped fixture)** | Strict request/reply and grant custody fixtures pass. No independent live allocation service or uncertain external store result after token consumption. |
| 8. Manifest restore | **pass (vector/browser fixture)** | All 12 manifest cases, including exact integer boundaries and control text, plus real browser restore/fault cases. |
| 9. Lane behaviour | **not run in the Browser app** | The 48 upstream lane vectors pass, but production MLS/lane wiring is unavailable; no Browser end-to-end lane recovery or sheltered-content claim is made. |

The independent cross-implementation exchange is the TypeScript/Rust binding fixture. Other results use the Rust engine through its WASM boundary and Browser host fixtures; they are not presented as independent second implementations. The unsigned-reader assertion accounts for every unframed vector explicitly through the five fixed hostile cases.

Production `Platform` construction currently omits the optional revoked-credential list, so the new tombstone gating cannot fire in product. That pre-existing limitation is not revocation-enforcement coverage; production MLS remains disabled. The `separatePerson` guest fixture reuses the adder's rendezvous key. Its person key equals the current guest device key in the ordinary path and the previous guest's device key in competing variants, so it has no independent person identity and provides no complete second-person exchange proof.

## Dependency disposition

A fresh `cargo audit` with 1,422 advisories reports no issue in the 71-package core lock. Every consumer lock nevertheless reports `RUSTSEC-2026-0387` through OpenMLS's retained `crypto-bigint` 0.5.5 line and `RUSTSEC-2026-0330`/`RUSTSEC-2026-0331` through `libcrux-kem` 0.0.9. On 7 November 2026 the owner explicitly approved Vennel's **non-shipping exception** for exactly those three advisories at the unchanged consumer lock hashes. Vennel `517dfd42eefc13ad0433d0b8240d1ddc5f347192` records the exposure analysis, raw unignored findings, successful audits with only those IDs ignored, and closure conditions. It also enables Vennel's PR and post-merge CI triggers. No stable compatible OpenMLS provider remediation is currently released; no unreleased pin, provider fork or backport is authorised.

The WASM source and assets remain those identified above from `c154087`; the exception commits change documentation and CI only. This decision permits PR review and hosted CI, not deployment, production use or shipping. Merge remains a separate decision after fresh review and hosted CI. Any new advisory, changed lock, provider, feature, target or flag, enabled draft/hybrid/other ciphersuite, or newly demonstrated reachable affected operation requires a new disposition.

No screen or user interaction changed. Production MLS remains disabled. No deployment, public-network test, real external service, physical device, human security approval or production acceptance is claimed.
