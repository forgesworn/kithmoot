# Encrypted files on a selected Bothy route

This source connects the existing file controls and Wildbloom encryption to
paired Bothy storage. It is an opt-in addition to the current text-room route;
it does not enable MLS, calls, live media, anonymous mode or quiet mode.

## Using it

1. Sign in with a supported NIP-07 browser extension. Event approvals use the
   signer's guarded provider boundary; file encryption happens locally.
2. Pair the Bothy and select it for the room using the existing room controls.
   Each recipient needs its own permitted Full pairing to that same box and an
   active room selection. Room membership alone does not grant file access.
3. Open the attachment panel and allow encrypted files on this room's Bothy.
   Files selected before permission stay on the device. Press **Upload selected
   files** to upload them, then Send to share the encrypted message.
4. Click **Show** on a received file. The app uses the selected paired route,
   verifies the complete ciphertext hash and size, then decrypts locally.

The ciphertext limit is 64 MiB including encryption and padding. Some smaller
source files therefore exceed the limit after encryption and are refused.
The message contains an existing Link `fsl://node/hash` reference and the file's
key inside the room's encrypted content. No public file announcement is sent,
and a server-provided URL is never followed. Public-store file downloads are
held while this room uses Bothy. Ordinary HTTPS attachments retain their
existing behaviour outside that route.

## Consent, ownership and cleanup

Stopping new private uploads and downloads does not delete uploaded copies or
close already opened files. Account, room, destination and expiry changes hold
new operations; losing an upload reply does not trigger an automatic retry.
The encrypted local journal records intent before dispatch, including uncertain
uploads, without storing file keys or names.

**Settings → Account → Review private uploads** also works after the original
room has closed or been forgotten. Connect the recorded Bothy and use the
uploading account's signer. Cleanup never substitutes a new node or discovers
another destination.

A successful delete can remove your storage claim while other owners retain
the ciphertext. The app reports that separately from the box confirming blob
deletion. After a missing-delete response it can resolve a receipt only when
that same paired box also reports the file absent. Neither result proves
physical erasure or removal of copies held by recipients or other operators.
An ambiguous response retains the receipt. In particular, a lost acknowledgement
of claim removal while another claim retains the file can remain unresolved.

Forget this browser refuses while any account has unresolved upload records.
When none remain, it holds the journal's custody lock through the wipe and
removes its encrypted records, non-extractable local key and revision marker.

Full-paired peers can fetch box-wide ciphertext. Encryption protects the file's
contents; this is not a new per-room file ACL. The operator and trusted local
processes remain part of the storage trust boundary, and transfer timing and
sizes are not hidden. Route retirement and the box's retention policy still
apply.

## Verification

Focused adapter, custody, signer and package checks:

```sh
npm run build:lib
npx vitest run src/private-attachment.test.ts app/src/browser-bothy-files.test.ts app/src/private-file-vault.test.ts app/src/nostr-message-signer.test.ts test/link-web-provenance.test.ts
npm run typecheck
npm run build
```

The existing real claimed-runtime browser journey has an optional
`ROOM_PRIVATE_FILES=1` extension. With its usual local Bothy and WebPKI Link
fixtures, it exercises separate consent, upload, two-profile decryption, fresh
reads after app/box/relay restart, owner cleanup outside a room, and actual
IndexedDB erasure through Forget this browser. `ROOM_ARTIFACT_DIR` must be an
owned repository release directory or retained evidence directory, never `/tmp`.
Declared fixture signers and local browser acceptance do not establish physical,
Android, whole-mode anonymity or full Vennel conformance. Mocked adapter deletion
recovery checks are separate from real multi-owner storage acceptance.
