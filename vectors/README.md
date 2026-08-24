# KithMoot interop vectors

This directory is the interop contract for KithMoot's wire format. It exists
so a second, independent implementation - starting with a native Kotlin
Android client - can be checked against something more concrete than "it
seemed to work against the TypeScript one". This is the same discipline
`relayswarm-kit` used (RFC 8439 vectors for ChaCha20, nostr-tools-generated
payloads for NIP-44).

## What is here

| File | What it is |
|---|---|
| `kithmoot-vectors.json` | The vectors themselves. Generated, never hand-edited. |
| `generate.mjs` | Produces `kithmoot-vectors.json` deterministically from fixed inputs. Run via `npm run vectors`. |
| `lib/determinism.mjs` | The handful of low-level helpers (fixed-seed key derivation, fixed-aux-rand signing) both `generate.mjs` and `verify.test.ts` share. |
| `lib/fixtures.mjs` | Every fixed secret, keypair and timestamp the vectors are built from, in one place. |
| `verify.test.ts` | A vitest suite (part of `npx vitest run`) that checks the JSON against the real `src/` implementation. |

## What the vectors pin - and what they don't

**These vectors pin the wire format: the exact bytes that cross a relay, and
the exact accept/reject decision the reference implementation makes for
them.** They do not pin the whole protocol. In particular, they say nothing
about:

- **Timing** - jitter windows, retry intervals, pairing timeouts.
- **Re-announce behaviour** - the arrive/answer roster pattern described in
  `docs/decisions.md`, or what happens when a device drops and rejoins.
- **Negotiation** - how offers, answers and ICE candidates are sequenced
  over the wire, beyond the shape of one signal payload.

An Android implementation that reproduces every vector here has a
byte-compatible codec and cryptographic layer. It still needs its own tests
for the state machine sitting on top.

## Why some vectors are not "just call the function"

Three of `src/`'s exported functions are non-deterministic by design:

- `finalizeEvent` (from `nostr-tools`, used throughout `src/`) signs with
  `schnorr.sign(hash, secretKey)` - no third argument, so it draws 32 fresh
  random bytes for BIP-340's aux-rand on every call. That is correct: aux-rand
  is randomised in production as side-channel hardening.
- `nip44.v2.encrypt(plaintext, key)` defaults to a random 32-byte nonce when
  none is supplied.
- `createDeviceCredential` and `wrapSignal` stamp `created_at` from
  `Date.now()`.

None of that is a bug, but it means calling `createDeviceCredential`,
`encodeRosterEvent`, `wrapSignal` or `issueKindredProof` twice with
identical arguments never produces the same bytes twice - fatal for a vector
file that must be byte-identical on every regeneration and readable by an
implementation in a different language.

So for every vector that involves signing or encryption, `generate.mjs`
rebuilds the exact same event/ciphertext shape by hand, using the same
underlying primitives (`schnorr.sign`, `nip44.v2.encrypt`, `getEventHash`)
with **explicit, recorded randomness** instead of the random defaults:

