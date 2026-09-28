#!/usr/bin/env node
// Generates `vectors/circle-vectors.json` - the wire-compatibility proof for
// the circle-layer gaps identified before extracting KithMoot's circle code
// into a shared kit (see docs/plans/2026-09-28-circle-kit-extraction.md §3.2
// in the girnel repository). This file is separate from
// `vectors/kithmoot-vectors.json` on purpose: running this generator never
// touches that file, so the Android client's contract is untouched.
//
// Unlike `vectors/generate.mjs`, every signed/encrypted event here is built
// by calling the REAL encoder exported from `dist/` - `encodeInvitationRequest`,
// `encodeInvitationGrant`, `encodeInvitationRetirement`, `encodePersistentInvitation`,
// `encodeEpochGrant`, `createDeviceCredential`, `signChannels` - rather than
// hand-rebuilt from a template. Two ways in, both needed because the two
// kinds of randomness those functions draw are surfaced differently:
//
//   1. `createDeviceCredential` takes an injected `ParticipantIdentity`
//      (`identity.ts`), so its `signEvent` is given straight to
//      `finalizeDeterministic` with the recorded aux-rand - no stubbing
//      needed, because the seam is already there in production code.
//
//   2. Everything else signs with `finalizeEvent`/`nip44.v2.encrypt` with no
//      explicit nonce or aux-rand, which is right for production and means
//      two calls never produce the same bytes twice. `withStubbedRandomness`
//      (`vectors/lib/determinism.mjs`) replaces `globalThis.crypto.getRandomValues`
//      for the duration of one call with a queue of recorded 32-byte values,
//      which is what `@noble/hashes`' `randomBytes` reads on every draw - so
//      every signature and every NIP-44 nonce the real function makes comes
//      out byte-identical on every run, and the queue's order is recorded in
//      each vector's `input` so a second implementation can check its own
//      derivation without needing to read this file's source.
//
// Pure functions with no hidden randomness (`encodeRoomLink`, `parseRoomLink`,
// `deriveInvitationId`, `deriveEpoch`, `canonicalChannels`, `verifyChannels`,
// `verifyInvitationDelegation`, `verifyDeviceCredential`, `decodeEpochGrant`,
// `decodeInvitationRequest`, `decodeRoomAdmissionGrant`,
// `decodeInvitationRetirementNotice`, `decodePersistentInvitation`) are
// called directly, same as before.
//
// 11 vectors across 10 distinct reasons are signed directly with
// `finalizeDeterministic` and the REAL signer's own key, rather than driven
// through a real top-level encoder call (one reason covers two vectors that
// share a single event; a different pair of vectors together isolate one
// check from another). In every case the negative vector's whole point is a
// state no real encoder call can reach - the real function either refuses
// to build it (correctly) or always keeps the two things the vector needs
// to disagree in lock-step - so the signature itself is always genuine and
// only the body it signs over is hand-built. (Two states that look like
// this at first glance are NOT actually unreachable, and are driven through
// the real encoder instead: see `rekey-epoch-tag-zero-refused` and
// `refused-over-30-days` below, both exploiting real, separately
// documented quirks rather than being hand-built.)
//
//   - `invitationEnvelope`'s `request-device-mismatched-signer-refused`:
//     `encodeInvitationRequest` always sets `body.device` to its own
//     signer's pubkey, so no real call can produce a body that names a
//     different device than the key that actually signed it.
//   - `invitationEnvelope`'s `delegation-hop-wrong-issuer-refused`: a
//     genuine hop 2, but issued by `IMPOSTOR_SK` rather than hop 1's real
//     delegate - `encodeInvitationGrant` calls `verifyInvitationDelegation`
//     on its own chain first and throws unless its signer is exactly who the
//     chain authorises, so no real call lets a non-delegate extend somebody
//     else's chain.
//   - `invitationEnvelope`'s `grant-signer-not-final-issuer-refused`: same
//     reason - `encodeInvitationGrant` refuses to let `IMPOSTOR_SK` sign a
//     grant carrying a chain that does not authorise it.
//   - `invitationEnvelope`'s `grant-secret-room-mismatch-refused`: the real
//     encoder always derives the sealed secret's room and the chain's room
//     from the same `roomSecret` argument, so the two can never disagree in
//     real output.
//   - `persistentInvitation`'s `room-mismatch-refused`: `encodePersistentInvitation`
//     always writes `room: deriveRoom(opts.roomSecret).roomId` alongside that
//     same secret, so the two can never disagree either.
//   - `personCredential`'s `wrong-person-identity-path-refused` and
//     `wrong-person-acceptperson-path-refused` (one event, two checks, one
//     reason): `createDeviceCredential` always sets `d` to its own signer's
//     pubkey for a person credential, so no real call can produce a `d`
//     naming someone other than whoever actually signed it.
//   - `epochGrant`'s `grant-epoch-above-max-refused`: the real
//     `encodeEpochGrant` refuses to build a grant above `MAX_EPOCH` itself
//     (`requireEpochNumber` throws at encode time), so the DECODE-side bound
//     this vector pins can only be reached by a body the real encoder would
//     never produce.
//   - `epochGrant`'s `rekey-epoch-tag-leading-zero-refused`: `encodeRekeyEvent`
//     always writes `String(epoch)`, which JavaScript never renders with a
//     leading zero for a non-negative integer, so no real call can write an
//     `epoch` tag of `"01"`.
//   - `epochGrant`'s `rekey-epoch-tag-above-max-refused`: the real
//     `encodeRekeyEvent` refuses to build an epoch above `MAX_EPOCH` itself
//     (same `requireEpochNumber` guard as the grant above), so this DECODE-side
//     bound can only be reached by a tag the real encoder would never write.
//   - `epochRequest`'s `credential-device-not-signer-refused-admission-matches`:
//     `encodeEpochRequest` always computes its admission proof for its own
//     real signer, so no real call can produce an admission that matches a
//     DIFFERENT device (the credential's claimed one) - needed here to
//     isolate the device check (epoch.ts:457) from the admission check,
//     which the vector above it fails independently of the device check.
//
// Non-exported message shapes mirrored here byte for byte, because nothing
// outside their own module has business constructing them: the invitation
// request key and delegation message (`src/invitation.ts`'s unexported
// `requestKey`/`delegationMessage`) and the epoch/persistent-invitation
// welcome keys (`src/invitation.ts` `INVITATION_REQUEST_KEY_INFO`,
// `src/persistent-invitation.ts` `welcomeKey`'s info string). Every mirror is
// checked against its real module by running the built event through the
// matching `verifyXxx`/`decodeXxx` before it is written out.
//
// Running this script twice produces byte-identical output: no
// `Date.now()`, no `Math.random()`, no unrecorded `randomBytes()`.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hkdf } from '@noble/hashes/hkdf'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip44 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'

import { deriveSecretKey, finalizeDeterministic, seed32, withStubbedRandomness } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

// The real implementation, built to `dist/` by `npm run build:lib`.
import { KINDS } from '../dist/src/kinds.js'
import { deriveRoom } from '../dist/src/room.js'
import { encodeRoomLink, parseRoomLink, MAX_ROOM_LINK_FRAGMENT_LENGTH } from '../dist/src/link.js'
import { MAX_RELAY_HINTS, safeIceUrls, safeRelayUrls } from '../dist/src/network-hints.js'
import { sanitiseDisplayName } from '../dist/src/display-name.js'
import {
  deriveInvitationId,
  decodeInvitationRequest,
  decodeRoomAdmissionGrant,
  decodeInvitationRetirementNotice,
  verifyInvitationDelegation,
  encodeInvitationRequest,
  encodeInvitationGrant,
  encodeInvitationRetirement,
} from '../dist/src/invitation.js'
import { decodePersistentInvitation, encodePersistentInvitation } from '../dist/src/persistent-invitation.js'
import { verifyDeviceCredential, createDeviceCredential, PERSON_CREDENTIAL_MAX_SECONDS } from '../dist/src/credential.js'
import {
  deriveEpoch,
  decodeEpochGrant,
  encodeEpochGrant,
  encodeEpochRequest,
  decodeEpochRequest,
  epochRequestAdmission,
  peekRekeyEvent,
  encodeRekeyEvent,
  canonicalChannels,
  verifyChannels,
  signChannels,
  MAX_EPOCH,
} from '../dist/src/epoch.js'
import { evaluateAccess, issueKindredProof } from '../dist/src/access.js'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'circle-vectors.json')

const vectors = {
  linkEnvelope: [],
  invitationEnvelope: [],
  persistentInvitation: [],
  epochGrant: [],
  epochRequest: [],
  personCredential: [],
  channelsSignature: [],
  accessEvaluation: [],
}

// ===========================================================================
// Local fixtures - labelled the same way `vectors/lib/fixtures.mjs` does,
// but kept in this file rather than added there: this generator must never
// risk changing a byte `generate.mjs` produces for `kithmoot-vectors.json`.
// ===========================================================================

const INVITER_A_SK = deriveSecretKey('circle-vectors/inviter-a')
const INVITER_A = getPublicKey(INVITER_A_SK)
const REQUESTER_A_SK = deriveSecretKey('circle-vectors/requester-a')
const REQUESTER_A = getPublicKey(REQUESTER_A_SK)
const DELEGATE_A_SK = deriveSecretKey('circle-vectors/delegate-a')
const DELEGATE_A = getPublicKey(DELEGATE_A_SK)
const OTHER_INVITER_SK = deriveSecretKey('circle-vectors/inviter-other')
const OTHER_INVITER = getPublicKey(OTHER_INVITER_SK)
const IMPOSTOR_SK = deriveSecretKey('circle-vectors/impostor')
const IMPOSTOR = getPublicKey(IMPOSTOR_SK)

const BEARER_A = seed32('circle-vectors/bearer-a')
const BEARER_B = seed32('circle-vectors/bearer-b')

const INVITATION_2 = { bearer: BEARER_A, inviter: INVITER_A }
const INVITATION_3 = { bearer: BEARER_B, inviter: INVITER_A, persistent: true }

const BASE_URL = 'https://kithmoot.com/j'
const NOW = fx.NOW
const REQUEST_CREATED_AT = fx.NOW - 30
const GRANT_CREATED_AT = fx.NOW - 10
const RETIREMENT_CREATED_AT = fx.NOW + 100

/** `identity.ts`'s `ParticipantIdentity` seam, driven with a fixed aux-rand:
 *  `createDeviceCredential` already takes its signer as an injected
 *  dependency, so this is the documented way to make it deterministic - no
 *  randomness stubbing needed for this one function. */
function deterministicIdentity(sk, auxRand) {
  return {
    pubkey: getPublicKey(sk),
    async signEvent(unsigned) {
      return finalizeDeterministic(unsigned, sk, auxRand)
    },
  }
}

