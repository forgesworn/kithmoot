import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import {
  createRoomInvitation,
  decodeInvitationGrant,
  decodeInvitationRequest,
  deriveInvitationId,
  encodeInvitationGrant,
  encodeInvitationRequest,
  encodeInvitationRetirement,
  hostRoomInvitation,
  requestRoomAdmission,
  requestRoomAdmissionCapability,
  roomInvitation,
  verifyInvitationDelegation,
} from './invitation.js'

const NOW = 1_800_000_000
const now = () => NOW

describe('room invitations', () => {
  it('creates an unlinkable bearer and a matching one-use inviter key', () => {
    const a = createRoomInvitation()
    const b = createRoomInvitation()

    expect(a.invitation.bearer).toHaveLength(32)
    expect(a.inviterSk).toHaveLength(32)
    expect(a.invitation.inviter).toBe(getPublicKey(a.inviterSk))
    expect(deriveInvitationId(a.invitation)).toMatch(/^[0-9a-f]{64}$/)
    expect(deriveInvitationId(a.invitation)).not.toBe(deriveInvitationId(b.invitation))
  })

  it('rejects malformed capabilities at the URL boundary', () => {
    expect(() => roomInvitation(new Uint8Array(16), 'a'.repeat(64))).toThrow(/32 bytes/)
    expect(() => roomInvitation(new Uint8Array(32), 'not-a-pubkey')).toThrow(/pubkey/)
  })
})

