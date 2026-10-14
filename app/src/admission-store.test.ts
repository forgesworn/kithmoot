import { expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { roomInvitation, deriveInvitationId, encodeInvitationGrant, decodeRoomAdmissionGrant } from '../../src/invitation.js'
import { memoryDeviceStore } from './device-store.js'
import { storeTabAdmission, TAB_ADMISSION_PREFIX } from './admission-store.js'

it('preserves the actual temporary admission cache bytes, including the delegate chain', () => {
  const inviterSk = new Uint8Array(32); inviterSk[31] = 1
  const requesterSk = new Uint8Array(32); requesterSk[31] = 2
  const invitation = roomInvitation(new Uint8Array(32).fill(7), getPublicKey(inviterSk))
  const event = encodeInvitationGrant({ invitation, inviterSk, requester: getPublicKey(requesterSk), request: 'a'.repeat(64),
    roomSecret: new Uint8Array(32).fill(9), now: 100, epoch: 2, delegationTtlSeconds: 30 })
  const admission = decodeRoomAdmissionGrant(event, { invitation, requesterSk, request: 'a'.repeat(64), now: 100 })!
  const store = memoryDeviceStore(); storeTabAdmission(store, invitation, admission)
  expect(store.keys()).toEqual([TAB_ADMISSION_PREFIX + deriveInvitationId(invitation)])
  expect(store.get(store.keys()[0]!)).toBe(JSON.stringify({ roomSecret: bytesToHex(admission.secret),
    delegateSk: bytesToHex(admission.delegate.delegateSk), delegation: admission.delegate.chain, epoch: 2 }))
})

it('preserves group cache bytes and leaves evidence and routing to the protected adapter', () => {
  const inviterSk = new Uint8Array(32); inviterSk[31] = 1
  const invitation = roomInvitation(new Uint8Array(32).fill(7), getPublicKey(inviterSk), true)
  const store = memoryDeviceStore()
  storeTabAdmission(store, invitation, { secret: new Uint8Array(32).fill(9), persistent: true, epoch: 0,
    endsAt: 200, destruct: true, relays: ['wss://signed.example'] })
  expect(store.get(TAB_ADMISSION_PREFIX + deriveInvitationId(invitation))).toBe(
    JSON.stringify({ roomSecret: '09'.repeat(32), persistent: true, epoch: 0, ends: 200, destruct: true }))
})