async function main() {
// ===========================================================================
// 1. Link envelope - v1 (legacy secret), v2 (live) and v3 (persistent) round
//    trips, refusals, and normalisation of hostile input (`src/link.ts`).
// ===========================================================================

function linkRoundTrip(name, note, link) {
  const url = encodeRoomLink(BASE_URL, link)
  const decoded = parseRoomLink(url)
  vectors.linkEnvelope.push({
    name,
    kind: 'positive',
    note,
    input: {
      base: BASE_URL,
      link: {
        invitation: link.invitation
          ? { bearerHex: bytesToHex(link.invitation.bearer), inviter: link.invitation.inviter, persistent: link.invitation.persistent ?? null }
          : null,
        secretHex: link.secret ? bytesToHex(link.secret) : null,
        relays: link.relays,
        iceUrls: link.iceUrls,
        policy: link.policy ?? null,
        pairingCodeHex: link.pairingCode ? bytesToHex(link.pairingCode) : null,
        name: link.name ?? null,
      },
    },
    output: {
      url,
      decoded: {
        invitation: decoded.invitation
          ? { bearerHex: bytesToHex(decoded.invitation.bearer), inviter: decoded.invitation.inviter, persistent: decoded.invitation.persistent ?? null }
          : null,
        secretHex: decoded.secret ? bytesToHex(decoded.secret) : null,
        relays: decoded.relays,
        iceUrls: decoded.iceUrls,
        policy: decoded.policy ?? null,
        pairingCodeHex: decoded.pairingCode ? bytesToHex(decoded.pairingCode) : null,
        name: decoded.name ?? null,
      },
    },
  })
}

linkRoundTrip(
  'v2-live-full-envelope',
  'A version 2 live-rendezvous link carrying every optional field at once: relay and ICE hints, a kith-gated policy, a pairing code (adding a device) and a room name.',
  {
    invitation: INVITATION_2,
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    iceUrls: ['stun:stun.kithmoot.example:3478'],
    policy: { tier: 'kith', admitted: [fx.HOST] },
    pairingCode: seed32('circle-vectors/pairing-code').slice(0, 16),
    name: 'Weekly town hall',
  },
)

linkRoundTrip(
  'v3-persistent-named-no-pairing-code',
  'A version 3 stored group link: no pairing code, an open policy, and a name. Persistent invitations round-trip through the same envelope as v2, only the version number and the invitation.persistent flag differ.',
  {
    invitation: INVITATION_3,
    relays: ['wss://relay.damus.io'],
    iceUrls: [],
    policy: { tier: 'open' },
    name: 'Family',
  },
)

linkRoundTrip(
  'v2-live-no-optional-fields',
  'A version 2 link with none of the optional fields: no policy, no pairing code, no name. The fragment must carry none of their keys.',
  { invitation: INVITATION_2, relays: [], iceUrls: [] },
)

linkRoundTrip(
  'v1-legacy-secret-link',
  "The version-1 shape from before invitations existed: the room traffic secret rides directly in the fragment (`s`), with no `j`/`h` invitation pair. `encodeRoomLink` writes this branch whenever `link.invitation` is absent, and a v1 URL carries no `v` key at all - `parseRoomLink` reads that absence the same way it reads `v: 1` would, which is the whole compatibility story for a link written before versioning existed.",
  { secret: fx.ROOM_SECRET_1, relays: ['wss://relay.damus.io'], iceUrls: [] },
)

{
  // A v3 link is still refused if its admission rule cannot be read - the
  // version number changes nothing about that rule (`link.ts:85-93` runs
  // before the invitation is even parsed).
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 3, j: base64urlnopad.encode(BEARER_B), h: INVITER_A, r: [], i: [], a: { tier: 'archon' },
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'v3-unknown-policy-tier-refused',
    kind: 'negative',
    note: 'A v3 (persistent) link naming an access tier outside open/ken/kith/kin is refused before the invitation itself is even read - a dropped rule would be an open room.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  // A version this parser has never heard of: v:4 must never be silently
  // treated as v2/v3 (which would read `j`/`h` and admit off a made-up
  // scheme) nor as v1 (which would look for `s` and find nothing).
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 4, j: base64urlnopad.encode(BEARER_A), h: INVITER_A, r: [], i: [],
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'v4-unsupported-version-refused',
    kind: 'negative',
    note: 'A link naming a version number this parser does not know (`v: 4`, one past the newest it understands): refused outright rather than guessed at as v1, v2 or v3.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  // A 31-byte bearer: one byte short of the 32 `roomInvitation` requires.
  // Caught on decode, not silently zero-padded or truncated to fit.
  const shortBearer = seed32('circle-vectors/short-bearer').slice(0, 31)
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 2, j: base64urlnopad.encode(shortBearer), h: INVITER_A, r: [], i: [],
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'bearer-31-bytes-refused',
    kind: 'negative',
    note: 'A bearer one byte short of the required 32: `roomInvitation` refuses it rather than accepting a link whose rendezvous derivation would not match what a correctly-sized bearer produces.',
    input: { url, bearerHex: bytesToHex(shortBearer) },
    output: { throws: true, error },
  })
}

{
  // An odd-length, non-hex pairing code: `hexToBytes` on `payload.c` throws,
  // and `parseRoomLink` turns that into its own named error rather than
  // letting a low-level parse error leak through.
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 2, j: base64urlnopad.encode(BEARER_A), h: INVITER_A, r: [], i: [], c: 'not-hex-zz',
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'pairing-code-malformed-refused',
    kind: 'negative',
    note: 'A pairing code field that is not valid hex at all: refused with a named error, not an uncaught parse exception.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  // Nine relay hints: one past MAX_RELAY_HINTS. Refused on ENCODE as well as
  // decode - `assertNetworkHintBounds` runs before `safeRelayUrls` would
  // otherwise just quietly keep the first eight.
  const nineRelays = Array.from({ length: MAX_RELAY_HINTS + 1 }, (_, i) => `wss://relay-${i}.kithmoot.example`)
  let error
  try { encodeRoomLink(BASE_URL, { invitation: INVITATION_2, relays: nineRelays, iceUrls: [] }) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'nine-relay-hints-refused',
    kind: 'negative',
    note: `One more than MAX_RELAY_HINTS (${MAX_RELAY_HINTS}) relay hint: refused outright on encode, rather than silently keeping the first ${MAX_RELAY_HINTS} and dropping the rest without saying so.`,
    input: { relays: nineRelays },
    output: { throws: true, error },
  })
}

{
  // A fragment past MAX_ROOM_LINK_FRAGMENT_LENGTH: the length check runs on
  // the raw fragment text, before any base64/JSON decoding is attempted, so
  // an oversized fragment cannot even reach the parser proper.
  const oversized = 'A'.repeat(MAX_ROOM_LINK_FRAGMENT_LENGTH + 1)
  const url = `${BASE_URL}#${oversized}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'oversize-fragment-refused',
    kind: 'negative',
    note: `A fragment one character past MAX_ROOM_LINK_FRAGMENT_LENGTH (${MAX_ROOM_LINK_FRAGMENT_LENGTH}): refused on length alone, before the fragment is treated as base64 or JSON at all.`,
    input: { url, fragmentLength: oversized.length },
    output: { throws: true, error },
  })
}

{
  // Hostile input the real link envelope has to normalise on the way in:
  // duplicate relay hints, a non-loopback ws:// hint (unsafe - must be
  // dropped), a loopback ws:// hint (safe - must be kept), and a name
  // carrying control characters and overlong text. Built by hand rather
  // than through `encodeRoomLink`, which would filter these before they
  // ever reached the wire - the point here is what `parseRoomLink` itself
  // does when handed a link nobody's own encoder would have produced.
  const hostileRelays = ['wss://relay.damus.io', 'wss://relay.damus.io', 'ws://tracker.example', 'ws://localhost:4869']
  const hostileIce = ['stun:stun.kithmoot.example:3478', 'stun:stun.kithmoot.example:3478']
  const hostileName = `Robin‮admin​${'x'.repeat(40)}`
  const payload = { v: 2, j: base64urlnopad.encode(BEARER_A), h: INVITER_A, r: hostileRelays, i: hostileIce, n: hostileName }
  const url = `${BASE_URL}#${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}`
  const decoded = parseRoomLink(url)
  vectors.linkEnvelope.push({
    name: 'hostile-input-normalised',
    kind: 'positive',
    note: "A link nobody's own encoder produced: duplicate relay and ICE hints, a non-loopback ws:// relay (unsafe - the room requires wss:// off loopback), a loopback ws:// relay (safe - kept for local development and tests), and a name carrying a bidirectional override, a zero-width space and overlong text. `parseRoomLink` is still readable, and every hostile byte is normalised away rather than rejected outright: the invitation itself is genuine, only its envelope is adversarial.",
    input: { url, rawRelays: hostileRelays, rawIceUrls: hostileIce, rawName: hostileName },
    output: {
      decoded: {
        relays: decoded.relays,
        iceUrls: decoded.iceUrls,
        name: decoded.name ?? null,
      },
    },
    expected: {
      relays: safeRelayUrls(hostileRelays),
      iceUrls: safeIceUrls(hostileIce),
      name: sanitiseDisplayName(hostileName) ?? null,
    },
  })
}

// ===========================================================================
// 2. Invitation envelope (v2) - id, request, grant with a delegation chain,
//    delegation-chain and grant-body security refusals, and retirement.
// ===========================================================================

vectors.invitationEnvelope.push({
  name: 'invitation-id-derivation',
  kind: 'positive',
  note: 'The public rendezvous id: HKDF-SHA256 of the bearer alone. Pure - the real function is called directly.',
  input: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
  output: { id: deriveInvitationId(INVITATION_2) },
})

// --- Request (kind 20466), driven through the real encoder -----------------

{
  const nonce = seed32('invitation-request-valid-nonce')
  const auxRand = seed32('invitation-request-valid')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeInvitationRequest({ invitation: INVITATION_2, requesterSk: REQUESTER_A_SK, now: REQUEST_CREATED_AT, name: 'Rowan', participant: fx.PARTICIPANT_A }),
  )
  const decoded = decodeInvitationRequest(event, { invitation: INVITATION_2, now: NOW })
  vectors.invitationEnvelope.push({
    name: 'request-valid',
    kind: 'positive',
    note: 'A request proving possession of the bearer, carrying an asking name and a participant pubkey. Built by calling the real `encodeInvitationRequest` with `crypto.getRandomValues` stubbed to the recorded [nonce, auxRand] queue - the NIP-44 nonce is drawn first (it is part of building `content`, which is evaluated before `finalizeEvent` signs), then the signature aux-rand.',
    input: {
      invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
      requesterSkHex: bytesToHex(REQUESTER_A_SK),
      createdAt: REQUEST_CREATED_AT,
      name: 'Rowan',
      participant: fx.PARTICIPANT_A,
      randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)],
    },
    output: { event },
    expected: { decode: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, now: NOW }, result: decoded },
  })
}

{
  const nonce = seed32('invitation-request-stale-nonce')
  const auxRand = seed32('invitation-request-stale')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeInvitationRequest({ invitation: INVITATION_2, requesterSk: REQUESTER_A_SK, now: REQUEST_CREATED_AT }),
  )
  vectors.invitationEnvelope.push({
    name: 'request-stale-refused',
    kind: 'negative',
    note: 'The same request, read long after its 90-second window: refused as stale.',
    input: {
      event,
      invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
      decode: { now: REQUEST_CREATED_AT + 91 },
    },
    output: { result: decodeInvitationRequest(event, { invitation: INVITATION_2, now: REQUEST_CREATED_AT + 91 }) },
  })
}

