#!/usr/bin/env node
// Generates `vectors/circle-vectors.json` - the wire-compatibility proof for
// the circle-layer gaps identified before extracting KithMoot's circle code
// into a shared kit (see docs/plans/2026-09-28-circle-kit-extraction.md §3.2
// in the girnel repository). This file is separate from
// `vectors/kithmoot-vectors.json` on purpose: running this generator never
// touches that file, so the Android client's contract is untouched.
//
// Same method as `vectors/generate.mjs` (see its header comment for the
// full rationale):
//
//   1. Pure functions with no hidden randomness (`encodeRoomLink`,
//      `parseRoomLink`, `deriveInvitationId`, `deriveEpoch`,
//      `epochRequestAdmission`, `canonicalAdmins`, `canonicalChannels`,
//      `verifyAdmins`, `verifyChannels`, `verifyDeviceCredential`) are
//      called directly from the real, built implementation in `dist/`.
//
//   2. Signing/encrypting functions default to random BIP-340 aux-rand or a
//      random NIP-44 nonce, so they cannot produce the same bytes twice.
//      Those are rebuilt by hand with explicit, recorded randomness, using
//      the same low-level primitives `vectors/lib/determinism.mjs` already
//      exposes (`finalizeDeterministic`, `seed32`, `deriveSecretKey`), and
//      every rebuilt event is then run through the real decode/verify
//      function before being written out.
//
// Two non-exported message shapes are mirrored here, byte for byte, because
// nothing outside their own module has business constructing them: the
// invitation-delegation message (`src/invitation.ts` `delegationMessage`)
// and the admins/channels signature messages (`src/epoch.ts`
// `adminsMessage`/`channelsMessage`, the latter already mirrored in
// `kindredCanonicalMessage`'s spirit). If any of the four disagree with
// their real module, the matching `verifyXxx`/`decodeXxx` assertion below
// fails.
//
// Running this script twice produces byte-identical output: no
// `Date.now()`, no `Math.random()`, no `randomBytes()` below this comment.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hkdf } from '@noble/hashes/hkdf'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { base64urlnopad } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip44 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'

import { deriveSecretKey, finalizeDeterministic, seed32 } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

// The real implementation, built to `dist/` by `npm run build:lib`.
import { KINDS } from '../dist/src/kinds.js'
import { deriveRoom } from '../dist/src/room.js'
import { encodeRoomLink, parseRoomLink } from '../dist/src/link.js'
import {
  deriveInvitationId,
  decodeInvitationRequest,
  decodeRoomAdmissionGrant,
  decodeInvitationRetirementNotice,
  verifyInvitationDelegation,
} from '../dist/src/invitation.js'
import { decodePersistentInvitation } from '../dist/src/persistent-invitation.js'
import { verifyDeviceCredential, PERSON_CREDENTIAL_MAX_SECONDS } from '../dist/src/credential.js'
import {
  deriveEpoch,
  decodeEpochGrant,
  canonicalAdmins,
  verifyAdmins,
  canonicalChannels,
  verifyChannels,
} from '../dist/src/epoch.js'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'circle-vectors.json')

const vectors = {
  linkEnvelope: [],
  invitationEnvelope: [],
  persistentInvitation: [],
  epochGrant: [],
  personCredential: [],
  channelsSignature: [],
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

const BEARER_A = seed32('circle-vectors/bearer-a')
const BEARER_B = seed32('circle-vectors/bearer-b')

const INVITATION_2 = { bearer: BEARER_A, inviter: INVITER_A }
const INVITATION_3 = { bearer: BEARER_B, inviter: INVITER_A, persistent: true }

const BASE_URL = 'https://kithmoot.com/j'
const NOW = fx.NOW
const REQUEST_CREATED_AT = fx.NOW - 30
const GRANT_CREATED_AT = fx.NOW - 10
const RETIREMENT_CREATED_AT = fx.NOW + 100

// ===========================================================================
// 1. Link envelope - v2 (live) and v3 (persistent) round trips, including
//    name, pairing code and access policy together (`src/link.ts:133-149`).
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

// ===========================================================================
// 2. Invitation envelope (v2) - id, request, grant with a delegation chain,
//    the delegation message bytes, and retirement with and without `ended`.
// ===========================================================================

vectors.invitationEnvelope.push({
  name: 'invitation-id-derivation',
  kind: 'positive',
  note: 'The public rendezvous id: HKDF-SHA256 of the bearer alone. Pure - the real function is called directly.',
  input: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
  output: { id: deriveInvitationId(INVITATION_2) },
})

// --- Request (kind 20466) --------------------------------------------------

function buildInvitationRequest({ invitation, requesterSk, createdAt, body, nonceLabel, auxRandLabel }) {
  const requestKeyInfo = 'kithmoot/v2/invitation-request-key'
  const requestKey = (() => {
    // Mirrors `requestKey` in `src/invitation.ts` (not exported): HKDF of the
    // bearer under a fixed info string.
    return hkdfSha256(invitation.bearer, requestKeyInfo)
  })()
  const nonce = seed32(nonceLabel)
  const auxRand = seed32(auxRandLabel)
  const event = finalizeDeterministic(
    {
      kind: KINDS.INVITATION_REQUEST,
      created_at: createdAt,
      tags: [['d', deriveInvitationId(invitation)], ['p', invitation.inviter]],
      content: nip44.v2.encrypt(JSON.stringify(body), requestKey, nonce),
    },
    requesterSk,
    auxRand,
  )
  return { event, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand) }
}

