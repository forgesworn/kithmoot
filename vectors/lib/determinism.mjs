// Shared low-level helpers for deriving byte-identical crypto output from
// fixed, labelled inputs. Used by both `generate.mjs` (which builds the
// vectors) and `verify.test.ts` (which recomputes them independently to
// prove the JSON file was not hand-edited into something the derivation no
// longer produces).
//
// Nothing in here is a KithMoot primitive in its own right - it is the
// smallest amount of code needed to call the *real* cryptographic building
// blocks (`@noble/curves` schnorr, NIP-44) with explicit, recorded
// randomness in place of the random defaults `src/` uses in production.

import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { getEventHash } from 'nostr-tools/pure'

const NAMESPACE = 'kithmoot/v1/vectors'

/**
 * A fixed 32-byte value derived from a label: an aux-rand seed, a NIP-44
 * nonce, or an edge-case room secret. Deterministic and stable across runs,
 * which is the entire point of a test vector - two people (or two
 * languages) hashing the same label always get the same bytes.
 */
export function seed32(label) {
  return sha256(utf8ToBytes(`${NAMESPACE}/${label}`))
}

/**
 * A valid secp256k1 secret key derived from a label.
 *
 * `schnorr.utils.randomSecretKey` maps an arbitrary 48-byte seed onto a
 * uniformly valid scalar in [1, n-1] via `mapHashToField`, so any 48-byte
 * input - not only a real CSPRNG draw - produces a usable key. Feeding it a
 * fixed, labelled HKDF output instead of random bytes is the documented way
 * to get a reproducible key out of that API, and it is what lets an
 * independent implementation regenerate exactly PARTICIPANT_A's key pair
 * from the label alone.
 */
export function deriveSecretKey(label) {
  const ikm = sha256(utf8ToBytes(`${NAMESPACE}/sk-ikm/${label}`))
  const seed48 = hkdf(sha256, ikm, undefined, `${NAMESPACE}/sk/${label}`, 48)
  return schnorr.utils.randomSecretKey(seed48)
}

/**
 * Build a signed Nostr event exactly as nostr-tools' `finalizeEvent` does
 * (see `node_modules/nostr-tools/lib/esm/pure.js`), except with an explicit
 * BIP-340 aux-rand in place of a random one.
 *
 * Every event-signing call in `src/` goes through `finalizeEvent`, which
 * signs with `schnorr.sign(hash, secretKey)` - no third argument, so
 * `@noble/curves` draws 32 fresh random bytes for aux-rand on every call.
 * That is correct for production (BIP-340 recommends randomising aux-rand
 * as side-channel hardening) and means two calls with identical inputs
 * never produce the same signature. A vector needs the opposite: the exact
 * same bytes on every run, on every machine. Fixing aux-rand to a recorded
 * seed is what the official BIP-340 test vectors do for exactly this
 * reason - it does not weaken the signature, because aux-rand only needs to
 * be unpredictable in a live signer, never in a frozen fixture.
 */
export function finalizeDeterministic(template, secretKey, auxRand) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const unsigned = { ...template, pubkey }
  const id = getEventHash(unsigned)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, auxRand))
  return { ...unsigned, id, sig }
}

/**
 * The exact bytes a kindred proof signs over.
 *
 * Mirrors `canonicalMessage` in `src/access.ts` byte for byte - that
 * function is not exported, because callers have no business constructing
 * this message themselves, so it is reproduced here deliberately rather
 * than imported. If the two ever disagree, `verify.test.ts`'s
 * access-evaluation assertions against the real `evaluateAccess` will fail.
 */
export function kindredCanonicalMessage(tier, participant, expiresAt) {
  return sha256(utf8ToBytes(`kithmoot/v1/kindred:${tier}:${participant}:${expiresAt}`))
}
