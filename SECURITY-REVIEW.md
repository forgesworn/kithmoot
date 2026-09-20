# Security Review — 2026-09-20

Scope: full working tree review of the kithmoot codebase, covering injection, XSS,
cryptography, authN/authZ, secrets in source, path traversal, SSRF, deserialization,
the desktop Electron shell, the LLM pipeline, and `npm audit` on production
dependencies. Also reviewed the current branch diff (`app/src/call-profile.ts`
default flip plus tests — benign).

## Findings

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | LOW | app/src/profiles.ts | 145-168 | Automatic NIP-05 fetch to attacker-controlled domain leaks participant IP/timing (de-anonymization vector) | 9/10 |

### Finding 1 — Automatic NIP-05 lookups leak participant IPs (LOW, 9/10)

**File:** `app/src/profiles.ts:145-168`

When a room participant's kind-0 profile contains a `nip05` field, every other
participant's client automatically fetches
`https://<domain>/.well-known/nostr.json?name=...`, where `<domain>` is fully
controlled by the profile owner (the regex at line 147 only enforces hostname
shape). A malicious room member can set their own NIP-05 address to a domain they
operate and thereby learn the IP address, timing, and rough client fingerprint of
every participant whose client renders their profile — a de-anonymization vector
in an app that otherwise goes to great lengths (Tor profile, unpublished device
credentials) to protect participant identity.

The fetch uses `credentials: 'omit'` and `redirect: 'error'`, which limits but
does not remove the IP disclosure. There is an off-switch, but the behaviour is
enabled by default.

**Suggested mitigations:**

- Proxy NIP-05 lookups through a relay/server-side fetch, or
- Restrict auto-checks to a well-known provider allowlist, or
- Make NIP-05 verification click-to-verify rather than automatic — particularly
  when the anonymous/Tor network profile is active.

## Areas reviewed with no reportable findings

- **Injection (SQL/command/template):** No `eval`/`new Function`. All
  `child_process` uses are `spawn`/`spawnSync`/`execFileSync` with argument arrays
  (no shell). The only SQL is fixed `PRAGMA`/`BEGIN`/`ROLLBACK` strings.
- **XSS:** Message rendering uses `textContent` throughout; the only `innerHTML`
  uses clear containers. Linkification only anchors `http(s)` URLs with
  `noopener noreferrer`. Attachment previews use locally-minted `blob:` URLs
  after decryption/hash verification.
- **Crypto:** HKDF with distinct domain-separated info strings, ChaCha20-Poly1305
  with salted per-session IVs, schnorr/NIP-44 via noble libraries, CSPRNG
  everywhere security-relevant. Nostr event signatures verified through
  `verifyEventUncached`, which strips the forgeable `verifiedSymbol` cache.
- **AuthN/AuthZ:** TURN minting service is unauthenticated by documented,
  rate-limited, CORS-gated design. Agent host command authorization is
  re-verified at every use. Forwarder refuses to start if a room key is present
  in its environment.
- **Secrets in source:** None found. Documentation contains only placeholders;
  deployment config uses env-var indirection. No default TURN secret by design.
- **Path traversal:** `desktop/policy.mjs localAsset()` rejects `..`, backslashes,
  NULs, and verifies the resolved path stays under the web root. Journal paths
  are regex-constrained to hex IDs.
- **SSRF / unsafe fetches:** Relay URLs must be `wss://` (ws only on localhost).
  Attachment/context fetches are https-only, size-capped, hash-verified against
  signed descriptors, and origin-allowlisted. L402 client refuses uncapped or
  amountless payments.
- **Deserialization:** All inbound Nostr payloads pass strict validators (size
  caps, hex/shape regexes, timestamp sanity) before use.
- **Desktop shell:** `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`; navigation/redirect/webview locks; permission handlers gated
  to the trusted origin; external links require confirmation; updates only via
  Electron's signed `autoUpdater` over a pinned HTTPS feed.
- **LLM/XPIA:** Room messages reach the model only as user-turn content; the
  model has no tool-execution capability; output is parsed into
  say/whisper/quiet and posted as ordinary room messages; provider errors are
  never echoed to the room.
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities. The one
  GitHub-sourced dependency (`signet-login`) is pinned to an immutable commit
  SHA; first-party `@forgesworn/*` packages are version-pinned.

## Overall assessment

The security posture of this codebase is unusually strong — threat models are
documented in-line, capabilities are enforced structurally rather than by
convention, and key material is consistently written mode-0600 and kept out of
argv and logs. Finding 1 is the only issue that survives the confidence/impact
thresholds.
