# Retained renewal version 1 plaintext contract

These eight synthetic fixtures were captured from the actual native browser
factory at source commit `84e84b4324571438dcfeb9ba8a1fcf54efb2c325`. They cover
accounts and visitors, kept and tab-only rooms, and first and subsequent
renewals. All keys, identities, room data and signatures are test material.

`expectedPlaintext` fixes the complete encoded browser and tab image bytes
before encryption. Recovery must reproduce these bytes even after historical
authority expires. This protects the version 1 projection used with the two
frame nonces already stored in the operation journal.

Do not regenerate these expected bytes to make a changed implementation pass.
A change that alters them needs a separately reviewed version transition or a
refusal of the old format before any persisted nonce is used. The fixtures
prove format stability; native authentication, phase checks, current authority,
write acknowledgement and production startup remain separate requirements.
