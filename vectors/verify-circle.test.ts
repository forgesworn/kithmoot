// Loads `circle-vectors.json` and checks every vector by calling the REAL
// function - the encoder, for anything signed or encrypted, with
// `crypto.getRandomValues` stubbed to the vector's own recorded randomness
// queue (see `vectors/lib/determinism.mjs`'s `withStubbedRandomness`), or the
// decoder/verifier directly for everything else - and asserting the result
// equals what is recorded on disk. This is the strongest form the review in
// `docs/plans/2026-09-28-circle-kit-extraction.md` (girnel repository) asked
// for: a vector's bytes are not merely internally self-consistent, they are
// what the ACTUAL implementation in `src/` produces from the ACTUAL inputs.
//
// See `vectors/generate-circle.mjs`'s header for the two documented
// exceptions (person-credential's over-30-days refusal, and the two
// room-mismatch negatives) where no real encoder can produce the vector's
// bytes by design, and for what each mutation ID (M1-M22) below refers to.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64urlnopad } from '@scure/base'
import { nip44 } from 'nostr-tools'
import { getPublicKey, type Event } from 'nostr-tools/pure'

import { finalizeDeterministic, withStubbedRandomness } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

import { KINDS } from '../src/kinds.js'
import { deriveRoom } from '../src/room.js'
import { encodeRoomLink, parseRoomLink, MAX_ROOM_LINK_FRAGMENT_LENGTH, type RoomLink } from '../src/link.js'
import { MAX_RELAY_HINTS, safeIceUrls, safeRelayUrls } from '../src/network-hints.js'
import { sanitiseDisplayName } from '../src/display-name.js'
import {
  deriveInvitationId,
  decodeInvitationRequest,
  decodeRoomAdmissionGrant,
  decodeInvitationRetirementNotice,
  verifyInvitationDelegation,
  encodeInvitationRequest,
  encodeInvitationGrant,
  encodeInvitationRetirement,
  type RoomInvitation,
  type InvitationDelegation,
} from '../src/invitation.js'
import { decodePersistentInvitation, encodePersistentInvitation } from '../src/persistent-invitation.js'
import { verifyDeviceCredential, createDeviceCredential, PERSON_CREDENTIAL_MAX_SECONDS, type CreateCredentialOptions } from '../src/credential.js'
import {
  deriveEpoch,
  decodeEpochGrant,
  encodeEpochGrant,
  canonicalChannels,
  verifyChannels,
  signChannels,
} from '../src/epoch.js'

interface Vector {
  name: string
  kind: 'positive' | 'negative'
  note: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected?: any
}

interface VectorDocument {
  protocolVersion: string
  generatedBy: string
  nostrToolsVersion: string
  groups: Record<string, Vector[]>
}

const here = dirname(fileURLToPath(import.meta.url))
const doc = JSON.parse(readFileSync(join(here, 'circle-vectors.json'), 'utf8')) as VectorDocument
const { groups } = doc

function vec(group: string, name: string): Vector {
  const found = groups[group]?.find((v) => v.name === name)
  if (!found) throw new Error(`missing vector ${group}/${name}`)
  return found
}

function hkdfSha256(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, undefined, info, 32)
}

/** Strip nostr-tools' non-serialisable `verifiedSymbol` cache (set by
 *  `finalizeEvent` on signing, and never present on a vector loaded from
 *  JSON) before a deep-equal comparison against a recorded vector. */
function plain(event: Event): Event {
  return JSON.parse(JSON.stringify(event)) as Event
}

function randomnessQueue(v: Vector, path: string[] = ['input']): Uint8Array[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = v
  for (const key of path) node = node[key]
  return (node.randomnessQueueHex as string[]).map(hexToBytes)
}

function invitationOf(raw: { bearerHex: string; inviter: string; persistent?: boolean | null }): RoomInvitation {
  return { bearer: hexToBytes(raw.bearerHex), inviter: raw.inviter, ...(raw.persistent ? { persistent: true as const } : {}) }
}

