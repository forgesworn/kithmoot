# Security Review — 2026-10-15

Scope: full delta review of everything changed since the 2026-09-20 review
(`22f1f27..12911b1`, ~1,215 files, ~135K lines: 328 non-test, non-asset source
files), across the three tiers agreed for this pass:

- **Tier 1** — the new vMLS group-encryption binding and revocation flow; epoch,
  rekey and seal machinery; the browser-link ("Bothy") pairing and in-browser
  credential vaults; live-meeting admission (requester and keeper sides);
  meeting moderation and call recording.
- **Tier 2** — the desktop updaters (archive, package, manifest signing);
  desktop redaction boxes, area share and marks overlay; node runtime
  (`cli.ts`, state lock, self-destruct); relay connection guards and room
  relay governance; message ordering; session/roster/control deltas.
- **Tier 3** — deploy and release tooling (Caddy, blossom, install scripts,
  zapstore/Android publication proofs, download manifest); `server/` TURN and
  forwarder deltas; secrets sweep of the whole delta; `npm audit --omit=dev`.

The 2026-09-20 full-tree review (`SECURITY-REVIEW.md`) stands as the baseline;
only its Finding 1 is re-examined here for status. The circle layer itself
(identity, credentials, epochs, member-epoch catch-up) now lives in the pinned
dependency `github:forgesworn/fold-kit#eaa3495127e55242cf8a09e4c57963c570d68e8d`;
this review covers the in-repo integration and all of its callers. A dedicated
review of fold-kit at that SHA is recommended if it has not had one.

## Findings

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | MEDIUM | package-lock.json | — | Five known-vulnerable transitive dependencies via `@modelcontextprotocol/sdk@1.30.0`, including critical-severity `proxy-addr` IP-spoofing advisory. No reachable path in current use; audit regressed from 0 to 5 findings. | 9/10 (presence), 9/10 (non-reachability) |
| 2 | LOW | src/node/cli.ts | 135-136, 941-944 | `--turn-credential user:pass` is argv-only and, unlike `--nsec`, never warns that any local user can read it from `ps` | 8/10 |
| 3 | LOW | app/src/profiles.ts | 145-168 | **Unchanged from 2026-09-20 Finding 1.** Automatic NIP-05 fetch to attacker-controlled domain leaks participant IP/timing; still default-on (`relay-settings.ts:423-425`, `!== 'false'`) and still ungated by the anonymous/Tor network profile | 9/10 |

### Finding 1 — Vulnerable transitive dependencies; audit is no longer clean (MEDIUM, 9/10)

`npm audit --omit=dev` now reports **5 vulnerabilities (1 critical, 2 high, 2
moderate)**; the September review recorded 0. All five arrive transitively
through `@modelcontextprotocol/sdk@1.30.0`:

- **proxy-addr 2.0.7** (critical): IP spoofing via IPv4-mapped IPv6 trust
  subnets — relevant only to an Express HTTP server making X-Forwarded-For
  trust decisions.
- **@modelcontextprotocol/sdk itself** (high): OAuth client could send
  credentials to an authorization server chosen by the MCP server — relevant
  only to the SDK's OAuth client flow.
- **fast-uri 3.1.6** (high, three advisories): authority injection / host
  confusion — reached via ajv's URI validation.
- **ip-address 10.7.0** (moderate, two advisories): cross-family subnet
  comparison and unbounded parse diagnostics — via express-rate-limit.
- **hono 4.13.5** (moderate): JSX boundary-component XSS — via the SDK's
  HTTP transport stack.

**Reachability: none in any shipping configuration.** Both MCP call sites
(`src/node/mcp.ts`, `packages/context-tools/src/context-mcp.ts`) instantiate
`StdioServerTransport` only. No Express/Hono HTTP server is ever created, no
OAuth client flow is run, no remote input crosses ajv URI validation, and no
JSX rendering exists in the codebase. Verified by import audit.

This is nevertheless a regression worth fixing on hygiene grounds:

1. The tree now ships a critical-labelled dependency; anyone benchmarking the
   project on `npm audit` sees it.
2. The moment an HTTP/SSE MCP transport or dashboard is added, all five code
   paths become live without any new dependency being introduced.

**Suggested fix:** `@modelcontextprotocol/sdk@^1.30.0` permits `1.32.1`, which
carries refreshed ranges. Run `npm update @modelcontextprotocol/sdk` (or
targeted `npm update fast-uri proxy-addr ip-address hono`), re-run
`npm audit --omit=dev` to confirm zero, and then add that exact command as a
CI step so "0 production vulnerabilities" is a gate rather than a memory of
the September review.

