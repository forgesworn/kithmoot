# Browser Admin2 product candidate

This is production-build-capable consumer source, off by default. It is not a supported public native release. The exact native input remains `qualificationOnly: true`, `experimental: true`, source `5b3eb5fe28255b5c0cc09d959a3010a3d48f9562`. Its manifest and executable hashes are pinned in `app/src/mls-admin2-candidate-pin.json`.

The exact reviewed native web files are tracked under `app/admin2-native/`, outside Vite's `public/` directory. A fresh checkout builds without local preparation. To compare another frozen copy against the pinned source and hashes, run:

```sh
node scripts/prepare-admin2-product-candidate.mjs /path/to/exact/qualification/web
```

Selection requires both `VITE_MLS_INVITATION_PROFILE=admin2` and `VITE_ACCOUNT_NETWORK_DEFAULT=private-invitations`. The enum defaults to `disabled`; invalid values fail configuration. Product selection rejects MLS preview and mixed-lab flags. The existing normal production engine and DEV-only legacy/mixed hooks retain their separate paths.

A selected candidate exposes Private groups and Private invitations (named device admins), through the existing protected room owner. Every creation selects Admin2 centrally; caller or UI flags cannot select FullVmls1 or Invitation1. Restore holds both profiles before a native opener. Trusted local restart uses the existing witnessed continuity rules; detected state loss, import and clone still require fresh rejoin. Replacements do not inherit a device leaf's admin role.

Account changes, locking, signout and forgetting invalidate all instantiated room, witness and grant owners, including signer and job fences, in production. Invitation signing remains the purpose-specific `signAdminInvitationV2/1` consent and canonical context/policy commitment; there is no new signing API.

Explicit device preparation, authenticated private invitation exchange, node keeper registration and manual delivery rounds remain necessary. This candidate supports one exact paired home box, has no public discovery or automatic enrolment, and does not claim transport metadata disappears. The private account-network default retains the existing explicit Enable Nostr choice.

Candidate executable bytes stay in tracked nonpublic source and are verified before emission under `vmls-wasm-admin2-candidate/` only when selected. Default builds do not emit this candidate path. The optional comparison does not fetch, compile, deploy, sign or publish anything, and retains the original manifest bytes.