describe('invitation envelopes', () => {
  it('accepts a fresh request that proves possession of the bearer', () => {
    const host = createRoomInvitation()
    const requesterSk = generateSecretKey()
    const event = encodeInvitationRequest({ invitation: host.invitation, requesterSk, now: NOW })

    expect(decodeInvitationRequest(event, { invitation: host.invitation, now: NOW })).toEqual({
      device: getPublicKey(requesterSk),
      request: event.id,
    })
  })

  it('rejects the request with a different bearer, addressee, or stale timestamp', () => {
    const host = createRoomInvitation()
    const event = encodeInvitationRequest({
      invitation: host.invitation,
      requesterSk: generateSecretKey(),
      now: NOW,
    })
    const differentBearer = roomInvitation(new Uint8Array(32).fill(9), host.invitation.inviter)
    const differentInviter = roomInvitation(host.invitation.bearer, getPublicKey(generateSecretKey()))

    expect(decodeInvitationRequest(event, { invitation: differentBearer, now: NOW })).toBeNull()
    expect(decodeInvitationRequest(event, { invitation: differentInviter, now: NOW })).toBeNull()
    expect(decodeInvitationRequest(event, { invitation: host.invitation, now: NOW + 91 })).toBeNull()
  })

  it('accepts only a room secret from the pinned inviter, for this request and requester', () => {
    const host = createRoomInvitation()
    const requesterSk = generateSecretKey()
    const request = encodeInvitationRequest({ invitation: host.invitation, requesterSk, now: NOW })
    const roomSecret = new Uint8Array(32).fill(44)
    const grant = encodeInvitationGrant({
      invitation: host.invitation,
      inviterSk: host.inviterSk,
      requester: getPublicKey(requesterSk),
      request: request.id,
      roomSecret,
      now: NOW,
    })

    expect(
      bytesToHex(
        decodeInvitationGrant(grant, {
          invitation: host.invitation,
          requesterSk,
          request: request.id,
          now: NOW,
        })!,
      ),
    ).toBe(bytesToHex(roomSecret))
    expect(
      decodeInvitationGrant(grant, {
        invitation: host.invitation,
        requesterSk,
        request: 'f'.repeat(64),
        now: NOW,
      }),
    ).toBeNull()
    expect(
      decodeInvitationGrant(grant, {
        invitation: host.invitation,
        requesterSk: generateSecretKey(),
        request: request.id,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('refuses a grant signed by somebody other than the inviter in the link', () => {
    const genuine = createRoomInvitation()
    const impostor = createRoomInvitation()
    const requesterSk = generateSecretKey()
    const request = encodeInvitationRequest({ invitation: genuine.invitation, requesterSk, now: NOW })

    // An impostor can make a perfectly valid room and response under their
    // own key. Pinning `inviter` in the link is what makes that response the
    // wrong one rather than a convincing substitution.
    const impostorGrant = encodeInvitationGrant({
      invitation: impostor.invitation,
      inviterSk: impostor.inviterSk,
      requester: getPublicKey(requesterSk),
      request: request.id,
      roomSecret: new Uint8Array(32).fill(8),
      now: NOW,
    })
    expect(
      decodeInvitationGrant(impostorGrant, {
        invitation: genuine.invitation,
        requesterSk,
        request: request.id,
        now: NOW,
      }),
    ).toBeNull()
  })
})

describe('invitation exchange', () => {
  it('turns a bearer into the room secret without putting that secret in the request', async () => {
    const relay = new SimRelay()
    const host = createRoomInvitation()
    const roomSecret = new Uint8Array(32).fill(73)
    const serving = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: host.invitation,
      inviterSk: host.inviterSk,
      roomSecret,
      now,
    })

    const admitted = await requestRoomAdmission({
      transport: new SimTransport(relay),
      invitation: host.invitation,
      now,
    })
    serving.close()

    expect(bytesToHex(admitted)).toBe(bytesToHex(roomSecret))
    const requestWire = JSON.stringify(
      relay.published.filter((event) => event.kind === 20466),
    )
    expect(requestWire).not.toContain(bytesToHex(roomSecret))
  })

  it('lets an admitted member keep the same link alive after the creator leaves', async () => {
    const relay = new SimRelay()
    const root = createRoomInvitation()
    const roomSecret = new Uint8Array(32).fill(74)
    const creator = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: root.inviterSk,
      roomSecret,
      now,
    })

    const first = await requestRoomAdmissionCapability({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      now,
    })
    const firstRequest = relay.published.find((event) => event.kind === 20466)!
    creator.close()

    let memberAdmissions = 0
    const member = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: first.delegate.delegateSk,
      delegation: first.delegate.chain,
      roomSecret: first.secret,
      now,
      onAdmitted: () => { memberAdmissions += 1 },
    })
    // Lenient public relays sometimes replay ephemeral requests to a new
    // subscription. The member must not grant its own original request.
    await new SimTransport(relay).publish(firstRequest)
    expect(memberAdmissions).toBe(0)
    const second = await requestRoomAdmission({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      now,
    })
    member.close()

    expect(bytesToHex(second)).toBe(bytesToHex(roomSecret))
    expect(memberAdmissions).toBe(1)
    expect(first.delegate.chain).toHaveLength(1)
    expect(
      verifyInvitationDelegation(root.invitation, first.delegate.chain, NOW),
    ).toBe(getPublicKey(first.delegate.delegateSk))
  })

  it('rejects a tampered delegation chain', async () => {
    const relay = new SimRelay()
    const root = createRoomInvitation()
    const creator = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: root.inviterSk,
      roomSecret: new Uint8Array(32).fill(75),
      now,
    })
    const admitted = await requestRoomAdmissionCapability({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      now,
    })
    creator.close()

    const tampered = admitted.delegate.chain.map((cert) => ({ ...cert, delegate: 'a'.repeat(64) }))
    expect(verifyInvitationDelegation(root.invitation, tampered, NOW)).toBeNull()
    expect(() => hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: admitted.delegate.delegateSk,
      delegation: tampered,
      roomSecret: admitted.secret,
      now,
    })).toThrow(/not delegated/)
    expect(() => hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: admitted.delegate.delegateSk,
      delegation: admitted.delegate.chain,
      roomSecret: new Uint8Array(32).fill(99),
      now,
    })).toThrow(/another room/)
  })

  it('stops delegated responders when the creator retires the link', async () => {
    const relay = new SimRelay()
    const root = createRoomInvitation()
    const roomSecret = new Uint8Array(32).fill(76)
    const creator = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: root.inviterSk,
      roomSecret,
      now,
    })
    const admitted = await requestRoomAdmissionCapability({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      now,
    })
    creator.close()

    let retired = false
    hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      inviterSk: admitted.delegate.delegateSk,
      delegation: admitted.delegate.chain,
      roomSecret,
      now,
      onRetired: () => { retired = true },
    })
    await new SimTransport(relay).publish(encodeInvitationRetirement({
      invitation: root.invitation,
      inviterSk: root.inviterSk,
      now: NOW,
    }))

    expect(retired).toBe(true)
    await expect(requestRoomAdmission({
      transport: new SimTransport(relay),
      invitation: root.invitation,
      now,
      timeoutMs: 30,
      retryMs: 10,
    })).rejects.toThrow(/not answering/)
  })

  it('retires a link for future admissions when its host is closed', async () => {
    const relay = new SimRelay()
    const host = createRoomInvitation()
    const serving = hostRoomInvitation({
      transport: new SimTransport(relay),
      invitation: host.invitation,
      inviterSk: host.inviterSk,
      roomSecret: new Uint8Array(32).fill(1),
      now,
    })
    serving.close()

    await expect(
      requestRoomAdmission({
        transport: new SimTransport(relay),
        invitation: host.invitation,
        now,
        timeoutMs: 30,
        retryMs: 10,
      }),
    ).rejects.toThrow(/not answering/)
  })

  it('fails an in-flight admission immediately on the creator tombstone', async () => {
    const relay = new SimRelay()
    const host = createRoomInvitation()
    const waiting = requestRoomAdmission({
      transport: new SimTransport(relay),
      invitation: host.invitation,
      now,
      timeoutMs: 1_000,
    })
    await new SimTransport(relay).publish(encodeInvitationRetirement({
      invitation: host.invitation,
      inviterSk: host.inviterSk,
      now: NOW,
    }))
    await expect(waiting).rejects.toThrow(/retired/)
  })
})