### Finding 2 — `--turn-credential` exposes a credential in argv, silently (LOW, 8/10)

`src/node/cli.ts` accepts TURN credentials as `--turn-credential user:pass`
only. The value sits in the process's argument list for its whole lifetime,
readable by any local user via `ps`. The adjacent `--nsec` option does exactly
this and emits a loud warning pointing at `--identity <file>`; the TURN
credential has neither the warning nor a lower-exposure alternative
(`KITHMOOT_TURN_CREDENTIAL` is not among the mapped env vars), and the usage
text is silent about the exposure.

Lower-impact than an identity key (a per-allocation TURN password, bounded by
the TURN server's own secret rotation), which is why this is LOW. The
inconsistency with the code's own surrounding discipline is what makes it
worth a line here.

**Suggested mitigation:** accept the credential from an env var or a 0600
file, and emit the same argv-exposure warning `--nsec` gets when the flag is
used.

### Finding 3 — NIP-05 auto-lookup, unchanged (LOW, 9/10, carried forward)

Finding 1 of the 2026-09-20 review stands exactly as written. The fetch is
still automatic on seeing a `nip05` field, still default-on
(`profilePreference` returns true unless the stored value is `'false'`), and
none of the `profiles.setEnabled(...)` call sites in `app/src/main.ts` consult
the anonymous/Tor network profile. The `credentials: 'omit'` /
`redirect: 'error'` mitigations are intact. The September mitigations are
repeated here by reference: proxy lookups, provider allowlist, or
click-to-verify — particularly under the anonymous profile, which this delta
makes more prominent (fresh-persona enforcement, more identity surfaces).

## Areas reviewed with no reportable findings

- **vMLS leaf-binding reader (`src/vmls/binding.ts`):** byte-exact canonical
  CBOR streaming reader with the Rust reference's check order and stable error
  codes; only the seven-key unsigned body is accepted; per-field bounds
  (16 tags × 8 entries × 512 chars, 1 KiB content, 8 KiB body); the embedded
  kind-20460 person credential is re-verified end to end (NIP-01 signature,
  `d` = signer, `scope=person`, exactly-one hex device, canonical expiration,
  ≤30-day lifetime, ≤600 s future skew, revocation set) and the binding is
  refused if it outlives the credential. The vault is structurally unable to
  sign bytes it has not read.
- **vMLS revocation (`src/vmls-revocation-request.ts`):** NIP-59 seal +
  gift-wrap with a fresh throwaway key zeroed in `finally`; timestamps
  backdated through a CSPRNG-backed fraction; the rumour is re-validated
  against re-derived id, exact tag set, sender≠keeper, expiry windows;
  publication is explicitly `authenticate: false` (no NIP-42 identity leak)
  and only goes to the keeper's *verified latest* kind-10050 relay list.
- **Browser link / Bothy (`app/src/browser-link-*.ts`):** vault is one opaque
  AES-GCM-256 record under a non-extractable WebCrypto key in IndexedDB, AAD
  `kithmoot.browser-link.v1`; pairing codes are ≤10-minute capabilities that
  must never be logged or persisted; ≤16 routes; seeds and route secrets are
  zero-filled on every failure and close path; single-owner via Web Lock
  (busy tabs refuse rather than race rendezvous registrations); Link relays
  must be `wss://` without credentials or fragments.
- **Rendezvous vault (`app/src/rendezvous-vault.ts`):** non-extractable device
  key; scalar exposed only via a synchronous copy-then-wipe boundary;
  replacement requires a strictly higher index (anti-rollback); corrupt
  storage fails closed, never falling back to a locally minted key; MLS
  custody rides a cross-tab lock plus synchronous revision invalidation.
- **Coordinated MLS vault (`app/src/mls-coordinated-vault.ts`):** two-phase
  consent (reserve under the witness before prompting, complete under a fresh
  confirmation); journal entries replay-bound to generation *and* revision;
  a replayed request returns the identical stored signature without
  re-signing or re-prompting; replies carry WeakMap provenance and cannot
  leave the vault through any other path; approvals are scope-exact
  (principal, persona, device, homeBox, method); box-request authorisation is
  NIP-98-shaped with a monotonically enforced `created_at` (clock floor),
  sha256 payload binding, exact route allowlist (no query, no alternate
  encoding, empty-body rule on GET/DELETE). The device scalar is never logged
  and is wiped from record copies after every read.
- **Live keeper journal and store (`src/live-keeper.ts`,
  `src/node/live-keeper-store.ts`):** journal re-validates on load to a
  canonical-JSON round-trip; every cached admission answer is re-decrypted
  and re-derived (tags, expiration, signature, plaintext equality) before
  being trusted; epoch transitions must match signed rekey evidence and the
  epoch-chain commitment (`validateNext`); pending rekeys outside a
  −90 s/+5 s `created_at` window are refused; the store is AES-256-GCM with
  AAD per record, atomic temp-file rename with fsync of file *and* parent
  directory, owner-only directory enforcement, hard-link and mode checks,
  `O_NOFOLLOW` reads, and a SQLite `BEGIN IMMEDIATE` lease with
  inode/device pinning to detect replacement; save failure poisons the
  owner rather than falling back.
- **Live admission (`src/live-admission.ts`,
  `src/live-admission-responder.ts`):** requester side uses a disposable
  request secret zeroed on settle, dual wall-clock *and* monotonic 90 s
  deadlines, ≤8 concurrent owners, tight subscription filters and event
  shape caps, ≤64 answer checks. Keeper side has a durable per-minute budget
  (64 checks / 16 challenges / 64 KiB) held in a canonical-JSON ledger that
  refuses on any parse deviation, with a single process owner.
- **Meeting moderation and recording (`src/meeting.ts`,
  `src/live-recording.ts`, `app/src/call-recorder.ts`):** speaker list and
  recording notices are schnorr-signed by the room authority with
  domain-separated messages; newest-wins versioning with a monotone bump;
  non-canonical speaker lists are refused rather than mended (the list
  verified is the list enforced); member-announced captures must bind
  recorder, device and call id and cross-check against the roster
  signature; a stale recording notice fails toward *showing
  "unconfirmed"*, not hiding; the recorder only ever mixes tracks the
  meeting policy already permits to be heard, self-caps at the largest
  sealable file, and the notice must be published before capture starts.
- **Call bell (`src/call-bell.ts`):** outer event signed by a per-bell
  throwaway key (zeroed); rendezvous `d` tag is HKDF(epoch-key, day-string)
  so it is unlinkable across days and epochs and shares nothing with the
  roster; content is NIP-44 under a derived key; the inner device signature
  binds room/state/call/timestamps with a 120 s TTL and ±60 s skew;
  attribution through the roster is the caller's duty, as documented.
- **Contact invitations and inbox (`src/contact-invitation.ts`,
  `app/src/contact-inbox.ts`, `app/src/granted-contacts-client.ts`):** NIP-17
  wraps with exact-tag-set enforcement and re-derived rumour ids; sender and
  recipient are bound to the authenticated parties before any join is
  offered; the inbox journal is encrypted under a fresh local key whose only
  copy is NIP-44-sealed to self, caps on every list, strict load-time
  revalidation (pending entries must correspond to retained own invitations),
  and the outbox clears only on a relay ACK. The Signet pairing flow holds a
  human confirmation-code ceremony between approval and persistence,
  defeating photographed-QR first-approver substitution, and capabilities are
  allowlisted.
- **Session/member-epoch integration (`src/session.ts`):** the member desk
  answers catch-up requests only while this device is in step and unremoved,
  refuses unknown participants once the room has removed anyone (#207),
  surfaces unknown askers rather than answering them, detects and reports
  epoch conflicts (two signed rekeys for one epoch) and epoch gaps, and
  bounds retained epoch secrets and rekey evidence to
  `MAX_MEMBER_EPOCH_CHAIN`. The desk's crypto lives in pinned fold-kit (see
  scope note).
- **State lock (`src/node/state-lock.ts`):** exclusive `O_EXCL` create;
  stale-lock takeover only for same-host dead processes, mismatched boot ids,
  or unreadable locks older than a minute; a foreign-host lock is never
  taken; pid recycling can only cause a safe refusal; release removes the
  file only if it still reads as this process's own record.
- **Relay guards (`src/relay-dial-gate.ts`, `src/guarded-websocket.ts`):**
  process-wide per-relay dial backoff with a single in-flight dial lease,
  ending the relay-ban storm documented in the module header; guarded send
  drops frames after cancellation. Room relay lists are authority-signed,
  versioned, canonical-only, add-only (`src/room-relays.ts`).
- **Desktop updaters (`desktop/archive-updater.mjs`,
  `desktop/update-manifest.mjs`, `desktop/package-updater.mjs`,
  `scripts/update-signing.mjs`):** manifests are Ed25519-signed offline by
  keys compiled into the app (release + offline recovery key), domain-bound
  per manifest path; replayed old manifests cannot downgrade
  (`compareVersions <= 0` refuses); archives must match the signed SHA-256
  *and* byte count, counted while streaming and cut off at the manifest size;
  extraction asserts a single expected top-level folder with the executable
  and `resources/app.asar` before staging; the Windows swap is a fixed
  PowerShell script with `param()`-typed argv (no interpolation); install
  requires the exact phase and is once-only. Signing keys are
  passphrase-encrypted PKCS#8, written 0600 with `wx`, never printed (only
  fingerprints). Note: the passphrase file sits beside the key, which is
  obfuscation rather than separation — acceptable on a release machine, but
  the recovery key pair should live offline as documented in docs/updates.md.