- a fixed BIP-340 aux-rand (recorded as `auxRandHex` in the vector's `input`)
- a fixed NIP-44 nonce (recorded as `nonceHex` / `nip44NonceHex`)
- a fixed `created_at` (recorded as `createdAt`)
- a fixed ephemeral keypair for gift wraps (recorded as `ephemeralSkHex`)

This is exactly what the official BIP-340 test vectors do for the same
reason: fixing aux-rand to a known value does not weaken the signature -
aux-rand only needs to be unpredictable in a live signer, never in a frozen
fixture - and it is the only way to get a reproducible signature out of a
scheme that is deliberately randomised by default.

Every hand-built vector is then run through the REAL verify/decode function
from the compiled `src/` implementation before being written out, so a
vector is only ever recorded once the actual code has accepted it (or
correctly rejected it, for the negative cases).

**Invariant an implementation must satisfy:** given the recorded secret key,
aux-rand (or nonce, or ephemeral key) and other inputs, running the same
BIP-340 signing / NIP-44 AEAD procedure must reproduce the exact `id`,
`sig`, and ciphertext recorded in `output`. If your implementation instead
draws its own randomness, it cannot be checked byte-for-byte against these
vectors for the signed/encrypted fields - but it can, and must, still
**verify** them (see "Positive vs negative", below).

The purely deterministic functions - `deriveRoom`, `encodeJoinUrl` /
`decodeJoinUrl`, `mintTurnCredential`, `evaluateAccess` - have no such
randomness. Their vectors are produced by calling the real function
directly, with no reimplementation involved.

## Groups

| Group | Covers | Source |
|---|---|---|
| `roomDerivation` | secret → `roomId` + `roomKey` via two HKDF info strings | `src/room.ts` |
| `joinUrl` | secret + relays (+ optional access policy) ↔ URL fragment | `src/room.ts` |
| `deviceCredential` | participant secret + device pubkey + roomId + expiry → signed kind-20460 event | `src/credential.ts` |
| `rosterEvent` | a `RosterEntry` + room key → encrypted kind-20461 event | `src/roster.ts` |
| `signalWrap` | a `SignalBody` + sender secret + recipient pubkey + ephemeral key → kind-21059 gift wrap | `src/signal.ts` |
| `kindredProof` | issuer secret + participant + tier + expiry → signed proof, one per tier (`ken`/`kith`/`kin`) | `src/access.ts` |
| `accessEvaluation` | a `RoomPolicy` + participant + proof + now → `{ admitted, reason }` | `src/access.ts` |
| `turnCredential` | secret + ttl + fixed now → coturn REST `{ username, credential }` | `src/turn.ts` |

**A note on scope:** the brief for this stage described the join URL as
carrying "secret + relays + ICE list". The current implementation does not
carry a separate ICE server list in the join URL - the fragment payload is
`{ s: secret, r: relays, a?: policy }`. TURN/ICE credentials are minted
separately, per viewer, via `mintTurnCredential` (the `turnCredential`
group) rather than embedded in the capability link. These vectors pin what
the wire format actually is.

### Positive vs negative

Every group with a verify/decode/parse step (`deviceCredential`,
`rosterEvent`, `signalWrap`, `accessEvaluation`, `joinUrl`) carries at least
one `kind: "negative"` entry alongside its positive ones, each with the
expected rejection outcome:

- **`deviceCredential`**: a credential checked against the wrong room
  (`wrong room`), one that has expired (`expired`), and one whose `device`
  tag was swapped after signing (`bad signature`).
- **`rosterEvent`**: the same event decrypted with the wrong room's key
  (returns `null`), and one signed by a device other than the one its
  credential names (`null`).
- **`signalWrap`**: opened by someone other than the intended recipient, and
  checked against a room the inner body does not name (both `null`).
- **`accessEvaluation`**: a `ken` proof presented to a `kith`-gated room
  (`tier too low`), and a well-formed proof from an issuer not on the room's
  allow-list (`untrusted issuer`).
- **`joinUrl`**: a fragment that is not valid base64url, one that decodes to
  a secret of the wrong length, and a policy naming an unrecognised tier -
  all three must throw, not silently fall back to an open room.

**These matter as much as the positive vectors.** An implementation that
accepts every well-formed structure passes every positive vector; only the
negative ones catch an implementation that accepts *everything*, including
what it should refuse.

## Using these vectors from another implementation

1. Read `lib/fixtures.mjs` for the fixed secrets and keypairs, or just take
   the hex values directly from each vector's `input` - every vector is
   self-contained and does not require reading the fixtures file.
2. For a purely deterministic vector (`roomDerivation`, `joinUrl` positive
   cases, `turnCredential`, `accessEvaluation`), feed `input` through your
   implementation and diff the result against `output` byte-for-byte.
3. For a signed/encrypted vector, there are two things to check, and they
   are not the same thing:
   - **Verification** (the invariant that matters for interop): feed the
     recorded `output` bytes through your implementation's verify/decode
     path and confirm it produces `expected.result` (or, for a negative
     vector, `output.result` / rejects for the stated reason).
   - **Byte-exact reproduction** (a stronger check, useful for exercising
     your own signing/encryption code): reproduce the signature or
     ciphertext yourself using the recorded aux-rand / nonce / ephemeral key
     and confirm you land on the identical `id` / `sig` / ciphertext. This
     requires your BIP-340 and NIP-44 implementations to accept externally
     supplied randomness, the way `@noble/curves`' `schnorr.sign(msg, sk,
     auxRand)` and `nip44.v2.encrypt(pt, key, nonce)` do.
4. For a `joinUrl` negative vector, `input.url` is the exact fragment to
   decode; `output.error` is the exact message the reference implementation
   throws. Your implementation does not need to produce the identical
   string, but it must refuse the input.

## Regenerating

```sh
npm run vectors
```

This builds `dist/` (`npm run build:lib`) and then runs `generate.mjs`
against the compiled output, so the pure-function groups are always checked
against the actual current implementation, not a stale copy of its logic.

Running it twice must produce a byte-identical `kithmoot-vectors.json` - there
is no `Date.now()`, `Math.random()`, or `randomBytes()` anywhere in
`generate.mjs`. This was verified by regenerating from a clean `dist/` and
diffing (see the stage-2 vectors report for the result).

`verify.test.ts` runs as part of `npx vitest run` and is the regression net:
if a derivation string, tag name, encoding, or rejection reason changes in
`src/`, it fails here first.