{
  // M13: a request whose signer is a genuine device (its own real key
  // signs the event), but whose body names a DIFFERENT device than its
  // signer - what an attacker who controls the requester process but wants
  // to attribute a request to somebody else's device would send. The
  // real `requestKey` HKDF is mirrored (not exported) so the body can be
  // built by hand; the signature itself is real, made by `REQUESTER_A_SK`.
  const impersonatedDevice = OTHER_INVITER
  const requestKeyInfo = 'kithmoot/v2/invitation-request-key'
  const requestKey = hkdfSha256(INVITATION_2.bearer, requestKeyInfo)
  const nonce = seed32('invitation-request-device-mismatch-nonce')
  const auxRand = seed32('invitation-request-device-mismatch')
  const body = { v: 1, device: impersonatedDevice }
  const event = finalizeDeterministic(
    {
      kind: KINDS.INVITATION_REQUEST,
      created_at: REQUEST_CREATED_AT,
      tags: [['d', deriveInvitationId(INVITATION_2)], ['p', INVITATION_2.inviter]],
      content: nip44.v2.encrypt(JSON.stringify(body), requestKey, nonce),
    },
    REQUESTER_A_SK,
    auxRand,
  )
  vectors.invitationEnvelope.push({
    name: 'request-device-mismatched-signer-refused',
    kind: 'negative',
    note: "M13: the event is genuinely signed by REQUESTER_A_SK - a real signature, not a zeroed or forged one - but the encrypted body claims a different device (`OTHER_INVITER`'s pubkey) than the key that actually signed it. `decodeInvitationRequest` checks `body.device` against `event.pubkey` and refuses the mismatch, or a stolen signing key could request admission in somebody else's device's name.",
    input: { event, body, signerIsReallyDevice: REQUESTER_A },
    output: { result: decodeInvitationRequest(event, { invitation: INVITATION_2, now: REQUEST_CREATED_AT }) },
  })
}

// --- Grant (kind 20467), with a real two-hop delegation chain --------------

const GRANT_ROOM_ID = deriveRoom(fx.ROOM_SECRET_1).roomId
const OTHER_ROOM_ID = deriveRoom(fx.ROOM_SECRET_2).roomId

function requestIdFor(label) {
  // A stand-in request id: `decodeRoomAdmissionGrant` only checks it
  // against the value the caller supplies, so any 32-byte hex is fine.
  return bytesToHex(seed32(label))
}

// Hop 1, through the real encoder: the root inviter grants DELEGATE_A
// directly (an empty incoming chain), and the resulting admission's own
// `delegate.chain` - decoded by the real `decodeRoomAdmissionGrant` - IS
// hop 1. Nothing about hop 1's bytes is hand-built.
const hop1Nonce = seed32('grant-hop1-nonce')
const hop1DelegationAuxRand = seed32('grant-hop1-delegation-auxrand')
const hop1OuterAuxRand = seed32('grant-hop1-outer-auxrand')
const request1Id = requestIdFor('grant-hop1-request')
const grant1Event = withStubbedRandomness([hop1DelegationAuxRand, hop1Nonce, hop1OuterAuxRand], () =>
  encodeInvitationGrant({
    invitation: INVITATION_2,
    inviterSk: INVITER_A_SK,
    requester: DELEGATE_A,
    request: request1Id,
    roomSecret: fx.ROOM_SECRET_1,
    now: GRANT_CREATED_AT - 20,
    delegation: [],
    epoch: 0,
  }),
)
const admission1 = decodeRoomAdmissionGrant(grant1Event, {
  invitation: INVITATION_2,
  requesterSk: DELEGATE_A_SK,
  request: request1Id,
  now: GRANT_CREATED_AT - 20,
})
if (!admission1) throw new Error('hop-1 grant must decode - it is the scaffolding for every two-hop vector below')
const chainHop1 = admission1.delegate.chain[0]

// Hop 2: DELEGATE_A (now a responder, holding hop 1's chain) grants
// REQUESTER_A. Again entirely through the real encoder.
const hop2Nonce = seed32('grant-hop2-nonce')
const hop2DelegationAuxRand = seed32('grant-hop2-delegation-auxrand')
const hop2OuterAuxRand = seed32('grant-hop2-outer-auxrand')
const request2Id = requestIdFor('grant-hop2-request')
const grant2Event = withStubbedRandomness([hop2DelegationAuxRand, hop2Nonce, hop2OuterAuxRand], () =>
  encodeInvitationGrant({
    invitation: INVITATION_2,
    inviterSk: DELEGATE_A_SK,
    requester: REQUESTER_A,
    request: request2Id,
    roomSecret: fx.ROOM_SECRET_1,
    now: GRANT_CREATED_AT,
    delegation: admission1.delegate.chain,
    epoch: 0,
  }),
)
const admission2 = decodeRoomAdmissionGrant(grant2Event, {
  invitation: INVITATION_2,
  requesterSk: REQUESTER_A_SK,
  request: request2Id,
  now: GRANT_CREATED_AT,
})

vectors.invitationEnvelope.push({
  name: 'grant-two-hop-delegation',
  kind: 'positive',
  note: 'A grant signed by a delegated responder (not the root inviter), carrying the full two-hop chain rooted at the inviter. Both hops and both grant events are produced by calling the real `encodeInvitationGrant` twice - hop 1 by the creator, hop 2 by the responder hop 1 itself admitted - with `crypto.getRandomValues` stubbed to each call\'s own recorded 3-value queue: the new delegation hop\'s signature aux-rand (drawn inside the not-exported `issueInvitationDelegation`), then the grant body\'s NIP-44 nonce, then the outer event\'s signature aux-rand.',
  input: {
    hop1: {
      grantEvent: grant1Event,
      randomnessQueueHex: [bytesToHex(hop1DelegationAuxRand), bytesToHex(hop1Nonce), bytesToHex(hop1OuterAuxRand)],
      inviterSkHex: bytesToHex(INVITER_A_SK),
      requester: DELEGATE_A,
      request: request1Id,
      createdAt: GRANT_CREATED_AT - 20,
    },
    hop2: {
      randomnessQueueHex: [bytesToHex(hop2DelegationAuxRand), bytesToHex(hop2Nonce), bytesToHex(hop2OuterAuxRand)],
      inviterSkHex: bytesToHex(DELEGATE_A_SK),
      requester: REQUESTER_A,
      request: request2Id,
      createdAt: GRANT_CREATED_AT,
    },
  },
  output: { event: grant2Event },
  expected: {
    decode: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, requesterSkHex: bytesToHex(REQUESTER_A_SK), request: request2Id, now: GRANT_CREATED_AT },
    result: admission2 && { secretHex: bytesToHex(admission2.secret), delegateSkHex: bytesToHex(admission2.delegate.delegateSk), chain: admission2.delegate.chain, epoch: admission2.epoch ?? null },
    chainVerifiesTo: verifyInvitationDelegation(INVITATION_2, admission2.delegate.chain, NOW),
  },
})

{
  // Tamper one byte of the second hop's signature: the whole chain must be
  // refused, not just the tampered hop. (Kept alongside the validly-signed
  // negatives below, which prove the app-level checks rather than only the
  // schnorr verification this one exercises.)
  const tamperedHop2 = { ...admission2.delegate.chain[1], sig: '00'.repeat(64) }
  const chain = [chainHop1, tamperedHop2]
  vectors.invitationEnvelope.push({
    name: 'delegation-chain-tampered-second-hop',
    kind: 'negative',
    note: "The two-hop chain above with hop 2's signature zeroed out. The whole chain is refused - a member cannot forge the last hop and admit themselves.",
    input: { chain },
    output: { result: verifyInvitationDelegation(INVITATION_2, chain, NOW) },
  })
}

{
  // M5: hop 2 genuinely signed, but by somebody who is NOT hop 1's
  // delegate - i.e. the issuer chain is broken. `IMPOSTOR_SK` holds a real
  // keypair and signs a real, validly-formed delegation hop; it is simply
  // not the pubkey hop 1 named as its delegate.
  const invitationId = deriveInvitationId(INVITATION_2)
  const forgedHop2ExpiresAt = NOW + 1800
  const forgedAuxRand = seed32('delegation-hop2-wrong-issuer-auxrand')
  const forgedSig = bytesToHex(schnorr.sign(
    delegationMessageBytes(invitationId, GRANT_ROOM_ID, IMPOSTOR, REQUESTER_A, forgedHop2ExpiresAt),
    IMPOSTOR_SK,
    forgedAuxRand,
  ))
  const forgedHop2 = { invitation: invitationId, room: GRANT_ROOM_ID, issuer: IMPOSTOR, delegate: REQUESTER_A, expiresAt: forgedHop2ExpiresAt, sig: forgedSig }
  const chain = [chainHop1, forgedHop2]
  vectors.invitationEnvelope.push({
    name: 'delegation-hop-wrong-issuer-refused',
    kind: 'negative',
    note: 'M5: hop 2 carries a genuine, validly-verifying schnorr signature - by IMPOSTOR_SK, a real keypair unrelated to this invitation - but IMPOSTOR is not hop 1\'s delegate (DELEGATE_A is). `verifyInvitationDelegation` walks the chain checking each hop\'s issuer against the PREVIOUS hop\'s delegate, so a validly-signed hop from the wrong signer is refused; only checking each hop\'s own signature in isolation would accept it.',
    input: { chain, forgedByPubkey: IMPOSTOR },
    output: { result: verifyInvitationDelegation(INVITATION_2, chain, NOW) },
  })
}

{
  // M9: an outer grant event genuinely signed by somebody OTHER than the
  // chain's final issuer. The body (delegation chain, secret, request,
  // epoch) is exactly hop 2's real body, encrypted with a REAL conversation
  // key between IMPOSTOR_SK and the requester, and the outer event is REALLY
  // signed by IMPOSTOR_SK - so both the encryption and the signature verify.
  // `decodeRoomAdmissionGrant` still refuses it because the chain's last
  // hop names DELEGATE_A as issuer, not the event's actual signer.
  // The delegation chain is exactly admission2's own real, valid two-hop
  // chain - unmodified - so the mismatch below is only ever the SIGNER,
  // never the chain or the body.
  const grantBody = { v: 2, request: request2Id, secret: base64urlnopad.encode(fx.ROOM_SECRET_1), delegation: admission2.delegate.chain, epoch: 0 }
  const conversationKey = nip44.v2.utils.getConversationKey(IMPOSTOR_SK, REQUESTER_A)
  const nonce = seed32('grant-wrong-signer-nonce')
  const auxRand = seed32('grant-wrong-signer-auxrand')
  const event = finalizeDeterministic(
    { kind: KINDS.INVITATION_GRANT, created_at: GRANT_CREATED_AT, tags: [['d', deriveInvitationId(INVITATION_2)], ['p', REQUESTER_A]], content: nip44.v2.encrypt(JSON.stringify(grantBody), conversationKey, nonce) },
    IMPOSTOR_SK,
    auxRand,
  )
  vectors.invitationEnvelope.push({
    name: 'grant-signer-not-final-issuer-refused',
    kind: 'negative',
    note: "M9: the outer event is REALLY signed by IMPOSTOR_SK (a genuine schnorr signature that verifies), and the NIP-44 content REALLY decrypts under the requester's real conversation key with IMPOSTOR - but the delegation chain inside names DELEGATE_A as its final issuer. `decodeRoomAdmissionGrant` checks `body.delegation.at(-1).issuer` against `event.pubkey` and refuses the mismatch; without it, anybody could wrap somebody else's real, valid delegation chain in an event of their own and be believed.",
    input: { event, body: grantBody, actualSigner: IMPOSTOR },
    output: { result: decodeRoomAdmissionGrant(event, { invitation: INVITATION_2, requesterSk: REQUESTER_A_SK, request: request2Id, now: GRANT_CREATED_AT }) },
  })
}

