#!/usr/bin/env node
// Generates `vectors/kithmoot-vectors.json` - the interop contract a second,
// independent implementation (a native Kotlin/Android client) is checked
// against.
//
// Every vector is derived from fixed, hardcoded inputs: fixed secrets, fixed
// keypairs, fixed timestamps, and - wherever the protocol genuinely needs a
// nonce or an ephemeral value (a BIP-340 signature's aux-rand, a NIP-44
// nonce, a signal wrap's ephemeral key) - a fixed seed, recorded in the
// vector itself. Running this script twice must produce byte-identical
// output; there is no `Date.now()`, no `Math.random()`, and no
// `randomBytes()` anywhere below this comment.
//
// Two kinds of derivation are used, deliberately:
//
//   1. Pure functions (`deriveRoom`, `encodeJoinUrl`/`decodeJoinUrl`,
//      `mintTurnCredential`, `evaluateAccess`) take every input as a
//      parameter and have no hidden randomness, so this script imports and
//      calls the REAL implementation directly, from `dist/` (see
//      `npm run vectors`, which builds `dist/` first). There is no room for
//      generator and implementation to drift on these.
//
//   2. Signing and encrypting functions (`createDeviceCredential`,
//      `encodeRosterEvent`, `wrapSignal`, `issueKindredProof`) are NOT
//      called directly, because they are not deterministic even given
//      identical arguments: `finalizeEvent` signs with a random BIP-340
//      aux-rand by default, `nip44.v2.encrypt` defaults to a random nonce,
//      and `createDeviceCredential`/`wrapSignal` stamp `created_at` from
//      `Date.now()`. None of that is a bug - it is exactly what production
//      code should do - but it means these functions cannot produce the
//      same bytes twice, which is fatal for a frozen vector file. Instead
//      this script rebuilds the identical event/ciphertext shape by hand
//      (see `vectors/lib/determinism.mjs`), using the same underlying
//      primitives (`schnorr.sign`, `nip44.v2.encrypt`, `getEventHash`) with
//      explicit, recorded randomness. Every vector this applies to is then
//      run through the REAL verify/decode function from `dist/` before
//      being written out, so a vector is only ever recorded once the actual
//      implementation has accepted (or correctly rejected) it.
//
// See `vectors/README.md` for what each group pins down and what it does
// not.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'

/** UTF-8 bytes, for the canonical messages a signature is taken over. */
const utf8Bytes = (text) => new TextEncoder().encode(text)
import { hexToBytes as hexToBytesLocal } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip44 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'

import { deriveSecretKey, finalizeDeterministic, kindredCanonicalMessage, seed32 } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

// The real implementation, built to `dist/` by `npm run build:lib` (see the
// `vectors` script in package.json, which always runs that first).
import { KINDS } from '../dist/src/kinds.js'
import { deriveRoom, encodeJoinUrl, decodeJoinUrl } from '../dist/src/room.js'
import { deriveChannel } from '../dist/src/chat.js'
import { verifyDeviceCredential } from '../dist/src/credential.js'
import { decodeRosterEvent } from '../dist/src/roster.js'
import { unwrapSignal } from '../dist/src/signal.js'
import { evaluateAccess } from '../dist/src/access.js'
import { mintTurnCredential } from '../dist/src/turn.js'
import { decodeDescriptorEvent } from '../dist/src/descriptor.js'
import { deriveEpoch, peekRekeyEvent, decodeRekeyEvent, decodeEpochGrant, signAdmins, verifyAdmins, canonicalAdmins } from '../dist/src/epoch.js'
import { normaliseAgentOwnership, verifyAgentOwnership } from '../dist/src/ownership.js'
import { decodeChatEvent } from '../dist/src/chat.js'
import { deriveEnvelopeKey, paddedPlaintextLength, buildFileEvent, buildUploadAuthorisation } from '../dist/src/attachment.js'
import { encodeControl, decodeControl } from '../dist/src/control.js'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'kithmoot-vectors.json')

const vectors = { roomDerivation: [], channelDerivation: [], joinUrl: [], deviceCredential: [], rosterEvent: [], signalWrap: [], kindredProof: [], accessEvaluation: [], turnCredential: [], roomDescriptor: [], roomEpoch: [], agentOwnership: [], chatAttachment: [], approvalControl: [] }

// ===========================================================================
// 1. Room derivation - secret -> { roomId, roomKey } (dist/src/room.js)
// ===========================================================================

for (const [name, secret, note] of [
  ['all-zero-secret', fx.ROOM_SECRET_ZERO, 'Edge case: a room secret of all-zero bytes derives normally - HKDF has no weak inputs.'],
  ['all-0xff-secret', fx.ROOM_SECRET_FF, 'Edge case: a room secret of all-0xff bytes derives normally.'],
  ['typical-secret-1', fx.ROOM_SECRET_1, 'A representative room secret, reused across the credential/roster/signal groups below so those vectors trace back to one room.'],
  ['typical-secret-2', fx.ROOM_SECRET_2, 'A second representative secret, used as "a different room" in wrong-room negative cases elsewhere.'],
]) {
  const { roomId, roomKey } = deriveRoom(secret)
  vectors.roomDerivation.push({
    name,
    kind: 'positive',
    note,
    input: { secretHex: bytesToHex(secret) },
    output: { roomId, roomKeyHex: bytesToHex(roomKey) },
  })
}

const ROOM_1 = deriveRoom(fx.ROOM_SECRET_1)
const ROOM_2 = deriveRoom(fx.ROOM_SECRET_2)

// ===========================================================================
// 2. Join URL - secret + relays (+ optional access policy) <-> URL fragment
//
// NOTE ON SCOPE: the brief for this stage described the join URL as
// carrying "secret + relays + ICE list". The current implementation
// (`src/room.ts`) does not carry a separate ICE server list - the fragment
// payload is `{ s: secret, r: relays, a?: policy }`. TURN/ICE credentials
// are minted separately per viewer (see the `turnCredential` group) rather
// than embedded in the capability link. These vectors pin what the wire
// format actually is; inventing an `ice` field here would produce vectors
// the real `encodeJoinUrl`/`decodeJoinUrl` neither emit nor accept.
// ===========================================================================

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol']

function joinUrlPositive(name, note, secret, relays, policy) {
  const url = encodeJoinUrl(fx.BASE_URL, secret, relays, policy)
  const decoded = decodeJoinUrl(url)
  vectors.joinUrl.push({
    name,
    kind: 'positive',
    note,
    input: { base: fx.BASE_URL, secretHex: bytesToHex(secret), relays, policy: policy ?? null },
    output: {
      url,
      decoded: {
        secretHex: bytesToHex(decoded.secret),
        relays: decoded.relays,
        policy: decoded.policy ?? null,
      },
    },
  })
}

joinUrlPositive('basic-no-policy', 'The common case: a secret and two relay hints, no access policy.', fx.ROOM_SECRET_1, RELAYS, undefined)
joinUrlPositive('kith-policy-with-admitted-issuer', 'A kith-gated policy round-trips its admitted-issuer allow-list.', fx.ROOM_SECRET_1, ['wss://relay.damus.io'], { tier: 'kith', admitted: [fx.HOST] })
joinUrlPositive('open-policy-has-no-admitted-list', "An 'open' policy carries no admitted list at all - decodeJoinUrl must not invent one.", fx.ROOM_SECRET_2, RELAYS, { tier: 'open' })
joinUrlPositive('empty-relay-list', 'Edge case: an empty relay list is a valid, if useless, join URL.', fx.ROOM_SECRET_1, [], undefined)

