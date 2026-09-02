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

- **Timing** - jitter windows, retry intervals, pairing timeouts. This
  includes signalling **staleness**: `unwrapSignal` refuses a signal stamped
  more than `SIGNAL_MAX_AGE_SECONDS` either side of now, but the vectors are
  stamped with a fixed time, so both suites hand it that fixed time as `now`
  rather than letting the wall clock expire the whole group. An implementation
  must apply the rule; the vectors do not pin the number.
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

**A fixed aux-rand and a fixed NIP-44 nonce are still two different roles,
even when both are just "some fixed bytes" in this file.** Every vector
below gives each its own distinct value - never the same hex reused for
both - purely so that a bug which swapped the two roles (signing with what
should have been the nonce, or encrypting with what should have been the
aux-rand) would actually change the recorded output and get caught. This
matters only as a model to read, not as a security property of this frozen
file: reusing a value here cannot leak anything, because nothing here is
secret or live. **It would be a real vulnerability in production code** -
NIP-44 nonce reuse breaks the AEAD's confidentiality guarantee outright, and
a predictable BIP-340 aux-rand is a foothold for fault/side-channel attacks
on the signature. Live code must never reuse a nonce across encryptions, and
must never derive aux-rand from anything an attacker could predict.

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
| `channelDerivation` | `roomKey` + channel name → the channel's `id` + `key` via two HKDF info strings; no name is the room itself | `src/chat.ts` |
| `joinUrl` | secret + relays (+ optional access policy) ↔ URL fragment | `src/room.ts` |
| `deviceCredential` | participant secret + device pubkey + roomId + expiry → signed kind-20460 event | `src/credential.ts` |
| `rosterEvent` | a `RosterEntry` + room key → encrypted kind-20461 event | `src/roster.ts` |
| `signalWrap` | a `SignalBody` + sender secret + recipient pubkey + ephemeral key → kind-21059 gift wrap | `src/signal.ts` |
| `kindredProof` | issuer secret + participant + tier + room + nonce + expiry → signed proof, one per tier (`ken`/`kith`/`kin`) | `src/access.ts` |
| `accessEvaluation` | a `RoomPolicy` + participant + proof + now → `{ admitted, reason }` | `src/access.ts` |
| `turnCredential` | secret + ttl + fixed now → coturn REST `{ username, credential }` | `src/turn.ts` |
| `roomDescriptor` | a `RoomDescriptor` (forwarders + ICE servers) + room key → encrypted kind-20465 event | `src/descriptor.ts` |

**A note on scope:** the brief for stage 1 described the join URL as
carrying "secret + relays + ICE list". The join URL does not carry an ICE
server list - the fragment payload is `{ s: secret, r: relays, a?: policy }`,
and it never will, because ICE servers and forwarders have to change while a
call is running and the URL cannot. That config lives in the **room
descriptor** instead (the `roomDescriptor` group), encrypted to the room key
and republished as it changes. TURN *credentials* remain minted separately,
per viewer, via `mintTurnCredential` (the `turnCredential` group). These
vectors pin what the wire format actually is.

**What the display-name vectors exist to pin.** A roster entry may carry a
`name`. It is self-asserted - anyone can type anything, and nothing checks
it - so `display-name` pins that the name travels inside the room-key
ciphertext (a relay that could read a guest list by name would be worse
than one that could read it by pubkey, not better) and decides nothing:
`participant` and the nested credential are still what say who the entry is
for. `display-name-hostile` is the one that matters. Its name carries a
right-to-left override, a smuggled newline, a zero-width space and 200
characters of padding, exactly as a client that sanitised nothing would
publish it, and a conforming reader must **accept the entry and neutralise
the name** - the person and their credential are genuine, so refusing the
whole entry would be the wrong answer. `expected.result.name` records what
must be left.

Both are recorded as **decode-only** vectors - a frozen event in, a decoded
entry out - rather than encode-and-decode pairs. That is deliberate: the
encode path is already pinned by `rosterEvent/valid`, what a second
implementation can actually get wrong is accepting a name it should have
defused, and decode-only keeps both vectors meaningful for an
implementation that does not model display names at all. Such an
implementation decodes the event, ignores the field, and still matches the
recorded entry on everything it does model.

**What the assist vectors exist to pin.** A roster entry may also carry an
`assist`: an offer to relay other people's media, so a room's spare uplink
comes from the people in it rather than from a server anybody pays for. Like a
display name it is entirely self-asserted - a device can advertise a gigabit
uplink it does not have - but unlike a display name it feeds arithmetic, and
that arithmetic decides which member of the room carries a pair that cannot
connect directly. `assist-offer` pins that the offer travels inside the
room-key ciphertext (a relay that could read which members were publicly
reachable, and how much bandwidth they had, would be reading a map of the
room) and survives the round trip exactly as published.