describe('vector file shape', () => {
  it('carries the protocol version this suite was written against, and never touches the Android contract file', () => {
    expect(doc.protocolVersion).toBe('kithmoot/v1')
    expect(doc.nostrToolsVersion).toBe('2.25.0')
  })

  it('every group that has a verify/decode/throw path includes at least one negative case', () => {
    for (const group of Object.keys(groups)) {
      const negatives = groups[group]!.filter((v) => v.kind === 'negative')
      expect(negatives.length, `${group} has no negative vectors`).toBeGreaterThan(0)
    }
  })
})

// ===========================================================================
// 1. Link envelope
// ===========================================================================

describe('link envelope', () => {
  for (const v of groups.linkEnvelope!.filter((x) => x.kind === 'positive' && x.input.link)) {
    it(`${v.name}: round-trips through the real encode/decode`, () => {
      const raw = v.input.link
      const link: RoomLink = {
        relays: raw.relays,
        iceUrls: raw.iceUrls,
        ...(raw.invitation ? { invitation: invitationOf(raw.invitation) } : {}),
        ...(raw.secretHex ? { secret: hexToBytes(raw.secretHex) } : {}),
        ...(raw.policy ? { policy: raw.policy } : {}),
        ...(raw.pairingCodeHex ? { pairingCode: hexToBytes(raw.pairingCodeHex) } : {}),
        ...(raw.name ? { name: raw.name } : {}),
      }
      const url = encodeRoomLink(v.input.base, link)
      expect(url).toBe(v.output.url)

      const decoded = parseRoomLink(url)
      expect(decoded.relays).toEqual(v.output.decoded.relays)
      expect(decoded.iceUrls).toEqual(v.output.decoded.iceUrls)
      expect(decoded.policy ?? null).toEqual(v.output.decoded.policy)
      expect(decoded.name ?? null).toEqual(v.output.decoded.name)
      if (raw.invitation) {
        expect(decoded.invitation?.inviter).toBe(v.output.decoded.invitation.inviter)
        expect(bytesToHex(decoded.invitation!.bearer)).toBe(v.output.decoded.invitation.bearerHex)
        expect(decoded.invitation?.persistent ?? null).toEqual(v.output.decoded.invitation.persistent)
      } else {
        expect(decoded.invitation).toBeUndefined()
      }
      if (raw.secretHex) expect(bytesToHex(decoded.secret!)).toBe(raw.secretHex)
      else expect(decoded.secret).toBeUndefined()
      if (raw.pairingCodeHex) expect(bytesToHex(decoded.pairingCode!)).toBe(raw.pairingCodeHex)
      else expect(decoded.pairingCode).toBeUndefined()
    })
  }

  it('hostile-input-normalised: the real parser normalises what nobody\'s own encoder would have produced', () => {
    const v = vec('linkEnvelope', 'hostile-input-normalised')
    const decoded = parseRoomLink(v.input.url)
    expect(decoded.relays).toEqual(v.expected.relays)
    expect(decoded.iceUrls).toEqual(v.expected.iceUrls)
    expect(decoded.name ?? null).toEqual(v.expected.name)
    // Cross-checked against the real filters directly, independent of the
    // vector's own recorded `expected` block.
    expect(safeRelayUrls(v.input.rawRelays)).toEqual(decoded.relays)
    expect(safeIceUrls(v.input.rawIceUrls)).toEqual(decoded.iceUrls)
    expect(sanitiseDisplayName(v.input.rawName) ?? null).toEqual(decoded.name ?? null)
  })

  for (const name of ['v3-unknown-policy-tier-refused', 'v4-unsupported-version-refused', 'bearer-31-bytes-refused', 'pairing-code-malformed-refused', 'oversize-fragment-refused']) {
    it(`${name}: the real parser throws`, () => {
      const v = vec('linkEnvelope', name)
      expect(() => parseRoomLink(v.input.url)).toThrow(v.output.error)
    })
  }

  it('nine-relay-hints-refused: the real encoder throws before filtering, not after', () => {
    const v = vec('linkEnvelope', 'nine-relay-hints-refused')
    expect(v.input.relays.length).toBe(MAX_RELAY_HINTS + 1)
    expect(() => encodeRoomLink(fx.BASE_URL, { invitation: { bearer: fx.ROOM_SECRET_1, inviter: fx.HOST }, relays: v.input.relays, iceUrls: [] })).toThrow(v.output.error)
  })
})

// ===========================================================================
// 2. Invitation envelope
// ===========================================================================