{
  const url = 'https://kithmoot.com/j#not-valid-base64url!!!'
  let error
  try {
    decodeJoinUrl(url)
  } catch (e) {
    error = e.message
  }
  vectors.joinUrl.push({
    name: 'decode-malformed-fragment',
    kind: 'negative',
    note: 'A fragment that is not valid base64url must be refused, not silently treated as an open room.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  // Deliberately weaker than it looks otherwise: `!!!` above fails on the
  // base64url alphabet before any parsing happens at all, so it never
  // exercises the JSON.parse step. This fragment is entirely valid
  // base64url - it decodes cleanly to bytes - but those bytes are not JSON.
  const url = `https://kithmoot.com/j#${base64urlnopad.encode(new TextEncoder().encode('this is not json'))}`
  let error
  try {
    decodeJoinUrl(url)
  } catch (e) {
    error = e.message
  }
  vectors.joinUrl.push({
    name: 'decode-fragment-not-json',
    kind: 'negative',
    note: 'A fragment made entirely of valid base64url characters that decodes to bytes which are not valid JSON at all - the alphabet check alone is not enough; the decoded payload must actually parse.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  // One step further again: the fragment now decodes to valid, parseable
  // JSON, but not a join payload - there is no `s` secret field to even
  // attempt to decode.
  const payload = { unexpected: true }
  const url = `https://kithmoot.com/j#${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}`
  let error
  try {
    decodeJoinUrl(url)
  } catch (e) {
    error = e.message
  }
  vectors.joinUrl.push({
    name: 'decode-payload-wrong-shape',
    kind: 'negative',
    note: "A fragment that decodes to valid JSON of the wrong shape - no 's' secret field at all - must be refused, not treated as a room with an empty or undefined secret.",
    input: { url },
    output: { throws: true, error },
  })
}

{
  const payload = { s: base64urlnopad.encode(seed32('joinurl-short-secret').slice(0, 16)), r: ['wss://relay.example'] }
  const url = `https://kithmoot.com/j#${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}`
  let error
  try {
    decodeJoinUrl(url)
  } catch (e) {
    error = e.message
  }
  vectors.joinUrl.push({
    name: 'decode-secret-wrong-length',
    kind: 'negative',
    note: 'A fragment that decodes to valid JSON but carries a 16-byte secret (not 32) must be refused.',
    input: { url },
    output: { throws: true, error },
  })
}

{
  const payload = { s: base64urlnopad.encode(fx.ROOM_SECRET_1), r: ['wss://relay.example'], a: { tier: 'archon' } }
  const url = `https://kithmoot.com/j#${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}`
  let error
  try {
    decodeJoinUrl(url)
  } catch (e) {
    error = e.message
  }
  vectors.joinUrl.push({
    name: 'decode-policy-unknown-tier',
    kind: 'negative',
    note: "A policy naming a tier outside open/ken/kith/kin must be refused, not silently dropped into an open room.",
    input: { url },
    output: { throws: true, error },
  })
}

// ===========================================================================
// 3. Device credential - participant secret + device pubkey + roomId +
//    expiry -> the exact signed kind-20460 event (src/credential.ts).
// ===========================================================================

function buildCredential({ participantSk, devicePubkey, roomId, createdAt, expiresAt, auxRandLabel }) {
  const auxRand = seed32(auxRandLabel)
  const event = finalizeDeterministic(
    {
      kind: KINDS.CREDENTIAL,
      created_at: createdAt,
      tags: [
        ['d', roomId],
        ['device', devicePubkey],
        ['expiration', String(expiresAt)],
      ],
      content: '',
    },
    participantSk,
    auxRand,
  )
  return { event, auxRandHex: bytesToHex(auxRand) }
}

const validCredential = buildCredential({
  participantSk: fx.PARTICIPANT_A_SK,
  devicePubkey: fx.DEVICE_A,
  roomId: ROOM_1.roomId,
  createdAt: fx.CREDENTIAL_CREATED_AT,
  expiresAt: fx.CREDENTIAL_EXPIRES_AT,
  auxRandLabel: 'credential-valid',
})

vectors.deviceCredential.push({
  name: 'valid',
  kind: 'positive',
  note: 'A credential signed by the participant, authorising one device, in one room, until an expiry.',
  input: {
    participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK),
    devicePubkey: fx.DEVICE_A,
    roomId: ROOM_1.roomId,
    createdAt: fx.CREDENTIAL_CREATED_AT,
    expiresAt: fx.CREDENTIAL_EXPIRES_AT,
    auxRandHex: validCredential.auxRandHex,
  },
  output: { event: validCredential.event },
  expected: {
    verify: { roomId: ROOM_1.roomId, now: fx.NOW },
    result: verifyDeviceCredential(validCredential.event, { roomId: ROOM_1.roomId, now: fx.NOW }),
  },
})

vectors.deviceCredential.push({
  name: 'wrong-room',
  kind: 'negative',
  note: 'The same, valid credential, checked against a different room id than the one it names.',
  input: { event: validCredential.event, verify: { roomId: ROOM_2.roomId, now: fx.NOW } },
  output: { result: verifyDeviceCredential(validCredential.event, { roomId: ROOM_2.roomId, now: fx.NOW }) },
})

{
  const expired = buildCredential({
    participantSk: fx.PARTICIPANT_A_SK,
    devicePubkey: fx.DEVICE_A,
    roomId: ROOM_1.roomId,
    createdAt: fx.CREDENTIAL_CREATED_AT,
    expiresAt: fx.CREDENTIAL_EXPIRES_AT_EXPIRED,
    auxRandLabel: 'credential-expired',
  })
  vectors.deviceCredential.push({
    name: 'expired',
    kind: 'negative',
    note: 'A credential whose expiry has already passed at verification time.',
    input: {
      participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK),
      devicePubkey: fx.DEVICE_A,
      roomId: ROOM_1.roomId,
      createdAt: fx.CREDENTIAL_CREATED_AT,
      expiresAt: fx.CREDENTIAL_EXPIRES_AT_EXPIRED,
      auxRandHex: expired.auxRandHex,
      verify: { roomId: ROOM_1.roomId, now: fx.NOW },
    },
    output: { event: expired.event, result: verifyDeviceCredential(expired.event, { roomId: ROOM_1.roomId, now: fx.NOW }) },
  })
}

{
  // Same tamper `src/credential.test.ts` exercises: swap the delegated
  // device in the `device` tag after signing, without re-signing.
  const tampered = { ...validCredential.event, tags: validCredential.event.tags.map((t) => [...t]) }
  tampered.tags[1][1] = 'c'.repeat(64)
  vectors.deviceCredential.push({
    name: 'tampered-signature',
    kind: 'negative',
    note: "The valid credential's device tag swapped for a different pubkey after signing - the signature no longer covers the tags it is checked against.",
    input: { event: tampered, verify: { roomId: ROOM_1.roomId, now: fx.NOW } },
    output: { result: verifyDeviceCredential(tampered, { roomId: ROOM_1.roomId, now: fx.NOW }) },
  })
}

// ===========================================================================
// 4. Roster event - RosterEntry + roomKey -> the exact encrypted kind-20461
//    event (src/roster.ts).
// ===========================================================================

function buildRoster({ entry, roomId, roomKey, deviceSk, nonceLabel, auxRandLabel }) {
  const nonce = seed32(nonceLabel)
  const auxRand = seed32(auxRandLabel)
  const plaintext = JSON.stringify(entry)
  const content = nip44.v2.encrypt(plaintext, roomKey, nonce)
  const event = finalizeDeterministic({ kind: KINDS.ROSTER, created_at: entry.updatedAt, tags: [['d', roomId]], content }, deviceSk, auxRand)
  return { event, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand) }
}

const rosterEntry = {
  participant: fx.PARTICIPANT_A,
  device: fx.DEVICE_A,
  credential: validCredential.event,
  tracks: [{ trackId: 't1', role: 'screen' }],
  claims: { mic: fx.NOW },
  updatedAt: fx.NOW,
}

const validRoster = buildRoster({
  entry: rosterEntry,
  roomId: ROOM_1.roomId,
  roomKey: ROOM_1.roomKey,
  deviceSk: fx.DEVICE_A_SK,
  // Distinct labels for the NIP-44 nonce and the BIP-340 aux-rand: they are
  // two different cryptographic roles and must never share a value, even in
  // a frozen fixture - see the README's note on nonce/aux-rand reuse.
  nonceLabel: 'roster-valid-nonce',
  auxRandLabel: 'roster-valid-auxrand',
})

vectors.rosterEvent.push({
  name: 'valid',
  kind: 'positive',
  note: 'A roster entry (with its device credential nested inside) encrypted to the room key and signed by the device.',
  input: {
    entry: rosterEntry,
    roomId: ROOM_1.roomId,
    roomKeyHex: bytesToHex(ROOM_1.roomKey),
    deviceSkHex: bytesToHex(fx.DEVICE_A_SK),
    nonceHex: validRoster.nonceHex,
    auxRandHex: validRoster.auxRandHex,
  },
  output: { event: validRoster.event },
  expected: {
    decode: { roomId: ROOM_1.roomId, now: fx.NOW },
    result: decodeRosterEvent(validRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
  },
})

vectors.rosterEvent.push({
  name: 'wrong-room-key',
  kind: 'negative',
  note: "The same event, decrypted with room 2's key instead of the room it was actually published to - NIP-44 decryption fails its MAC check and the decoder must return null, not throw.",
  input: { event: validRoster.event, decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_2.roomKey), now: fx.NOW } },
  output: { result: decodeRosterEvent(validRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_2.roomKey, now: fx.NOW }) },
})