// Small local HKDF helper, mirroring `src/invitation.ts`'s unexported
// `requestKey`/`welcomeKey` shape (HKDF-SHA256, no salt, 32 bytes).
function hkdfSha256(ikm, info) {
  return hkdf(sha256, ikm, undefined, info, 32)
}

{
  const body = { v: 1, device: REQUESTER_A, name: 'Rowan', participant: fx.PARTICIPANT_A }
  const built = buildInvitationRequest({
    invitation: INVITATION_2,
    requesterSk: REQUESTER_A_SK,
    createdAt: REQUEST_CREATED_AT,
    body,
    nonceLabel: 'invitation-request-valid-nonce',
    auxRandLabel: 'invitation-request-valid',
  })
  vectors.invitationEnvelope.push({
    name: 'request-valid',
    kind: 'positive',
    note: 'A request proving possession of the bearer, carrying an asking name and a participant pubkey.',
    input: {
      invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
      requesterSkHex: bytesToHex(REQUESTER_A_SK),
      createdAt: REQUEST_CREATED_AT,
      body,
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      decode: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, now: NOW },
      result: decodeInvitationRequest(built.event, { invitation: INVITATION_2, now: NOW }),
    },
  })
}

{
  const built = buildInvitationRequest({
    invitation: INVITATION_2,
    requesterSk: REQUESTER_A_SK,
    createdAt: REQUEST_CREATED_AT,
    body: { v: 1, device: REQUESTER_A },
    nonceLabel: 'invitation-request-stale-nonce',
    auxRandLabel: 'invitation-request-stale',
  })
  vectors.invitationEnvelope.push({
    name: 'request-stale-refused',
    kind: 'negative',
    note: 'The same request, read long after its 90-second window: refused as stale.',
    input: {
      event: built.event,
      invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A },
      decode: { now: REQUEST_CREATED_AT + 91 },
    },
    output: { result: decodeInvitationRequest(built.event, { invitation: INVITATION_2, now: REQUEST_CREATED_AT + 91 }) },
  })
}

// --- Grant (kind 20467), with a two-hop delegation chain -------------------

function invitationDelegationMessage(invitationId, room, issuer, delegate, expiresAt) {
  // Mirrors `delegationMessage` in `src/invitation.ts` (not exported).
  return sha256(new TextEncoder().encode(`kithmoot/v2/invitation-delegation:${invitationId}:${room}:${issuer}:${delegate}:${expiresAt}`))
}

function signDelegation({ invitationId, room, issuerSk, delegate, expiresAt, auxRandLabel }) {
  const issuer = getPublicKey(issuerSk)
  const auxRand = seed32(auxRandLabel)
  const sig = bytesToHex(schnorr.sign(invitationDelegationMessage(invitationId, room, issuer, delegate, expiresAt), issuerSk, auxRand))
  return { invitation: invitationId, room, issuer, delegate, expiresAt, sig, auxRandHex: bytesToHex(auxRand) }
}

const GRANT_ROOM_ID = deriveRoom(fx.ROOM_SECRET_1).roomId
const INVITATION_2_ID = deriveInvitationId(INVITATION_2)

