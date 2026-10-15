# Security remediation — changes and where they landed

Companion to `SECURITY-REVIEW-2026-10-15.md`. That document is the review;
this one is the fix list for the three findings it recorded. Everything below
is committed on `main`; the only remaining work is the two deferred items at
the end, which are gated on other work rather than forgotten.

## Finding 1 — vulnerable transitive dependencies (MEDIUM) — `62c2061`, `b2639f3`

**Problem.** `npm audit --omit=dev` regressed from 0 to 5 advisories (critical
`proxy-addr`, plus MCP SDK OAuth, `fast-uri`, `ip-address`, `hono`), all
pulled in transitively by `@modelcontextprotocol/sdk@1.30.0`. None of the
vulnerable code paths was reachable — every MCP use in this tree is stdio —
but the floor was no longer clean and the next HTTP transport would have
inherited all five.

**Changes:**

| File | Change |
|------|--------|
| `packages/context-tools/package.json` | The exact pin `"@modelcontextprotocol/sdk": "1.30.0"` — the thing that held every resolution at the vulnerable version — bumped to `1.32.1` |
| `package-lock.json` | Resolved the SDK at 1.32.1 for both the workspace and the root (`^1.30.0`), and moved `ajv`, `express`, `express-rate-limit`, `fast-uri`, `hono`, `ip-address`, `proxy-addr` to their patched versions within declared ranges |
| `.github/workflows/ci.yml` | New required step `Audit production dependencies` (`npm audit --omit=dev`) in the `test` job, immediately after `npm ci`, so a clean floor is enforced on every push and pull request |

**Verified:** `npm audit --omit=dev` → 0 vulnerabilities; `npm run build:lib`
clean; full suite 303 files / 4,230 tests green.

## Finding 2 — `--turn-credential` in argv (LOW) — `e4c7c2b`

**Problem.** The TURN credential was accepted only as a command-line flag,
visible for the process's lifetime to any local user running `ps`. The
adjacent `--nsec` already warned about exactly this; the TURN flag did not.

**Changes (all in `src/node/cli.ts`):**

- Usage text for `--turn-credential` now says the value is visible via `ps`
  and names the alternative.
- `KITHMOOT_TURN_CREDENTIAL` (`user:pass`) is accepted from the environment,
  joining the other `KITHMOOT_*` mappings documented for a systemd
  `EnvironmentFile`; a flag still wins over the environment.
- Constructing the credential from the *flag* emits the warning, worded in
  parallel with the `--nsec` one: the credential is on the command line,
  readable by anyone on the machine, prefer the env var.

No behaviour change for existing invocations beyond the warning.

## Finding 3 — NIP-05 verification was automatic (LOW, carried from 2026-09-20) — `64e2212`

**Problem.** Rendering a participant's kind-0 profile automatically fetched
`https://<claimed-domain>/.well-known/nostr.json`, letting a room member
point every peer's client at a server they run and collect IP/timing/
fingerprint — with the behaviour on by default and ungated by anything.

Verifying an address is now **opt-in**: claims are held and shown only after
the person asks for checks. Nothing fetches from a claimed domain out of the
box, and an already-running check cannot publish its answer after the switch
is turned back off.

**Changes:**

| File | Change |
|------|--------|
| `app/src/profiles.ts` | `#found` records keep the raw claim (`nip05Claim`). New gate `#nip05Automatic` (default off) and `setNip05Automatic()`: enabling checks every held claim; disabling aborts in-flight checks. `#ingest` stores the claim and only checks when the gate is on. `#checkAddress`'s late-answer guard additionally refuses when the gate is off, so a response in flight at switch-off can never reach the profile. Module header rewritten to state the cost of the check and why it is never automatic, including the standing requirement below |
| `app/src/relay-settings.ts` | New `nip05VerifyPreference()` reading `kithmoot.nip05.verify` (default off), beside `profilePreference()` |
| `app/src/main.ts` | Imports the preference, applies it to the `ProfileBook` at startup, and wires the new checkbox (persist on change, apply immediately) |
| `app/index.html` | New "Verify Nostr addresses" checkbox in profile settings; the old blanket sentence claiming addresses were checked as part of the profile toggle was replaced by copy that names the real cost of each switch separately (the address's domain operator learns the visitor's IP, timing and rough browser; the check starts only when asked; verified addresses live until profiles are turned off) |
| `app/src/profiles.test.ts` | Existing fixtures opt in explicitly (their assertions are about verification itself); two new tests pin the gate: no fetch on a claim until switched on, a check in flight at switch-off never publishes, and switching back on re-asks cleanly |

Room identity lookups (kind-0 names, pictures) are unchanged: their cost is
documented separately in the same module header and retained toggle.

**Verified:** `npx vitest run app/src/profiles.test.ts` 7/7; `npm run
typecheck` clean; `npm run build` clean (including the no-telemetry check);
full suite 303 files / 4,232 tests green.

## Deferred work (deliberate, tracked)

1. **The anonymous/Tor profile must force NIP-05 verification off.** The
   profile exists in the library (`src/anonymous.ts`, `NetworkProfile`) and
   is applied to relay dialling, but no app surface exposes it yet. When one
   does, it must call `profiles.setNip05Automatic(false)` and ignore the
   stored `kithmoot.nip05.verify` value under `'tor'`. This requirement is
   written into `app/src/profiles.ts` and the review document so it cannot
   be lost between here and that work.

2. **fold-kit hygiene note (upstream, negligible impact).** In
   `forgesworn/fold-kit`, `encodeMemberEpochGrant`'s one-time grant signer
   key is not zeroed after signing, where this repository wipes ephemeral
   keys in `finally`. A grant is trusted only for its authority-signed
   contents, so disclosure of that key re-signs nothing of value — but the
   upstream fix is one line: wrap the `finalizeEvent` in `try`/`finally` and
   `fill(0)` the key. Land it with the next fold-kit touch rather than as a
   release of its own.

## References

- Review: `SECURITY-REVIEW-2026-10-15.md` (scope, threats, per-file
  verification notes) and `SECURITY-REVIEW.md` (2026-09-20 baseline).
- Commits, oldest first: `e4c7c2b` (finding 2), `62c2061` (finding 1 deps),
  `b2639f3` (finding 1 CI gate), `64e2212` (finding 3), `fed5fb8` and
  `0347ad6` (review documents).