{
  // The entry still names DEVICE_A as the authorised device, but the event
  // is actually signed by an impostor device - decodeRosterEvent must catch
  // the mismatch between `event.pubkey` and `entry.device`.
  const impostorRoster = buildRoster({
    entry: rosterEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_IMPOSTOR_SK,
    nonceLabel: 'roster-impostor-nonce',
    auxRandLabel: 'roster-impostor-auxrand',
  })
  vectors.rosterEvent.push({
    name: 'wrong-signing-device',
    kind: 'negative',
    note: 'The entry names DEVICE_A as the authorised device, but a different device (holding no credential for this room) signed the event.',
    input: {
      entry: rosterEntry,
      roomId: ROOM_1.roomId,
      roomKeyHex: bytesToHex(ROOM_1.roomKey),
      deviceSkHex: bytesToHex(fx.DEVICE_IMPOSTOR_SK),
      nonceHex: impostorRoster.nonceHex,
      auxRandHex: impostorRoster.auxRandHex,
    },
    output: {
      event: impostorRoster.event,
      result: decodeRosterEvent(impostorRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // Same class of hole as the accessEvaluation forgery below: nothing else
  // in decodeRosterEvent re-establishes that DEVICE_A's own key produced
  // this event. Only `sig` is corrupted here - id, pubkey, tags and content
  // are exactly the valid event's - so the room match, decryption and the
  // entry.device === event.pubkey check all still succeed. Skip verifying
  // the event's own signature, and anyone who relabels an event with
  // someone else's pubkey (no private key required) is accepted as that
  // device's genuine announcement.
  const tamperedOuter = { ...validRoster.event, sig: '00'.repeat(64) }
  vectors.rosterEvent.push({
    name: 'tampered-outer-signature',
    kind: 'negative',
    note: "The valid roster event above with its own signature corrupted - id, pubkey, tags and content untouched. Decryption, the room match, and the entry.device === event.pubkey check would all still pass; only verifying the event's own signature catches this.",
    input: { event: tamperedOuter, decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW } },
    output: { result: decodeRosterEvent(tamperedOuter, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
  })
}

{
  // One layer deeper: the OUTER event's signature is genuine here - it
  // really was signed by DEVICE_IMPOSTOR's own key, matching entry.device -
  // but the credential nested inside, which is what actually vouches that
  // PARTICIPANT_A authorised this device, is the valid DEVICE_A credential
  // with its `device` tag swapped after signing, not something
  // PARTICIPANT_A ever signed for DEVICE_IMPOSTOR. Room, decrypt, the outer
  // signature and entry.device === event.pubkey all check out; only
  // verifying the NESTED credential's own signature catches the forgery.
  // Skip that inner check (easy to do by mistake: it looks like "just
  // re-parse the credential fields") and an attacker with no key but their
  // own gets full standing as PARTICIPANT_A.
  const forgedCredential = { ...validCredential.event, tags: validCredential.event.tags.map((t) => [...t]) }
  forgedCredential.tags[1][1] = fx.DEVICE_IMPOSTOR

  const forgedEntry = { ...rosterEntry, device: fx.DEVICE_IMPOSTOR, credential: forgedCredential }
  const forgedRoster = buildRoster({
    entry: forgedEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_IMPOSTOR_SK,
    nonceLabel: 'roster-forged-credential-nonce',
    auxRandLabel: 'roster-forged-credential-auxrand',
  })

  vectors.rosterEvent.push({
    name: 'forged-credential-signature',
    kind: 'negative',
    note: "The outer event is genuinely signed by DEVICE_IMPOSTOR, and entry.device matches it, but the nested credential (claiming PARTICIPANT_A authorised DEVICE_IMPOSTOR) is the valid DEVICE_A credential with its device tag swapped after signing - PARTICIPANT_A never signed this. Room, decrypt, the outer signature, and entry.device === event.pubkey all pass; only verifying the nested credential's own signature catches this.",
    input: {
      entry: forgedEntry,
      roomId: ROOM_1.roomId,
      roomKeyHex: bytesToHex(ROOM_1.roomKey),
      deviceSkHex: bytesToHex(fx.DEVICE_IMPOSTOR_SK),
      nonceHex: forgedRoster.nonceHex,
      auxRandHex: forgedRoster.auxRandHex,
    },
    output: {
      event: forgedRoster.event,
      result: decodeRosterEvent(forgedRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // --- Display names ----------------------------------------------------
  //
  // A roster entry may carry a `name`: what the person would like to be
  // called. It is SELF-ASSERTED - anyone can type anything, nothing checks
  // it - so both vectors below are about what a reader must do with it, and
  // are recorded as decode-only cases: a frozen event in, a decoded entry
  // out. Encoding a name is already pinned by `rosterEvent/valid`'s
  // machinery; what a second implementation can get wrong is accepting a
  // name it should have defused.
  //
  // Decode-only also means these two stay meaningful for an implementation
  // that does not carry names at all: it decodes the event, ignores the
  // field, and matches the recorded entry on everything it does model.

  const namedEntry = { ...rosterEntry, name: 'Darren' }
  const namedRoster = buildRoster({
    entry: namedEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-named-nonce',
    auxRandLabel: 'roster-named-auxrand',
  })

  vectors.rosterEvent.push({
    name: 'display-name',
    kind: 'positive',
    note: "A roster entry carrying an ordinary display name. The name is inside the room-key ciphertext, alongside the participant pubkey and the credential - a relay that could read the guest list by name would be worse than one that could read it by pubkey, not better. The name survives the round trip exactly as typed, and decides nothing: `participant` and the nested credential are still what say who this is.",
    input: { event: namedRoster.event },
    output: { result: decodeRosterEvent(namedRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(namedRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })

  // Published by a client that sanitises nothing - which is the only kind
  // worth pinning, because a well-behaved sender proves nothing about a
  // reader. Everything in this string is a known display-name attack:
  //
  //   U+202E RIGHT-TO-LEFT OVERRIDE  reverses the rest of the line, so
  //                                  "nerrad" renders as "darren"
  //   \n                             takes a second row in the tile
  //   U+200B ZERO WIDTH SPACE        hides the join between two parts
  //   200 further characters         push the pubkey beside it off the row
  //
  // A reader must return the name defused, not reject the entry: the
  // person is genuinely in the room, and their credential is genuine. The
  // name is the only thing at fault, so the name is the only thing changed.
  const HOSTILE_NAME = `\u202Enerrad\nadmin\u200B${'x'.repeat(200)}`
  const hostileEntry = { ...rosterEntry, name: HOSTILE_NAME }
  const hostileRoster = buildRoster({
    entry: hostileEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-hostile-name-nonce',
    auxRandLabel: 'roster-hostile-name-auxrand',
  })

  vectors.rosterEvent.push({
    name: 'display-name-hostile',
    kind: 'positive',
    note: "A genuine, fully valid roster entry whose display name carries a right-to-left override, a smuggled newline, a zero-width space and 200 characters of padding - published by a client that sanitised nothing. The entry is ACCEPTED (the person and their credential are genuine) and the name is neutralised: every Unicode 'other' character removed, whitespace collapsed, and the result capped at 32 code points. `expected.result.name` is what a reader must end up with.",
    input: { event: hostileRoster.event, rawName: HOSTILE_NAME },
    output: { result: decodeRosterEvent(hostileRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(hostileRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // --- Farewell ----------------------------------------------------------
  //
  // The last entry a device publishes as it leaves: nothing published,
  // nothing claimed, flagged as an answer so it provokes no re-announce,
  // and flagged `left` so every other device drops it NOW rather than when
  // its presence lapses. Departure is a stated fact rather than a guess from
  // an empty track list, because a device with everything switched off looks
  // exactly like one on its way out and only one of them should vanish.
  //
  // Recorded decode-only, like the display-name and assist vectors: an
  // implementation that does not model `left` still decodes this event,
  // ignores the field, and matches the recorded entry on everything else -
  // it simply removes the device on the timeout, as every client did before
  // the field existed.
  const farewellEntry = { ...rosterEntry, tracks: [], claims: {}, reply: true, left: true }
  const farewellRoster = buildRoster({
    entry: farewellEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-farewell-nonce',
    auxRandLabel: 'roster-farewell-auxrand',
  })
  vectors.rosterEvent.push({
    name: 'farewell',
    kind: 'positive',
    note: 'The entry a device publishes as it leaves: empty tracks and claims, `reply: true` so nobody answers it, and `left: true` so every other device removes it at once instead of waiting out the presence timeout. A reader that does not know `left` treats this as an ordinary answer carrying nothing and evicts the device on the timeout. Only a JSON `true` is a farewell; any other value is not one.',
    input: { event: farewellRoster.event },
    output: { result: decodeRosterEvent(farewellRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(farewellRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // --- The agent flag ----------------------------------------------------
  //
  // A roster entry may say `agent: true`: this device is an automated
  // participant. Self-declared, like a display name, and what it is FOR is
  // consent - a member may choose to send its media to nothing that says
  // this. So only an honest JSON `true` is the flag; a looser
  // implementation's `1` or `"yes"` is a person, and a reader that does not
  // know the field at all sees an ordinary entry. Recorded decode-only, like
  // the farewell: an implementation that ignores the field still matches
  // the recorded entry on everything else.
  const agentEntry = { ...rosterEntry, agent: true }
  const agentRoster = buildRoster({
    entry: agentEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-agent-nonce',
    auxRandLabel: 'roster-agent-auxrand',
  })
  vectors.rosterEvent.push({
    name: 'agent',
    kind: 'positive',
    note: 'A roster entry from a device declaring itself an automated participant with `agent: true`. Inside the room-key ciphertext like everything else. A reader keeps the flag; a member may use it to decide what media this device is sent. A reader that does not know the field sees an ordinary entry.',
    input: { event: agentRoster.event },
    output: { result: decodeRosterEvent(agentRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(agentRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })

  const looseAgentEntry = { ...rosterEntry, agent: 'yes' }
  const looseAgentRoster = buildRoster({
    entry: looseAgentEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-agent-loose-nonce',
    auxRandLabel: 'roster-agent-loose-auxrand',
  })
  vectors.rosterEvent.push({
    name: 'agent-loose-value',
    kind: 'positive',
    note: 'A genuine roster entry whose `agent` field is the string "yes" rather than the JSON boolean `true`. The entry is ACCEPTED and the field is DROPPED: only an honest `true` declares an agent, because the flag decides what a member sends this device. `expected.result` carries no `agent` at all.',
    input: { event: looseAgentRoster.event, rawAgent: 'yes' },
    output: { result: decodeRosterEvent(looseAgentRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(looseAgentRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // --- Channel derivation --------------------------------------------------
  //
  // A named channel is the same room-key chat under an id and a key derived
  // from the room KEY for that name - never from the room id, so a party
  // holding the id alone cannot find it. Two HKDF expansions, two info
  // strings, exactly as `deriveRoom`. The unnamed channel is the main chat:
  // the room id and the room key themselves, byte for byte.
  for (const channel of ['agents', 'transcript']) {
    const { id, key } = deriveChannel(ROOM_1.roomId, ROOM_1.roomKey, channel)
    vectors.channelDerivation.push({
      name: channel,
      kind: 'positive',
      note: `The \`${channel}\` channel of ROOM_1: id = HKDF-SHA256(ikm = roomKey, info = "kithmoot/v1/channel-id/${channel}", 32 bytes) as hex, key = HKDF-SHA256(ikm = roomKey, info = "kithmoot/v1/channel-key/${channel}", 32 bytes). No salt. A chat event on this channel carries the id in its \`d\` tag and is NIP-44-encrypted under the key; the credential inside is still checked against the ROOM id.`,
      input: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), channel },
      output: { id, keyHex: bytesToHex(key) },
    })
  }
  const main = deriveChannel(ROOM_1.roomId, ROOM_1.roomKey)
  vectors.channelDerivation.push({
    name: 'unnamed-is-the-room',
    kind: 'positive',
    note: 'No channel name means the main chat: the id is the room id and the key is the room key, unchanged, so every chat event ever published decodes exactly as before channels existed.',
    input: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey) },
    output: { id: main.id, keyHex: bytesToHex(main.key) },
  })
}

{
  // --- Assist offers -----------------------------------------------------
  //
  // A roster entry may carry an `assist`: an offer to relay other people's
  // media, so a room's spare uplink comes from the people in it rather than
  // from a server anybody pays for. Like a display name it is entirely
  // SELF-ASSERTED - a device can advertise a gigabit uplink it does not have,
  // or claim to be publicly reachable from behind a NAT - so both vectors
  // below are about what a READER must do with one.
  //
  // Unlike a display name, it feeds arithmetic: the numbers here decide which
  // member of the room carries a pair that cannot connect directly. A NaN
  // uplink or a fan-out claim of five thousand would otherwise flow straight
  // into that sum on every client in the room.
  //
  // Recorded decode-only (a frozen event in, a decoded entry out) for the
  // same reason the display-name vectors are: an implementation that does not
  // carry assist offers at all still decodes the event, ignores the field,
  // and matches the recorded entry on everything it does model.

  const assistOffer = {
    reachability: 'public',
    capacity: { uplinkBps: 100000000, peers: 4, perPeerBps: 600000 },
    relaying: 1,
    maxRelayed: 3,
  }
  const assistEntry = { ...rosterEntry, assist: assistOffer }
  const assistRoster = buildRoster({
    entry: assistEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-assist-nonce',
    auxRandLabel: 'roster-assist-auxrand',
  })

  vectors.rosterEvent.push({
    name: 'assist-offer',
    kind: 'positive',
    note: "A roster entry carrying an offer to relay for the room: measured reachability, the uplink estimate every client derives spare capacity from, and how many pairs this device is already carrying. It is inside the room-key ciphertext with everything else - a relay that could read which members were publicly reachable and how much bandwidth they had would be reading a map of the room. The offer survives the round trip exactly as published, and decides nothing on its own: what it feeds is a selection every client computes independently from the same roster.",
    input: { event: assistRoster.event },
    output: { result: decodeRosterEvent(assistRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(assistRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })

  // Published by a client that sanitises nothing, which is the only kind
  // worth pinning. Every value here is a known way to break the sum that
  // decides who carries a room:
  //
  //   uplinkBps: null          NaN once coerced; every comparison against it
  //                            is false, so the device looks like it has
  //                            neither capacity nor a shortage of it
  //   peers: -3                a negative spend, which is spare capacity
  //                            invented out of nothing
  //   relaying: 0.5            a fractional load, so a fan-out cap counted in
  //                            whole pairs never quite reaches
  //   maxRelayed: 5000         a claim to carry the entire room
  //   reachability: 'amazing'  not one of the four measured answers
  //
  // The entry is ACCEPTED - the person is genuinely in the room and their
  // credential is genuine - and the offer is DROPPED WHOLE rather than
  // repaired. A half-mended offer is a number somebody made up wearing a
  // measurement's clothes; absent is honest.
  const HOSTILE_OFFER = {
    reachability: 'amazing',
    capacity: { uplinkBps: null, peers: -3, perPeerBps: 600000 },
    relaying: 0.5,
    maxRelayed: 5000,
  }
  const hostileAssistEntry = { ...rosterEntry, assist: HOSTILE_OFFER }
  const hostileAssistRoster = buildRoster({
    entry: hostileAssistEntry,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'roster-assist-hostile-nonce',
    auxRandLabel: 'roster-assist-hostile-auxrand',
  })

  vectors.rosterEvent.push({
    name: 'assist-offer-hostile',
    kind: 'positive',
    note: "A genuine, fully valid roster entry whose assist offer is nonsense: a null uplink, a negative peer count, a fractional load, a claim to carry five thousand pairs, and a reachability that is not one of the four measured answers. The entry is ACCEPTED and the offer is dropped whole - `expected.result` carries no `assist` field at all. Repairing it would be worse than dropping it: a mended number is still a number the publisher chose, and it would go on to decide who carries this room.",
    input: { event: hostileAssistRoster.event, rawAssist: HOSTILE_OFFER },
    output: { result: decodeRosterEvent(hostileAssistRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }) },
    expected: {
      decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_1.roomKey), now: fx.NOW },
      result: decodeRosterEvent(hostileAssistRoster.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

// ===========================================================================
// 5. Signal wrap - SignalBody + sender secret + recipient pubkey + fixed
//    ephemeral key -> the exact kind-21059 gift wrap (src/signal.ts).
// ===========================================================================

function buildSignalWrap({ body, senderSk, recipientPubkey, ephemeralSk, createdAt, innerAuxLabel, outerAuxLabel, nonceLabel }) {
  const innerAux = seed32(innerAuxLabel)
  const outerAux = seed32(outerAuxLabel)
  const nonce = seed32(nonceLabel)

  const inner = finalizeDeterministic(
    { kind: KINDS.SIGNAL, created_at: createdAt, tags: [['p', recipientPubkey]], content: JSON.stringify(body) },
    senderSk,
    innerAux,
  )
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, recipientPubkey)
  const outerContent = nip44.v2.encrypt(JSON.stringify(inner), conversationKey, nonce)
  const outer = finalizeDeterministic({ kind: KINDS.SIGNAL_WRAP, created_at: createdAt, tags: [['p', recipientPubkey]], content: outerContent }, ephemeralSk, outerAux)

  return { inner, outer, innerAuxHex: bytesToHex(innerAux), outerAuxHex: bytesToHex(outerAux), nonceHex: bytesToHex(nonce) }
}

const offerBody = { type: 'offer', roomId: ROOM_1.roomId, sdp: fx.SDP_FIXTURE }
const offerWrap = buildSignalWrap({
  body: offerBody,
  senderSk: fx.SENDER_SK,
  recipientPubkey: fx.RECIPIENT,
  ephemeralSk: fx.EPHEMERAL_SK_OFFER,
  createdAt: fx.SIGNAL_CREATED_AT,
  // Distinct labels for the outer aux-rand and the outer NIP-44 nonce: two
  // different cryptographic roles, never sharing a value - see the
  // README's note on nonce/aux-rand reuse.
  innerAuxLabel: 'signal-offer-inner',
  outerAuxLabel: 'signal-offer-outer-aux',
  nonceLabel: 'signal-offer-outer-nonce',
})

vectors.signalWrap.push({
  name: 'offer',
  kind: 'positive',
  note: "An SDP offer, gift-wrapped so the relay sees neither the SDP nor the sender's identity - only that someone sent something to the recipient.",
  input: {
    body: offerBody,
    senderSkHex: bytesToHex(fx.SENDER_SK),
    recipientPubkey: fx.RECIPIENT,
    ephemeralSkHex: bytesToHex(fx.EPHEMERAL_SK_OFFER),
    createdAt: fx.SIGNAL_CREATED_AT,
    innerAuxRandHex: offerWrap.innerAuxHex,
    outerAuxRandHex: offerWrap.outerAuxHex,
    nip44NonceHex: offerWrap.nonceHex,
  },
  output: { inner: offerWrap.inner, outer: offerWrap.outer },
  expected: {
    unwrap: { recipientSkHex: bytesToHex(fx.RECIPIENT_SK), roomId: ROOM_1.roomId },
    result: unwrapSignal(offerWrap.outer, { recipientSk: fx.RECIPIENT_SK, roomId: ROOM_1.roomId, now: fx.SIGNAL_CREATED_AT }),
  },
})

const iceBody = { type: 'ice', roomId: ROOM_1.roomId, candidate: fx.ICE_FIXTURE }
const iceWrap = buildSignalWrap({
  body: iceBody,
  senderSk: fx.SENDER_SK,
  recipientPubkey: fx.RECIPIENT,
  ephemeralSk: fx.EPHEMERAL_SK_ICE,
  createdAt: fx.SIGNAL_CREATED_AT,
  innerAuxLabel: 'signal-ice-inner',
  outerAuxLabel: 'signal-ice-outer-aux',
  nonceLabel: 'signal-ice-outer-nonce',
})

vectors.signalWrap.push({
  name: 'ice-candidate',
  kind: 'positive',
  note: 'A trickled ICE candidate, wrapped the same way as an offer or answer.',
  input: {
    body: iceBody,
    senderSkHex: bytesToHex(fx.SENDER_SK),
    recipientPubkey: fx.RECIPIENT,
    ephemeralSkHex: bytesToHex(fx.EPHEMERAL_SK_ICE),
    createdAt: fx.SIGNAL_CREATED_AT,
    innerAuxRandHex: iceWrap.innerAuxHex,
    outerAuxRandHex: iceWrap.outerAuxHex,
    nip44NonceHex: iceWrap.nonceHex,
  },
  output: { inner: iceWrap.inner, outer: iceWrap.outer },
  expected: {
    unwrap: { recipientSkHex: bytesToHex(fx.RECIPIENT_SK), roomId: ROOM_1.roomId },
    result: unwrapSignal(iceWrap.outer, { recipientSk: fx.RECIPIENT_SK, roomId: ROOM_1.roomId, now: fx.SIGNAL_CREATED_AT }),
  },
})

vectors.signalWrap.push({
  name: 'wrong-recipient',
  kind: 'negative',
  note: "The offer wrap above, opened by someone other than the intended recipient - the ECDH shared point differs, so the outer NIP-44 payload fails to authenticate and unwrapSignal must return null.",
  input: { wrap: offerWrap.outer, unwrap: { recipientSkHex: bytesToHex(fx.EAVESDROPPER_SK), roomId: ROOM_1.roomId } },
  output: { result: unwrapSignal(offerWrap.outer, { recipientSk: fx.EAVESDROPPER_SK, roomId: ROOM_1.roomId, now: fx.SIGNAL_CREATED_AT }) },
})

vectors.signalWrap.push({
  name: 'wrong-room',
  kind: 'negative',
  note: "The offer wrap above, unwrapped correctly by the real recipient but checked against a room id the inner body does not name.",
  input: { wrap: offerWrap.outer, unwrap: { recipientSkHex: bytesToHex(fx.RECIPIENT_SK), roomId: ROOM_2.roomId } },
  output: { result: unwrapSignal(offerWrap.outer, { recipientSk: fx.RECIPIENT_SK, roomId: ROOM_2.roomId, now: fx.SIGNAL_CREATED_AT }) },
})

{
  // Same class of hole as GAP 1's opening example, one layer down: the
  // gift wrap's outer key is ALWAYS attacker-chosen (that is the whole
  // point of a fresh ephemeral key per wrap) so it proves nothing about
  // who sent the payload - only the INNER event's signature does, via
  // `inner.pubkey`. Corrupt only the inner event's `sig`, leaving its id,
  // pubkey, tags and content untouched, so the outer wrap still decrypts
  // cleanly and inner.kind/body.roomId/the addressed tag all still check
  // out. Skip verifying the inner event and this is accepted as a
  // genuine message `from` whoever's pubkey the attacker typed into the
  // forged inner event - no private key required, since the outer wrap can
  // be assembled under any ephemeral key the attacker likes.
  const tamperedInner = { ...offerWrap.inner, sig: '00'.repeat(64) }
  const tamperedNonce = seed32('signal-tampered-inner-outer-nonce')
  const tamperedOuterAux = seed32('signal-tampered-inner-outer-aux')
  const tamperedConversationKey = nip44.v2.utils.getConversationKey(fx.EPHEMERAL_SK_TAMPERED, fx.RECIPIENT)
  const tamperedOuterContent = nip44.v2.encrypt(JSON.stringify(tamperedInner), tamperedConversationKey, tamperedNonce)
  const tamperedOuter = finalizeDeterministic(
    { kind: KINDS.SIGNAL_WRAP, created_at: fx.SIGNAL_CREATED_AT, tags: [['p', fx.RECIPIENT]], content: tamperedOuterContent },
    fx.EPHEMERAL_SK_TAMPERED,
    tamperedOuterAux,
  )

  vectors.signalWrap.push({
    name: 'tampered-inner-signature',
    kind: 'negative',
    note: "The offer's inner event with its own signature corrupted - id, pubkey, tags and content untouched - re-wrapped under a fresh (but otherwise ordinary) ephemeral key. The outer wrap decrypts fine, and inner.kind, body.roomId, and the addressed 'p' tag all still check out; only verifying the inner event's own signature catches this.",
    input: { wrap: tamperedOuter, unwrap: { recipientSkHex: bytesToHex(fx.RECIPIENT_SK), roomId: ROOM_1.roomId } },
    output: { result: unwrapSignal(tamperedOuter, { recipientSk: fx.RECIPIENT_SK, roomId: ROOM_1.roomId, now: fx.SIGNAL_CREATED_AT }) },
  })
}

// ===========================================================================
// 6. Kindred proof - issuer secret + participant + tier + expiry -> the
//    exact proof (src/access.ts), one per non-open tier.
// ===========================================================================

function buildKindredProof({ hostSk, participant, tier, room, nonce, expiresAt, auxRandLabel }) {
  const auxRand = seed32(auxRandLabel)
  const message = kindredCanonicalMessage(tier, participant, room, nonce, expiresAt)
  const sig = schnorr.sign(message, hostSk, auxRand)
  return {
    proof: { tier, participant, issuer: getPublicKey(hostSk), room, nonce, sig: bytesToHex(sig), expiresAt },
    auxRandHex: bytesToHex(auxRand),
  }
}

// Every kindred proof names one room, and it is ROOM_1 throughout - the same
// room the credential, roster and signal groups above are built against, so a
// reader can trace one moot through the whole file.
const KINDRED_ROOM = ROOM_1.roomId

const kenProof = buildKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'ken', room: KINDRED_ROOM, nonce: fx.KINDRED_NONCE_KEN, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandLabel: 'kindred-ken' })
const kithProof = buildKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'kith', room: KINDRED_ROOM, nonce: fx.KINDRED_NONCE_KITH, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandLabel: 'kindred-kith' })
const kinProof = buildKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'kin', room: KINDRED_ROOM, nonce: fx.KINDRED_NONCE_KIN, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandLabel: 'kindred-kin' })
const untrustedKithProof = buildKindredProof({ hostSk: fx.HOST_UNTRUSTED_SK, participant: fx.GUEST, tier: 'kith', room: KINDRED_ROOM, nonce: fx.KINDRED_NONCE_UNTRUSTED, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandLabel: 'kindred-untrusted' })
// Genuinely signed, by the trusted issuer, at a sufficient tier, unexpired,
// naming the right participant - and minted for ROOM_2. The only thing wrong
// with it is the room, which is precisely the replay the binding exists to
// stop.
const otherRoomKithProof = buildKindredProof({ hostSk: fx.HOST_SK, participant: fx.GUEST, tier: 'kith', room: ROOM_2.roomId, nonce: fx.KINDRED_NONCE_OTHER_ROOM, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandLabel: 'kindred-other-room' })

for (const [name, built, tier] of [
  ['ken', kenProof, 'ken'],
  ['kith', kithProof, 'kith'],
  ['kin', kinProof, 'kin'],
]) {
  vectors.kindredProof.push({
    name,
    kind: 'positive',
    note: `A ${tier} proof: the issuer vouches for GUEST at the '${tier}' tier, in ROOM_1, until KINDRED_EXPIRES_AT. The room and the nonce are both inside the signed message - see canonicalMessage in src/access.ts - so a proof cannot be edited into another room, and two proofs on identical terms are still distinguishable. Pins the signed message layout, not any admission decision - see the accessEvaluation group for that.`,
    input: { hostSkHex: bytesToHex(fx.HOST_SK), participant: fx.GUEST, tier, roomId: KINDRED_ROOM, nonce: built.proof.nonce, expiresAt: fx.KINDRED_EXPIRES_AT, auxRandHex: built.auxRandHex },
    output: { proof: built.proof },
  })
}

// ===========================================================================
// 7. Access evaluation - RoomPolicy + participant + KindredProof + now ->
//    the exact { admitted, reason } (src/access.ts, evaluateAccess).
// ===========================================================================

const KITH_POLICY = { tier: 'kith', admitted: [fx.HOST] }
const OPEN_POLICY = { tier: 'open' }

function accessVector(name, kind, note, policy, proof, roomId = KINDRED_ROOM) {
  vectors.accessEvaluation.push({
    name,
    kind,
    note,
    input: { policy, participant: fx.GUEST, proof: proof ?? null, now: fx.NOW, roomId },
    output: { result: evaluateAccess(policy, fx.GUEST, proof, fx.NOW, roomId) },
  })
}

accessVector('open-room-admits-anyone', 'positive', 'An open room admits any participant without a proof at all.', OPEN_POLICY, undefined)
accessVector('kith-room-admits-kith-proof', 'positive', 'A kith-gated room admits a matching kith proof from a trusted issuer.', KITH_POLICY, kithProof.proof)
accessVector('kith-room-admits-kin-proof', 'positive', 'A kith-gated room also admits a kin proof - kin is closer than kith.', KITH_POLICY, kinProof.proof)
accessVector('kith-room-rejects-ken-proof', 'negative', "A kith-gated room refuses a ken proof - ken is one-way recognition and never satisfies a kith gate ('tier too low').", KITH_POLICY, kenProof.proof)
accessVector('kith-room-rejects-untrusted-issuer', 'negative', 'A kith-gated room refuses a well-formed, correctly-signed kith proof from an issuer not on its allow-list.', KITH_POLICY, untrustedKithProof.proof)

// Hex identifiers in this protocol are compared case-insensitively (see
// "Hex identifiers are compared case-insensitively" in vectors/README.md).
// These two vectors are the reason that rule is written down: the first
// independent implementation (Kotlin/Android) did an exact string match on
// `proof.issuer` against `policy.admitted`, which passed every other
// accessEvaluation vector - none of which vary the hex case - and would
// still have silently refused a genuine issuer the moment a room's
// allow-list was typed or pasted in upper-case hex. Both directions are
// covered: the allow-list entry in upper case against an ordinarily-cased
// proof, and the mirror image.
const upperCaseHostPolicy = { tier: 'kith', admitted: [fx.HOST.toUpperCase()] }
accessVector(
  'kith-room-admits-issuer-via-upper-case-allow-list-entry',
  'positive',
  "The allow-list names the trusted issuer (HOST) in upper-case hex; the proof itself is issued and signed normally, so its issuer field is the ordinary lower-case pubkey. Still admitted - an implementation that compares the allow-list entry to the issuer with an exact string match wrongly refuses this.",
  upperCaseHostPolicy,
  kithProof.proof,
)

const upperCaseIssuerProof = { ...kithProof.proof, issuer: kithProof.proof.issuer.toUpperCase() }
accessVector(
  'kith-room-admits-upper-case-issuer-against-lower-case-allow-list',
  'positive',
  "The mirror image: the proof carries its own issuer field in upper-case hex - issuer is not part of the signed message (see canonicalMessage in src/access.ts), so upper-casing it does not disturb the signature - while the room's allow-list names HOST in the ordinary lower case. Still admitted.",
  KITH_POLICY,
  upperCaseIssuerProof,
)

// The vector every other accessEvaluation negative above is NOT: both
// 'kith-room-rejects-ken-proof' and 'kith-room-rejects-untrusted-issuer' are
// refused before evaluateAccess ever reaches schnorr.verify - one on the
// tier ladder, one on the allow-list. An implementation that never checks a
// kindred proof's signature at all - a two-line forgery, since nothing else
// in the proof needs a real key to produce - passes every other vector in
// this group. This is the one negative that fails on nothing BUT the
// signature: the issuer IS trusted, the tier IS sufficient, the proof is NOT
// expired, and it names the right participant - only `sig` is garbage.
// A kindred proof names one room - see `KindredProof` in src/types.ts. This
// proof is genuine in every other respect, and the reason it is refused is
// the reason the binding exists: without it, one proof from a trusted issuer
// admits its holder to every room that trusts that issuer.
accessVector(
  'kith-room-rejects-proof-for-another-room',
  'negative',
  "A kith proof from the trusted issuer, at a sufficient tier, unexpired, naming the right participant - and minted for a different room. An implementation that does not compare proof.room to the room being joined admits a proof its issuer never granted here ('proof names another room').",
  KITH_POLICY,
  otherRoomKithProof.proof,
)

// The mirror: the room field edited to name this room, which the signature
// covers - so this is refused on the signature rather than on the room.
accessVector(
  'kith-room-rejects-room-edited-into-the-proof',
  'negative',
  "The same other-room proof with its `room` field rewritten to name this room. The room is inside the signed message, so rewriting it invalidates the signature ('bad signature') - an implementation that binds the room but leaves it out of canonicalMessage admits this.",
  KITH_POLICY,
  { ...otherRoomKithProof.proof, room: KINDRED_ROOM },
)

accessVector(
  'kith-room-admits-proof-against-upper-case-room-id',
  'positive',
  'The room id handed to evaluateAccess is upper-case hex naming the very room the proof was minted for. Hex identifiers are compared case-insensitively throughout - see the section of this README on that - so this is still admitted.',
  KITH_POLICY,
  kithProof.proof,
  KINDRED_ROOM.toUpperCase(),
)

accessVector(
  'kith-room-rejects-tampered-signature',
  'negative',
  "A kith proof from the trusted issuer, at a sufficient tier, unexpired, naming the right participant - identical to 'kith-room-admits-kith-proof' except its signature is garbage. Every check before the final schnorr verification passes; skip that check, or skip it entirely, and this is indistinguishable from a genuine proof.",
  KITH_POLICY,
  { ...kithProof.proof, sig: '00'.repeat(64) },
)

// ===========================================================================
// 8. TURN credential - secret + ttl + fixed now -> the exact
//    { username, credential } (src/turn.ts, coturn REST scheme).
// ===========================================================================

for (const [name, note, secret, ttlSeconds, now, deviceName] of [
  [
    'coturn-known-vector',
    "Cross-checked independently with Node's own crypto module (see src/turn.test.ts) - HMAC-SHA1('my-shared-secret', '1735776000:kithmoot') base64-encoded.",
    'my-shared-secret',
    86400,
    1_735_689_600,
    undefined,
  ],
  ['custom-device-name', 'A per-viewer name in place of the default.', 'secret', 60, 100, 'alice-device-1'],
  ['fractional-seconds-floor', 'ttl and now are floored before being summed, so expiry is always a whole Unix second.', 'secret', 60.7, 100.4, undefined],
  ['zero-ttl', 'Edge case: a zero-length TTL still mints a credential that expires immediately.', 'secret', 0, 1_800_000_000, undefined],
]) {
  const result = deviceName ? mintTurnCredential(secret, ttlSeconds, now, deviceName) : mintTurnCredential(secret, ttlSeconds, now)
  vectors.turnCredential.push({
    name,
    kind: 'positive',
    note,
    input: { secret, ttlSeconds, now, name: deviceName ?? null },
    output: result,
  })
}

// ===========================================================================
// 9. Room descriptor - the room's forwarder and ICE config, encrypted to the
//    room key (src/descriptor.ts).
//
//    The claim these vectors pin is narrow and load-bearing: a forwarder
//    entry names a url, optionally a pubkey, optionally a label, and NOTHING
//    ELSE. A forwarder is given the room *id*; it is never given the room
//    *key*. A second implementation that decodes a descriptor by copying the
//    JSON object through - rather than projecting each entry onto those three
//    fields - passes every other vector here and fails
//    'forwarder-extra-fields-stripped', which is exactly why that vector
//    exists.
// ===========================================================================

function buildDescriptor({ descriptor, roomId, roomKey, deviceSk, nonceLabel, auxRandLabel }) {
  const nonce = seed32(nonceLabel)
  const auxRand = seed32(auxRandLabel)
  const content = nip44.v2.encrypt(JSON.stringify(descriptor), roomKey, nonce)
  const event = finalizeDeterministic({ kind: KINDS.DESCRIPTOR, created_at: descriptor.updatedAt, tags: [['d', roomId]], content }, deviceSk, auxRand)
  return { event, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand) }
}

const descriptorBase = {
  device: fx.DEVICE_A,
  participant: fx.PARTICIPANT_A,
  credential: validCredential.event,
  forwarders: [],
  iceServers: fx.ICE_SERVERS,
  updatedAt: fx.NOW,
}

for (const [name, note, forwarders] of [
  [
    'no-forwarders',
    'A room that names no forwarder at all - the ordinary case for a small mesh. The empty list is explicit on the wire, not an absent field, so a reader never has to guess whether the room has forwarders or the publisher forgot to say.',
    [],
  ],
  [
    'one-forwarder',
    "One forwarder, named by url and pubkey. The pubkey is the forwarder's own Nostr key - it identifies the forwarder, and grants it nothing.",
    [{ url: fx.FORWARDER_URL_A, pubkey: fx.FORWARDER_A, label: 'Community box' }],
  ],
  [
    'several-forwarders',
    'Three forwarders with different fields present: url+pubkey, url+label, url alone. All three fields except url are optional and an absent one must stay absent, not become an empty string or a null.',
    [
      { url: fx.FORWARDER_URL_A, pubkey: fx.FORWARDER_A },
      { url: fx.FORWARDER_URL_B, label: "Somebody's fat uplink" },
      { url: fx.FORWARDER_URL_LOCAL },
    ],
  ],
]) {
  const descriptor = { ...descriptorBase, forwarders }
  const built = buildDescriptor({
    descriptor,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: `descriptor-${name}-nonce`,
    auxRandLabel: `descriptor-${name}-auxrand`,
  })
  vectors.roomDescriptor.push({
    name,
    kind: 'positive',
    note,
    input: {
      descriptor,
      roomId: ROOM_1.roomId,
      roomKeyHex: bytesToHex(ROOM_1.roomKey),
      deviceSkHex: bytesToHex(fx.DEVICE_A_SK),
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      decode: { roomId: ROOM_1.roomId, now: fx.NOW },
      result: decodeDescriptorEvent(built.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  // The one that matters. The plaintext here carries a forwarder entry with
  // two extra fields, one of them holding the room key itself - the exact
  // mistake a well-meaning implementation makes when it treats the forwarder
  // list as "config" and serialises whatever the caller handed it. A
  // conforming decoder projects the entry onto url/pubkey/label and the
  // extras are gone; a decoder that copies the object through hands its
  // caller the room key with a forwarder's name on it.
  const leaky = {
    ...descriptorBase,
    forwarders: [
      {
        url: fx.FORWARDER_URL_A,
        pubkey: fx.FORWARDER_A,
        label: 'Community box',
        roomKey: bytesToHex(ROOM_1.roomKey),
        note: 'should never survive decoding',
      },
    ],
  }
  const built = buildDescriptor({
    descriptor: leaky,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'descriptor-leaky-nonce',
    auxRandLabel: 'descriptor-leaky-auxrand',
  })
  vectors.roomDescriptor.push({
    name: 'forwarder-extra-fields-stripped',
    kind: 'positive',
    note: 'The descriptor decodes, but the forwarder entry does not survive intact: a conforming decoder projects each entry onto url/pubkey/label, so the roomKey and note fields this one carries are dropped. A decoder that passes the JSON object through instead will return them, and will have handed a forwarder reference the room key.',
    input: {
      descriptor: leaky,
      roomId: ROOM_1.roomId,
      roomKeyHex: bytesToHex(ROOM_1.roomKey),
      deviceSkHex: bytesToHex(fx.DEVICE_A_SK),
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      decode: { roomId: ROOM_1.roomId, now: fx.NOW },
      result: decodeDescriptorEvent(built.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}

{
  const oneForwarder = vectors.roomDescriptor.find((v) => v.name === 'one-forwarder')
  vectors.roomDescriptor.push({
    name: 'wrong-room-key',
    kind: 'negative',
    note: "The one-forwarder descriptor decrypted with room 2's key - NIP-44's MAC check fails and the decoder must return null, not throw. A relay, or a forwarder, holds neither key and so learns nothing from either.",
    input: { event: oneForwarder.output.event, decode: { roomId: ROOM_1.roomId, roomKeyHex: bytesToHex(ROOM_2.roomKey), now: fx.NOW } },
    output: { result: decodeDescriptorEvent(oneForwarder.output.event, { roomId: ROOM_1.roomId, roomKey: ROOM_2.roomKey, now: fx.NOW }) },
  })
}

{
  // Repointing the room at your own forwarder while wearing somebody else's
  // name. Everyone in the room holds the room key, so encrypting a
  // descriptor proves nothing about who wrote it; only the credential does.
  const descriptor = { ...descriptorBase, forwarders: [{ url: fx.FORWARDER_URL_LOCAL, pubkey: fx.FORWARDER_B }] }
  const built = buildDescriptor({
    descriptor,
    roomId: ROOM_1.roomId,
    roomKey: ROOM_1.roomKey,
    deviceSk: fx.DEVICE_IMPOSTOR_SK,
    nonceLabel: 'descriptor-impostor-nonce',
    auxRandLabel: 'descriptor-impostor-auxrand',
  })
  vectors.roomDescriptor.push({
    name: 'wrong-signing-device',
    kind: 'negative',
    note: "A descriptor naming DEVICE_A, correctly encrypted to the room key, but signed by a device holding no credential for this room - a member repointing the room at its own forwarder under somebody else's name. Holding the room key is not authority to rewrite the room's config; the credential is.",
    input: {
      descriptor,
      roomId: ROOM_1.roomId,
      roomKeyHex: bytesToHex(ROOM_1.roomKey),
      deviceSkHex: bytesToHex(fx.DEVICE_IMPOSTOR_SK),
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: {
      event: built.event,
      result: decodeDescriptorEvent(built.event, { roomId: ROOM_1.roomId, roomKey: ROOM_1.roomKey, now: fx.NOW }),
    },
  })
}


// ===========================================================================
// Room epochs: removing a member by moving the room, not by asking nicely
// ===========================================================================
//
// Link rotation retires a rendezvous; it cannot remove anybody, because
// everybody admitted holds the room key. Removal is therefore a new key that
// the removed are not given: the authority - the root inviter, the only key
// a member believes for this - publishes a rekey naming the next epoch, with
// the successor secret sealed once per device that stays.
//
// Two things are worth reading twice. The ROOM ID does not move: a device
// credential binds to it, and a room whose id changed would invalidate every
// credential in it. What moves is the `d` tag events are published under and
// the key they are encrypted to, both derived from the epoch number. And
// epoch 0 is byte-identical to a room with no epochs at all, so every vector
// in every other group above remains exactly what this room looks like
// before anybody is removed.
{
  const room = deriveRoom(fx.ROOM_SECRET_1)
  for (const [name, epoch, secret, note] of [
    [
      'epoch-zero-is-the-room',
      0,
      fx.ROOM_SECRET_1,
      'Epoch 0 is not a special case bolted on: it derives to exactly what `deriveRoom` derives, with the same two HKDF info strings and no salt. A client that has never heard of epochs and one that has agree byte for byte on a room nobody has been removed from, which is what makes the whole mechanism additive.',
    ],
    [
      'epoch-one',
      1,
      fx.ROOM_SECRET_1,
      'The first successor. `id = HKDF-SHA256(ikm = secret, info = "kithmoot/v1/epoch-id/1", 32)` as hex and `key = HKDF-SHA256(ikm = secret, info = "kithmoot/v1/epoch-key/1", 32)`, no salt. The secret is the one the rekey sealed to each remaining device - NOT the original room secret, which the removed device still holds and which now opens nothing.',
    ],
    [
      'epoch-two',
      2,
      fx.EPOCH_SECRET_1,
      'A second removal from a room already at epoch 1: a fresh secret again, and the info strings carry the number so two epochs of one room never collide.',
    ],
  ]) {
    const keys = deriveEpoch({ epoch, secret })
    vectors.roomEpoch.push({
      name,
      kind: 'positive',
      note,
      input: { epoch, secretHex: bytesToHex(secret) },
      output: { id: keys.id, keyHex: bytesToHex(keys.key), epoch: keys.epoch },
    })
  }

  // --- A rekey event -----------------------------------------------------
  const current = deriveEpoch({ epoch: 0, secret: fx.ROOM_SECRET_1 })
  const next = { epoch: 1, secret: fx.EPOCH_SECRET_1 }

  function buildRekey({ authoritySk, current, next, recipients, removed, by, closed, createdAt, nonceLabel, auxRandLabel, sealLabel }) {
    const keys = {}
    if (!closed) {
      for (const [i, device] of recipients.entries()) {
        const conversation = nip44.v2.utils.getConversationKey(authoritySk, device)
        keys[device] = nip44.v2.encrypt(
          JSON.stringify({ v: 1, secret: base64urlnopad.encode(next.secret) }),
          conversation,
          seed32(`${sealLabel}-${i}`),
        )
      }
    }
    const body = {
      v: 1,
      epoch: next.epoch,
      removed: [...new Set(removed.map((d) => d.toLowerCase()))].sort(),
      ...(by ? { by } : {}),
      ...(closed ? { closed: true } : {}),
      keys,
    }
    const event = finalizeDeterministic(
      {
        kind: KINDS.ROOM_REKEY,
        created_at: createdAt,
        tags: [
          ['d', room.roomId],
          ['epoch', String(next.epoch)],
        ],
        content: nip44.v2.encrypt(JSON.stringify(body), current.key, seed32(nonceLabel)),
      },
      authoritySk,
      seed32(auxRandLabel),
    )
    return { event, nonceHex: bytesToHex(seed32(nonceLabel)), auxRandHex: bytesToHex(seed32(auxRandLabel)) }
  }

  const rekey = buildRekey({
    authoritySk: fx.AUTHORITY_SK,
    current,
    next,
    recipients: [fx.KEPT_DEVICE],
    removed: [fx.REMOVED_DEVICE],
    by: fx.PARTICIPANT_A,
    createdAt: fx.REKEY_CREATED_AT,
    nonceLabel: 'rekey-1-nonce',
    auxRandLabel: 'rekey-1-auxrand',
    sealLabel: 'rekey-1-seal',
  })
  const decodeArgs = {
    roomId: room.roomId,
    authority: fx.AUTHORITY,
    current: { epoch: 0, id: current.id, keyHex: bytesToHex(current.key) },
  }
  /** A notice as JSON: the secret is bytes, and bytes do not survive
   *  JSON.stringify as anything a reader could use. */
  const noticeJson = (notice) =>
    notice === null
      ? null
      : { ...notice, secret: undefined, ...(notice.secret ? { secretHex: bytesToHex(notice.secret) } : {}) }

  const keptResult = noticeJson(
    decodeRekeyEvent(rekey.event, { roomId: room.roomId, authority: fx.AUTHORITY, current, deviceSk: fx.KEPT_DEVICE_SK }),
  )
  vectors.roomEpoch.push({
    name: 'rekey',
    kind: 'positive',
    note: 'The authority moves the room to epoch 1 and removes one device. Encrypted to the epoch being LEFT, so everybody currently in the room can read who left; the successor secret inside is sealed separately to each device that stays, under a NIP-44 conversation key between the authority and that device, so the removed device reads the notice and not the secret. `peekRekeyEvent` answers "which epoch is this" with no key at all, which is how a device that has fallen behind knows it has.',
    input: {
      event: rekey.event,
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      currentEpoch: 0,
      currentKeyHex: bytesToHex(current.key),
      next: { epoch: next.epoch, secretHex: bytesToHex(next.secret) },
      recipients: [fx.KEPT_DEVICE],
      removed: [fx.REMOVED_DEVICE],
      by: fx.PARTICIPANT_A,
      createdAt: fx.REKEY_CREATED_AT,
      nonceHex: rekey.nonceHex,
      sealNonceHex: bytesToHex(seed32('rekey-1-seal-0')),
      auxRandHex: rekey.auxRandHex,
    },
    output: { peek: peekRekeyEvent(rekey.event, { roomId: room.roomId, authority: fx.AUTHORITY }), result: keptResult },
    expected: {
      decode: { ...decodeArgs, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK) },
      result: keptResult,
    },
  })

  const removedResult = noticeJson(
    decodeRekeyEvent(rekey.event, { roomId: room.roomId, authority: fx.AUTHORITY, current, deviceSk: fx.REMOVED_DEVICE_SK }),
  )
  vectors.roomEpoch.push({
    name: 'rekey-read-by-the-removed-device',
    kind: 'positive',
    note: 'The same event, decoded by the device it removes. It decodes - the notice is encrypted to the epoch that device still holds - and it carries no `secret`, because no copy was sealed to it. A client must treat "decoded, no secret" as "you are out", not as an error: it is how a removed member learns it has been removed, and it is the only notice it will get.',
    input: { event: rekey.event },
    output: { result: removedResult },
    expected: { decode: { ...decodeArgs, deviceSkHex: bytesToHex(fx.REMOVED_DEVICE_SK) }, result: removedResult },
  })

  const closed = buildRekey({
    authoritySk: fx.AUTHORITY_SK,
    current,
    next: { epoch: 1, secret: fx.EPOCH_SECRET_2 },
    recipients: [],
    removed: [],
    closed: true,
    createdAt: fx.REKEY_CREATED_AT,
    nonceLabel: 'rekey-closed-nonce',
    auxRandLabel: 'rekey-closed-auxrand',
    sealLabel: 'rekey-closed-seal',
  })
  const closedResult = noticeJson(
    decodeRekeyEvent(closed.event, { roomId: room.roomId, authority: fx.AUTHORITY, current, deviceSk: fx.KEPT_DEVICE_SK }),
  )
  vectors.roomEpoch.push({
    name: 'rekey-closed',
    kind: 'positive',
    note: 'Closing a room is a rekey with no sealed copies at all: the epoch advances and nobody is given the successor, so nothing further can be published or read. `closed` is inside the ciphertext and is only a JSON `true`; the empty `keys` object is what actually closes the room, and a client that ignored the flag would still find itself with no key.',
    input: { event: closed.event },
    output: { result: closedResult },
    expected: { decode: { ...decodeArgs, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK) }, result: closedResult },
  })

  // Negatives.
  const impostor = buildRekey({
    authoritySk: fx.HOST_UNTRUSTED_SK,
    current,
    next,
    recipients: [fx.KEPT_DEVICE],
    removed: [fx.KEPT_DEVICE],
    createdAt: fx.REKEY_CREATED_AT,
    nonceLabel: 'rekey-impostor-nonce',
    auxRandLabel: 'rekey-impostor-auxrand',
    sealLabel: 'rekey-impostor-seal',
  })
  vectors.roomEpoch.push({
    name: 'rekey-not-the-authority',
    kind: 'negative',
    note: 'A perfectly formed rekey, correctly encrypted to the current epoch, signed by a member who is not the room authority - which is to say, by anybody else who holds the room key, which is everybody in the room. It is REFUSED before decryption, on the signing key alone. Without this check any member could remove any other, and "removal" would mean nothing.',
    input: { event: impostor.event, decode: { ...decodeArgs, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK) } },
    output: {
      peek: peekRekeyEvent(impostor.event, { roomId: room.roomId, authority: fx.AUTHORITY }),
      result: decodeRekeyEvent(impostor.event, { roomId: room.roomId, authority: fx.AUTHORITY, current, deviceSk: fx.KEPT_DEVICE_SK }),
    },
  })

  const skipped = buildRekey({
    authoritySk: fx.AUTHORITY_SK,
    current,
    next: { epoch: 3, secret: fx.EPOCH_SECRET_2 },
    recipients: [fx.KEPT_DEVICE],
    removed: [fx.REMOVED_DEVICE],
    createdAt: fx.REKEY_CREATED_AT,
    nonceLabel: 'rekey-skipped-nonce',
    auxRandLabel: 'rekey-skipped-auxrand',
    sealLabel: 'rekey-skipped-seal',
  })
  vectors.roomEpoch.push({
    name: 'rekey-skips-an-epoch',
    kind: 'negative',
    note: 'The authority naming epoch 3 while this device is at epoch 0. Refused: only the very next epoch is applied, so a device cannot be walked forward past a removal it never saw, and a replayed rekey from an epoch already passed cannot move it backwards either. `peekRekeyEvent` still answers 3, which is how a client knows it is behind and should ask.',
    input: { event: skipped.event, decode: { ...decodeArgs, deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK) } },
    output: {
      peek: peekRekeyEvent(skipped.event, { roomId: room.roomId, authority: fx.AUTHORITY }),
      result: decodeRekeyEvent(skipped.event, { roomId: room.roomId, authority: fx.AUTHORITY, current, deviceSk: fx.KEPT_DEVICE_SK }),
    },
  })

  // --- The admin list, signed -------------------------------------------
  const admins = [fx.PARTICIPANT_A, fx.GUEST]
  // Signed by hand with a recorded aux-rand: `signAdmins` signs with random
  // aux-rand, which is right for production and fatal for a frozen vector.
  // The message is built exactly as `signAdmins` builds it, and the result
  // is handed to the real `verifyAdmins` below before it is written out.
  const adminsMessageHex = `kithmoot/v1/admins:${room.roomId}:1:${canonicalAdmins(admins).join(',')}`
  const adminsAuxRand = seed32('admins-1-auxrand')
  const adminsSig = bytesToHex(schnorr.sign(sha256(utf8Bytes(adminsMessageHex)), fx.AUTHORITY_SK, adminsAuxRand))
  vectors.roomEpoch.push({
    name: 'admins-signature',
    kind: 'positive',
    note: 'Who may remove somebody, said by the authority and checkable by everybody. The message is `sha256("kithmoot/v1/admins:<roomId>:<epoch>:<admins joined by comma>")` over the CANONICAL list - lower-cased, deduplicated, sorted - so two clients that hold the same set in different orders verify the same signature. The epoch is inside the message, so a list signed for one epoch does not authorise anybody after the next removal.',
    input: {
      roomId: room.roomId,
      epoch: 1,
      admins,
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      canonicalMessage: adminsMessageHex,
      auxRandHex: bytesToHex(adminsAuxRand),
    },
    output: { canonical: canonicalAdmins(admins), sig: adminsSig },
    expected: {
      verify: { roomId: room.roomId, epoch: 1, admins, authority: fx.AUTHORITY },
      result: verifyAdmins({ roomId: room.roomId, epoch: 1, admins, sig: adminsSig, authority: fx.AUTHORITY }),
    },
  })
  vectors.roomEpoch.push({
    name: 'admins-signature-another-epoch',
    kind: 'negative',
    note: 'The same signature, offered for epoch 2. Refused: a list is authorised for the epoch it names and no other, so an admin set from before a removal cannot be replayed to re-authorise somebody after it.',
    input: { roomId: room.roomId, epoch: 2, admins, sig: adminsSig, authority: fx.AUTHORITY },
    output: { result: verifyAdmins({ roomId: room.roomId, epoch: 2, admins, sig: adminsSig, authority: fx.AUTHORITY }) },
  })
}

// ===========================================================================
// Whose agent is this
// ===========================================================================
//
// A principal signs, once, that an agent is theirs. Deliberately room
// independent: the same proof rides in every room that agent joins, so a
// person does not re-sign for every moot. It is not revocable except by
// expiry, which is why the vectors below pin the expiry rules as hard as the
// signature.
{
    const utf8 = utf8Bytes

  function buildOwnership({ principalSk, agent, issuedAt, expiresAt, label, auxRandLabel }) {
    const canonical = `kithmoot/v1/agent-owner:${agent}:${getPublicKey(principalSk)}:${issuedAt}:${expiresAt ?? ''}:${label ?? ''}`
    const message = sha256(utf8(canonical))
    const auxRand = seed32(auxRandLabel)
    return {
      canonical,
      proof: {
        agent,
        principal: getPublicKey(principalSk),
        issuedAt,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(label !== undefined ? { label } : {}),
        sig: bytesToHex(schnorr.sign(message, principalSk, auxRand)),
      },
      auxRandHex: bytesToHex(auxRand),
    }
  }

  const plain = buildOwnership({
    principalSk: fx.PRINCIPAL_SK,
    agent: fx.AGENT,
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    auxRandLabel: 'ownership-plain',
  })
  vectors.agentOwnership.push({
    name: 'valid',
    kind: 'positive',
    note: 'The smallest honest proof: an agent pubkey, a principal pubkey, when it was issued, and a BIP-340 signature over `sha256("kithmoot/v1/agent-owner:<agent>:<principal>:<issuedAt>:<expiresAt>:<label>")`. Note the two empty fields: an absent expiry and an absent label are the EMPTY STRING in the signed message, not omitted, so a proof with no expiry and one whose expiry is the empty string cannot be made to collide.',
    input: { ...plain.proof, canonicalMessage: plain.canonical, principalSkHex: bytesToHex(fx.PRINCIPAL_SK), auxRandHex: plain.auxRandHex },
    output: { proof: plain.proof },
    expected: {
      verify: { agent: fx.AGENT, now: fx.NOW },
      result: verifyAgentOwnership(plain.proof, { agent: fx.AGENT, now: fx.NOW }),
    },
  })

  const labelled = buildOwnership({
    principalSk: fx.PRINCIPAL_SK,
    agent: fx.AGENT,
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    expiresAt: fx.OWNERSHIP_EXPIRES_AT,
    label: fx.OWNERSHIP_LABEL,
    auxRandLabel: 'ownership-labelled',
  })
  vectors.agentOwnership.push({
    name: 'with-expiry-and-label',
    kind: 'positive',
    note: 'The same proof with a horizon and a human label. The label is sanitised BEFORE it is signed, so what a reader renders is what the principal actually put their name to - and a reader must re-sanitise and compare, which is the `label-not-as-signed` negative below.',
    input: { ...labelled.proof, canonicalMessage: labelled.canonical, auxRandHex: labelled.auxRandHex },
    output: { proof: labelled.proof },
    expected: {
      verify: { agent: fx.AGENT, now: fx.NOW },
      result: verifyAgentOwnership(labelled.proof, { agent: fx.AGENT, now: fx.NOW }),
    },
  })

  vectors.agentOwnership.push({
    name: 'names-another-agent',
    kind: 'negative',
    note: 'A genuine, correctly signed proof presented for a DIFFERENT agent - the exact move an agent would make to borrow somebody else standing. The check is against the agent whose roster entry or chat message carries it, never against the agent named inside, so the proof is refused with `names another agent`.',
    input: { proof: plain.proof, verify: { agent: fx.GUEST, now: fx.NOW } },
    output: { result: verifyAgentOwnership(plain.proof, { agent: fx.GUEST, now: fx.NOW }) },
  })

  const expired = buildOwnership({
    principalSk: fx.PRINCIPAL_SK,
    agent: fx.AGENT,
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    expiresAt: fx.OWNERSHIP_EXPIRED_AT,
    auxRandLabel: 'ownership-expired',
  })
  vectors.agentOwnership.push({
    name: 'expired',
    kind: 'negative',
    note: 'Signed properly and out of date. Expiry is the only revocation this proof has, so it is checked strictly: `expiresAt <= now` is expired, not "expired a moment ago is fine".',
    input: { proof: expired.proof, verify: { agent: fx.AGENT, now: fx.NOW } },
    output: { result: verifyAgentOwnership(expired.proof, { agent: fx.AGENT, now: fx.NOW }) },
  })

  const hostileLabel = buildOwnership({
    principalSk: fx.PRINCIPAL_SK,
    agent: fx.AGENT,
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    label: 'Ada‮ evil',
    auxRandLabel: 'ownership-hostile-label',
  })
  vectors.agentOwnership.push({
    name: 'label-not-as-signed',
    kind: 'negative',
    note: 'A label carrying a right-to-left override, signed exactly as written. The signature verifies; the proof does not. A reader sanitises the label and refuses when the result differs from what was signed, because otherwise a principal could sign one thing and every reader would render another. `label is not as signed` is the reason.',
    input: { proof: hostileLabel.proof, verify: { agent: fx.AGENT, now: fx.NOW } },
    output: { result: verifyAgentOwnership(hostileLabel.proof, { agent: fx.AGENT, now: fx.NOW }) },
  })

  const selfOwned = buildOwnership({
    principalSk: fx.AGENT_SK,
    agent: fx.AGENT,
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    auxRandLabel: 'ownership-self',
  })
  vectors.agentOwnership.push({
    name: 'its-own-principal',
    kind: 'negative',
    note: 'An agent signing for itself, which is a valid signature over a meaningless claim: the whole point of the proof is that somebody ELSE vouched. Refused on the two keys being equal, before the signature is even checked.',
    input: { proof: selfOwned.proof, verify: { agent: fx.AGENT, now: fx.NOW } },
    output: { result: verifyAgentOwnership(selfOwned.proof, { agent: fx.AGENT, now: fx.NOW }) },
  })

  const forged = { ...plain.proof, sig: 'ff'.repeat(64) }
  vectors.agentOwnership.push({
    name: 'bad-signature',
    kind: 'negative',
    note: 'Every field right and the signature wrong. Checked last, because it is the expensive one, but checked.',
    input: { proof: forged, verify: { agent: fx.AGENT, now: fx.NOW } },
    output: { result: verifyAgentOwnership(forged, { agent: fx.AGENT, now: fx.NOW }) },
  })

  const messy = {
    principal: fx.PRINCIPAL.toUpperCase(),
    label: 'kept',
    agent: fx.AGENT.toUpperCase(),
    sig: plain.proof.sig.toUpperCase(),
    issuedAt: fx.OWNERSHIP_ISSUED_AT,
    junk: 'dropped',
  }
  vectors.agentOwnership.push({
    name: 'normalised-shape',
    kind: 'positive',
    note: 'What a reader must make of an ownership proof off the wire before it verifies anything: keys lower-cased, unknown fields dropped, and the surviving fields written back in a fixed order - `agent, principal, issuedAt, sig, expiresAt, label`. This is the order the roster and chat encoders re-serialise, so an implementation that keeps the sender order produces different bytes for the same proof.',
    input: { raw: messy },
    output: { result: normaliseAgentOwnership(messy) },
  })
}


// ===========================================================================
// A Wildbloom file riding with a chat message
// ===========================================================================
//
// What crosses the wire is four hex strings and a URL, inside the room-key
// ciphertext: which file event, where the sealed envelope is served, the
// hash of exactly those bytes, and the recovery key that opens them. The
// bytes themselves are on a Blossom server that never sees the key, and the
// key is in the chat and nowhere else - which is the whole design, and why
// the normalisation rules below are a security boundary rather than tidying.
{
  const room = deriveRoom(fx.ROOM_SECRET_1)
  const credential = buildCredential({
    participantSk: fx.PARTICIPANT_A_SK,
    devicePubkey: fx.DEVICE_A,
    roomId: room.roomId,
    createdAt: fx.CREDENTIAL_CREATED_AT,
    expiresAt: fx.CREDENTIAL_EXPIRES_AT,
    auxRandLabel: 'attachment-credential',
  })

  function buildChat({ message, roomId, roomKey, deviceSk, nonceLabel, auxRandLabel }) {
    const content = nip44.v2.encrypt(JSON.stringify(message), roomKey, seed32(nonceLabel))
    const event = finalizeDeterministic(
      { kind: KINDS.CHAT, created_at: message.sentAt, tags: [['d', roomId]], content },
      deviceSk,
      seed32(auxRandLabel),
    )
    return { event, nonceHex: bytesToHex(seed32(nonceLabel)), auxRandHex: bytesToHex(seed32(auxRandLabel)) }
  }

  const attachment = {
    event: fx.ATTACHMENT_EVENT_ID,
    url: fx.ATTACHMENT_URL,
    sha256: fx.ATTACHMENT_SHA256,
    key: fx.ATTACHMENT_KEY,
    name: 'minutes.pdf',
    type: 'application/pdf',
    size: 131_072,
  }
  const withAttachment = buildChat({
    message: {
      id: 'attachment-message-1',
      participant: fx.PARTICIPANT_A,
      device: fx.DEVICE_A,
      credential: credential.event,
      text: 'the minutes, sealed',
      sentAt: fx.ATTACHMENT_CREATED_AT,
      attachments: [attachment],
    },
    roomId: room.roomId,
    roomKey: room.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'chat-attachment-nonce',
    auxRandLabel: 'chat-attachment-auxrand',
  })
  const decodeArgs = { roomId: room.roomId, roomKeyHex: bytesToHex(room.roomKey), now: fx.NOW }
  const decoded = decodeChatEvent(withAttachment.event, { roomId: room.roomId, roomKey: room.roomKey, now: fx.NOW })
  vectors.chatAttachment.push({
    name: 'chat-with-attachment',
    kind: 'positive',
    note: 'One share on one message. Everything that matters is inside the ciphertext: a relay carrying this sees a chat event for a room id and nothing about a file, and the Blossom server that holds the bytes sees a hash being fetched and never the key. `name`, `type` and `size` are the sender\'s hints for rendering before the envelope is opened; the envelope carries its own metadata and that is the authority.',
    input: { event: withAttachment.event, nonceHex: withAttachment.nonceHex, auxRandHex: withAttachment.auxRandHex },
    output: { result: decoded },
    expected: { decode: decodeArgs, result: decoded },
  })

  const messy = buildChat({
    message: {
      id: 'attachment-message-2',
      participant: fx.PARTICIPANT_A,
      device: fx.DEVICE_A,
      credential: credential.event,
      text: 'two of these are not shares',
      sentAt: fx.ATTACHMENT_CREATED_AT,
      attachments: [
        { ...attachment, url: 'http://kithmoot.example/blossom/' + fx.ATTACHMENT_SHA256 },
        { ...attachment, key: 'not-a-key' },
        { ...attachment, name: 'quarterly‮report.pdf', type: 'APPLICATION/PDF', size: 12.5 },
      ],
    },
    roomId: room.roomId,
    roomKey: room.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'chat-attachment-messy-nonce',
    auxRandLabel: 'chat-attachment-messy-auxrand',
  })
  const messyResult = decodeChatEvent(messy.event, { roomId: room.roomId, roomKey: room.roomKey, now: fx.NOW })
  vectors.chatAttachment.push({
    name: 'attachments-a-reader-must-defuse',
    kind: 'positive',
    note: 'Three attachments from a client that checked nothing. The first is served over plain HTTP and is DROPPED - a share is https or it is not a share, because the URL is fetched by the browser and a downgrade is a downgrade. The second has a key that is not 32 bytes of hex and is dropped. The third survives with its name defused (the right-to-left override goes), its media type lower-cased, and its non-integer size dropped. The MESSAGE is kept throughout: a bad attachment costs the attachment, never the sentence somebody wrote.',
    input: { event: messy.event },
    output: { result: messyResult },
    expected: { decode: decodeArgs, result: messyResult },
  })

  const tooMany = buildChat({
    message: {
      id: 'attachment-message-3',
      participant: fx.PARTICIPANT_A,
      device: fx.DEVICE_A,
      credential: credential.event,
      text: 'five is too many',
      sentAt: fx.ATTACHMENT_CREATED_AT,
      attachments: [1, 2, 3, 4, 5].map((n) => ({ ...attachment, name: `file-${n}.pdf` })),
    },
    roomId: room.roomId,
    roomKey: room.roomKey,
    deviceSk: fx.DEVICE_A_SK,
    nonceLabel: 'chat-attachment-many-nonce',
    auxRandLabel: 'chat-attachment-many-auxrand',
  })
  vectors.chatAttachment.push({
    name: 'more-attachments-than-a-message-may-carry',
    kind: 'negative',
    note: 'Five shares on one message. The WHOLE MESSAGE is refused rather than the extras being trimmed, and the count is taken as sent rather than after filtering: a cap that silently truncates is a cap an attacker tunes, and one that counts survivors can be walked past with junk entries.',
    input: { event: tooMany.event, decode: decodeArgs },
    output: { result: decodeChatEvent(tooMany.event, { roomId: room.roomId, roomKey: room.roomKey, now: fx.NOW }) },
  })

  // --- The envelope's own arithmetic ------------------------------------
  vectors.chatAttachment.push({
    name: 'envelope-key-derivation',
    kind: 'positive',
    note: 'The recovery key in the chat is not the AES key: the AES key is `HKDF-SHA256(ikm = recovery key, salt = the envelope header salt, info = "forgesworn-aes-256-gcm-chunked/v2", 32)`. The salt is in the header of the envelope being opened, so the same recovery key opens exactly one envelope and knowing it tells you nothing about another.',
    input: { recoveryKeyHex: fx.ATTACHMENT_KEY, saltHex: bytesToHex(fx.ATTACHMENT_SALT) },
    output: { keyHex: bytesToHex(deriveEnvelopeKey(hexToBytesLocal(fx.ATTACHMENT_KEY), fx.ATTACHMENT_SALT)) },
  })

  vectors.chatAttachment.push({
    name: 'padded-plaintext-length',
    kind: 'positive',
    note: 'What an envelope\'s length is allowed to say about the file inside it. Everything up to 64 KiB is padded to 64 KiB; up to a mebibyte, to the next power of two; beyond that, to the next whole mebibyte. A watcher who can see only the size of an upload therefore learns a bucket rather than a fingerprint.',
    input: { lengths: [0, 1, 65_536, 65_537, 100_000, 1_048_576, 1_048_577, 5_000_000] },
    output: { padded: [0, 1, 65_536, 65_537, 100_000, 1_048_576, 1_048_577, 5_000_000].map(paddedPlaintextLength) },
  })

  vectors.chatAttachment.push({
    name: 'file-event',
    kind: 'positive',
    note: 'The NIP-94 kind-1063 event that announces a sealed envelope: tags in a fixed order, `x` and `ox` both the hash of the served bytes, the media type the opaque envelope type rather than the file\'s own, and an `alt` that says nothing about the contents. Deterministic given the url, hash, size and time, so two implementations announcing the same upload produce the same event.',
    input: { url: fx.ATTACHMENT_URL, sha256: fx.ATTACHMENT_SHA256, size: 131_072, now: fx.ATTACHMENT_CREATED_AT },
    output: { template: buildFileEvent({ url: fx.ATTACHMENT_URL, sha256: fx.ATTACHMENT_SHA256, size: 131_072 }, fx.ATTACHMENT_CREATED_AT) },
  })

  vectors.chatAttachment.push({
    name: 'upload-authorisation',
    kind: 'positive',
    note: 'The kind-24242 Blossom authorisation an uploader signs: bound to one hash and one server, expiring ninety seconds later, and stamped a second early so a server whose clock is a moment behind does not refuse a fresh one.',
    input: { sha256: fx.ATTACHMENT_SHA256, server: 'https://kithmoot.example', now: fx.ATTACHMENT_CREATED_AT },
    output: { template: buildUploadAuthorisation(fx.ATTACHMENT_SHA256, 'https://kithmoot.example', fx.ATTACHMENT_CREATED_AT) },
  })
}

// ===========================================================================
// Approvals: an agent asking, and what counts as an answer
// ===========================================================================
//
// The request and the answer are ordinary chat messages on the room's
// `control` channel, so attribution is the chat message's credential-bound
// participant and nothing inside the JSON names a sender. What makes an
// answer count is decided by the agent, not the codec: only an admin the
// authority signed for, or the agent's own principal, and only an option the
// question actually offered.
{
  const request = { op: 'approval-request', id: 'spend-1', text: 'Publish the minutes to the town hall room?', options: ['approve', 'decline'], expiresAt: fx.NOW + 600 }
  vectors.approvalControl.push({
    name: 'approval-request',
    kind: 'positive',
    note: 'A question, its options and its horizon. The id is what an answer refers to; the options are what an answer may say, exactly, case-sensitively. Encoded as JSON in the text of a chat message on the `control` channel, so everybody in the room can read both the question and every answer to it - an agent asking permission in private would not be asking permission.',
    input: { message: request },
    output: { text: encodeControl(request), result: decodeControl(encodeControl(request)) },
  })

  const noOptions = { op: 'approval-request', id: 'spend-2', text: 'Delete the room?' }
  vectors.approvalControl.push({
    name: 'approval-request-without-options',
    kind: 'positive',
    note: 'Options are optional on the wire; a reader keeps the message as sent, with no options field. The default pair - approve and decline - is applied by the agent that asked, not by the decoder, so a decoder never invents an option the asker did not offer.',
    input: { message: noOptions },
    output: { text: encodeControl(noOptions), result: decodeControl(encodeControl(noOptions)) },
  })

  const answer = { op: 'approval', id: 'spend-1', verdict: 'approve', note: 'go ahead' }
  vectors.approvalControl.push({
    name: 'approval',
    kind: 'positive',
    note: 'An answer names the question it answers and says one of its options. Nothing here says who answered: that is the chat message\'s participant, bound to a device credential, which is the only attribution that cannot be typed by somebody else.',
    input: { message: answer },
    output: { text: encodeControl(answer), result: decodeControl(encodeControl(answer)) },
  })

  const dupes = { op: 'approval-request', id: 'spend-3', text: 'Which?', options: ['yes', 'no', 'yes', 'maybe'] }
  vectors.approvalControl.push({
    name: 'approval-request-duplicate-options',
    kind: 'positive',
    note: 'Repeated options are deduplicated in the order they were first offered, and NOT sorted or lower-cased: an option list is a menu a person reads, so the order is the asker\'s and the comparison against a verdict is exact.',
    input: { message: dupes },
    output: { text: encodeControl(dupes), result: decodeControl(encodeControl(dupes)) },
  })

  for (const [name, text, note] of [
    [
      'approval-verdict-with-a-newline',
      JSON.stringify({ op: 'approval', id: 'spend-1', verdict: 'approve\nand pay' }),
      'A verdict carrying a newline, which a renderer might show as one word and a comparison might treat as another. Refused whole: a verdict is a short token from a fixed alphabet, and anything else is not an answer.',
    ],
    [
      'approval-request-option-list-too-long',
      JSON.stringify({ op: 'approval-request', id: 'spend-4', text: 'Pick', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
      'Nine options where eight is the cap. Refused whole rather than trimmed, for the same reason the attachment cap refuses the message: a limit that silently drops the tail is a limit an attacker aims at.',
    ],
    [
      'approval-request-id-that-is-a-path',
      JSON.stringify({ op: 'approval-request', id: '../../etc/passwd', text: 'Read this?' }),
      'An id is a short token, not a name a reader might resolve against anything. Refused.',
    ],
    [
      'not-a-control-message',
      'have you seen the minutes?',
      'Somebody typing into the control channel by hand. It is a perfectly good chat message and not a control message, and a reader must treat it as the former: the channel is a place in the room, and people can write there.',
    ],
  ]) {
    vectors.approvalControl.push({
      name,
      kind: 'negative',
      note,
      input: { text },
      output: { result: decodeControl(text) },
    })
  }

  const room = deriveRoom(fx.ROOM_SECRET_1)
  const admins = [fx.PARTICIPANT_A, fx.GUEST]
  // Hand-built with a recorded aux-rand, for the same reason the
  // `roomEpoch/admins-signature` vector is: a frozen file cannot carry a
  // signature that changes on every run.
  const announcedSig = bytesToHex(
    schnorr.sign(
      sha256(utf8Bytes(`kithmoot/v1/admins:${room.roomId}:1:${canonicalAdmins(admins).join(',')}`)),
      fx.AUTHORITY_SK,
      seed32('admins-announcement-auxrand'),
    ),
  )
  const adminsMessage = { op: 'admins', host: fx.PARTICIPANT_A, admins, epoch: 1, sig: announcedSig }
  vectors.approvalControl.push({
    name: 'admins-announcement',
    kind: 'positive',
    note: 'Who may answer an approval, announced on the same channel. ANY member may publish this op - the channel is the room\'s - and only the authority\'s signature over the canonical list makes it believed, which is what the `roomEpoch/admins-signature` vector pins. A reader that took the list on the word of whoever sent it would let any member appoint themselves.',
    input: { message: adminsMessage, roomId: room.roomId, authority: fx.AUTHORITY, auxRandHex: bytesToHex(seed32('admins-announcement-auxrand')) },
    output: { text: encodeControl(adminsMessage), result: decodeControl(encodeControl(adminsMessage)) },
  })
}

// ===========================================================================
// Write out
// ===========================================================================

const document = {
  protocolVersion: 'kithmoot/v1',
  generatedBy: 'vectors/generate.mjs',
  nostrToolsVersion: '2.23.9',
  groups: vectors,
}

writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`)

const total = Object.values(vectors).reduce((sum, list) => sum + list.length, 0)
console.error(`Wrote ${total} vectors across ${Object.keys(vectors).length} groups to ${outFile}`)
for (const [group, list] of Object.entries(vectors)) {
  console.error(`  ${group}: ${list.length} (${list.filter((v) => v.kind === 'negative').length} negative)`)
}
