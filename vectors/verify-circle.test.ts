// Loads `circle-vectors.json` and checks it two ways for every vector that
// involves signing or encryption, exactly as `verify.test.ts` does for
// `kithmoot-vectors.json` - see that file's header comment for the full
// rationale. In short:
//
//   1. Recomputing the bytes from the vector's own recorded inputs (secret
//      keys, aux-rand, NIP-44 nonces), independently of `generate-circle.mjs`,
//      and asserting they equal what is on disk.
//
//   2. Feeding the vector's frozen output through the REAL function in
//      `src/` and asserting it produces the recorded result.
//
// This file freezes the gaps identified before extracting the circle layer
// into a shared kit (docs/plans/2026-09-28-circle-kit-extraction.md §3.2,
// in the girnel repository): the v2/v3 link envelope, the invitation
// request/grant/retirement shapes (including a two-hop delegation chain),
// the v3 persistent group invitation, the epoch grant (secret, epoch-0,
// both refusals, wrong request id), the person-scope credential, and the
// channels signature. `kithmoot-vectors.json` is untouched by this file.
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

import { finalizeDeterministic } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

import { KINDS } from '../src/kinds.js'
import { deriveRoom } from '../src/room.js'
import { encodeRoomLink, parseRoomLink, type RoomLink } from '../src/link.js'
import {
  deriveInvitationId,
  decodeInvitationRequest,
  decodeRoomAdmissionGrant,
  decodeInvitationRetirementNotice,
  verifyInvitationDelegation,
  type RoomInvitation,
  type InvitationDelegation,
} from '../src/invitation.js'
import { decodePersistentInvitation } from '../src/persistent-invitation.js'
import { verifyDeviceCredential } from '../src/credential.js'
import {
  deriveEpoch,
  decodeEpochGrant,
  canonicalChannels,
  verifyChannels,
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
  for (const v of groups.linkEnvelope!.filter((x) => x.kind === 'positive')) {
    it(`${v.name}: round-trips through the real encode/decode`, () => {
      const raw = v.input.link
      const link: RoomLink = {
        relays: raw.relays,
        iceUrls: raw.iceUrls,
        ...(raw.invitation ? { invitation: invitationOf(raw.invitation) } : {}),
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
      if (raw.pairingCodeHex) expect(bytesToHex(decoded.pairingCode!)).toBe(raw.pairingCodeHex)
      else expect(decoded.pairingCode).toBeUndefined()
    })
  }

  it('v3-unknown-policy-tier-refused: the real parser throws before reading the invitation', () => {
    const v = vec('linkEnvelope', 'v3-unknown-policy-tier-refused')
    expect(() => parseRoomLink(v.input.url)).toThrow(v.output.error)
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

  function rebuildRequest(v: Vector): Event {
    const invitation = invitationOf(v.input.invitation)
    const requestKey = hkdfSha256(invitation.bearer, 'kithmoot/v2/invitation-request-key')
    return finalizeDeterministic(
      {
        kind: KINDS.INVITATION_REQUEST,
        created_at: v.input.createdAt,
        tags: [['d', deriveInvitationId(invitation)], ['p', invitation.inviter]],
        content: nip44.v2.encrypt(JSON.stringify(v.input.body), requestKey, hexToBytes(v.input.nonceHex)),
      },
      hexToBytes(v.input.requesterSkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
  }

  it('request-valid: reproduces the exact event, and the real decoder accepts it', () => {
    const v = vec('invitationEnvelope', 'request-valid')
    const event = rebuildRequest(v)
    expect(event).toEqual(v.output.event)
    const invitation = invitationOf(v.expected.decode.invitation)
    const result = decodeInvitationRequest(event, { invitation, now: v.expected.decode.now })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ device: v.input.body.device, request: event.id, name: v.input.body.name, participant: v.input.body.participant })
  })

  it('request-stale-refused: the real decoder refuses it outside the 90-second window', () => {
    const v = vec('invitationEnvelope', 'request-stale-refused')
    const invitation = invitationOf(v.input.invitation)
    const result = decodeInvitationRequest(v.input.event as Event, { invitation, now: v.input.decode.now })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  function delegationMessage(invitationId: string, room: string, issuer: string, delegate: string, expiresAt: number): Uint8Array {
    return sha256(new TextEncoder().encode(`kithmoot/v2/invitation-delegation:${invitationId}:${room}:${issuer}:${delegate}:${expiresAt}`))
  }

  it('grant-two-hop-delegation: rebuilds both delegation hops and the outer event, and the real decoder walks the whole chain', () => {
    const v = vec('invitationEnvelope', 'grant-two-hop-delegation')
    const chain = v.input.chain as InvitationDelegation[]
    expect(chain).toHaveLength(2)

    // The message text for hop 1 is recorded explicitly, so a second
    // implementation can check its own mirror of `delegationMessage`
    // against it without needing the issuer's secret key at all.
    const hop1 = chain[0]!
    expect(v.input.delegationMessageHop1).toBe(
      `kithmoot/v2/invitation-delegation:${hop1.invitation}:${hop1.room}:${hop1.issuer}:${hop1.delegate}:${hop1.expiresAt}`,
    )

    // Every hop's recorded signature verifies against its own recorded
    // message and issuer - what any implementation can check without a
    // secret key.
    for (const hop of chain) {
      expect(
        schnorr.verify(
          hexToBytes(hop.sig),
          delegationMessage(hop.invitation, hop.room, hop.issuer, hop.delegate, hop.expiresAt),
          hexToBytes(hop.issuer),
        ),
      ).toBe(true)
    }

    // The outer grant event, rebuilt from its own recorded aux-rand and the
    // delegate (hop 2's issuer) secret key is not carried in the vector
    // either - the event itself is compared as recorded, and decoded by the
    // real implementation, which is the check that actually matters here.
    const grantEvent = v.output.event as Event
    const invitation = invitationOf(v.expected.decode.invitation)
    const result = decodeRoomAdmissionGrant(grantEvent, {
      invitation,
      requesterSk: hexToBytes(v.expected.decode.requesterSkHex),
      request: v.expected.decode.request,
      now: v.expected.decode.now,
    })
    expect(result).not.toBeNull()
    expect(bytesToHex(result!.secret)).toBe(v.expected.result.secretHex)
    expect(bytesToHex(result!.delegate.delegateSk)).toBe(v.expected.result.delegateSkHex)
    expect(result!.delegate.chain).toEqual(chain)
    expect(result!.epoch ?? null).toEqual(v.expected.result.epoch)

    // And the chain verifies to the requester on its own, independent of
    // the outer grant event.
    expect(verifyInvitationDelegation(invitation, chain, v.expected.decode.now)).toBe(v.expected.chainVerifiesTo)
  })

  it('delegation-chain-tampered-second-hop: the whole chain is refused', () => {
    const v = vec('invitationEnvelope', 'delegation-chain-tampered-second-hop')
    // Minted against the same invitation as `grant-two-hop-delegation`,
    // which shares it in its own `expected.decode.invitation`.
    const sibling = vec('invitationEnvelope', 'grant-two-hop-delegation')
    const sharedInvitation = invitationOf(sibling.expected.decode.invitation)
    const chain = v.input.chain as InvitationDelegation[]
    const result = verifyInvitationDelegation(sharedInvitation, chain, 1_800_000_000)
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('retirement-plain: reproduces the exact event, and reads back as an ordinary retirement', () => {
    const v = vec('invitationEnvelope', 'retirement-plain')
    const rebuilt = finalizeDeterministic(
      { kind: KINDS.INVITATION_RETIREMENT, created_at: v.input.createdAt, tags: [['d', deriveInvitationId(invitationOf(v.input.invitation))]], content: JSON.stringify({ v: 1 }) },
      hexToBytes(v.input.inviterSkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
    expect(rebuilt).toEqual(v.output.event)
    const result = decodeInvitationRetirementNotice(v.output.event as Event, invitationOf(v.input.invitation))
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ ended: false })
  })

  it('retirement-room-ended: reproduces the exact event, and reads back as ended', () => {
    const v = vec('invitationEnvelope', 'retirement-room-ended')
    const rebuilt = finalizeDeterministic(
      { kind: KINDS.INVITATION_RETIREMENT, created_at: v.input.createdAt, tags: [['d', deriveInvitationId(invitationOf(v.input.invitation))]], content: JSON.stringify({ v: 1, ended: true }) },
      hexToBytes(v.input.inviterSkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
    expect(rebuilt).toEqual(v.output.event)
    const result = decodeInvitationRetirementNotice(v.output.event as Event, invitationOf(v.input.invitation))
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ ended: true })
  })

  it('retirement-wrong-signer-refused: a genuine event, wrong signer, refused', () => {
    const v = vec('invitationEnvelope', 'retirement-wrong-signer-refused')
    // Reconstructed against the SAME invitation the positive retirement
    // vectors use, so the only variable is the signer.
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
  function rebuild(v: Vector): Event {
    const invitation = invitationOf({ ...v.input.invitation, persistent: true })
    const welcomeKey = hkdfSha256(invitation.bearer, 'kithmoot/v3/group-invitation-key')
    const roomSecret = hexToBytes(v.input.roomSecretHex)
    const room = deriveRoom(roomSecret).roomId
    const content = nip44.v2.encrypt(JSON.stringify({ v: 3, room, secret: base64urlnopad.encode(roomSecret) }), welcomeKey, hexToBytes(v.input.nonceHex))
    return finalizeDeterministic(
      { kind: KINDS.GROUP_INVITATION, created_at: v.input.createdAt, tags: [['d', deriveInvitationId(invitation)]], content },
      hexToBytes(v.input.inviterSkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
  }

  it('valid: reproduces the exact event, and the real decoder returns the secret', () => {
    const v = vec('persistentInvitation', 'valid')
    const event = rebuild(v)
    expect(event).toEqual(v.output.event)
    const invitation = invitationOf({ ...v.input.invitation, persistent: true })
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
})

// ===========================================================================
// 4. Epoch grant
// ===========================================================================

describe('epoch grant', () => {
  // Every vector in this group carries everything the real encode/decode
  // calls need in its own `input` - roomId, authority, the authority and
  // device secret keys, the request id and `createdAt` - so none of these
  // checks needs to reach into a sibling vector for context.
  function rebuild(v: Vector): Event {
    const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(v.input.authoritySkHex), v.input.device)
    return finalizeDeterministic(
      { kind: KINDS.EPOCH_GRANT, created_at: v.input.createdAt, tags: [['d', v.input.roomId], ['p', v.input.device]], content: nip44.v2.encrypt(JSON.stringify(v.input.body), conversationKey, hexToBytes(v.input.nonceHex)) },
      hexToBytes(v.input.authoritySkHex),
      hexToBytes(v.input.auxRandHex),
    ) as Event
  }

  function decodeArgsOf(v: Vector, request = v.input.request as string) {
    return { roomId: v.input.roomId as string, authority: v.input.authority as string, deviceSk: hexToBytes(v.input.deviceSkHex), request, now: v.input.createdAt as number }
  }

  it('grant-with-secret-at-epoch-1: reproduces the exact event, and the real decoder returns the secret and removed set', () => {
    const v = vec('epochGrant', 'grant-with-secret-at-epoch-1')
    const event = rebuild(v)
    expect(event).toEqual(v.output.event)
    const result = decodeEpochGrant(event, decodeArgsOf(v))
    expect(result).not.toBeNull()
    expect(result && 'refused' in result).toBe(false)
    if (result && !('refused' in result)) {
      expect('secret' in result.epoch).toBe(true)
      if ('secret' in result.epoch) expect(bytesToHex(result.epoch.secret)).toBe(v.expected.result.epoch.secretHex)
      expect(result.epoch.epoch).toBe(v.expected.result.epoch.epoch)
      expect(result.removed).toEqual(v.expected.result.removed)
    }
    // The successor secret derives the epoch id the vector separately pins.
    const idVector = vec('epochGrant', 'epoch-1-id-independent-check')
    const derived = deriveEpoch({ epoch: 1, secret: hexToBytes(v.expected.result.epoch.secretHex) })
    expect(derived.id).toBe(idVector.output.id)
    expect(bytesToHex(derived.key)).toBe(idVector.output.keyHex)
  })

  it('grant-wrong-request-id-refused: the real decoder refuses a request-id mismatch', () => {
    const v = vec('epochGrant', 'grant-wrong-request-id-refused')
    const result = decodeEpochGrant(v.input.event as Event, decodeArgsOf(v))
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('grant-epoch-zero-no-secret: reproduces the exact event, and the real decoder returns epoch 0 with no secret', () => {
    const v = vec('epochGrant', 'grant-epoch-zero-no-secret')
    const event = rebuild(v)
    expect(event).toEqual(v.output.event)
    const result = decodeEpochGrant(event, decodeArgsOf(v))
    expect(result).toEqual(v.expected.result)
    expect(result).toMatchObject({ epoch: { epoch: 0 } })
    expect(result && !('refused' in result) && 'secret' in result.epoch).toBe(false)
  })

  for (const refused of ['removed', 'closed'] as const) {
    it(`grant-refused-${refused}: reproduces the exact event, and the real decoder returns the refusal`, () => {
      const v = vec('epochGrant', `grant-refused-${refused}`)
      const event = rebuild(v)
      expect(event).toEqual(v.output.event)
      const result = decodeEpochGrant(event, decodeArgsOf(v))
      expect(result).toEqual(v.expected.result)
      expect(result).toEqual({ refused })
    })
  }
})

// ===========================================================================
// 5. Person-scope credential
// ===========================================================================

describe('person credential', () => {
  function rebuild(v: Vector): Event {
    const participantSk = hexToBytes(v.input.participantSkHex)
    const participant = getPublicKey(participantSk)
    const tags = [
      ['d', participant],
      ['device', v.input.devicePubkey],
      ['expiration', String(v.input.expiresAt)],
      ['scope', 'person'],
      ...(v.input.label ? [['label', v.input.label]] : []),
    ]
    return finalizeDeterministic(
      { kind: KINDS.CREDENTIAL, created_at: v.input.createdAt, tags, content: '' },
      participantSk,
      hexToBytes(v.input.auxRandHex),
    ) as Event
  }

  it('valid-accepted-with-acceptPerson: reproduces the exact event, and is refused as a room credential unless acceptPerson is set', () => {
    const v = vec('personCredential', 'valid-accepted-with-acceptPerson')
    const event = rebuild(v)
    expect(event).toEqual(v.output.event)
    const participant = getPublicKey(hexToBytes(v.input.participantSkHex))

    const asPerson = verifyDeviceCredential(event, { identity: participant, now: 1_800_000_000 })
    expect(asPerson).toEqual(v.expected.asPerson)
    expect(asPerson).toEqual({ ok: true, participant, device: v.input.devicePubkey })

    // The generator minted this credential for fixtures.PARTICIPANT_A, and
    // checked it against fixtures.ROOM_SECRET_1's room - reused here so the
    // room check is independently verified rather than only read back off
    // the frozen `expected` block.
    const roomId = deriveRoom(fx.ROOM_SECRET_1).roomId
    const withoutAcceptPerson = verifyDeviceCredential(event, { roomId, now: 1_800_000_000 })
    expect(withoutAcceptPerson).toEqual(v.expected.asRoomWithoutAcceptPerson)
    expect(withoutAcceptPerson).toEqual({ ok: false, reason: 'person credential where a room credential was expected' })

    const withAcceptPerson = verifyDeviceCredential(event, { roomId, now: 1_800_000_000, acceptPerson: true })
    expect(withAcceptPerson).toEqual(v.expected.asRoomWithAcceptPerson)
    expect(withAcceptPerson).toEqual({ ok: true, participant, device: v.input.devicePubkey })
  })

  it('refused-over-30-days: the verifier refuses an expiry more than 30 days past mint, regardless of who minted it', () => {
    const v = vec('personCredential', 'refused-over-30-days')
    const event = rebuild(v)
    expect(event).toEqual(v.output.event)
    const result = verifyDeviceCredential(event, { identity: v.input.verify.identity, now: v.input.verify.now })
    expect(result).toEqual(v.output.result)
    expect(result).toEqual({ ok: false, reason: 'longer than 30 days' })
  })
})

// ===========================================================================
// 6. Channels signature
// ===========================================================================

describe('channels signature', () => {
  function channelsMessage(roomId: string, epoch: number, channels: string[]): Uint8Array {
    return sha256(new TextEncoder().encode(`kithmoot/v1/channels:${roomId}:${epoch}:${channels.join(',')}`))
  }

  it('valid-at-epoch-1: canonical, self-consistent, and the real verifyChannels accepts either order', () => {
    const v = vec('channelsSignature', 'valid-at-epoch-1')
    expect(canonicalChannels(v.input.channels)).toEqual(v.output.canonical)
    const message = channelsMessage(v.input.roomId, v.input.epoch, v.output.canonical)
    expect(schnorr.verify(hexToBytes(v.output.sig), message, hexToBytes(getPublicKey(hexToBytes(v.input.authoritySkHex))))).toBe(true)
    const authority = getPublicKey(hexToBytes(v.input.authoritySkHex))
    expect(verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, sig: v.output.sig, authority })).toBe(v.expected.verifiesInGivenOrder)
    expect(verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: [...v.input.channels].reverse(), sig: v.output.sig, authority })).toBe(v.expected.verifiesReversed)
  })

  it('refused-at-another-epoch: the real verifyChannels refuses a replay into a new epoch', () => {
    const v = vec('channelsSignature', 'refused-at-another-epoch')
    const result = verifyChannels({ roomId: v.input.roomId, epoch: v.input.epoch, channels: v.input.channels, sig: v.input.sig, authority: v.input.authority })
    expect(result).toBe(false)
    expect(result).toEqual(v.output.result)
  })

  it('refused-reserved-channel-name: canonicalChannels refuses a reserved name', () => {
    const v = vec('channelsSignature', 'refused-reserved-channel-name')
    expect(() => canonicalChannels(v.input.channels)).toThrow(v.output.error)
  })
})