`assist-offer-hostile` is the one that matters. Its offer has a null uplink, a
negative peer count, a fractional load, a claim to carry five thousand pairs,
and a reachability that is not one of the four measured answers. A conforming
reader must **accept the entry and drop the offer whole** - the person and
their credential are genuine, so refusing the entry would be the wrong answer,
and repairing the offer would be worse than dropping it, because a mended
number is still a number the publisher chose wearing a measurement's clothes.
`expected.result` carries no `assist` field at all.

The mitigation for a lie that *does* survive sanitising - a plausible uplink
that is not real - is deliberately not a trust system. A relay that cannot do
the job shows up as a connection that will not come up and is replaced by the
next volunteer, then a forwarder, then TURN. Nothing anywhere believes the
number; it only orders a list.

Both assist vectors are recorded **decode-only**, for the same reasons the
display-name pair are: the encode path is already pinned by
`rosterEvent/valid`, what a second implementation can get wrong is believing
an offer it should have dropped, and decode-only keeps them meaningful for an
implementation that does not model peer assist at all.

**What `roomDescriptor` exists to pin.** A forwarder entry is `url`, optional
`pubkey`, optional `label`, and nothing else. A forwarder is given the room
**id**; it is never given the room **key**, which is what lets it route
ciphertext it can neither read nor forge attribution for. The
`forwarder-extra-fields-stripped` vector carries a plaintext forwarder entry
with the room key in an extra field: a conforming decoder projects the entry
onto those three fields and the extra is gone, while a decoder that passes
the JSON object straight through returns it - and has just handed a forwarder
reference the room key. That vector is the one an implementation is most
likely to fail, and the only one that tests the claim the forwarder design
rests on.

### Positive vs negative

Every group with a verify/decode/parse step (`deviceCredential`,
`rosterEvent`, `signalWrap`, `accessEvaluation`, `joinUrl`,
`roomDescriptor`) carries at least one `kind: "negative"` entry alongside its
positive ones, each with the expected rejection outcome:

- **`deviceCredential`**: a credential checked against the wrong room
  (`wrong room`), one that has expired (`expired`), and one whose `device`
  tag was swapped after signing (`bad signature`).
- **`rosterEvent`** (the negatives; `display-name`, `display-name-hostile`,
  `assist-offer` and `assist-offer-hostile` above are all positives): the same event decrypted with the wrong room's key
  (returns `null`); one signed by a device other than the one its credential
  names (`null`); the valid event with its own signature corrupted but id,
  pubkey, tags and content untouched (`tampered-outer-signature`, `null`);
  and one whose outer signature and device match are both genuine but whose
  *nested* credential has been tampered with after signing
  (`forged-credential-signature`, `null`).
- **`signalWrap`**: opened by someone other than the intended recipient; one
  checked against a room the inner body does not name; and one whose outer
  gift wrap decrypts cleanly (a fresh ephemeral key proves nothing about the
  sender - that is the point of a gift wrap) but whose *inner* event has a
  corrupted signature (`tampered-inner-signature`) - all `null`.
- **`accessEvaluation`**: a `ken` proof presented to a `kith`-gated room
  (`tier too low`); a well-formed proof from an issuer not on the room's
  allow-list (`untrusted issuer`); and a proof from a trusted issuer, at a
  sufficient tier, unexpired, naming the right participant, with nothing
  wrong except a corrupted signature (`kith-room-rejects-tampered-signature`,
  `bad signature`).
- **`joinUrl`**: a fragment that is not valid base64url; one that is valid
  base64url but decodes to bytes that are not valid JSON at all
  (`decode-fragment-not-json`); one that decodes to valid JSON of the wrong
  shape, with no secret field at all (`decode-payload-wrong-shape`); one
  that decodes to a secret of the wrong length; and a policy naming an
  unrecognised tier - all five must throw, not silently fall back to an open
  room.

**These matter as much as the positive vectors.** An implementation that
accepts every well-formed structure passes every positive vector; only the
negative ones catch an implementation that accepts *everything*, including
what it should refuse.

