# Roster envelope 2: reader-first codec

This opt-in codec hides the device key in the outer author of one roster
publication. It does not activate a new room profile. Existing sessions,
background room watches, web, desktop and Android publishers continue writing
the legacy roster format. Older readers cannot read envelope 2, so callers must
not enable its writer in existing rooms. No dual publication or fallback is
provided: either would expose the device key again.

Both envelopes retain kind 20461, the current room/epoch `d` tag, NIP-44 v2
encryption under the current room/epoch key, and the conference expiration when
present. The default encoder remains the legacy device-signed format.

With `encodeRosterEvent(entry, { ...options, envelope: 2 })`, every publication
gets a fresh random outer signing key. The encrypted plaintext is exactly
`{"v":2,"body":<string>,"sig":<128 lower-case hex>}`. `body` contains the same
sanitised entry JSON as the legacy format. It remains a string so the signature
authenticates its original bytes rather than a reader's reserialisation.

The device signs SHA-256 of UTF-8:

```text
kithmoot/v1/roster-envelope-2:<room id>:<epoch d>:<outer pubkey>:<created_at>:<body>
```

Hex context fields are canonical lower case. The signature binds the room,
current epoch selector, fresh outer author, timestamp and complete body,
including the credential and admission proof. The outer timestamp must equal
the entry's `updatedAt`. The outer private key is zeroed after signing.

The decoder reads both envelopes. It verifies the outer event without trusting
a cached verification result, then the inner signature for envelope 2. The
credential must independently bind the authenticated device to the claimed
participant and original room, and must still be valid at receive time. A room
member holding a copied credential cannot impersonate its device. Legacy
entries still require their device to be the outer signer. All existing future
time, claim, ownership, name and capability validation remains in place;
RoomSession still enforces admission policy, removals and freshness after decode.

Before signature verification or decryption, readers bound the signed wire
fields to 131,072 UTF-8 bytes, at most 32 tags and 16 values per tag. Tags must
have unique names and string values, with exactly one two-value hex `d` tag.
An optional two-value `expiration` must be canonical non-negative safe-integer
seconds. Malformed or unknown envelopes are refused without legacy fallback.

The shared `d` tag still identifies a group of publications to the Nostr relay.
Sizes, timing, network connections and unchanged signalling recipient selectors
remain observable. This codec alone does not provide group unlinkability,
anonymous transport or protection against colluding observers. Audio and video
remain outside Nostr. STUN servers and TURN media relays retain their existing
connectivity roles. ForgeSworn operates no relay network, and this work changes
neither an operator's infrastructure nor the owner's private Archy node.

Production activation requires a separately reviewed authority-controlled room
profile, fail-closed links/admission and persistence, independent Android
readers, background watches and mixed-version evidence. Adding an optional field
to an existing v3 URL is insufficient: old clients ignore unknown fields and
would silently join a room whose presence they cannot read. No new kind,
selector, URL version or production activation is introduced here.

Independent conformance data is in `vectors/roster-envelope-2.json`, generated
by `vectors/generate-roster-envelope-2.mjs` without importing the roster encoder
or digest. Root and epoch cases deliberately retain whitespace in the signed
body and include credential expiry and ciphertext-lifting checks. The file
contains public synthetic test data only. `src/session-roster-privacy.test.ts`
checks the full receiving RoomSession policy gate with fake media endpoints;
codec acceptance alone does not admit a caller.
