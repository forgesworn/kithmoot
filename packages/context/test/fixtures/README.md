# Wildbloom conformance fixtures

`unicode-filenames.json` is copied byte for byte from
[`forgesworn/wildbloom` at `8d4dcda0a0592b676e70064344d73637652f3b9d`](https://github.com/forgesworn/wildbloom/blob/8d4dcda0a0592b676e70064344d73637652f3b9d/test-vectors/unicode-filenames.json).
It covers NFC normalisation and UTF-16 filename truncation. Its keys, salts,
nonces and plaintext are public synthetic test data. Do not regenerate the
expected names or envelopes using the implementation under test.

Copyright (c) 2026 TheCryptoDonkey. MIT; see [LICENSE](../../LICENSE).
