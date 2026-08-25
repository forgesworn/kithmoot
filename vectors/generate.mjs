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
import { verifyDeviceCredential } from '../dist/src/credential.js'
import { decodeRosterEvent } from '../dist/src/roster.js'
import { unwrapSignal } from '../dist/src/signal.js'
import { evaluateAccess } from '../dist/src/access.js'
import { mintTurnCredential } from '../dist/src/turn.js'
import { decodeDescriptorEvent } from '../dist/src/descriptor.js'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'kithmoot-vectors.json')

const vectors = { roomDerivation: [], joinUrl: [], deviceCredential: [], rosterEvent: [], signalWrap: [], kindredProof: [], accessEvaluation: [], turnCredential: [], roomDescriptor: [] }

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