- **Desktop shell delta (`desktop/main.mjs`, `redaction.mjs`,
  `share-area.mjs`, `screen-share.mjs`, `marks-overlay.mjs`,
  `context-menu.mjs`, `policy.mjs`):** display-capture requests remain
  main-process-mediated with a user gesture; while any redaction box is on,
  only whole screens are offered (a box cannot follow a window) and the
  system picker — whose choice is invisible to the main process — is no
  longer used, so an unmappable capture fails toward over-redaction, never
  leakage; redaction and marks windows are `about:blank`-anchored with
  regex-checked ids, navigation and window-open denied, click-through and
  placement owned by the main process (X11 shapes, cursor watch elsewhere);
  context menu opens only http(s) links through the existing confirm path;
  CSP gains `frame-src` restricted to the bundled same-origin girnel board
  surface, with `frame-ancestors 'self'` granted to that path only.
- **TURN minting service (`server/turn-credentials.mjs`):** refuses to start
  without `TURN_SECRET` (no default, by design); disallowed `Origin` is 403,
  never a wildcard (regression-tested); per-IP token bucket honestly
  documented as a speed bump; X-Forwarded-For trusts only Caddy's last-hop
  entry; per-mint random usernames make `user-quota` allocate per session.
- **Release tooling:** notary keychain wrapper scope-locks the keychain for
  one allowlisted `notarytool` invocation, with `O_NOFOLLOW`/owner/0600/size
  checks on the password file, secret zeroing and verified lock restoration;
  zapstore/Android publication proofs re-verify Nostr signatures, pin the
  publisher key, require the release→asset reference (relay filters treated
  as hints, not proof), allowlist download URLs, and hash-count the served
  APK byte-exactly; `download-versions.mjs` uses argv-array ssh and
  NUL-delimited `xargs`, and classifies paths by strict regex before hashing.