{
  // M19: a grant whose delegation chain is correctly rooted and signed for
  // fx.ROOM_SECRET_1's room, but whose SECRET is fx.ROOM_SECRET_2's - i.e.
  // the chain and the room the grant actually opens disagree. Produced by
  // taking the real hop-1 grant's genuine chain and secret-encrypting body,
  // then swapping only the `secret` field and re-signing for real with the
  // same real inviter key (the signature is genuine; only the body's
  // internal consistency is what is being attacked).
  const mismatchedBody = { v: 2, request: request1Id, secret: base64urlnopad.encode(fx.ROOM_SECRET_2), delegation: admission1.delegate.chain, epoch: 0 }
  const conversationKey = nip44.v2.utils.getConversationKey(INVITER_A_SK, DELEGATE_A)
  const nonce = seed32('grant-room-mismatch-nonce')
  const auxRand = seed32('grant-room-mismatch-auxrand')
  const event = finalizeDeterministic(
    { kind: KINDS.INVITATION_GRANT, created_at: GRANT_CREATED_AT - 20, tags: [['d', deriveInvitationId(INVITATION_2)], ['p', DELEGATE_A]], content: nip44.v2.encrypt(JSON.stringify(mismatchedBody), conversationKey, nonce) },
    INVITER_A_SK,
    auxRand,
  )
  vectors.invitationEnvelope.push({
    name: 'grant-secret-room-mismatch-refused',
    kind: 'negative',
    note: "M19: genuinely signed by the real root inviter, carrying the real hop-1 delegation chain (rooted and bound to fx.ROOM_SECRET_1's room) - but the sealed secret is fx.ROOM_SECRET_2's, a different room entirely. `decodeRoomAdmissionGrant` checks `body.delegation[0].room` against `deriveRoom(secret).roomId` and refuses the mismatch; without it, a chain authorised for one room could be reused to open a different one.",
    input: { event, body: mismatchedBody, chainRoom: GRANT_ROOM_ID, secretDerivesToRoom: OTHER_ROOM_ID },
    output: { result: decodeRoomAdmissionGrant(event, { invitation: INVITATION_2, requesterSk: DELEGATE_A_SK, request: request1Id, now: GRANT_CREATED_AT - 20 }) },
  })
}

{
  // M21: hop 1's own recorded expiry, checked at a `now` past it. The chain
  // and event are exactly the real hop-1 grant above; only the decode-time
  // clock differs.
  const pastExpiry = chainHop1.expiresAt + 1
  vectors.invitationEnvelope.push({
    name: 'grant-delegation-expired-refused',
    kind: 'negative',
    note: `M21: hop 1's real, validly-signed delegation names an expiry of ${chainHop1.expiresAt}. Checked one second after that instant, the whole chain is refused - an expired hop is no hop, however good its signature.`,
    input: { chain: [chainHop1], now: pastExpiry },
    output: { result: verifyInvitationDelegation(INVITATION_2, [chainHop1], pastExpiry) },
  })
}

// --- Retirement (kind 1461), driven through the real encoder ---------------

{
  const auxRand = seed32('retirement-plain')
  const event = withStubbedRandomness([auxRand], () =>
    encodeInvitationRetirement({ invitation: INVITATION_2, inviterSk: INVITER_A_SK, now: RETIREMENT_CREATED_AT, ended: false }),
  )
  vectors.invitationEnvelope.push({
    name: 'retirement-plain',
    kind: 'positive',
    note: 'An ordinary retirement: the link was replaced, not the room ended. Built by calling the real `encodeInvitationRetirement`.',
    input: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, inviterSkHex: bytesToHex(INVITER_A_SK), createdAt: RETIREMENT_CREATED_AT, randomnessQueueHex: [bytesToHex(auxRand)] },
    output: { event },
    expected: { result: decodeInvitationRetirementNotice(event, INVITATION_2) },
  })
}

{
  const auxRand = seed32('retirement-ended')
  const event = withStubbedRandomness([auxRand], () =>
    encodeInvitationRetirement({ invitation: INVITATION_2, inviterSk: INVITER_A_SK, now: RETIREMENT_CREATED_AT, ended: true }),
  )
  vectors.invitationEnvelope.push({
    name: 'retirement-room-ended',
    kind: 'positive',
    note: 'A retirement that also says the room itself was ended, not just this link replaced.',
    input: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, inviterSkHex: bytesToHex(INVITER_A_SK), createdAt: RETIREMENT_CREATED_AT, randomnessQueueHex: [bytesToHex(auxRand)] },
    output: { event },
    expected: { result: decodeInvitationRetirementNotice(event, INVITATION_2) },
  })
}

{
  const auxRand = seed32('retirement-forged')
  const event = withStubbedRandomness([auxRand], () =>
    encodeInvitationRetirement({ invitation: { ...INVITATION_2, inviter: OTHER_INVITER }, inviterSk: OTHER_INVITER_SK, now: RETIREMENT_CREATED_AT, ended: false }),
  )
  vectors.invitationEnvelope.push({
    name: 'retirement-wrong-signer-refused',
    kind: 'negative',
    note: 'A retirement signed by somebody other than the inviter pinned in the link: refused, even though the event itself verifies.',
    input: { event },
    output: { result: decodeInvitationRetirementNotice(event, INVITATION_2) ?? null },
  })
}

// ===========================================================================
// 3. Persistent (v3) group invitation - encode/decode both ways, a tampered
//    ciphertext, a room-body mismatch and a non-persistent invitation refused.
// ===========================================================================

{
  const nonce = seed32('persistent-invitation-valid-nonce')
  const auxRand = seed32('persistent-invitation-valid-auxrand')
  const createdAt = fx.NOW - 86_400 * 30
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodePersistentInvitation({ invitation: INVITATION_3, inviterSk: INVITER_A_SK, roomSecret: fx.ROOM_SECRET_1, now: createdAt }),
  )
  const decoded = decodePersistentInvitation(event, INVITATION_3)
  vectors.persistentInvitation.push({
    name: 'valid',
    kind: 'positive',
    note: 'A stored group invitation (kind 1463), published once and readable weeks later with nobody online. Built by calling the real `encodePersistentInvitation`.',
    input: {
      invitation: { bearerHex: bytesToHex(BEARER_B), inviter: INVITER_A },
      inviterSkHex: bytesToHex(INVITER_A_SK),
      roomSecretHex: bytesToHex(fx.ROOM_SECRET_1),
      createdAt,
      randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)],
    },
    output: { event },
    expected: { result: decoded && { secretHex: bytesToHex(decoded.secret), persistent: decoded.persistent, epoch: decoded.epoch } },
  })

  const tampered = { ...event, content: event.content.slice(0, -4) + 'AAAA' }
  vectors.persistentInvitation.push({
    name: 'tampered-ciphertext-refused',
    kind: 'negative',
    note: "The valid event above with its final ciphertext bytes flipped: NIP-44's MAC check fails and the decoder must return null.",
    input: { event: tampered },
    output: { result: decodePersistentInvitation(tampered, INVITATION_3) },
  })

  const { persistent: _omit, ...temporary } = INVITATION_3
  vectors.persistentInvitation.push({
    name: 'non-persistent-invitation-refused',
    kind: 'negative',
    note: 'The same event, decoded against the same bearer and inviter but without the `persistent` flag set: refused - a v2 (live) invitation must never be readable as a stored v3 group welcome.',
    input: { event, invitationPersistent: false },
    output: { result: decodePersistentInvitation(event, temporary) },
  })

  // M20: the same real inviter key, the same real welcome key, but the
  // ENCRYPTED body's `room` field is patched to a room the sealed secret
  // does not derive to. Re-encrypted with the same key and a fresh nonce,
  // and genuinely re-signed by INVITER_A_SK - the signature is real; only
  // the body's internal room binding is wrong.
  const welcomeKey = hkdfSha256(INVITATION_3.bearer, 'kithmoot/v3/group-invitation-key')
  const mismatchedNonce = seed32('persistent-invitation-room-mismatch-nonce')
  const mismatchedAuxRand = seed32('persistent-invitation-room-mismatch-auxrand')
  const mismatchedContent = nip44.v2.encrypt(
    JSON.stringify({ v: 3, room: OTHER_ROOM_ID, secret: base64urlnopad.encode(fx.ROOM_SECRET_1) }),
    welcomeKey,
    mismatchedNonce,
  )
  const mismatchedEvent = finalizeDeterministic(
    { kind: KINDS.GROUP_INVITATION, created_at: createdAt, tags: [['d', deriveInvitationId(INVITATION_3)]], content: mismatchedContent },
    INVITER_A_SK,
    mismatchedAuxRand,
  )
  vectors.persistentInvitation.push({
    name: 'room-mismatch-refused',
    kind: 'negative',
    note: `M20: genuinely signed by the real inviter, genuinely encrypted under the real welcome key - but the body's \`room\` field (${OTHER_ROOM_ID}) does not match what its own sealed secret derives to (${GRANT_ROOM_ID}). \`decodePersistentInvitation\` checks \`deriveRoom(secret).roomId === body.room\` and refuses the mismatch.`,
    input: { event: mismatchedEvent, roomInBody: OTHER_ROOM_ID, roomFromSecret: GRANT_ROOM_ID },
    output: { result: decodePersistentInvitation(mismatchedEvent, INVITATION_3) },
  })
}

// ===========================================================================
// 4. Epoch grant - secret at a later epoch, epoch-0, both refusals, a wrong
//    request id, a wrong authority signer, a wrong room, and staleness.
// ===========================================================================

function fx_roomId() {
  return deriveRoom(fx.ROOM_SECRET_1).roomId
}

const EPOCH_1 = deriveEpoch({ epoch: 1, secret: fx.EPOCH_SECRET_1 })
const EPOCH_GRANT_REQUEST = requestIdFor('epoch-grant-request')