// Hop 1: root inviter delegates to DELEGATE_A (the first admitted member).
const delegationHop1 = signDelegation({
  invitationId: INVITATION_2_ID,
  room: GRANT_ROOM_ID,
  issuerSk: INVITER_A_SK,
  delegate: DELEGATE_A,
  expiresAt: NOW + 3600,
  auxRandLabel: 'delegation-hop-1',
})

{
  // Hop 2: DELEGATE_A (now a responder) grants REQUESTER_A, and its own
  // grant event names the two-hop chain. This is the shape
  // `encodeInvitationGrant` produces for the SECOND joiner - the plan's gap
  // list calls out "a delegation chain" explicitly.
  const chainHop1 = { invitation: delegationHop1.invitation, room: delegationHop1.room, issuer: delegationHop1.issuer, delegate: delegationHop1.delegate, expiresAt: delegationHop1.expiresAt, sig: delegationHop1.sig }
  const delegationHop2 = signDelegation({
    invitationId: INVITATION_2_ID,
    room: GRANT_ROOM_ID,
    issuerSk: DELEGATE_A_SK,
    delegate: REQUESTER_A,
    expiresAt: NOW + 1800,
    auxRandLabel: 'delegation-hop-2',
  })
  const chainHop2 = { invitation: delegationHop2.invitation, room: delegationHop2.room, issuer: delegationHop2.issuer, delegate: delegationHop2.delegate, expiresAt: delegationHop2.expiresAt, sig: delegationHop2.sig }
  const chain = [chainHop1, chainHop2]

  const grantBody = { v: 2, request: 'ab'.repeat(32), secret: base64urlnopad.encode(fx.ROOM_SECRET_1), delegation: chain, epoch: 0 }
  const conversationKey = nip44.v2.utils.getConversationKey(DELEGATE_A_SK, REQUESTER_A)
  const grantNonce = seed32('invitation-grant-two-hop-nonce')
  const auxRand = seed32('invitation-grant-two-hop')
  const grantEvent = finalizeDeterministic(
    { kind: KINDS.INVITATION_GRANT, created_at: GRANT_CREATED_AT, tags: [['d', INVITATION_2_ID], ['p', REQUESTER_A]], content: nip44.v2.encrypt(JSON.stringify(grantBody), conversationKey, grantNonce) },
    DELEGATE_A_SK,
    auxRand,
  )

  vectors.invitationEnvelope.push({
    name: 'grant-two-hop-delegation',
    kind: 'positive',
    note: 'A grant signed by a delegated responder (not the root inviter), carrying the full two-hop chain rooted at the inviter. The real decoder verifies the whole chain and returns the room secret and a fresh delegate capability.',
    input: {
      chain,
      delegationMessageHop1: `kithmoot/v2/invitation-delegation:${delegationHop1.invitation}:${delegationHop1.room}:${delegationHop1.issuer}:${delegationHop1.delegate}:${delegationHop1.expiresAt}`,
      hop1AuxRandHex: delegationHop1.auxRandHex,
      hop2AuxRandHex: delegationHop2.auxRandHex,
      request: grantBody.request,
      nonceHex: bytesToHex(grantNonce),
      auxRandHex: bytesToHex(auxRand),
    },
    output: { event: grantEvent },
    expected: {
      decode: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, requesterSkHex: bytesToHex(REQUESTER_A_SK), request: grantBody.request, now: GRANT_CREATED_AT },
      result: (() => {
        const r = decodeRoomAdmissionGrant(grantEvent, { invitation: INVITATION_2, requesterSk: REQUESTER_A_SK, request: grantBody.request, now: GRANT_CREATED_AT })
        return r && { secretHex: bytesToHex(r.secret), delegateSkHex: bytesToHex(r.delegate.delegateSk), chain: r.delegate.chain, epoch: r.epoch ?? null }
      })(),
      chainVerifiesTo: verifyInvitationDelegation(INVITATION_2, chain, NOW),
    },
  })
}

