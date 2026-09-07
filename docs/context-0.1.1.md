# Context packages 0.1.1

This patch corrects filename handling and adds distributable dependency notices
to `@forgesworn/context` and `@forgesworn/context-tools`.

## Compatibility

An emoji straddling the 180 UTF-16 unit filename limit previously left an
unpaired surrogate in the canonical name. The helper now truncates before
the pair, matching Wildbloom. Shared NFC and Unicode boundary vectors are
copied unchanged from Wildbloom and exercise both published-envelope reads
and canonical new writes. Existing ASCII names and complete pairs at the
limit are preserved. The context snapshot name remains `context.json`.

The envelope marker `FSWNENC2` means ForgeSworn encryption version 2. Its
AES-256-GCM/HKDF-SHA256 format, recovery keys, context cache schema, signed
history, access controls and KithMoot ownership verification are unchanged.

## Copyright and dependency notices

Both tarballs retain the existing MIT licence and
`Copyright (c) 2026 TheCryptoDonkey`. No ownership transfer is asserted.
Each now includes `THIRD_PARTY_NOTICES.md` with verbatim direct-dependency
licences and source provenance. Packaging checks require those notices in
the installed artifacts and check their dependency versions.

The transitive `nostr-wasm@0.1.0` package declares MIT but omits its wrapper
licence/copyright notice in both the npm artifact and recorded source revision.
The core notice documents that upstream omission and includes the original
libsecp256k1 `COPYING` from its exact referenced submodule revision. This does
not manufacture or replace the missing wrapper notice. The context core uses
the pure JavaScript Nostr exports; neither context tarball bundles WASM or
third-party dependencies. A distributor choosing to bundle the WASM module
still needs to resolve its wrapper notice with the maintainer.

## Validation

Local validation on 7 September 2026 passed: 1,469 tests across 89 files,
typechecking, the production browser build, the KithMoot packed-library
check and independent context tarball checks. The latter cover Node and
browser imports, declarations, encrypted CLI persistence across processes,
installed licence notices and the Unicode correction. The core browser
consumer's bundle is also checked for absence of `nostr-wasm`.

## Installation

```sh
npm install @forgesworn/context@0.1.1
# For file persistence, CLI or MCP:
npm install @forgesworn/context-tools@0.1.1
```

Publish the core first, then the matching tools package. KithMoot consumes
the patch through its existing adapters. Updating the live NanoClaw client
is a separate runtime rollout.