{
  const nonce = seed32('epoch-grant-with-secret-nonce')
  const auxRand = seed32('epoch-grant-with-secret')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochGrant({
      roomId: fx_roomId(),
      authoritySk: fx.AUTHORITY_SK,
      device: fx.KEPT_DEVICE,
      request: EPOCH_GRANT_REQUEST,
      now: fx.EPOCH_CREATED_AT,
      epoch: { epoch: 1, secret: fx.EPOCH_SECRET_1 },
      removed: [fx.REMOVED_DEVICE],
    }),
  )
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  const decoded = decodeEpochGrant(event, decodeArgs)
  vectors.epochGrant.push({
    name: 'grant-with-secret-at-epoch-1',
    kind: 'positive',
    note: 'The authority answers a caught-up request: the room has moved to epoch 1, and the secret that opens it is sealed to the asking device. Built by calling the real `encodeEpochGrant`.',
    input: {
      roomId: fx_roomId(),
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      authority: fx.AUTHORITY,
      device: fx.KEPT_DEVICE,
      deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK),
      request: EPOCH_GRANT_REQUEST,
      createdAt: fx.EPOCH_CREATED_AT,
      epoch: 1,
      secretHex: bytesToHex(fx.EPOCH_SECRET_1),
      removed: [fx.REMOVED_DEVICE],
      randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)],
    },
    output: { event },
    expected: { result: decoded && ('refused' in decoded ? decoded : { epoch: 'secret' in decoded.epoch ? { epoch: decoded.epoch.epoch, secretHex: bytesToHex(decoded.epoch.secret) } : decoded.epoch, removed: decoded.removed }) },
  })
  vectors.epochGrant.push({
    name: 'grant-wrong-request-id-refused',
    kind: 'negative',
    note: 'The same event, but the device asked with a different request id than the one the grant answers: refused.',
    input: { event, roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK), request: 'ff'.repeat(32), now: fx.EPOCH_CREATED_AT },
    output: { result: decodeEpochGrant(event, { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: 'ff'.repeat(32), now: fx.EPOCH_CREATED_AT }) },
  })
  vectors.epochGrant.push({
    name: 'grant-stale-refused',
    kind: 'negative',
    note: 'M18: the same genuinely-signed, genuinely-sealed grant, read 91 seconds after it was made (one past the 90-second window `decodeEpochGrant` allows): refused as stale, the same freshness rule `decodeInvitationRequest` applies.',
    input: { event, decode: { roomId: decodeArgs.roomId, authority: decodeArgs.authority, deviceSkHex: bytesToHex(decodeArgs.deviceSk), request: decodeArgs.request, now: fx.EPOCH_CREATED_AT + 91 } },
    output: { result: decodeEpochGrant(event, { ...decodeArgs, now: fx.EPOCH_CREATED_AT + 91 }) },
  })
}

{
  // Epoch 0: the room has never been rekeyed, so the grant carries no
  // secret at all - the requester already holds what it needs from the link.
  const nonce = seed32('epoch-grant-epoch-zero-nonce')
  const auxRand = seed32('epoch-grant-epoch-zero')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochGrant({ roomId: fx_roomId(), authoritySk: fx.AUTHORITY_SK, device: fx.KEPT_DEVICE, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT, epoch: { epoch: 0, secret: fx.ROOM_SECRET_1 }, removed: [] }),
  )
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  vectors.epochGrant.push({
    name: 'grant-epoch-zero-no-secret',
    kind: 'positive',
    note: 'A grant answering "the room is still at epoch 0": no secret rides in the body, because the epoch-0 room key is already what the link handed out.',
    input: { roomId: fx_roomId(), authoritySkHex: bytesToHex(fx.AUTHORITY_SK), authority: fx.AUTHORITY, device: fx.KEPT_DEVICE, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK), request: EPOCH_GRANT_REQUEST, createdAt: fx.EPOCH_CREATED_AT, randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)] },
    output: { event },
    expected: { result: decodeEpochGrant(event, decodeArgs) },
  })
}

for (const refused of ['removed', 'closed']) {
  const nonce = seed32(`epoch-grant-refused-${refused}-nonce`)
  const auxRand = seed32(`epoch-grant-refused-${refused}`)
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochGrant({ roomId: fx_roomId(), authoritySk: fx.AUTHORITY_SK, device: fx.REMOVED_DEVICE, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT, refused }),
  )
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.REMOVED_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  vectors.epochGrant.push({
    name: `grant-refused-${refused}`,
    kind: 'negative',
    note: `The authority refuses the epoch request because the device's participant was ${refused === 'removed' ? 'removed from the room' : 'the room has been closed'}. Sealed like an ordinary grant, so only the asking device learns why.`,
    input: { roomId: fx_roomId(), authoritySkHex: bytesToHex(fx.AUTHORITY_SK), authority: fx.AUTHORITY, device: fx.REMOVED_DEVICE, deviceSkHex: bytesToHex(fx.REMOVED_DEVICE_SK), request: EPOCH_GRANT_REQUEST, createdAt: fx.EPOCH_CREATED_AT, randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)] },
    output: { event },
    expected: { result: decodeEpochGrant(event, decodeArgs) },
  })
}

{
  // M6: genuinely signed by IMPOSTOR_SK - real schnorr signature, real
  // conversation key with the device - but the decoder is checking against
  // the room's actual authority, fx.AUTHORITY, which IMPOSTOR is not.
  const nonce = seed32('epoch-grant-wrong-authority-nonce')
  const auxRand = seed32('epoch-grant-wrong-authority')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochGrant({ roomId: fx_roomId(), authoritySk: IMPOSTOR_SK, device: fx.KEPT_DEVICE, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT, epoch: { epoch: 1, secret: fx.EPOCH_SECRET_1 }, removed: [] }),
  )
  vectors.epochGrant.push({
    name: 'grant-wrong-authority-signer-refused',
    kind: 'negative',
    note: 'M6: a grant genuinely signed and genuinely sealed by IMPOSTOR_SK - a real keypair, not the room authority. `decodeEpochGrant` checks `event.pubkey` against the caller-supplied `authority` and refuses before decryption is even attempted; holding a valid signature over SOME key is not holding authority over this room.',
    input: { event, actualSigner: IMPOSTOR, request: EPOCH_GRANT_REQUEST },
    output: { result: decodeEpochGrant(event, { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }) },
  })
}

{
  // M18 (`d` check): a grant genuinely made for a DIFFERENT room's id.
  const nonce = seed32('epoch-grant-wrong-room-nonce')
  const auxRand = seed32('epoch-grant-wrong-room')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochGrant({ roomId: OTHER_ROOM_ID, authoritySk: fx.AUTHORITY_SK, device: fx.KEPT_DEVICE, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT, epoch: { epoch: 1, secret: fx.EPOCH_SECRET_1 }, removed: [] }),
  )
  vectors.epochGrant.push({
    name: 'grant-wrong-room-refused',
    kind: 'negative',
    note: `M18: a genuinely-signed grant whose \`d\` tag names a different room (${OTHER_ROOM_ID}) than the one being asked about (${fx_roomId()}). Refused on the tag alone, before decryption.`,
    input: { event, grantedForRoom: OTHER_ROOM_ID, askedAboutRoom: fx_roomId(), request: EPOCH_GRANT_REQUEST },
    output: { result: decodeEpochGrant(event, { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }) },
  })
}

// EPOCH_1 is exercised above via fx.EPOCH_SECRET_1; keep the derived value
// referenced so a reviewer can see epoch-1's id independent of the grant.
vectors.epochGrant.push({
  name: 'epoch-1-id-independent-check',
  kind: 'positive',
  note: "`deriveEpoch` for epoch 1 from EPOCH_SECRET_1, called directly (pure, no signing) - confirms the secret sealed in `grant-with-secret-at-epoch-1` really does derive to that epoch's id and key.",
  input: { epoch: 1, secretHex: bytesToHex(fx.EPOCH_SECRET_1) },
  output: { id: EPOCH_1.id, keyHex: bytesToHex(EPOCH_1.key) },
})

// ===========================================================================
// 5. Person-scope credential - valid, exactly-at-boundary, over 30 days,
//    refused without acceptPerson.
// ===========================================================================

{
  const auxRand = seed32('person-credential-valid')
  const createdAt = fx.CREDENTIAL_CREATED_AT
  const expiresAt = createdAt + 7 * 24 * 3600
  const cred = await createDeviceCredential({
    identity: deterministicIdentity(fx.PARTICIPANT_A_SK, auxRand),
    devicePubkey: fx.DEVICE_A,
    scope: 'person',
    label: 'phone',
    expiresAt,
    now: () => createdAt,
  })
  vectors.personCredential.push({
    name: 'valid-accepted-with-acceptPerson',
    kind: 'positive',
    note: 'A person-scope credential (device authorised for every room, not one) is refused as a room credential by default, and accepted only when the caller opts in with `acceptPerson`. Built by calling the real, async `createDeviceCredential` with an injected `ParticipantIdentity` whose `signEvent` is `finalizeDeterministic` under the recorded aux-rand.',
    input: { participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK), devicePubkey: fx.DEVICE_A, createdAt, expiresAt, label: 'phone', auxRandHex: bytesToHex(auxRand) },
    output: { event: cred },
    expected: {
      asPerson: verifyDeviceCredential(cred, { identity: fx.PARTICIPANT_A, now: fx.NOW }),
      asRoomWithoutAcceptPerson: verifyDeviceCredential(cred, { roomId: deriveRoom(fx.ROOM_SECRET_1).roomId, now: fx.NOW }),
      asRoomWithAcceptPerson: verifyDeviceCredential(cred, { roomId: deriveRoom(fx.ROOM_SECRET_1).roomId, now: fx.NOW, acceptPerson: true }),
    },
  })
}

{
  // M15 (boundary, accepted side): expiresAt exactly `createdAt +
  // PERSON_CREDENTIAL_MAX_SECONDS`. `createDeviceCredential`'s own guard is
  // `expiresAt - now > PERSON_CREDENTIAL_MAX_SECONDS` (strictly greater), so
  // exactly-at-the-boundary is minted without refusal, and the verifier's
  // matching check must accept it too.
  const auxRand = seed32('person-credential-exactly-max')
  const createdAt = fx.CREDENTIAL_CREATED_AT
  const expiresAt = createdAt + PERSON_CREDENTIAL_MAX_SECONDS
  const cred = await createDeviceCredential({
    identity: deterministicIdentity(fx.PARTICIPANT_A_SK, auxRand),
    devicePubkey: fx.DEVICE_A,
    scope: 'person',
    expiresAt,
    now: () => createdAt,
  })
  vectors.personCredential.push({
    name: 'valid-at-exactly-30-day-boundary',
    kind: 'positive',
    note: `M15 (accepted side): expiresAt is exactly ${PERSON_CREDENTIAL_MAX_SECONDS} seconds (30 days) past createdAt - the boundary itself. Both \`createDeviceCredential\` (mint time) and \`verifyDeviceCredential\` (read time) use a strict \`>\`, so this is accepted; past the boundary ("refused-over-30-days" below) is refused. Minted through the real, async \`createDeviceCredential\`.`,
    input: { participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK), devicePubkey: fx.DEVICE_A, createdAt, expiresAt, auxRandHex: bytesToHex(auxRand) },
    output: { event: cred, result: verifyDeviceCredential(cred, { identity: fx.PARTICIPANT_A, now: createdAt }) },
  })
}