**Signature verification specifically must never be a check an
implementation can skip and still pass.** A vector set built only from happy
paths and structural rejections (wrong room, wrong tier, untrusted issuer)
can be satisfied by an implementation that never calls a verify function at
all - it would still correctly reject those cases on earlier, cheaper
checks, and admit everything else. `kith-room-rejects-tampered-signature`,
`tampered-signature` (`deviceCredential`), `tampered-outer-signature` and
`forged-credential-signature` (`rosterEvent`), and `tampered-inner-signature`
(`signalWrap`) exist specifically to close that gap: each one is
well-formed and passes every *other* check in its group, and fails on
nothing but a signature. An implementation that skips signature
verification - anywhere a signature is checked - fails exactly these five
vectors and nothing else, which is what makes them worth having.

## Reason strings are normative

**The `reason` string in `accessEvaluation`'s and `deviceCredential`'s output
is part of the wire contract, not free text a caller can reword.** This was
not decided up front - the vectors above already assert exact `reason`
values in several negative cases, which makes the strings de facto part of
what an implementation is checked against, whether or not that was the
original intent. It was tested the hard way: the first independent
implementation (Kotlin/Android) passed every structural and admit/reject
check and still failed `accessEvaluation/kith-room-rejects-tampered-signature`,
because it returned `"bad proof signature"` where the reference returns
`"bad signature"` - correct behaviour, wrong string. A second divergence was
found on audit, not by a vector: `evaluateAccess`'s expiry rejection was
`"proof expired"` in Kotlin against `"expired"` here, reachable the moment
someone writes a vector or test for it. Both were check-order bugs as much
as spelling ones - see below.

So: **an implementation must reproduce these exact strings**, and must check
in this exact order, because a caller cannot tell which reason it will see
from a proof that fails more than one check in a different order.

### `evaluateAccess` (`src/access.ts`)

Checked in this order; the first match wins.

| # | Condition | `reason` |
|---|---|---|
| 1 | `policy.tier === 'open'` | `open room` (admitted) |
| 2 | no proof supplied | `no kindred proof` |
| 3 | `proof.participant` does not match `participant` (case-insensitive hex) | `proof names another participant` |
| 4 | `proof.room` missing, or not the room being joined (case-insensitive hex) | `proof names another room` |
| 5 | `proof.expiresAt <= now` | `expired` |
| 6 | `proof.issuer` not in `policy.admitted` (case-insensitive hex) | `untrusted issuer` |
| 7 | `proof.tier` not a recognised kindred tier | `unrecognised tier` |
| 8 | tier rank below `policy.tier`'s | `tier too low` |
| 9 | schnorr verification fails | `bad signature` |
| - | none of the above | `kindred proof accepted` (admitted) |

Row 4 is the room binding. A kindred proof names exactly one room, and both
`room` and a per-proof `nonce` are inside the signed message, so a proof
cannot be edited into another room (that is row 9, not row 4) and two proofs
on identical terms are still distinguishable. The trade is stated plainly in
`KindredProof`: a kindred proof is a **room grant**, not a portable statement
about a relationship, so an issuer mints one per room. In this protocol the
party who vouches is the party who sent the join link, so it already knows
the room id. An implementation that omits `room` and `nonce` from the signed
message produces proofs this one refuses, and vice versa - which is the right
way round, since the failure is a refusal rather than a silent admission.

Row 7 is reachable in TypeScript because a proof's `tier` is only a type
annotation, not a runtime check, so a signed-but-nonsense tier can still
reach `evaluateAccess`. An implementation whose proof type is parsed and
validated *before* it can be constructed (Kotlin's `KindredProof.fromJson`
returns `null` for an unrecognised tier, so the caller never has a proof
object to pass at all) cannot reach row 7 the same way and will instead
report row 2 (`no kindred proof`) for that wire input. Both fail closed -
the proof is refused either way - but the reason a caller sees differs by
implementation for this one case. This is accepted as an inherent
consequence of stricter parsing, not something to paper over by weakening
the parse step; row 7 is listed so a third implementation knows this
divergence is documented, not overlooked.

### `verifyDeviceCredential` (`src/credential.ts`)

| # | Condition | `reason` |
|---|---|---|
| 1 | `event.kind` is not the credential kind | `wrong kind` |
| 2 | `d` tag does not match the room | `wrong room` |
| 3 | `expiration` tag missing, or not a finite number | `no expiration` |
| 4 | `expiresAt <= now` | `expired` |
| 5 | `device` tag missing | `no device` |
| 6 | signature verification fails | `bad signature` |
| - | none of the above | `ok: true` |

Row 3 covers two distinct wire shapes with one reason deliberately: a
missing tag and a present-but-garbage one both mean "no usable expiry", and
treating them differently would invite exactly the fail-open bug this
covers - see the next paragraph.

