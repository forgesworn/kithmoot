import { describe, expect, it } from 'vitest'
import { createRoomInvitation, deriveInvitationId } from '../../src/invitation.js'
import { encodeRoomLink } from '../../src/link.js'
import { generateRoomSecret } from '../../src/room.js'
import {
  CONFERENCE_ENDED_PREFIX,
  conferenceEnded,
  conferenceEndedMessage,
  conferenceEndsAt,
  conferenceEndsLine,
  formatConferenceEnd,
} from './conference.js'
import { loadKeptAdmission, memoryDeviceStore, storeKeptAdmission } from './device-store.js'
import { loadInvitationOwner, storeInvitationOwner } from './invitation-store.js'
import { endLapsedConferences, knownRoom, rememberRoom } from './rooms-store.js'

const NOW = 1_800_000_000

describe('conference room choices and wording', () => {
  it('offers never, one, three and seven days, and nothing else', () => {
    expect(conferenceEndsAt(0, NOW)).toBeUndefined()
    expect(conferenceEndsAt(1, NOW)).toBe(NOW + 86_400)
    expect(conferenceEndsAt(3, NOW)).toBe(NOW + 3 * 86_400)
    expect(conferenceEndsAt(7, NOW)).toBe(NOW + 7 * 86_400)
    for (const days of [2, 30, -1, Number.NaN]) expect(conferenceEndsAt(days, NOW)).toBeUndefined()
  })

  it('has ended at its end, not before, and a room with no end never has', () => {
    expect(conferenceEnded(NOW, NOW - 1)).toBe(false)
    expect(conferenceEnded(NOW, NOW)).toBe(true)
    expect(conferenceEnded(undefined, NOW)).toBe(false)
  })

  it('reads as "Sat 4 Oct, 18:00" in local time', () => {
    const at = new Date(2026, 9, 3, 18, 0).getTime() / 1000 // Saturday 3 October 2026
    expect(formatConferenceEnd(at)).toBe('Sat 3 Oct, 18:00')
    expect(formatConferenceEnd(new Date(2026, 0, 5, 9, 7).getTime() / 1000)).toBe('Mon 5 Jan, 09:07')
    expect(conferenceEndsLine(at)).toBe('Ends Sat 3 Oct, 18:00')
    expect(conferenceEndedMessage(at)).toBe('This conference room ended on Sat 3 Oct, 18:00.')
    expect(conferenceEndedMessage(at).startsWith(CONFERENCE_ENDED_PREFIX)).toBe(true)
  })
})

describe('a conference room’s end, kept across reopening', () => {
  it('rides in the owner’s record, the kept admission and the rooms list', () => {
    const store = memoryDeviceStore()
    const host = createRoomInvitation(true)
    const secret = generateRoomSecret()
    const ends = NOW + 86_400
    storeInvitationOwner(store, host.invitation, secret, host.inviterSk, NOW, ends)
    expect(loadInvitationOwner(store, host.invitation, NOW)?.endsAt).toBe(ends)
    const plain = createRoomInvitation(true)
    storeInvitationOwner(store, plain.invitation, secret, plain.inviterSk, NOW)
    expect(loadInvitationOwner(store, plain.invitation, NOW)).not.toHaveProperty('endsAt')

    const id = deriveInvitationId(host.invitation)
    storeKeptAdmission(store, id, { secret, persistent: true, epoch: 0, endsAt: ends }, NOW)
    expect(loadKeptAdmission(store, id, NOW)).toEqual({ secret, persistent: true, epoch: 0, endsAt: ends })
    storeKeptAdmission(store, id, { secret, persistent: true, epoch: 0 }, NOW)
    expect(loadKeptAdmission(store, id, NOW)).toEqual({ secret, persistent: true, epoch: 0 })
  })

  it('a corrupted end is refused rather than read as no end', () => {
    const store = memoryDeviceStore()
    const host = createRoomInvitation(true)
    const secret = generateRoomSecret()
    storeInvitationOwner(store, host.invitation, secret, host.inviterSk, NOW, NOW + 60)
    const key = store.keys().find(k => k.includes(deriveInvitationId(host.invitation)))!
    store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)!), ends: 'soon' }))
    expect(loadInvitationOwner(store, host.invitation, NOW)).toBeUndefined()
  })

  it('the list marks a conference room ended once its end has come, and keeps the end across a new link', () => {
    const store = memoryDeviceStore()
    const roomId = 'e'.repeat(64)
    const link = encodeRoomLink('https://example.test/j/', { invitation: createRoomInvitation(true).invitation, relays: [], iceUrls: [] })
    const ends = NOW + 60
    rememberRoom(store, { roomId, link, openedAt: NOW, endsAt: ends })
    expect(knownRoom(store, roomId)?.endsAt).toBe(ends)
    // A rotated link, remembered without saying when the room ends: the end stays.
    const rotated = encodeRoomLink('https://example.test/j/', { invitation: createRoomInvitation(true).invitation, relays: [], iceUrls: [] })
    rememberRoom(store, { roomId, link: rotated, openedAt: NOW + 1 })
    expect(knownRoom(store, roomId)?.endsAt).toBe(ends)
    expect(endLapsedConferences(store, ends - 1)).toEqual([])
    expect(knownRoom(store, roomId)?.endedAt).toBeUndefined()
    expect(endLapsedConferences(store, ends + 5)).toEqual([roomId])
    expect(knownRoom(store, roomId)?.endedAt).toBe(ends)
    expect(endLapsedConferences(store, ends + 10)).toEqual([])
  })
})