{
  // Tamper one byte of the second hop's signature: the whole chain must be
  // refused, not just the tampered hop.
  const chainHop1 = { invitation: delegationHop1.invitation, room: delegationHop1.room, issuer: delegationHop1.issuer, delegate: delegationHop1.delegate, expiresAt: delegationHop1.expiresAt, sig: delegationHop1.sig }
  const tamperedHop2 = { invitation: INVITATION_2_ID, room: GRANT_ROOM_ID, issuer: DELEGATE_A, delegate: REQUESTER_A, expiresAt: NOW + 1800, sig: '00'.repeat(64) }
  const chain = [chainHop1, tamperedHop2]
  vectors.invitationEnvelope.push({
    name: 'delegation-chain-tampered-second-hop',
    kind: 'negative',
    note: "The two-hop chain above with hop 2's signature zeroed out. The whole chain is refused - a member cannot forge the last hop and admit themselves.",
    input: { chain },
    output: { result: verifyInvitationDelegation(INVITATION_2, chain, NOW) },
  })
}

// --- Retirement (kind 1461), with and without `ended` -----------------------

function buildRetirement({ invitation, inviterSk, createdAt, ended, auxRandLabel }) {
  const auxRand = seed32(auxRandLabel)
  const content = JSON.stringify(ended ? { v: 1, ended: true } : { v: 1 })
  const event = finalizeDeterministic(
    { kind: KINDS.INVITATION_RETIREMENT, created_at: createdAt, tags: [['d', deriveInvitationId(invitation)]], content },
    inviterSk,
    auxRand,
  )
  return { event, auxRandHex: bytesToHex(auxRand) }
}

{
  const plain = buildRetirement({ invitation: INVITATION_2, inviterSk: INVITER_A_SK, createdAt: RETIREMENT_CREATED_AT, ended: false, auxRandLabel: 'retirement-plain' })
  vectors.invitationEnvelope.push({
    name: 'retirement-plain',
    kind: 'positive',
    note: 'An ordinary retirement: the link was replaced, not the room ended.',
    input: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, inviterSkHex: bytesToHex(INVITER_A_SK), createdAt: RETIREMENT_CREATED_AT, auxRandHex: plain.auxRandHex },
    output: { event: plain.event },
    expected: { result: decodeInvitationRetirementNotice(plain.event, INVITATION_2) },
  })
}

{
  const ended = buildRetirement({ invitation: INVITATION_2, inviterSk: INVITER_A_SK, createdAt: RETIREMENT_CREATED_AT, ended: true, auxRandLabel: 'retirement-ended' })
  vectors.invitationEnvelope.push({
    name: 'retirement-room-ended',
    kind: 'positive',
    note: 'A retirement that also says the room itself was ended, not just this link replaced.',
    input: { invitation: { bearerHex: bytesToHex(BEARER_A), inviter: INVITER_A }, inviterSkHex: bytesToHex(INVITER_A_SK), createdAt: RETIREMENT_CREATED_AT, auxRandHex: ended.auxRandHex },
    output: { event: ended.event },
    expected: { result: decodeInvitationRetirementNotice(ended.event, INVITATION_2) },
  })
}

{
  const forged = buildRetirement({ invitation: INVITATION_2, inviterSk: OTHER_INVITER_SK, createdAt: RETIREMENT_CREATED_AT, ended: false, auxRandLabel: 'retirement-forged' })
  vectors.invitationEnvelope.push({
    name: 'retirement-wrong-signer-refused',
    kind: 'negative',
    note: 'A retirement signed by somebody other than the inviter pinned in the link: refused, even though the event itself verifies.',
    input: { event: forged.event },
    output: { result: decodeInvitationRetirementNotice(forged.event, INVITATION_2) ?? null },
  })
}

// ===========================================================================
// 3. Persistent (v3) group invitation - encode/decode both ways, plus a
//    tampered ciphertext and a non-persistent invitation refused.
// ===========================================================================

function buildPersistentInvitation({ invitation, inviterSk, roomSecret, createdAt, nonceLabel, auxRandLabel }) {
  const welcomeKey = hkdfSha256(invitation.bearer, 'kithmoot/v3/group-invitation-key')
  const nonce = seed32(nonceLabel)
  const auxRand = seed32(auxRandLabel)
  const room = deriveRoom(roomSecret).roomId
  const content = nip44.v2.encrypt(JSON.stringify({ v: 3, room, secret: base64urlnopad.encode(roomSecret) }), welcomeKey, nonce)
  const event = finalizeDeterministic(
    { kind: KINDS.GROUP_INVITATION, created_at: createdAt, tags: [['d', deriveInvitationId(invitation)]], content },
    inviterSk,
    auxRand,
  )
  return { event, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand) }
}