{
  // Driven through the REAL, async `createDeviceCredential` - not hand-
  // signed. `created_at` is deliberately never compared against what the
  // identity's `signEvent` actually returns (see `credential.ts`'s own
  // comment on that), so an identity that restamps the signed event's
  // `created_at` EARLIER than what it was asked to sign defeats the
  // mint-time 30-day check without the credential's own tags disagreeing
  // with anything: `expiresAt` is set to exactly `now + PERSON_CREDENTIAL_MAX_SECONDS`
  // (the mint-time check is `expiresAt - now > MAX`, which a plain equality
  // does not trip), but the identity restamps `created_at` to ten seconds
  // BEFORE `now` - so the credential that actually comes back runs for
  // `PERSON_CREDENTIAL_MAX_SECONDS + 10` seconds, measured from its own,
  // real, persisted `created_at`. `verifyDeviceCredential` reads that real
  // `created_at` and refuses it. This is a known runtime quirk in
  // `createDeviceCredential` (raised separately, not fixed by this vector
  // work), not something this generator works around by hand-signing.
  const mintTimeNow = fx.CREDENTIAL_CREATED_AT
  const restampedCreatedAt = mintTimeNow - 10
  const expiresAt = mintTimeNow + PERSON_CREDENTIAL_MAX_SECONDS
  const auxRand = seed32('person-credential-over-30-days')
  const restampingIdentity = {
    pubkey: getPublicKey(fx.PARTICIPANT_A_SK),
    async signEvent(unsigned) {
      return finalizeDeterministic({ ...unsigned, created_at: restampedCreatedAt }, fx.PARTICIPANT_A_SK, auxRand)
    },
  }
  const event = await createDeviceCredential({
    identity: restampingIdentity,
    devicePubkey: fx.DEVICE_A,
    scope: 'person',
    expiresAt,
    now: () => mintTimeNow,
  })
  vectors.personCredential.push({
    name: 'refused-over-30-days',
    kind: 'negative',
    note: `M15 (refused side): the real \`createDeviceCredential\`'s mint-time check passes (expiry is exactly ${PERSON_CREDENTIAL_MAX_SECONDS} seconds past the requested \`now\`, not more) - but the injected identity restamps the signed event's \`created_at\` ten seconds earlier than \`now\`, so the credential that actually results runs ${PERSON_CREDENTIAL_MAX_SECONDS + 10} seconds from its own real \`created_at\`. \`verifyDeviceCredential\` refuses it on read.`,
    input: { participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK), devicePubkey: fx.DEVICE_A, mintTimeNow, restampedCreatedAt, expiresAt, auxRandHex: bytesToHex(auxRand), verify: { identity: fx.PARTICIPANT_A, now: restampedCreatedAt } },
    output: { event, result: verifyDeviceCredential(event, { identity: fx.PARTICIPANT_A, now: restampedCreatedAt }) },
  })
}

// ===========================================================================
// 6. Channels signature (`epoch.ts:798-849`) - the admin-list signature's
//    sibling: signed by the authority, bound to the room and the epoch.
// ===========================================================================

{
  const roomId = fx_roomId()
  const channels = ['planning', 'social']
  const auxRand = seed32('channels-signature-valid')
  const sig = withStubbedRandomness([auxRand], () => signChannels({ roomId, epoch: 1, channels, authoritySk: fx.AUTHORITY_SK }))
  vectors.channelsSignature.push({
    name: 'valid-at-epoch-1',
    kind: 'positive',
    note: "The authority signs the room's channel list at epoch 1. Canonicalised (deduplicated, sorted) before signing, and verified with the real `verifyChannels`, in either list order. Built by calling the real `signChannels` with `crypto.getRandomValues` stubbed to the recorded aux-rand.",
    input: { roomId, epoch: 1, channels, authoritySkHex: bytesToHex(fx.AUTHORITY_SK), randomnessQueueHex: [bytesToHex(auxRand)] },
    output: { canonical: canonicalChannels(channels), sig },
    expected: {
      verifiesInGivenOrder: verifyChannels({ roomId, epoch: 1, channels, sig, authority: fx.AUTHORITY }),
      verifiesReversed: verifyChannels({ roomId, epoch: 1, channels: [...channels].reverse(), sig, authority: fx.AUTHORITY }),
    },
  })
  vectors.channelsSignature.push({
    name: 'refused-at-another-epoch',
    kind: 'negative',
    note: 'The same signature, checked against epoch 2 instead of the epoch it was made for: refused - a channel list valid at one epoch is not replayable into the next.',
    input: { roomId, epoch: 2, channels, sig, authority: fx.AUTHORITY },
    output: { result: verifyChannels({ roomId, epoch: 2, channels, sig, authority: fx.AUTHORITY }) },
  })
  vectors.channelsSignature.push({
    name: 'refused-wrong-authority',
    kind: 'negative',
    note: 'The same genuinely-signed message, checked against a different (real) pubkey than the one that actually signed it: refused. A member who holds the room key cannot present somebody else\'s signed channel list as if the authority had signed it for them.',
    input: { roomId, epoch: 1, channels, sig, wrongAuthority: OTHER_INVITER },
    output: { result: verifyChannels({ roomId, epoch: 1, channels, sig, authority: OTHER_INVITER }) },
  })
  vectors.channelsSignature.push({
    name: 'refused-wrong-room',
    kind: 'negative',
    note: "The same genuinely-signed message, checked against a different room's id: refused. A channel list signed for one room is not replayable into another, even under the same authority and epoch number.",
    input: { roomId, epoch: 1, channels, sig, authority: fx.AUTHORITY, wrongRoomId: OTHER_ROOM_ID },
    output: { result: verifyChannels({ roomId: OTHER_ROOM_ID, epoch: 1, channels, sig, authority: fx.AUTHORITY }) },
  })
  vectors.channelsSignature.push({
    name: 'refused-reserved-channel-name',
    kind: 'negative',
    note: '`agents`, `minutes` and `transcript` are reserved: the room already means something else by them, so `canonicalChannels` throws rather than letting them into a signed registry.',
    input: { channels: ['planning', 'agents'] },
    output: { throws: true, error: (() => { try { canonicalChannels(['planning', 'agents']); return null } catch (e) { return e.message } })() },
  })
}

// ===========================================================================
// 7. Person credential identity mismatch - N9/N9b (Opus round-two review).
// ===========================================================================

{
  // N9/N9b: a person credential genuinely signed by PARTICIPANT_B_SK, but
  // whose `d` tag names PARTICIPANT_A - "I'll claim to be someone else's
  // device credential while signing with my own key". `createDeviceCredential`
  // always sets `d` to its own signer's pubkey for a person credential, so no
  // real minting call can produce this; signed directly with the real
  // participant key (a seventh documented exception - see the header).
  const auxRand = seed32('person-credential-wrong-person')
  const createdAt = fx.CREDENTIAL_CREATED_AT
  const expiresAt = createdAt + 7 * 24 * 3600
  const tags = [['d', fx.PARTICIPANT_A], ['device', fx.DEVICE_A], ['expiration', String(expiresAt)], ['scope', 'person']]
  const event = finalizeDeterministic({ kind: KINDS.CREDENTIAL, created_at: createdAt, tags, content: '' }, fx.PARTICIPANT_B_SK, auxRand)
  const roomId = fx_roomId()
  vectors.personCredential.push({
    name: 'wrong-person-identity-path-refused',
    kind: 'negative',
    note: "N9: genuinely signed by PARTICIPANT_B_SK, but its `d` tag names PARTICIPANT_A - claiming to be a device credential for someone else while signing with your own key. Checked via the `identity` path (credential.ts:136): refused, because `d` must equal BOTH the identity asked for AND the credential's own real signer - checking only the first half would accept this.",
    input: { participantSkHex: bytesToHex(fx.PARTICIPANT_B_SK), claimedIdentity: fx.PARTICIPANT_A, devicePubkey: fx.DEVICE_A, createdAt, expiresAt, auxRandHex: bytesToHex(auxRand) },
    output: { event, result: verifyDeviceCredential(event, { identity: fx.PARTICIPANT_A, now: createdAt }) },
  })
  vectors.personCredential.push({
    name: 'wrong-person-acceptperson-path-refused',
    kind: 'negative',
    note: 'N9b: the SAME event, checked via the room-credential-with-acceptPerson path instead (credential.ts:139): refused for the same reason - `d` (PARTICIPANT_A) does not match the real signer (PARTICIPANT_B), and this path checks nothing else about `d`.',
    input: { event, roomId, acceptPerson: true },
    output: { result: verifyDeviceCredential(event, { roomId, now: createdAt, acceptPerson: true }) },
  })
}

// ===========================================================================
// 8. Epoch request whose credential names a different device than its
//    signer - N2 (Opus round-two review).
// ===========================================================================

{
  const roomId = fx_roomId()
  const roomKey = deriveRoom(fx.ROOM_SECRET_1).roomKey
  // The embedded credential: genuinely signed by PARTICIPANT_A_SK, genuinely
  // naming REMOVED_DEVICE - a real credential for a real, different device
  // than the one about to sign the outer request. Minted through the real,
  // async `createDeviceCredential`, the same as every other room-scope
  // credential in this file.
  const credAuxRand = seed32('epoch-request-device-mismatch-credential')
  const credCreatedAt = fx.CREDENTIAL_CREATED_AT
  const credential = await createDeviceCredential({
    identity: deterministicIdentity(fx.PARTICIPANT_A_SK, credAuxRand),
    devicePubkey: fx.REMOVED_DEVICE,
    roomId,
    expiresAt: fx.EPOCH_CREATED_AT + 3600,
    now: () => credCreatedAt,
  })
  const nonce = seed32('epoch-request-device-mismatch-nonce')
  const auxRand = seed32('epoch-request-device-mismatch')
  // `encodeEpochRequest` embeds whatever credential it is handed without
  // checking that credential names its own signer - so this IS driven
  // through the real encoder, with KEPT_DEVICE_SK as the actual signer.
  // Its OWN admission proof binds to KEPT_DEVICE (the real signer), which
  // independently disagrees with the credential's REMOVED_DEVICE - so this
  // vector is refused by the admission check as well as the device check,
  // real defence in depth.
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodeEpochRequest({ roomId, authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, roomKey, credential, now: fx.EPOCH_CREATED_AT }),
  )
  vectors.epochRequest.push({
    name: 'credential-device-not-signer-refused',
    kind: 'negative',
    note: "N2: the outer event is genuinely signed by KEPT_DEVICE_SK, and the embedded credential is genuinely signed by PARTICIPANT_A_SK and genuinely names REMOVED_DEVICE. Refused by TWO independent checks: the device check (epoch.ts:457) and the admission proof, which `encodeEpochRequest` always binds to its own real signer and so also disagrees with REMOVED_DEVICE. See `credential-device-not-signer-refused-admission-matches` below for a vector that isolates the device check alone.",
    input: { roomId, roomKeyHex: bytesToHex(roomKey), authority: fx.AUTHORITY, authoritySkHex: bytesToHex(fx.AUTHORITY_SK), deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK), credential, createdAt: fx.EPOCH_CREATED_AT, randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)] },
    output: { event, result: decodeEpochRequest(event, { roomId, authoritySk: fx.AUTHORITY_SK, roomKey, now: fx.EPOCH_CREATED_AT }) },
  })

  // The isolating vector: the admission proof is hand-computed for
  // REMOVED_DEVICE (the credential's claimed device) rather than
  // KEPT_DEVICE (the real signer) - genuinely computed by the real,
  // exported `epochRequestAdmission`, just not the one `encodeEpochRequest`
  // would have produced for its own signer. The body is otherwise real and
  // real-encrypted, and the outer event is genuinely signed by
  // KEPT_DEVICE_SK. With the admission now matching what a decoder expects
  // for REMOVED_DEVICE, the ONLY thing left to catch this is the device
  // check at epoch.ts:457 - a documented exception (no real encoder call
  // produces a self-consistent-but-forged admission like this).
  const matchingAdmission = epochRequestAdmission({ roomKey, roomId, authority: fx.AUTHORITY, device: fx.REMOVED_DEVICE, createdAt: fx.EPOCH_CREATED_AT })
  const body2 = { v: 1, credential, admission: matchingAdmission }
  const conversationKey2 = nip44.v2.utils.getConversationKey(fx.KEPT_DEVICE_SK, fx.AUTHORITY)
  const nonce2 = seed32('epoch-request-device-mismatch-isolated-nonce')
  const auxRand2 = seed32('epoch-request-device-mismatch-isolated')
  const event2 = finalizeDeterministic(
    { kind: KINDS.EPOCH_REQUEST, created_at: fx.EPOCH_CREATED_AT, tags: [['d', roomId], ['p', fx.AUTHORITY]], content: nip44.v2.encrypt(JSON.stringify(body2), conversationKey2, nonce2) },
    fx.KEPT_DEVICE_SK,
    auxRand2,
  )
  vectors.epochRequest.push({
    name: 'credential-device-not-signer-refused-admission-matches',
    kind: 'negative',
    note: "N2 (isolated): the SAME credential-device mismatch as above, but the admission proof is hand-computed to match REMOVED_DEVICE (the credential's claim) rather than the real signer - so the admission check alone would pass this. Only `decodeEpochRequest`'s device check (epoch.ts:457) refuses it. Genuinely signed and genuinely encrypted throughout; only the admission field is deliberately built to defeat the OTHER check, isolating this one.",
    input: { roomId, roomKeyHex: bytesToHex(roomKey), authority: fx.AUTHORITY, authoritySkHex: bytesToHex(fx.AUTHORITY_SK), credential, admission: matchingAdmission, createdAt: fx.EPOCH_CREATED_AT, event: event2 },
    output: { event: event2, result: decodeEpochRequest(event2, { roomId, authoritySk: fx.AUTHORITY_SK, roomKey, now: fx.EPOCH_CREATED_AT }) },
  })
}

