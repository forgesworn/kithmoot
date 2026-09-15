# Private file storage

Private Bothy storage is the intended default, with encryption retained.
An owned hostname or signed upload alone does not establish private reads.

## Implemented browser safety boundary

- New uploads default off, including chat picker/drop and Context uploads.
- No fallback to the app host. Old `kithmoot.blossom-server` values are only
  suggestions; they are preserved but never promoted into consent.
- Shared storage requires the destination, a disclosure checkbox and an
  explicit Allow action. Consent is stored on this browser/device, not sent
  to other room members. Editing a URL revokes it immediately, even if invalid.
- The warning distinguishes encryption from download access control and
  names the host's metadata visibility. A URL is never labelled private.
- Chat checks consent before encryption, again before upload and for each
  file in a batch. Other tabs' preference changes are reflected. A request
  already sent cannot be recalled; turning uploads off is not deletion.
- Selecting/dropping a file after opt-in uploads before pressing Send.
- Context collections/backups still work locally. Its existing server
  allowlist also applies to imports; reopen Context after changing servers.
- Existing attachment messages and click-to-fetch reads are unchanged.
  Already staged attachments are not silently removed. No remote migration,
  deletion, relay change or CLI/MCP policy change is part of this patch.

## Remaining Bothy gate — not implemented by this patch

1. Pair a box and bind its storage endpoint to verified owner/device authority.
   Existing box discovery verifies claims/status; it does not supply a
   browser storage session or private download authorisation.
2. Implement a transport that authenticates upload, GET, HEAD and range reads.
   Reject anonymous, wrong-device, expired and revoked grants. A successful
   signed upload or inaccessible guessed URL is not sufficient evidence.
3. Authorise recipient devices for the selected files without exporting owner
   credentials or sending room decryption keys to storage. Verify another
   member can read after the sender disconnects, and revocation prevents new
   reads (not recovery of copies already downloaded).
4. Prove browser/PWA reachability on home Wi-Fi and mobile data using the real
   Bothy transport. No silent public mirror, repair source or hosted fallback.
5. Enable **Connect your Bothy** only when that journey works. Until then the
   UI says it is unavailable and leaves uploads off, not a cosmetic private mode.
6. Review a separate migration plan for existing hosted blobs: inventory,
   authorised copy, hash/decryption verification, reference replacement and
   explicit deletion approval. Report any retained copies and failed deletions.

Validation: policy unit tests and isolated browser acceptance cover the safety
boundary; they are not proof of a running Bothy or a production deployment.

## Local validation — 15 September 2026

- `npm test`: 1,865 tests passed, including 12 storage-policy cases.
- `npm run typecheck` and production build passed; the build retains its
  existing large-chunk warning.
- Drafts and Context acceptance: 36 checks passed across Chromium, Firefox
  and WebKit. Chromium room-switching checks also passed.
- Additional Chromium batch-revocation coverage passed: one upload completes,
  the second is blocked, the existing attachment is preserved.
- `test/quiet.spec.ts --project=chromium --workers=1`: all three passed,
  including encrypted file retrieval and suppression of public announcements.
  Running it alongside drafts initially failed its global relay message-count
  assertion because other tests wrote to that relay; isolated execution passed
  without changing that assertion.
- The phone-width storage panel was visually inspected. All files, people and
  relays used for acceptance were synthetic/local. No live room was joined and
  no deployment, migration or deletion was performed.