{
  const built = buildPersistentInvitation({
    invitation: INVITATION_3,
    inviterSk: INVITER_A_SK,
    roomSecret: fx.ROOM_SECRET_1,
    createdAt: fx.NOW - 86_400 * 30,
    nonceLabel: 'persistent-invitation-valid-nonce',
    auxRandLabel: 'persistent-invitation-valid-auxrand',
  })
  vectors.persistentInvitation.push({
    name: 'valid',
    kind: 'positive',
    note: 'A stored group invitation (kind 1463), published once and readable weeks later with nobody online.',
    input: {
      invitation: { bearerHex: bytesToHex(BEARER_B), inviter: INVITER_A },
      inviterSkHex: bytesToHex(INVITER_A_SK),
      roomSecretHex: bytesToHex(fx.ROOM_SECRET_1),
      createdAt: fx.NOW - 86_400 * 30,
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      result: (() => {
        const r = decodePersistentInvitation(built.event, INVITATION_3)
        return r && { secretHex: bytesToHex(r.secret), persistent: r.persistent, epoch: r.epoch }
      })(),
    },
  })

  const tampered = { ...built.event, content: built.event.content.slice(0, -4) + 'AAAA' }
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
    input: { event: built.event, invitationPersistent: false },
    output: { result: decodePersistentInvitation(built.event, temporary) },
  })
}

// ===========================================================================
// 4. Epoch grant - secret at a later epoch, an epoch-0 grant carrying none,
//    both refusals, and a wrong request id.
// ===========================================================================

function buildEpochGrant({ authoritySk, device, createdAt, body, nonceLabel, auxRandLabel }) {
  const nonce = seed32(nonceLabel)
  const auxRand = seed32(auxRandLabel)
  const conversationKey = nip44.v2.utils.getConversationKey(authoritySk, device)
  const event = finalizeDeterministic(
    { kind: KINDS.EPOCH_GRANT, created_at: createdAt, tags: [['d', fx_roomId()], ['p', device]], content: nip44.v2.encrypt(JSON.stringify(body), conversationKey, nonce) },
    authoritySk,
    auxRand,
  )
  return { event, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand) }
}

function fx_roomId() {
  return deriveRoom(fx.ROOM_SECRET_1).roomId
}

const EPOCH_1 = deriveEpoch({ epoch: 1, secret: fx.EPOCH_SECRET_1 })
const EPOCH_GRANT_REQUEST = 'cd'.repeat(32)

{
  const body = { v: 1, request: EPOCH_GRANT_REQUEST, epoch: 1, secret: base64urlnopad.encode(fx.EPOCH_SECRET_1), removed: [fx.REMOVED_DEVICE] }
  const built = buildEpochGrant({ authoritySk: fx.AUTHORITY_SK, device: fx.KEPT_DEVICE, createdAt: fx.EPOCH_CREATED_AT, body, nonceLabel: 'epoch-grant-with-secret-nonce', auxRandLabel: 'epoch-grant-with-secret' })
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  vectors.epochGrant.push({
    name: 'grant-with-secret-at-epoch-1',
    kind: 'positive',
    note: 'The authority answers a caught-up request: the room has moved to epoch 1, and the secret that opens it is sealed to the asking device. Every field the real decoder needs rides in this vector\'s own `input`.',
    input: {
      roomId: fx_roomId(),
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      authority: fx.AUTHORITY,
      device: fx.KEPT_DEVICE,
      deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK),
      request: EPOCH_GRANT_REQUEST,
      createdAt: fx.EPOCH_CREATED_AT,
      body,
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      result: (() => {
        const r = decodeEpochGrant(built.event, decodeArgs)
        return r && ('refused' in r ? r : { epoch: 'secret' in r.epoch ? { epoch: r.epoch.epoch, secretHex: bytesToHex(r.epoch.secret) } : r.epoch, removed: r.removed })
      })(),
    },
  })
  vectors.epochGrant.push({
    name: 'grant-wrong-request-id-refused',
    kind: 'negative',
    note: 'The same event, but the device asked with a different request id than the one the grant answers: refused.',
    input: {
      event: built.event,
      roomId: fx_roomId(),
      authority: fx.AUTHORITY,
      deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK),
      request: 'ff'.repeat(32),
      now: fx.EPOCH_CREATED_AT,
    },
    output: {
      result: decodeEpochGrant(built.event, { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: 'ff'.repeat(32), now: fx.EPOCH_CREATED_AT }),
    },
  })
}