**A non-numeric `expiration` must never be treated as unexpired.**
`Number('garbage')` is `NaN`, and every comparison with `NaN`, including
`NaN <= now`, is `false` - so a naive `Number(expiration) <= now` check
silently *admits* a credential with a corrupted expiry tag instead of
refusing it. This was not exploitable in practice at the time it was found,
because the `expiration` tag sits inside the event's signed content and the
signature check (row 6 / step "signature last") still catches a tampered
tag - but it is a fail-open default sitting inside a security check, and
relying on check *ordering* elsewhere to keep it safe is exactly the kind of
coupling that breaks quietly when the ordering changes. Both implementations
must reject a non-finite expiry outright: TypeScript via
`Number.isFinite(expiresAt)`, Kotlin via `toLongOrNull()` (which already
returns `null` - and therefore `"no expiration"` - for anything that is not
a valid integer, with no separate fix needed).

## Hex identifiers are compared case-insensitively

**Every hex-encoded identifier this protocol compares for equality -
pubkeys (`participant`, `device`, `issuer`, a signal's recipient) and
`roomId` - must be compared case-insensitively.** This protocol always
*produces* such identifiers in lower case (`getPublicKey`, `deriveRoom`'s
`toString(16)`, and their Kotlin equivalents all emit lower-case hex), but
nothing on the wire enforces that, and a room's access policy in particular
is data a person can type or paste - a `RoomPolicy.admitted` entry stored in
upper-case hex names exactly the same issuer and must not be rejected for
it. Decode paths must accept any case on input; they do not need to
*produce* anything but lower case.

This was found on audit, not by a vector, and is exactly the class of bug a
vector or a test only catches if someone thinks to vary the case: the first
independent implementation (Kotlin/Android) compared `proof.issuer` against
`policy.admitted` with an exact string match, so the same room, the same
kindred proof, and the same allow-list produced different admit/reject
answers on web versus Android depending purely on which case the allow-list
happened to be typed in - a silent split-brain with no error on either side.
`accessEvaluation`'s `kith-room-admits-issuer-via-upper-case-allow-list-entry`
and `kith-room-admits-upper-case-issuer-against-lower-case-allow-list`
vectors exist specifically to catch this, in both directions.

Every comparison of this kind must be normalised the same way on both
sides - do not lower-case one operand and leave the other as-is. The
reference implementation does this via a single `hexEquals` helper
(`src/hex.ts`) used at every hex-equality comparison site, rather than
`.toLowerCase()` sprinkled ad hoc through `access.ts`, `roster.ts`,
`credential.ts` and `signal.ts`; Kotlin's `String.hexEquals` extension
(`crypto/Hex.kt`) plays the same role. Comparisons this covers, concretely:
`proof.participant` against the `participant` argument and `proof.issuer`
against each `policy.admitted` entry (`access.ts`); a roster entry's
`device` against the signing event's `pubkey`, and the credential's
verified `device`/`participant` against the entry's (`roster.ts`); a
credential's `d` tag against the room id (`credential.ts`); a signal's
`roomId` and its `p` tag against the local room id and recipient pubkey
(`signal.ts`).

**What this does not cover.** `sig` is never compared for equality - it is
decoded to bytes and fed to schnorr verification, which is case-agnostic by
construction - so it is unaffected either way. A handful of comparisons of
the same *shape* were found outside the four files above during this audit
and deliberately left untouched, because they are not wire-format
interop the vectors pin, and both implementations already agree with each
other on them (case-sensitive on both sides, not case-insensitive - a
latent risk of the same kind, not a live divergence today):
`resolveSingularRoles`'s device-pubkey tiebreak (`roles.ts` /
`RoleArbiter.kt`), `Peer`'s polite/impolite tiebreak
(`peer.ts` / `Negotiation.kt`), `RoomSession`'s self-device/self-participant
filtering (`session.ts`, `mesh.ts` / `RoomSession.kt`, `WebRtcEngine.kt`),
credential-adoption's device check (`session.ts` / `RoomIdentity.kt`), and
`decodeChatEvent`'s device/participant/room checks (`chat.ts`, which has no
Kotlin equivalent in `:protocol` at all - `Chat.kt` lives in `:app`). A
future pass should extend the same `hexEquals` treatment there for
consistency, but none of it is reachable via `evaluateAccess`,
`verifyDeviceCredential`, `decodeRosterEvent` or `unwrapSignal`, so it is
out of scope for the vectors in this file.

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
