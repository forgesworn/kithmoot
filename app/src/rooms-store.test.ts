import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { loadKeptAdmission, memoryDeviceStore, storeKeptAdmission } from './device-store.js'
import {
  ROOM_PREFIX,
  forgetRoom,
  knownRoom,
  knownRooms,
  markRead,
  rememberRoom,
  roomLabel,
  setKeepRoom,
  unreadCount,
} from './rooms-store.js'
import { createRoomInvitation, deriveInvitationId } from '../../src/invitation.js'
import { parseRoomLink } from '../../src/link.js'
import { encodeRoomLink } from '../../src/link.js'
import { encodeJoinUrl } from '../../src/room.js'

const NOW = 1_800_000_000
const BASE = 'https://example.test/j/'
const ROOM_A = 'a'.repeat(64)
const ROOM_B = 'b'.repeat(64)

function invitationLink(extra: { name?: string; pairingCode?: Uint8Array } = {}): string {
  const { invitation } = createRoomInvitation()
  return encodeRoomLink(BASE, { invitation, relays: ['wss://relay.example'], iceUrls: [], ...extra })
}

describe('the rooms this device has been in', () => {
  it('writes a room down on a visit, and lists the most recently opened first', () => {
    const store = memoryDeviceStore()
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink({ name: 'Town hall' }), openedAt: NOW })
    rememberRoom(store, { roomId: ROOM_B, link: invitationLink({ name: 'Bench' }), openedAt: NOW + 60 })
    expect(knownRooms(store).map((r) => r.name)).toEqual(['Bench', 'Town hall'])
    expect(knownRoom(store, ROOM_A)?.readAt).toBe(0)
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink({ name: 'Town hall' }), openedAt: NOW + 120 })
    expect(knownRooms(store).map((r) => r.name)).toEqual(['Town hall', 'Bench'])
  })

  it('takes the name off the link when none is given, keeps the held one when the link has none, and prefers a given one', () => {
    const store = memoryDeviceStore()
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink({ name: 'Off the link' }), openedAt: NOW })
    expect(knownRoom(store, ROOM_A)?.name).toBe('Off the link')
    // A later link to the same room with no name on it does not unname it.
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink(), openedAt: NOW + 1 })
    expect(knownRoom(store, ROOM_A)?.name).toBe('Off the link')
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink({ name: 'On the link' }), name: 'Given', openedAt: NOW + 2 })
    expect(knownRoom(store, ROOM_A)?.name).toBe('Given')
  })

  it('shows a room by its name, or by enough of its id to tell it from the next', () => {
    expect(roomLabel({ roomId: ROOM_A, name: 'Bench' })).toBe('Bench')
    expect(roomLabel({ roomId: ROOM_A })).toBe('Room aaaaaaaa')
  })

  it('sanitises a name like a display name, wherever it came from', () => {
    const store = memoryDeviceStore()
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink(), name: '  Town​ hall\n2  ', openedAt: NOW })
    expect(knownRoom(store, ROOM_A)?.name).toBe('Town hall 2')
    // Even a name somebody wrote straight into storage.
    store.set(ROOM_PREFIX + ROOM_B, JSON.stringify({ link: invitationLink(), openedAt: NOW, name: 'x'.repeat(100) }))
    expect(knownRoom(store, ROOM_B)?.name).toHaveLength(32)
  })

  it('never keeps a pairing link, and refuses a link or an id it cannot read', () => {
    const store = memoryDeviceStore()
    expect(() =>
      rememberRoom(store, { roomId: ROOM_A, link: invitationLink({ pairingCode: new Uint8Array(16).fill(1) }), openedAt: NOW }),
    ).toThrow(/pairing/)
    expect(() => rememberRoom(store, { roomId: ROOM_A, link: BASE, openedAt: NOW })).toThrow(/fragment/)
    expect(() => rememberRoom(store, { roomId: 'not-a-room', link: invitationLink(), openedAt: NOW })).toThrow(/room id/)
    expect(knownRooms(store)).toEqual([])
  })

  it('keeps a legacy secret link as it is, since that is what opens the room', () => {
    const store = memoryDeviceStore()
    const link = encodeJoinUrl(BASE, new Uint8Array(32).fill(5), ['wss://relay.example'])
    rememberRoom(store, { roomId: ROOM_A, link, openedAt: NOW })
    expect(knownRoom(store, ROOM_A)?.link).toBe(link)
  })

  it('marks how far the chat has been read, only ever forwards, and only for a room it knows', () => {
    const store = memoryDeviceStore()
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink(), openedAt: NOW })
    expect(markRead(store, ROOM_A, NOW + 10)).toBe(true)
    expect(knownRoom(store, ROOM_A)?.readAt).toBe(NOW + 10)
    expect(markRead(store, ROOM_A, NOW + 5)).toBe(true)
    expect(knownRoom(store, ROOM_A)?.readAt).toBe(NOW + 10)
    expect(markRead(store, ROOM_B, NOW + 10)).toBe(false)
    expect(markRead(store, ROOM_A, Number.NaN)).toBe(false)
    // A later visit does not reset it.
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink(), openedAt: NOW + 100 })
    expect(knownRoom(store, ROOM_A)?.readAt).toBe(NOW + 10)
  })

  it('counts what is newer than the room was read to', () => {
    const messages = [{ sentAt: NOW - 10 }, { sentAt: NOW }, { sentAt: NOW + 1 }, { sentAt: NOW + 2 }]
    expect(unreadCount(messages, 0)).toBe(4)
    expect(unreadCount(messages, NOW)).toBe(2)
    expect(unreadCount(messages, NOW + 2)).toBe(0)
    expect(unreadCount([], 0)).toBe(0)
  })

  it('forgets a room and nothing else', () => {
    const store = memoryDeviceStore()
    rememberRoom(store, { roomId: ROOM_A, link: invitationLink(), openedAt: NOW })
    rememberRoom(store, { roomId: ROOM_B, link: invitationLink(), openedAt: NOW })
    store.set('kithmoot.device.' + ROOM_A, 'a device key, left alone')
    forgetRoom(store, ROOM_A)
    expect(knownRoom(store, ROOM_A)).toBeUndefined()
    expect(knownRooms(store).map((r) => r.roomId)).toEqual([ROOM_B])
    expect(store.get('kithmoot.device.' + ROOM_A)).toBe('a device key, left alone')
  })

  it('does not choke on a stored value somebody else wrote', () => {
    const store = memoryDeviceStore()
    store.set(ROOM_PREFIX + ROOM_A, 'not json')
    store.set(ROOM_PREFIX + ROOM_B, JSON.stringify({ openedAt: 'yesterday' }))
    store.set(ROOM_PREFIX + 'short', JSON.stringify({ link: invitationLink(), openedAt: NOW }))
    expect(knownRooms(store)).toEqual([])
    expect(knownRoom(store, ROOM_A)).toBeUndefined()
  })

  it('keeps a room only when asked, remembers the choice across visits, and turning it off removes what was kept', () => {
    const store = memoryDeviceStore()
    const link = invitationLink({ name: 'Town hall' })
    const invitationId = deriveInvitationId(parseRoomLink(link).invitation!)
    rememberRoom(store, { roomId: ROOM_A, link, openedAt: NOW })
    expect(knownRoom(store, ROOM_A)?.keep).toBeUndefined()
    expect(setKeepRoom(store, ROOM_B, true)).toBe(false)

    expect(setKeepRoom(store, ROOM_A, true)).toBe(true)
    expect(knownRoom(store, ROOM_A)?.keep).toBe(true)
    rememberRoom(store, { roomId: ROOM_A, link, openedAt: NOW + 60 })
    expect(knownRoom(store, ROOM_A)?.keep).toBe(true)

    const admission = { secret: new Uint8Array(32).fill(1), delegate: { delegateSk: generateSecretKey(), chain: [] } }
    storeKeptAdmission(store, invitationId, admission, NOW)
    setKeepRoom(store, ROOM_A, false)
    expect(knownRoom(store, ROOM_A)?.keep).toBeUndefined()
    expect(loadKeptAdmission(store, invitationId, NOW)).toBeUndefined()
  })

  it('forgetting a room takes the admission kept for it too', () => {
    const store = memoryDeviceStore()
    const link = invitationLink()
    const invitationId = deriveInvitationId(parseRoomLink(link).invitation!)
    rememberRoom(store, { roomId: ROOM_A, link, openedAt: NOW })
    setKeepRoom(store, ROOM_A, true)
    storeKeptAdmission(store, invitationId, { secret: new Uint8Array(32).fill(2), delegate: { delegateSk: generateSecretKey(), chain: [] } }, NOW)
    forgetRoom(store, ROOM_A)
    expect(knownRoom(store, ROOM_A)).toBeUndefined()
    expect(loadKeptAdmission(store, invitationId, NOW)).toBeUndefined()
  })
})