- **Deploy:** `deploy.sh` now refuses to deploy if the signed update
  manifests fail verification; the Caddyfile adds per-path CSP and
  Permissions-Policy (downloads page and marketing pages get
  `default-src 'none'` variants), HSTS, and keeps `frame-ancestors 'none'`
  everywhere but the girnel surface; blossom's `removeWhenNoOwners: true`
  matches the one-owner-per-upload envelope design.
- **Secrets sweep:** the entire delta was grepped for key material and
  hardcoded credentials; all 64-hex literals found are public keys, test
  vectors, package hashes, or the two published update-verify public keys.
  The vendored WASM (`girnel-embed`, vmls) is pinned by SHA-256 at build time
  (`scripts/check-vmls-wasm.mjs`, `check-link-web.mjs`).
- **Supply-chain pinning discipline:** `signet-login` moved from a tarball
  URL to an exactly-pinned registry version (0.17.1); the two git-sourced
  first-party deps (`fold-kit`, `signet-contacts`) are pinned to immutable
  commit SHAs; the vendored `girnel-embed` tarball carries lockfile
  integrity.

## Overall assessment

The posture that made the September review short has held through a very busy
three weeks: new capability came in with its threat model written down in the
module header, capabilities enforced structurally, keys zeroed at boundaries,
and every cross-checkpoint (admission→journal→store, consent→journal→reply,
manifest→download→swap) verifying at each step rather than trusting the last.

The one behavioural finding of September (NIP-05) is untouched and carries
forward unchanged. The one new actionable item is not in application code at
all but in the dependency floor: the audit-clean state regressed via the MCP
SDK, and the durable fix is a one-line CI gate. Beyond that, `--turn-credential`
deserves the argv warning its neighbours already have.

**Recommended actions, in order:**

1. `npm update @modelcontextprotocol/sdk` (or targeted transitive bumps),
   confirm `npm audit --omit=dev` is 0, and add it to CI as a required gate.
2. Take one of the September NIP-05 mitigations — click-to-verify under the
   anonymous profile is the smallest that changes the attack's economics.
3. Move `--turn-credential` to env-or-file input with the same warning
   `--nsec` emits.
4. Schedule a review of `forgesworn/fold-kit` at the pinned SHA now that the
   circle layer lives there; this repo's integration was reviewed here, the
   library's internals were not.