// ===========================================================================
// 9. Persistent invitation signed by someone other than the pinned inviter -
//    N7 (Opus round-two review).
// ===========================================================================

{
  // Same bearer as INVITATION_3 (so the welcome key and `d` tag both still
  // match), but the invitation object handed to the real encoder names
  // OTHER_INVITER as its own inviter - self-consistent, so the real
  // function happily signs it. Decoded back against the ORIGINAL
  // INVITATION_3 (inviter INVITER_A), the signer disagrees with the pinned
  // inviter.
  const impostorInvitation = { bearer: INVITATION_3.bearer, inviter: OTHER_INVITER, persistent: true }
  const nonce = seed32('persistent-invitation-wrong-signer-nonce')
  const auxRand = seed32('persistent-invitation-wrong-signer-auxrand')
  const event = withStubbedRandomness([nonce, auxRand], () =>
    encodePersistentInvitation({ invitation: impostorInvitation, inviterSk: OTHER_INVITER_SK, roomSecret: fx.ROOM_SECRET_1, now: fx.NOW - 86_400 * 30 }),
  )
  vectors.persistentInvitation.push({
    name: 'wrong-signer-refused',
    kind: 'negative',
    note: "N7: genuinely signed and genuinely encrypted (the SAME bearer as INVITATION_3, so the same welcome key and `d` tag) - but by OTHER_INVITER_SK rather than the pinned inviter. `decodePersistentInvitation` (persistent-invitation.ts:49) checks `event.pubkey === invitation.inviter` and refuses: holding the bearer is not authority to publish as the inviter.",
    input: {
      event,
      actualSigner: OTHER_INVITER,
      actualSignerSkHex: bytesToHex(OTHER_INVITER_SK),
      bearerHex: bytesToHex(INVITATION_3.bearer),
      roomSecretHex: bytesToHex(fx.ROOM_SECRET_1),
      createdAt: fx.NOW - 86_400 * 30,
      randomnessQueueHex: [bytesToHex(nonce), bytesToHex(auxRand)],
    },
    output: { result: decodePersistentInvitation(event, INVITATION_3) },
  })
}

// ===========================================================================
// 10. Access evaluation: a kindred proof naming another participant, and the
//     proof/credential expiry boundaries - N11, N10, N8 (Opus round-two
//     review). issueKindredProof and verifyDeviceCredential are pure/real
//     calls throughout; no stubbing or hand-signing needed.
// ===========================================================================

{
  const roomId = fx_roomId()
  const policy = { tier: 'kith', admitted: [fx.HOST] }

  // `issueKindredProof` signs with random aux-rand when not stubbed (its
  // `nonce` option makes the MESSAGE reproducible, but not the schnorr
  // signature over it) - stubbed here so the recorded `sig` is exactly
  // reproducible, the same as every other real-encoder vector in this file.
  const proofForGuestAuxRand = seed32('kindred-proof-for-guest-auxrand')
  const proofForGuest = withStubbedRandomness([proofForGuestAuxRand], () =>
    issueKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'kith', roomId, expiresAt: NOW + 3600, nonce: 'aa'.repeat(32) }),
  )
  vectors.accessEvaluation.push({
    name: 'kindred-proof-names-another-participant-refused',
    kind: 'negative',
    note: 'N11: a real, validly-signed kindred proof for GUEST, checked against PARTICIPANT_A instead. `evaluateAccess` (access.ts:96) refuses before it ever reaches the signature check - a proof is a grant to the one participant it names, not a bearer token any holder can present.',
    input: { policy, proof: proofForGuest, checkedParticipant: fx.PARTICIPANT_A, now: NOW, roomId, randomnessQueueHex: [bytesToHex(proofForGuestAuxRand)] },
    output: { result: evaluateAccess(policy, fx.PARTICIPANT_A, proofForGuest, NOW, roomId) },
  })

  // N10: the expiry boundary. `proof.expiresAt <= now` refuses (access.ts:101)
  // - so AT the instant of expiry it is already refused, and one second
  // earlier it still verifies. Both vectors check the SAME proof, so the
  // only variable is `now`.
  const boundaryProofAuxRand = seed32('kindred-proof-boundary-auxrand')
  const boundaryProof = withStubbedRandomness([boundaryProofAuxRand], () =>
    issueKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'kith', roomId, expiresAt: NOW, nonce: 'bb'.repeat(32) }),
  )
  vectors.accessEvaluation.push({
    name: 'kindred-proof-expiry-at-boundary-refused',
    kind: 'negative',
    note: 'N10 (refused side): a real kindred proof checked at exactly its own `expiresAt`: refused. Proves the check is `<=`, not `<` - a boundary shifted by one would accept this.',
    input: { policy, proof: boundaryProof, now: NOW, roomId, randomnessQueueHex: [bytesToHex(boundaryProofAuxRand)] },
    output: { result: evaluateAccess(policy, fx.GUEST, boundaryProof, NOW, roomId) },
  })
  vectors.accessEvaluation.push({
    name: 'kindred-proof-one-second-before-expiry-accepted',
    kind: 'positive',
    note: 'N10 (accepted side): the SAME proof, checked one second before its own `expiresAt`: accepted. Together with the refused-side vector above, this pins the boundary exactly, in both directions.',
    input: { policy, proof: boundaryProof, now: NOW - 1, roomId },
    output: { result: evaluateAccess(policy, fx.GUEST, boundaryProof, NOW - 1, roomId) },
  })

  // N8: the same boundary, one level down - a plain (room-scope) device
  // credential's own `expiration` tag, not the 30-day person cap. Minted
  // through the real, async `createDeviceCredential`.
  const credAuxRand = seed32('credential-expiry-boundary')
  const credCreatedAt = fx.CREDENTIAL_CREATED_AT
  const credExpiresAt = NOW
  const boundaryCred = await createDeviceCredential({
    identity: deterministicIdentity(fx.PARTICIPANT_A_SK, credAuxRand),
    devicePubkey: fx.DEVICE_A,
    roomId,
    expiresAt: credExpiresAt,
    now: () => credCreatedAt,
  })
  vectors.accessEvaluation.push({
    name: 'device-credential-expiry-at-boundary-refused',
    kind: 'negative',
    note: 'N8 (refused side): a real room-scope device credential checked at exactly its own `expiration`: refused (credential.ts:155, the same `<=` rule the kindred proof uses).',
    input: { event: boundaryCred, roomId, now: credExpiresAt, createdAt: credCreatedAt, expiresAt: credExpiresAt, devicePubkey: fx.DEVICE_A, auxRandHex: bytesToHex(credAuxRand) },
    output: { result: verifyDeviceCredential(boundaryCred, { roomId, now: credExpiresAt }) },
  })
  vectors.accessEvaluation.push({
    name: 'device-credential-one-second-before-expiry-accepted',
    kind: 'positive',
    note: 'N8 (accepted side): the SAME credential, checked one second before its own `expiration`: accepted.',
    input: { event: boundaryCred, roomId, now: credExpiresAt - 1 },
    output: { result: verifyDeviceCredential(boundaryCred, { roomId, now: credExpiresAt - 1 }) },
  })
}

// ===========================================================================
// 11. Room policy negatives: a quiet room with no members list, and an
//     unrecognised agent rule (Opus round-two review, item 5).
// ===========================================================================

{
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 2, j: base64urlnopad.encode(BEARER_A), h: INVITER_A, r: [], i: [], a: { tier: 'kith', quiet: true },
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'quiet-room-without-members-refused',
    kind: 'negative',
    note: 'A policy asking for a quiet room (room.ts:83) but naming no members list: refused. A quiet room derives its per-pair keys from the members list, and with none there is nobody to derive them for.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({
    v: 2, j: base64urlnopad.encode(BEARER_A), h: INVITER_A, r: [], i: [], a: { tier: 'kith', agents: 'unheard-of-rule' },
  })))
  const url = `${BASE_URL}#${payload}`
  let error
  try { parseRoomLink(url) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'unknown-agent-rule-refused',
    kind: 'negative',
    note: 'A policy naming an agent rule this reader does not know (room.ts:77): refused for the same reason an unknown tier is - dropping it would admit what the room meant to keep out.',
    input: { url },
    output: { throws: true, error },
  })
}

// ===========================================================================
// 12. The real encodeRoomLink normalising hostile caller input, and the
//     encode-side (not just decode-side) oversize-fragment refusal - the
//     M22 survivor and item 6 of the Opus round-two review.
// ===========================================================================

