import { describe, expect, it } from 'vitest'
import { createRoomInvitation } from '../../src/invitation.js'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { memoryDeviceStore, loadKeptAdmission, storeKeptAdmission } from './device-store.js'
import { forgetRoomAccess, loadInvitationOwner, storeInvitationOwner } from './invitation-store.js'
import { encodeRoomLink } from '../../src/link.js'
import { rememberRoom, setKeepRoom } from './rooms-store.js'

const NOW = 1_800_000_000
describe('persistent membership recovery', () => {
  it('keeps group membership and creator authority weeks later; meetings still expire', () => {
    const store = memoryDeviceStore()
    const group = createRoomInvitation(true)
    const meeting = createRoomInvitation()
    const secret = generateRoomSecret()
    for (const host of [group, meeting]) storeInvitationOwner(store, host.invitation, secret, host.inviterSk, NOW)
    storeKeptAdmission(store, 'group', { secret, persistent: true, epoch: 0 }, NOW)
    expect(loadInvitationOwner(store, group.invitation, NOW + 30 * 86400)?.inviterSk).toEqual(group.inviterSk)
    expect(loadKeptAdmission(store, 'group', NOW + 30 * 86400)?.secret).toEqual(secret)
    expect(loadInvitationOwner(store, meeting.invitation, NOW + 12 * 3600)).toBeUndefined()
  })

  it('a URL change alone cannot make old creator records permanent', () => {
    const store = memoryDeviceStore()
    const host = createRoomInvitation()
    storeInvitationOwner(store, host.invitation, generateRoomSecret(), host.inviterSk, NOW)
    expect(loadInvitationOwner(store, { ...host.invitation, persistent: true }, NOW + 86400)).toBeUndefined()
  })

  it('opening an old meeting link cannot erase authority after conversion to a group', () => {
    const store = memoryDeviceStore()
    const host = createRoomInvitation()
    const group = { ...host.invitation, persistent: true as const }
    storeInvitationOwner(store, group, generateRoomSecret(), host.inviterSk, NOW)
    expect(loadInvitationOwner(store, host.invitation, NOW + 86400)?.inviterSk).toEqual(host.inviterSk)
    expect(loadInvitationOwner(store, group, NOW + 86400)?.inviterSk).toEqual(host.inviterSk)
  })

  it('forgets every retained link for the room while preserving unrelated rooms', () => {
    const store = memoryDeviceStore()
    const secret = generateRoomSecret()
    const other = generateRoomSecret()
    for (const roomSecret of [secret, secret, other]) {
      const host = createRoomInvitation(true)
      storeInvitationOwner(store, host.invitation, roomSecret, host.inviterSk, NOW)
    }
    storeKeptAdmission(store, 'old-link', { secret, persistent: true, epoch: 0 }, NOW)
    forgetRoomAccess(store, deriveRoom(secret).roomId)
    expect(store.keys()).toHaveLength(1)
    expect(loadKeptAdmission(store, 'old-link', NOW)).toBeUndefined()
  })

  it('remembers groups by default and preserves a deliberate opt-out on later visits', () => {
    const store = memoryDeviceStore()
    const host = createRoomInvitation(true)
    const visit = { roomId: deriveRoom(generateRoomSecret()).roomId, link: encodeRoomLink('https://example.com/', { invitation: host.invitation, relays: [], iceUrls: [] }), openedAt: NOW }
    expect(rememberRoom(store, visit).keep).toBe(true)
    setKeepRoom(store, visit.roomId, false)
    expect(rememberRoom(store, { ...visit, openedAt: NOW + 86400 }).keep).toBe(false)
  })
})