## Follow-up (same day)

All three findings were addressed immediately after this review, in the
commits that landed it:

- **Finding 1:** `@modelcontextprotocol/sdk` 1.30.0 → 1.32.1 (the exact pin
  in `packages/context-tools` had been what held the floor) plus transitive
  bumps of `fast-uri`, `proxy-addr`, `ip-address`, `hono`, `express`,
  `express-rate-limit` and `ajv` within their ranges. `npm audit --omit=dev`
  now reports 0 vulnerabilities; full suite (303 files, 4,230 tests) green.
  The recommended gate landed with it: `npm audit --omit=dev` is now a
  required step of the CI `test` job, so the zero-finding state is enforced
  rather than remembered.
- **Finding 2:** `KITHMOOT_TURN_CREDENTIAL` is now accepted and preferred,
  and using `--turn-credential` emits the same argv-exposure warning
  `--nsec` gives.
- **Finding 3:** automatic NIP-05 verification is now **opt-in, default
  off**, rather than automatic with an off-switch. `ProfileBook` holds a
  claimed address unverified until the person turns on "Verify Nostr
  addresses" in profile settings (which then checks every claim already
  held, and can be switched back off with in-flight checks aborted and late
  answers ignored). The honest settings copy names the cost: the address's
  domain — chosen by the person being looked up — learns the visitor's IP,
  timing and rough browser. Behaviour under the (library-level, not yet
  user-exposed) anonymous/Tor profile should remain "never automatic":
  when that profile reaches the app, it must force this preference off
  regardless of the stored value — noted as a requirement in
  `app/src/profiles.ts`. Unit tests pin both the default-off gate and the
  toggle-on/off lifecycle.

## Adjacent review: forgesworn/fold-kit at `eaa3495`

The scope note's deferred item was also taken in this pass: the
security-critical modules of the pinned fold-kit were reviewed in the
installed distribution (`node_modules/@forgesworn/fold-kit@0.12.0`,
`git+ssh` resolved at `eaa3495127e55242cf8a09e4c57963c570d68e8d`):
`epoch.js`, `member-epoch.js`, `seal.js`, `credential.js`,
`live-persistent-admission.js`, `mls-admission.js`, and
`invitation.js`'s delegation-chain and grant-decoding paths.

No reportable findings. Highlights worth recording:

- **Member epoch catch-up** is trustless end to end: every intermediate
  epoch secret is proven by the next rekey decrypting under it (NIP-44 MAC),
  and the last epoch requires the authority's in-body commitment; a chain
  that removes the requester is refused; the requester subscribes to
  authority-signed rekeys first and refuses any grant that ends below that
  floor, so a removed member cannot pin anyone to an epoch it can still
  read. Desks never answer removed or (post-first-removal) unknown
  participants, grants travel under one-time signers sealed to the asking
  device, and amplification is damped by jitter plus a once-per-device
  stand-down rule.
- **Epoch requests** prove admission by an HMAC under a key derived from
  the epoch-0 room key, domain-separated (request-key info), compared in
  constant time, and bound to device/room/authority/timestamp; the request
  body is itself NIP-44-sealed to the authority. Legacy (proof-less)
  participants are an explicit configured set, not a fallback.
- **Rekeys** move the room forward by exactly one epoch, refuse a
  scheduled rekey that removes or closes, encrypt the body under the epoch
  being left, and carry an optional commitment that member-serving code
  requires for the chain's head when it can check it.
- **Credentials/seal keys:** the credential verifier fails closed on a
  non-finite expiration (with a comment naming the fail-open trap it
  avoids), person credentials are capped at 30 days measured from the
  signed `created_at` with a mint-time restamp error for remote signers
  (#205), and seal-target selection refuses the healing-breaking fallback
  of sealing to a copied device key when the credential names a seal key.
- **MLS admission v4** is the strictest parser in either repository:
  canonical-JSON with a hand-rolled depth limit (≤8), fixed-size padded
  envelopes verified both directions, exact deadline arithmetic, credentials
  doubly capped (from `created_at` and from `now`), capability handles via
  frozen null-prototype objects in a WeakMap with revalidation at retained
  use, and every caller secret copied and wiped on exit paths.

One informational note: `encodeMemberEpochGrant`'s one-time grant signer is
not zeroed after signing, unlike the `finally { …fill(0) }` discipline used
for the revocation wrap's ephemeral key and throughout this repository.
Impact is negligible — a grant is trusted only for its authority-signed
contents, so the signer's disclosure re-signs nothing of value — recording
it only for consistency of hygiene.