describe('invitation envelope', () => {
  it('invitation-id-derivation: pure, matches the real function directly', () => {
    const v = vec('invitationEnvelope', 'invitation-id-derivation')
    const invitation = invitationOf({ bearerHex: v.input.bearerHex, inviter: v.input.inviter })
    expect(deriveInvitationId(invitation)).toBe(v.output.id)
  })

  it('request-valid: the real encodeInvitationRequest reproduces the exact event, and the real decoder accepts it', () => {
    const v = vec('invitationEnvelope', 'request-valid')
    const invitation = invitationOf(v.input.invitation)
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodeInvitationRequest({ invitation, requesterSk: hexToBytes(v.input.requesterSkHex), now: v.input.createdAt, name: v.input.name, participant: v.input.participant }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const decodeInvitation = invitationOf(v.expected.decode.invitation)
    const result = decodeInvitationRequest(event, { invitation: decodeInvitation, now: v.expected.decode.now })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ device: getPublicKey(hexToBytes(v.input.requesterSkHex)), request: event.id, name: v.input.name, participant: v.input.participant })
  })

  it('request-stale-refused: the real decoder refuses it outside the 90-second window', () => {
    const v = vec('invitationEnvelope', 'request-stale-refused')
    const invitation = invitationOf(v.input.invitation)
    const result = decodeInvitationRequest(v.input.event as Event, { invitation, now: v.input.decode.now })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('request-device-mismatched-signer-refused: a genuinely-signed event whose body names a different device - refused (M13)', () => {
    const v = vec('invitationEnvelope', 'request-device-mismatched-signer-refused')
    expect(v.input.event.pubkey).toBe(v.input.signerIsReallyDevice)
    expect(v.input.body.device).not.toBe(v.input.signerIsReallyDevice)
    const result = decodeInvitationRequest(v.input.event as Event, { invitation: INVITATION_2(), now: v.input.event.created_at })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  function INVITATION_2(): RoomInvitation {
    const sibling = vec('invitationEnvelope', 'request-valid')
    return invitationOf(sibling.input.invitation)
  }

  function delegationMessage(invitationId: string, room: string, issuer: string, delegate: string, expiresAt: number): Uint8Array {
    return sha256(new TextEncoder().encode(`kithmoot/v2/invitation-delegation:${invitationId}:${room}:${issuer}:${delegate}:${expiresAt}`))
  }

  function schnorrVerifiesHop(hop: InvitationDelegation): boolean {
    return schnorr.verify(hexToBytes(hop.sig), delegationMessage(hop.invitation, hop.room, hop.issuer, hop.delegate, hop.expiresAt), hexToBytes(hop.issuer))
  }

  it('grant-two-hop-delegation: rebuilds both hops through the real encodeInvitationGrant, and the real decoder walks the whole chain', () => {
    const v = vec('invitationEnvelope', 'grant-two-hop-delegation')
    const invitation = INVITATION_2()

    const hop1Queue = (v.input.hop1.randomnessQueueHex as string[]).map(hexToBytes)
    const hop1Event = withStubbedRandomness(hop1Queue, () =>
      encodeInvitationGrant({
        invitation,
        inviterSk: hexToBytes(v.input.hop1.inviterSkHex),
        requester: v.input.hop1.requester,
        request: v.input.hop1.request,
        roomSecret: fx.ROOM_SECRET_1,
        now: v.input.hop1.createdAt,
        delegation: [],
        epoch: 0,
      }),
    ) as Event
    expect(plain(hop1Event)).toEqual(v.input.hop1.grantEvent)

    const admission1 = decodeRoomAdmissionGrant(hop1Event, {
      invitation,
      requesterSk: hexToBytes(v.input.hop1.inviterSkHex) /* placeholder, corrected below */,
      request: v.input.hop1.request,
      now: v.input.hop1.createdAt,
    })
    // Hop 1's requester is the delegate, whose secret key we do not have a
    // labelled hex for on this vector directly - it is `hop2.inviterSkHex`,
    // since that responder signs hop 2's outer grant.
    const admission1Real = decodeRoomAdmissionGrant(hop1Event, {
      invitation,
      requesterSk: hexToBytes(v.input.hop2.inviterSkHex),
      request: v.input.hop1.request,
      now: v.input.hop1.createdAt,
    })
    expect(admission1).toBeNull() // wrong requester key: proves the addressing check runs
    expect(admission1Real).not.toBeNull()
    const chain1 = admission1Real!.delegate.chain

    const hop2Queue = (v.input.hop2.randomnessQueueHex as string[]).map(hexToBytes)
    const hop2Event = withStubbedRandomness(hop2Queue, () =>
      encodeInvitationGrant({
        invitation,
        inviterSk: hexToBytes(v.input.hop2.inviterSkHex),
        requester: v.input.hop2.requester,
        request: v.input.hop2.request,
        roomSecret: fx.ROOM_SECRET_1,
        now: v.input.hop2.createdAt,
        delegation: chain1,
        epoch: 0,
      }),
    ) as Event
    expect(plain(hop2Event)).toEqual(v.output.event)

    const requesterSk = hexToBytes(v.expected.decode.requesterSkHex)
    const result = decodeRoomAdmissionGrant(hop2Event, { invitation, requesterSk, request: v.expected.decode.request, now: v.expected.decode.now })
    expect(result).not.toBeNull()
    expect(bytesToHex(result!.secret)).toBe(v.expected.result.secretHex)
    expect(bytesToHex(result!.delegate.delegateSk)).toBe(v.expected.result.delegateSkHex)
    expect(result!.delegate.chain).toEqual(v.expected.result.chain)
    expect(result!.epoch ?? null).toEqual(v.expected.result.epoch)

    // Every hop's recorded signature also verifies independently, against
    // its own recorded message and issuer - the schnorr check underneath
    // `verifyInvitationDelegation`, not the chain-position check, which
    // only makes sense starting from the root.
    for (const hop of result!.delegate.chain as InvitationDelegation[]) {
      expect(schnorrVerifiesHop(hop)).toBe(true)
    }
    expect(verifyInvitationDelegation(invitation, result!.delegate.chain, v.expected.decode.now)).toBe(v.expected.chainVerifiesTo)
  })

  it('delegation-chain-tampered-second-hop: the whole chain is refused', () => {
    const v = vec('invitationEnvelope', 'delegation-chain-tampered-second-hop')
    const invitation = INVITATION_2()
    const chain = v.input.chain as InvitationDelegation[]
    const result = verifyInvitationDelegation(invitation, chain, fx.NOW)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('delegation-hop-wrong-issuer-refused: hop 2 genuinely signed, but not by hop 1\'s delegate - refused (M5)', () => {
    const v = vec('invitationEnvelope', 'delegation-hop-wrong-issuer-refused')
    const invitation = INVITATION_2()
    const chain = v.input.chain as InvitationDelegation[]
    expect(chain[1]!.issuer).toBe(v.input.forgedByPubkey)
    expect(chain[1]!.issuer).not.toBe(chain[0]!.delegate)
    const result = verifyInvitationDelegation(invitation, chain, fx.NOW)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-signer-not-final-issuer-refused: genuinely signed and genuinely encrypted, wrong signer - refused (M9)', () => {
    const v = vec('invitationEnvelope', 'grant-signer-not-final-issuer-refused')
    const invitation = INVITATION_2()
    expect(v.input.event.pubkey).toBe(v.input.actualSigner)
    expect(v.input.body.delegation.at(-1).issuer).not.toBe(v.input.actualSigner)
    const sibling = vec('invitationEnvelope', 'request-valid')
    const realRequesterSk = hexToBytes(sibling.input.requesterSkHex)
    const result = decodeRoomAdmissionGrant(v.input.event as Event, { invitation, requesterSk: realRequesterSk, request: v.input.body.request, now: v.input.event.created_at })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-secret-room-mismatch-refused: genuinely signed, chain rooted correctly, secret opens a different room - refused (M19)', () => {
    const v = vec('invitationEnvelope', 'grant-secret-room-mismatch-refused')
    const invitation = INVITATION_2()
    expect(deriveRoom(fx.ROOM_SECRET_2).roomId).toBe(v.input.secretDerivesToRoom)
    expect(v.input.body.delegation[0].room).toBe(v.input.chainRoom)
    expect(v.input.chainRoom).not.toBe(v.input.secretDerivesToRoom)
    const sibling = vec('invitationEnvelope', 'grant-two-hop-delegation')
    const delegateSk = hexToBytes(sibling.input.hop2.inviterSkHex)
    const result = decodeRoomAdmissionGrant(v.input.event as Event, { invitation, requesterSk: delegateSk, request: v.input.body.request, now: v.input.event.created_at })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-delegation-expired-refused: hop 1\'s real expiry, checked one second past it - refused (M21)', () => {
    const v = vec('invitationEnvelope', 'grant-delegation-expired-refused')
    const invitation = INVITATION_2()
    const chain = v.input.chain as InvitationDelegation[]
    expect(v.input.now).toBe(chain[0]!.expiresAt + 1)
    const result = verifyInvitationDelegation(invitation, chain, v.input.now)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
    // The check is strict (`expiresAt <= now` refuses), so the expiry
    // instant itself already refuses; one second earlier still verifies.
    expect(verifyInvitationDelegation(invitation, chain, chain[0]!.expiresAt)).toBeNull()
    expect(verifyInvitationDelegation(invitation, chain, chain[0]!.expiresAt - 1)).not.toBeNull()
  })

  it('retirement-plain: the real encodeInvitationRetirement reproduces the exact event, and reads back as an ordinary retirement', () => {
    const v = vec('invitationEnvelope', 'retirement-plain')
    const invitation = invitationOf(v.input.invitation)
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodeInvitationRetirement({ invitation, inviterSk: hexToBytes(v.input.inviterSkHex), now: v.input.createdAt, ended: false }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = decodeInvitationRetirementNotice(event, invitation)
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ ended: false })
  })

  it('retirement-room-ended: the real encodeInvitationRetirement reproduces the exact event, and reads back as ended', () => {
    const v = vec('invitationEnvelope', 'retirement-room-ended')
    const invitation = invitationOf(v.input.invitation)
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodeInvitationRetirement({ invitation, inviterSk: hexToBytes(v.input.inviterSkHex), now: v.input.createdAt, ended: true }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = decodeInvitationRetirementNotice(event, invitation)
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ ended: true })
  })

  it('retirement-wrong-signer-refused: a genuine event, wrong signer, refused', () => {
    const v = vec('invitationEnvelope', 'retirement-wrong-signer-refused')
    const plain = vec('invitationEnvelope', 'retirement-plain')
    const invitation = invitationOf(plain.input.invitation)
    const result = decodeInvitationRetirementNotice(v.input.event as Event, invitation)
    expect(result ?? null).toEqual(v.output.result)
  })
})

// ===========================================================================
// 3. Persistent (v3) group invitation
// ===========================================================================

describe('persistent group invitation', () => {
  it('valid: the real encodePersistentInvitation reproduces the exact event, and the real decoder returns the secret', () => {
    const v = vec('persistentInvitation', 'valid')
    const invitation = invitationOf({ ...v.input.invitation, persistent: true })
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodePersistentInvitation({ invitation, inviterSk: hexToBytes(v.input.inviterSkHex), roomSecret: hexToBytes(v.input.roomSecretHex), now: v.input.createdAt }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = decodePersistentInvitation(event, invitation)
    expect(result).not.toBeNull()
    expect(bytesToHex(result!.secret)).toBe(v.expected.result.secretHex)
    expect(result!.persistent).toBe(true)
    expect(result!.epoch).toBe(0)
  })

  it('tampered-ciphertext-refused: NIP-44 MAC failure returns null, not a throw', () => {
    const v = vec('persistentInvitation', 'tampered-ciphertext-refused')
    const valid = vec('persistentInvitation', 'valid')
    const invitation = invitationOf({ ...valid.input.invitation, persistent: true })
    const result = decodePersistentInvitation(v.input.event as Event, invitation)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('non-persistent-invitation-refused: the same event refuses without the persistent flag', () => {
    const v = vec('persistentInvitation', 'non-persistent-invitation-refused')
    const valid = vec('persistentInvitation', 'valid')
    const invitation = invitationOf({ ...valid.input.invitation, persistent: false })
    const result = decodePersistentInvitation(v.input.event as Event, invitation)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('room-mismatch-refused: genuinely signed and encrypted, body room does not match its own secret - refused (M20)', () => {
    const v = vec('persistentInvitation', 'room-mismatch-refused')
    const valid = vec('persistentInvitation', 'valid')
    const invitation = invitationOf({ ...valid.input.invitation, persistent: true })
    expect(deriveRoom(fx.ROOM_SECRET_1).roomId).toBe(v.input.roomFromSecret)
    expect(v.input.roomInBody).not.toBe(v.input.roomFromSecret)
    const result = decodePersistentInvitation(v.input.event as Event, invitation)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })
})

// ===========================================================================
// 4. Epoch grant
// ===========================================================================

describe('epoch grant', () => {
  it('grant-with-secret-at-epoch-1: the real encodeEpochGrant reproduces the exact event, and the real decoder returns the secret and removed set', () => {
    const v = vec('epochGrant', 'grant-with-secret-at-epoch-1')
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodeEpochGrant({
        roomId: v.input.roomId,
        authoritySk: hexToBytes(v.input.authoritySkHex),
        device: v.input.device,
        request: v.input.request,
        now: v.input.createdAt,
        epoch: { epoch: v.input.epoch, secret: hexToBytes(v.input.secretHex) },
        removed: v.input.removed,
      }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = decodeEpochGrant(event, { roomId: v.input.roomId, authority: v.input.authority, deviceSk: hexToBytes(v.input.deviceSkHex), request: v.input.request, now: v.input.createdAt })
    expect(result).not.toBeNull()
    expect(result && 'refused' in result).toBe(false)
    if (result && !('refused' in result)) {
      expect('secret' in result.epoch).toBe(true)
      if ('secret' in result.epoch) expect(bytesToHex(result.epoch.secret)).toBe(v.expected.result.epoch.secretHex)
      expect(result.epoch.epoch).toBe(v.expected.result.epoch.epoch)
      expect(result.removed).toEqual(v.expected.result.removed)
    }
    const idVector = vec('epochGrant', 'epoch-1-id-independent-check')
    const derived = deriveEpoch({ epoch: 1, secret: hexToBytes(v.expected.result.epoch.secretHex) })
    expect(derived.id).toBe(idVector.output.id)
    expect(bytesToHex(derived.key)).toBe(idVector.output.keyHex)
  })

  it('grant-wrong-request-id-refused: the real decoder refuses a request-id mismatch', () => {
    const v = vec('epochGrant', 'grant-wrong-request-id-refused')
    const result = decodeEpochGrant(v.input.event as Event, { roomId: v.input.roomId, authority: v.input.authority, deviceSk: hexToBytes(v.input.deviceSkHex), request: v.input.request, now: v.input.now })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-stale-refused: the real decoder refuses a grant read past its freshness window (M18)', () => {
    const v = vec('epochGrant', 'grant-stale-refused')
    const result = decodeEpochGrant(v.input.event as Event, {
      roomId: v.input.decode.roomId, authority: v.input.decode.authority, deviceSk: hexToBytes(v.input.decode.deviceSkHex), request: v.input.decode.request, now: v.input.decode.now,
    })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-epoch-zero-no-secret: the real encodeEpochGrant reproduces the exact event, and the real decoder returns epoch 0 with no secret', () => {
    const v = vec('epochGrant', 'grant-epoch-zero-no-secret')
    const event = withStubbedRandomness(randomnessQueue(v), () =>
      encodeEpochGrant({ roomId: v.input.roomId, authoritySk: hexToBytes(v.input.authoritySkHex), device: v.input.device, request: v.input.request, now: v.input.createdAt, epoch: { epoch: 0, secret: fx.ROOM_SECRET_1 }, removed: [] }),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = decodeEpochGrant(event, { roomId: v.input.roomId, authority: v.input.authority, deviceSk: hexToBytes(v.input.deviceSkHex), request: v.input.request, now: v.input.createdAt })
    expect(result).toEqual(v.expected.result)
    expect(result).toMatchObject({ epoch: { epoch: 0 } })
    expect(result && !('refused' in result) && 'secret' in result.epoch).toBe(false)
  })

  for (const refused of ['removed', 'closed'] as const) {
    it(`grant-refused-${refused}: the real encodeEpochGrant reproduces the exact event, and the real decoder returns the refusal`, () => {
      const v = vec('epochGrant', `grant-refused-${refused}`)
      const event = withStubbedRandomness(randomnessQueue(v), () =>
        encodeEpochGrant({ roomId: v.input.roomId, authoritySk: hexToBytes(v.input.authoritySkHex), device: v.input.device, request: v.input.request, now: v.input.createdAt, refused }),
      ) as Event
      expect(plain(event)).toEqual(v.output.event)
      const result = decodeEpochGrant(event, { roomId: v.input.roomId, authority: v.input.authority, deviceSk: hexToBytes(v.input.deviceSkHex), request: v.input.request, now: v.input.createdAt })
      expect(result).toEqual(v.expected.result)
      expect(result).toEqual({ refused })
    })
  }

  it('grant-wrong-authority-signer-refused: genuinely signed and sealed, wrong signer - refused (M6)', () => {
    const v = vec('epochGrant', 'grant-wrong-authority-signer-refused')
    expect(v.input.event.pubkey).toBe(v.input.actualSigner)
    expect(v.input.event.pubkey).not.toBe(fx.AUTHORITY)
    const result = decodeEpochGrant(v.input.event as Event, { roomId: deriveRoom(fx.ROOM_SECRET_1).roomId, authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: v.input.request, now: v.input.event.created_at })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-wrong-room-refused: genuinely signed for a different room\'s id - refused (M18)', () => {
    const v = vec('epochGrant', 'grant-wrong-room-refused')
    expect(v.input.event.tags.find((t: string[]) => t[0] === 'd')?.[1]).toBe(v.input.grantedForRoom)
    expect(v.input.askedAboutRoom).not.toBe(v.input.grantedForRoom)
    const result = decodeEpochGrant(v.input.event as Event, { roomId: v.input.askedAboutRoom, authority: fx.AUTHORITY, deviceSk: fx.KEPT_DEVICE_SK, request: v.input.request, now: v.input.event.created_at })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })
})

// ===========================================================================
// 5. Person-scope credential
// ===========================================================================

describe('person credential', () => {
  function identityFor(sk: Uint8Array, auxRand: Uint8Array): CreateCredentialOptions['identity'] {
    return {
      pubkey: getPublicKey(sk),
      async signEvent(unsigned) {
        return finalizeDeterministic(unsigned, sk, auxRand) as Event
      },
    }
  }

  it('valid-accepted-with-acceptPerson: the real createDeviceCredential reproduces the exact event, and is refused as a room credential unless acceptPerson is set', async () => {
    const v = vec('personCredential', 'valid-accepted-with-acceptPerson')
    const sk = hexToBytes(v.input.participantSkHex)
    const cred = await createDeviceCredential({
      identity: identityFor(sk, hexToBytes(v.input.auxRandHex)),
      devicePubkey: v.input.devicePubkey,
      scope: 'person',
      label: v.input.label,
      expiresAt: v.input.expiresAt,
      now: () => v.input.createdAt,
    })
    expect(cred).toEqual(v.output.event)
    const participant = getPublicKey(sk)

    const asPerson = verifyDeviceCredential(cred, { identity: participant, now: fx.NOW })
    expect(asPerson).toEqual(v.expected.asPerson)
    expect(asPerson).toEqual({ ok: true, participant, device: v.input.devicePubkey })

    const roomId = deriveRoom(fx.ROOM_SECRET_1).roomId
    const withoutAcceptPerson = verifyDeviceCredential(cred, { roomId, now: fx.NOW })
    expect(withoutAcceptPerson).toEqual(v.expected.asRoomWithoutAcceptPerson)
    expect(withoutAcceptPerson).toEqual({ ok: false, reason: 'person credential where a room credential was expected' })

    const withAcceptPerson = verifyDeviceCredential(cred, { roomId, now: fx.NOW, acceptPerson: true })
    expect(withAcceptPerson).toEqual(v.expected.asRoomWithAcceptPerson)
    expect(withAcceptPerson).toEqual({ ok: true, participant, device: v.input.devicePubkey })
  })

  it('valid-at-exactly-30-day-boundary: accepted at exactly the boundary, minted through the real createDeviceCredential (M15, accepted side)', async () => {
    const v = vec('personCredential', 'valid-at-exactly-30-day-boundary')
    expect(v.input.expiresAt - v.input.createdAt).toBe(PERSON_CREDENTIAL_MAX_SECONDS)
    const sk = hexToBytes(v.input.participantSkHex)
    const cred = await createDeviceCredential({
      identity: identityFor(sk, hexToBytes(v.input.auxRandHex)),
      devicePubkey: v.input.devicePubkey,
      scope: 'person',
      expiresAt: v.input.expiresAt,
      now: () => v.input.createdAt,
    })
    expect(cred).toEqual(v.output.event)
    const result = verifyDeviceCredential(cred, { identity: getPublicKey(sk), now: v.input.createdAt })
    expect(result).toEqual(v.output.result)
    expect(result).toEqual({ ok: true, participant: getPublicKey(sk), device: v.input.devicePubkey })
  })

  it('refused-over-30-days: the verifier refuses an expiry more than 30 days past mint, regardless of who minted it (M15, refused side)', () => {
    const v = vec('personCredential', 'refused-over-30-days')
    expect(v.input.expiresAt - v.input.createdAt).toBe(PERSON_CREDENTIAL_MAX_SECONDS + 1)
    const tags = [
      ['d', getPublicKey(hexToBytes(v.input.participantSkHex))],
      ['device', v.input.devicePubkey],
      ['expiration', String(v.input.expiresAt)],
      ['scope', 'person'],
    ]
    const event = finalizeDeterministic(
      { kind: KINDS.CREDENTIAL, created_at: v.input.createdAt, tags, content: '' },
      hexToBytes(v.input.participantSkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
    expect(plain(event)).toEqual(v.output.event)
    const result = verifyDeviceCredential(event, { identity: v.input.verify.identity, now: v.input.verify.now })
    expect(result).toEqual(v.output.result)
    expect(result).toEqual({ ok: false, reason: 'longer than 30 days' })
  })
})

// ===========================================================================
// 6. Channels signature
// ===========================================================================

describe('channels signature', () => {
  it('valid-at-epoch-1: the real signChannels reproduces the exact signature, canonical, and verifyChannels accepts either order', () => {
    const v = vec('channelsSignature', 'valid-at-epoch-1')
    expect(canonicalChannels(v.input.channels)).toEqual(v.output.canonical)
    const sig = withStubbedRandomness(randomnessQueue(v), () =>
      signChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, authoritySk: hexToBytes(v.input.authoritySkHex) }),
    )
    expect(sig).toBe(v.output.sig)
    const authority = getPublicKey(hexToBytes(v.input.authoritySkHex))
    expect(verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, sig, authority })).toBe(v.expected.verifiesInGivenOrder)
    expect(verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: [...v.input.channels].reverse(), sig, authority })).toBe(v.expected.verifiesReversed)
  })

  it('refused-at-another-epoch: the real verifyChannels refuses a replay into a new epoch', () => {
    const v = vec('channelsSignature', 'refused-at-another-epoch')
    const result = verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, sig: v.input.sig, authority: v.input.authority })
    expect(result).toBe(false)
    expect(result).toEqual(v.output.result)
  })

  it('refused-wrong-authority: the real verifyChannels refuses a genuine signature checked against the wrong pubkey', () => {
    const v = vec('channelsSignature', 'refused-wrong-authority')
    const result = verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, sig: v.input.sig, authority: v.input.wrongAuthority })
    expect(result).toBe(false)
    expect(result).toEqual(v.output.result)
  })

  it('refused-wrong-room: the real verifyChannels refuses a genuine signature checked against a different room', () => {
    const v = vec('channelsSignature', 'refused-wrong-room')
    expect(v.input.wrongRoomId).not.toBe(v.input.roomId)
    const result = verifyChannels({ roomId: v.input.wrongRoomId, epoch: v.input.epoch, channels: v.input.channels, sig: v.input.sig, authority: v.input.authority })
    expect(result).toBe(false)
    expect(result).toEqual(v.output.result)
  })

  it('refused-reserved-channel-name: canonicalChannels refuses a reserved name', () => {
    const v = vec('channelsSignature', 'refused-reserved-channel-name')
    expect(() => canonicalChannels(v.input.channels)).toThrow(v.output.error)
  })
})