{
  // Epoch 0: the room has never been rekeyed, so the grant carries no
  // secret at all - the requester already holds what it needs from the link.
  const body = { v: 1, request: EPOCH_GRANT_REQUEST, epoch: 0, removed: [] }
  const built = buildEpochGrant({ authoritySk: fx.AUTHORITY_SK, device: fx.KEPT_DEVICE, createdAt: fx.EPOCH_CREATED_AT, body, nonceLabel: 'epoch-grant-epoch-zero-nonce', auxRandLabel: 'epoch-grant-epoch-zero' })
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  vectors.epochGrant.push({
    name: 'grant-epoch-zero-no-secret',
    kind: 'positive',
    note: 'A grant answering "the room is still at epoch 0": no secret rides in the body, because the epoch-0 room key is already what the link handed out.',
    input: {
      roomId: fx_roomId(),
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      authority: fx.AUTHORITY,
      device: fx.KEPT_DEVICE,
      deviceSkHex: bytesToHex(fx.KEPT_DEVICE_SK),
      request: EPOCH_GRANT_REQUEST,
      createdAt: fx.EPOCH_CREATED_AT,
      body,
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: { result: decodeEpochGrant(built.event, decodeArgs) },
  })
}

for (const refused of ['removed', 'closed']) {
  const body = { v: 1, request: EPOCH_GRANT_REQUEST, refused }
  const built = buildEpochGrant({ authoritySk: fx.AUTHORITY_SK, device: fx.REMOVED_DEVICE, createdAt: fx.EPOCH_CREATED_AT, body, nonceLabel: `epoch-grant-refused-${refused}-nonce`, auxRandLabel: `epoch-grant-refused-${refused}` })
  const decodeArgs = { roomId: fx_roomId(), authority: fx.AUTHORITY, deviceSk: fx.REMOVED_DEVICE_SK, request: EPOCH_GRANT_REQUEST, now: fx.EPOCH_CREATED_AT }
  vectors.epochGrant.push({
    name: `grant-refused-${refused}`,
    kind: 'negative',
    note: `The authority refuses the epoch request because the device's participant was ${refused === 'removed' ? 'removed from the room' : 'the room has been closed'}. Sealed like an ordinary grant, so only the asking device learns why.`,
    input: {
      roomId: fx_roomId(),
      authoritySkHex: bytesToHex(fx.AUTHORITY_SK),
      authority: fx.AUTHORITY,
      device: fx.REMOVED_DEVICE,
      deviceSkHex: bytesToHex(fx.REMOVED_DEVICE_SK),
      request: EPOCH_GRANT_REQUEST,
      createdAt: fx.EPOCH_CREATED_AT,
      body,
      nonceHex: built.nonceHex,
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: { result: decodeEpochGrant(built.event, decodeArgs) },
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
// 5. Person-scope credential - valid, over 30 days, refused without
//    acceptPerson.
// ===========================================================================

function buildPersonCredential({ participantSk, devicePubkey, createdAt, expiresAt, label, auxRandLabel }) {
  const participant = getPublicKey(participantSk)
  const auxRand = seed32(auxRandLabel)
  const tags = [
    ['d', participant],
    ['device', devicePubkey],
    ['expiration', String(expiresAt)],
    ['scope', 'person'],
    ...(label !== undefined ? [['label', label]] : []),
  ]
  const event = finalizeDeterministic({ kind: KINDS.CREDENTIAL, created_at: createdAt, tags, content: '' }, participantSk, auxRand)
  return { event, auxRandHex: bytesToHex(auxRand) }
}

{
  const built = buildPersonCredential({
    participantSk: fx.PARTICIPANT_A_SK,
    devicePubkey: fx.DEVICE_A,
    createdAt: fx.CREDENTIAL_CREATED_AT,
    expiresAt: fx.CREDENTIAL_CREATED_AT + 7 * 24 * 3600,
    label: 'phone',
    auxRandLabel: 'person-credential-valid',
  })
  vectors.personCredential.push({
    name: 'valid-accepted-with-acceptPerson',
    kind: 'positive',
    note: 'A person-scope credential (device authorised for every room, not one) is refused as a room credential by default, and accepted only when the caller opts in with `acceptPerson`.',
    input: {
      participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK),
      devicePubkey: fx.DEVICE_A,
      createdAt: fx.CREDENTIAL_CREATED_AT,
      expiresAt: fx.CREDENTIAL_CREATED_AT + 7 * 24 * 3600,
      label: 'phone',
      auxRandHex: built.auxRandHex,
    },
    output: { event: built.event },
    expected: {
      asPerson: verifyDeviceCredential(built.event, { identity: fx.PARTICIPANT_A, now: fx.NOW }),
      asRoomWithoutAcceptPerson: verifyDeviceCredential(built.event, { roomId: deriveRoom(fx.ROOM_SECRET_1).roomId, now: fx.NOW }),
      asRoomWithAcceptPerson: verifyDeviceCredential(built.event, { roomId: deriveRoom(fx.ROOM_SECRET_1).roomId, now: fx.NOW, acceptPerson: true }),
    },
  })
}

{
  // Signed directly (not through `createDeviceCredential`, which refuses
  // this at mint time) so the vector pins what a VERIFIER does when handed
  // one anyway - a looser or buggy signer's output.
  const longExpiry = fx.CREDENTIAL_CREATED_AT + PERSON_CREDENTIAL_MAX_SECONDS + 1
  const built = buildPersonCredential({
    participantSk: fx.PARTICIPANT_A_SK,
    devicePubkey: fx.DEVICE_A,
    createdAt: fx.CREDENTIAL_CREATED_AT,
    expiresAt: longExpiry,
    auxRandLabel: 'person-credential-over-30-days',
  })
  vectors.personCredential.push({
    name: 'refused-over-30-days',
    kind: 'negative',
    note: 'A person credential whose expiry is one second past the 30-day maximum, measured from its own `created_at`. `createDeviceCredential` refuses to mint this; this vector pins the separate check `verifyDeviceCredential` makes on anything it is handed regardless.',
    input: {
      participantSkHex: bytesToHex(fx.PARTICIPANT_A_SK),
      devicePubkey: fx.DEVICE_A,
      createdAt: fx.CREDENTIAL_CREATED_AT,
      expiresAt: longExpiry,
      auxRandHex: built.auxRandHex,
      verify: { identity: fx.PARTICIPANT_A, now: fx.CREDENTIAL_CREATED_AT },
    },
    output: { event: built.event, result: verifyDeviceCredential(built.event, { identity: fx.PARTICIPANT_A, now: fx.CREDENTIAL_CREATED_AT }) },
  })
}

// ===========================================================================
// 6. Channels signature (`epoch.ts:798-849`) - the admin-list signature's
//    sibling: signed by the authority, bound to the room and the epoch.
// ===========================================================================

function channelsMessage(roomId, epoch, channels) {
  // Mirrors `channelsMessage` in `src/epoch.ts` (not exported).
  return sha256(new TextEncoder().encode(`kithmoot/v1/channels:${roomId}:${epoch}:${channels.join(',')}`))
}

{
  const roomId = fx_roomId()
  const channels = ['planning', 'social']
  const auxRand = seed32('channels-signature-valid')
  const sig = bytesToHex(schnorr.sign(channelsMessage(roomId, 1, canonicalChannels(channels)), fx.AUTHORITY_SK, auxRand))
  vectors.channelsSignature.push({
    name: 'valid-at-epoch-1',
    kind: 'positive',
    note: 'The authority signs the room\'s channel list at epoch 1. Canonicalised (deduplicated, sorted) before signing, and verified with the real `verifyChannels`, in either list order.',
    input: { roomId, epoch: 1, channels, authoritySkHex: bytesToHex(fx.AUTHORITY_SK), auxRandHex: bytesToHex(auxRand) },
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
    name: 'refused-reserved-channel-name',
    kind: 'negative',
    note: '`agents`, `minutes` and `transcript` are reserved: the room already means something else by them, so `canonicalChannels` throws rather than letting them into a signed registry.',
    input: { channels: ['planning', 'agents'] },
    output: { throws: true, error: (() => { try { canonicalChannels(['planning', 'agents']); return null } catch (e) { return e.message } })() },
  })
}

// ===========================================================================
// Write the file.
// ===========================================================================

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
