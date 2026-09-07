# Context package extraction

The encrypted context implementation is now two independently consumable npm
packages maintained in the KithMoot workspace:

- `@forgesworn/context`: browser-safe signed collections, grants, revisions,
  encrypted caches and the existing Wildbloom/Blossom implementation.
- `@forgesworn/context-tools`: Node file persistence, CLI and MCP tools.

KithMoot consumes these packages through compatibility adapters. Its ownership
proof verifier remains in `src/ownership.ts`; `src/context.ts` installs it as a
trusted delegation verifier. The portable package rejects delegation proofs
without a verifier. Existing `ContextVault`, attachment exports and
`kithmoot-context` commands remain supported.

The packages have separate manifests, exports, builds and tarballs. They have
no KithMoot or NanoClaw runtime dependency. Keeping source in this workspace
makes the existing browser and agent consumers part of every change's checks.
A separate repository is not required to consume the packages independently.

## Compatibility

This is an implementation extraction, not a protocol revision. Preserve the
`kithmoot/context/v1/*` signing domains, personal/kin/kith scope labels, `room`
audience binding, `agent` proof slot, FSWNENC2 format, NIP-44 access envelopes,
signed record identifiers, ancestry, cache schema and MCP request shapes.
Renaming any of those requires a separately reviewed migration.

`test/fixtures/context-v1/cache.json` was generated against pre-extraction
commit `4e684fc`. It contains only fixed, public test identities and includes
shared records plus a personal collection with an agent ownership grant.
Compatibility tests restore it, retain its signed heads and history, append a
new revision, and restore again. The portable package refuses its agent proof
when the KithMoot adapter is absent.

The envelope and Blossom source moved unchanged except for replacing the
KithMoot attachment type with an equivalent structural interface. Existing
known-answer and attachment tests exercise the extracted implementation.

## Validation on 7 September 2026

- Full regression suite: 1,463 tests passed across 88 files.
- Final focused context, legacy cache, attachment and HTTPS/MCP checks:
  60 tests passed. The HTTPS test exercises both the legacy KithMoot command
  with ownership proofs and the standalone command with direct grants.
- Typecheck and production browser build passed.
- Packed core installed outside this workspace: Node execution, declarations,
  browser bundle and cache recovery passed, without KithMoot or MCP installed.
- Packed tools installed outside this workspace: CLI create, append and
  recovery in separate processes passed, without KithMoot installed.
- Existing KithMoot packed-library smoke test passed.
- Context sharing, personal-data exclusion and recovery passed in Chromium and
  Firefox. WebKit failed before app navigation with
  `Page.overrideSetting: Unknown setting: PushAPIEnabled` on this Mac.
  Hosted Linux WebKit acceptance subsequently passed in PR #40.

All five hosted checks passed in [PR #40](https://github.com/forgesworn/kithmoot/pull/40):
Node 22, Node 24, Chromium, Firefox and WebKit. The Node jobs include the
independent artifact check. The library still provides
bounded collections and literal search; graph extraction and semantic search
are outside this change.

## Release and operator impact

Both 0.1.0 packages are published to npm. The registry integrity values match
the checked tarballs in [the GitHub release](https://github.com/forgesworn/kithmoot/releases/tag/context-v0.1.0).

```sh
npm install @forgesworn/context@0.1.0 @forgesworn/context-tools@0.1.0
```

For future versions, publish core before tools, and both before publishing a
KithMoot version depending on them. Consumers can also install the GitHub
release tarballs together.

A source checkout continues to use `npm ci --ignore-scripts` followed by
`npm run build:lib`; npm resolves the packages locally through the workspace.
Browser build, typecheck and demo commands build their package dependencies.
Existing NanoClaw registrations can keep `bin/kithmoot-context.mjs`, identity,
room and state arguments. Do not replace it with the generic command when
collections carry KithMoot ownership proofs.

This extraction has not been activated in the live NanoClaw install. No live
identity, grant, cache, service or model configuration was changed.