{
  // `hostile-input-normalised` (group 1, above) proves what `parseRoomLink`
  // does with a link nobody's own encoder produced. This proves the other
  // half: `encodeRoomLink` ITSELF - not a caller, not the decoder - filters
  // and sanitises the same kind of hostile input before it is ever written
  // to a URL. Real function, real inputs, no hand-building.
  const hostileRelays = ['wss://relay.damus.io', 'wss://relay.damus.io', 'ws://tracker.example', 'wss://nos.lol']
  const hostileIce = ['not-a-real-scheme:nope', 'stun:stun.kithmoot.example:3478']
  const hostileName = `Rowan‮txet​nedih${'y'.repeat(40)}`
  const url = encodeRoomLink(BASE_URL, { invitation: INVITATION_2, relays: hostileRelays, iceUrls: hostileIce, name: hostileName })
  const decoded = parseRoomLink(url)
  vectors.linkEnvelope.push({
    name: 'encoder-normalises-hostile-input',
    kind: 'positive',
    note: "The real `encodeRoomLink` (link.ts:135-147) filters an unsafe ws:// relay, deduplicates the repeated one, drops an unrecognised ICE scheme, and sanitises an overlong/bidi-override/zero-width name - before the bytes ever reach a QR code, not only when a stranger's link is decoded. Fed the same kind of hostile input `hostile-input-normalised` (above) fakes directly on the wire; the output here is what the real encoder itself already wrote.",
    input: { base: BASE_URL, invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, rawRelays: hostileRelays, rawIceUrls: hostileIce, rawName: hostileName },
    output: { url, decoded: { relays: decoded.relays, iceUrls: decoded.iceUrls, name: decoded.name ?? null } },
    expected: { relays: safeRelayUrls(hostileRelays), iceUrls: safeIceUrls(hostileIce), name: sanitiseDisplayName(hostileName) ?? null },
  })
}

{
  // The ENCODE-side fragment-size refusal (link.ts:147's
  // MAX_ROOM_LINK_FRAGMENT_LENGTH check, at the point of WRITING a link,
  // distinct from `oversize-fragment-refused` above which is the
  // decode-side check on an already-written fragment): MAX_RELAY_HINTS
  // hints each near the per-hint length ceiling, real inputs, real call.
  const bigRelays = Array.from({ length: MAX_RELAY_HINTS }, (_, i) => `wss://${'r'.repeat(2000)}-${i}.example`)
  let error
  try { encodeRoomLink(BASE_URL, { invitation: INVITATION_2, relays: bigRelays, iceUrls: [] }) } catch (e) { error = e.message }
  vectors.linkEnvelope.push({
    name: 'encoder-oversize-fragment-refused',
    kind: 'negative',
    note: `${MAX_RELAY_HINTS} relay hints, each near the ${2048} per-hint character ceiling, push the WRITTEN fragment past MAX_ROOM_LINK_FRAGMENT_LENGTH: refused at the point of encoding, not only on the way back in.`,
    input: { relays: bigRelays },
    output: { throws: true, error },
  })
}

// ===========================================================================
// 13. Optional, cheap additions (Opus round-two review, item 7): an epoch
//     grant above MAX_EPOCH refused on decode, and a rekey epoch tag that
//     fails the epoch-number regex.
// ===========================================================================

{
  // The real `encodeEpochGrant` already refuses to build a grant above
  // MAX_EPOCH (`requireEpochNumber` throws first) - so the decode-side
  // bound at epoch.ts:571 can only be exercised by a body the real encoder
  // itself would never produce. Encrypted for real (a real conversation
  // key), signed for real (the real authority key); only the JSON body's
  // `epoch` number is hand-built past what the encoder would ever allow
  // through - an eighth documented exception, same shape as the other six.
  const roomId = fx_roomId()
  const overMaxBody = { v: 1, request: EPOCH_GRANT_REQUEST, epoch: MAX_EPOCH + 1, secret: base64urlnopad.encode(fx.EPOCH_SECRET_1), removed: [] }
  const conversationKey = nip44.v2.utils.getConversationKey(fx.AUTHORITY_SK, fx.KEPT_DEVICE)
  const nonce = seed32('epoch-grant-over-max-epoch-nonce')
  const auxRand = seed32('epoch-grant-over-max-epoch')
  const event = finalizeDeterministic(
    { kind: KINDS.EPOCH_GRANT, created_at: fx.EPOCH_CREATED_AT, tags: [['d', roomId], ['p', fx.KEPT_DEVICE]], content: nip44.v2.encrypt(JSON.stringify(overMaxBody), conversationKey, nonce) },
    fx.AUTHORITY_SK,
    auxRand,
  )
  vectors.epochGrant.push({
    name: 'grant-epoch-above-max-refused',
    kind: 'negative',
    note: `Genuinely signed and genuinely sealed by the real authority key, naming epoch ${MAX_EPOCH + 1} - one past MAX_EPOCH (${MAX_EPOCH}). The real \`encodeEpochGrant\` refuses to build this itself (\`requireEpochNumber\` throws at encode time), so this pins the decode-side bound (epoch.ts:571) directly: an authority that was tricked, or a second implementation with a looser encoder, must still be refused on read.`,
    input: { event, roomId, request: EPOCH_GRANT_REQUEST, epoch: MAX_EPOCH + 1 },
    output: { result: decodeEpochGrant(event, { roomId, authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }) },
  })
}

{
  // The rekey epoch-tag regex (epoch.ts:258, `/^[1-9][0-9]{0,6}$/`) and the
  // separate `epoch > MAX_EPOCH` bound (epoch.ts:260).
  //
  // `epoch: 0` IS reachable through the real `encodeRekeyEvent`: it only
  // checks `next.epoch === current.epoch + 1` (epoch.ts:193), so a
  // `current` naming epoch -1 - a value nothing in the real epoch-following
  // path ever produces, but not one `encodeRekeyEvent` itself refuses -
  // makes it write a real `epoch: 0` tag. Genuinely signed, genuinely
  // sealed (no recipients, so no seal nonce needed).
  const roomId = fx_roomId()
  const zeroNonce = seed32('rekey-epoch-tag-zero-nonce')
  const zeroAuxRand = seed32('rekey-epoch-tag-zero-auxrand')
  const zeroEvent = withStubbedRandomness([zeroNonce, zeroAuxRand], () =>
    encodeRekeyEvent({
      roomId,
      authoritySk: fx.AUTHORITY_SK,
      current: { epoch: -1, id: 'unused-by-the-real-encoder', key: fx.EPOCH_SECRET_1 },
      next: { epoch: 0, secret: fx.EPOCH_SECRET_2 },
      recipients: [],
      removed: [],
      now: fx.REKEY_CREATED_AT,
    }),
  )
  vectors.epochGrant.push({
    name: 'rekey-epoch-tag-zero-refused',
    kind: 'negative',
    note: "Genuinely signed and sealed by the real `encodeRekeyEvent`, called with a `current` naming epoch -1 (a value the real epoch-following path never holds, but that `encodeRekeyEvent` itself does not refuse) so that `next.epoch` (0) satisfies its `current.epoch + 1` check. Epoch 0 is the room's own secret, byte-identical to before any rekey, and is never itself announced by a rekey event. `peekRekeyEvent`'s regex (`/^[1-9][0-9]{0,6}$/`) refuses a leading zero outright, before the signature is even checked.",
    input: { roomId, authoritySkHex: bytesToHex(fx.AUTHORITY_SK), createdAt: fx.REKEY_CREATED_AT, randomnessQueueHex: [bytesToHex(zeroNonce), bytesToHex(zeroAuxRand)] },
    output: { event: zeroEvent, peek: peekRekeyEvent(zeroEvent, { roomId, authority: fx.AUTHORITY }) },
  })
}

{
  // A leading zero: real signature, hand-built tag (`encodeRekeyEvent`
  // always writes `String(epoch)`, which JavaScript never renders with a
  // leading zero for a non-negative integer, so no real call can produce
  // this literal tag text). Kills two different weakenings of the regex at
  // once: one that allows a leading zero (e.g. `^0*[1-9][0-9]{0,6}$`), and
  // one that drops the `^`/`$` anchors (`[1-9][0-9]{0,6}` unanchored still
  // finds a match inside "01", starting at its second character).
  const roomId = fx_roomId()
  const auxRand = seed32('rekey-epoch-tag-leading-zero-auxrand')
  const event = finalizeDeterministic(
    { kind: KINDS.ROOM_REKEY, created_at: fx.REKEY_CREATED_AT, tags: [['d', roomId], ['epoch', '01']], content: 'AA==' },
    fx.AUTHORITY_SK,
    auxRand,
  )
  vectors.epochGrant.push({
    name: 'rekey-epoch-tag-leading-zero-refused',
    kind: 'negative',
    note: 'Genuinely signed by the real authority key, `epoch` tag the literal string "01". No real `encodeRekeyEvent` call writes this (`String(epoch)` never carries a leading zero for a non-negative integer), so this is hand-built. Refused by the regex\'s `^[1-9]` requirement - a leading-zero-tolerant regex, or an unanchored one, would wrongly accept it.',
    input: { event, roomId },
    output: { peek: peekRekeyEvent(event, { roomId, authority: fx.AUTHORITY }) },
  })
}

{
  // One past MAX_EPOCH, in a tag that still matches the digit-count shape
  // the regex allows (7 digits, leading digit non-zero): real signature,
  // hand-built tag, because `encodeRekeyEvent` refuses to build an epoch
  // this large itself (`requireEpochNumber` throws at encode time, same
  // reason `grant-epoch-above-max-refused` above is hand-built). Refused by
  // the SEPARATE `epoch > MAX_EPOCH` bound (epoch.ts:260), not by the
  // regex - a mutation that dropped only that bound, leaving the regex
  // intact, would wrongly accept this.
  const roomId = fx_roomId()
  const auxRand = seed32('rekey-epoch-tag-above-max-auxrand')
  const aboveMaxTag = String(MAX_EPOCH + 1)
  const event = finalizeDeterministic(
    { kind: KINDS.ROOM_REKEY, created_at: fx.REKEY_CREATED_AT, tags: [['d', roomId], ['epoch', aboveMaxTag]], content: 'AA==' },
    fx.AUTHORITY_SK,
    auxRand,
  )
  vectors.epochGrant.push({
    name: 'rekey-epoch-tag-above-max-refused',
    kind: 'negative',
    note: `Genuinely signed by the real authority key, \`epoch\` tag "${aboveMaxTag}" - one past MAX_EPOCH (${MAX_EPOCH}), and a shape (7 digits, no leading zero) the regex alone accepts. Hand-built because the real \`encodeRekeyEvent\` refuses to build an epoch this large itself. Refused by the separate epoch.ts:260 bound, independent of the regex.`,
    input: { event, roomId, epoch: MAX_EPOCH + 1 },
    output: { peek: peekRekeyEvent(event, { roomId, authority: fx.AUTHORITY }) },
  })
}

} // end main()

// ===========================================================================
// Small local mirrors of non-exported message shapes - see the header
// comment for why each exists and how it is checked against its real module.
// ===========================================================================

function hkdfSha256(ikm, info) {
  return hkdf(sha256, ikm, undefined, info, 32)
}

function delegationMessageBytes(invitationId, room, issuer, delegate, expiresAt) {
  return sha256(new TextEncoder().encode(`kithmoot/v2/invitation-delegation:${invitationId}:${room}:${issuer}:${delegate}:${expiresAt}`))
}

// ===========================================================================
// Run, then write the file.
// ===========================================================================

await main()

const document = {
  protocolVersion: 'kithmoot/v1',
  generatedBy: 'vectors/generate-circle.mjs',
  nostrToolsVersion: '2.25.0',
  groups: vectors,
}

writeFileSync(outFile, JSON.stringify(document, null, 2) + '\n')
console.log(`wrote ${outFile}`)
for (const [group, list] of Object.entries(vectors)) {
  console.log(`  ${group}: ${list.length} vectors`)
}
