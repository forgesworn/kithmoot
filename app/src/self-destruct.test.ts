import { describe, expect, it } from 'vitest'
import { DEVICE_KEY_MAX_AGE_SECONDS, deviceKeyFor, loadDeviceKeyFor, loadKeptAdmission, memoryDeviceStore, storeKeptAdmission } from './device-store.js'
import { loadInvitationOwner, storeInvitationOwner } from './invitation-store.js'
import { destructDue, endLapsedConferences, knownRoom, markDestruct, markEnded, rememberRoom } from './rooms-store.js'
import { scrubJson, scrubStore } from './storage-scrub.js'
import { createRoomInvitation, deriveInvitationId } from '../../src/invitation.js'
import { encodeRoomLink } from '../../src/link.js'
import { generateRoomSecret } from '../../src/room.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { formatConferenceEnd } from './conference.js'
import {
  DESTRUCTED_KEY,
  TOMBSTONE_SECONDS,
  addTombstone,
  countdown,
  countdownStage,
  countdownThresholds,
  dismissTombstone,
  finalBannerText,
  remainingSpoken,
  remainingWords,
  stageAnnouncement,
  tombstoneText,
  tombstones,
} from './self-destruct.js'

const DAY = 86_400
const HOUR = 3_600

describe('countdown stages', () => {
  it('scales amber and red with the lifetime', () => {
    // A seven-day room: amber at a day, red at an hour.
    expect(countdownThresholds(7 * DAY)).toEqual({ amber: DAY, red: HOUR })
    // A one-day room: amber at six hours, red at an hour.
    expect(countdownThresholds(DAY)).toEqual({ amber: 6 * HOUR, red: HOUR })
    // A two-minute room: amber at thirty seconds, red at six.
    expect(countdownThresholds(120)).toEqual({ amber: 30, red: 6 })
    // Not known: taken as long.
    expect(countdownThresholds(undefined)).toEqual({ amber: DAY, red: HOUR })
  })

  it('walks green, amber, red, the final minute, then gone', () => {
    expect(countdownStage(4 * DAY, 7 * DAY)).toBe('green')
    expect(countdownStage(DAY + 1, 7 * DAY)).toBe('green')
    expect(countdownStage(DAY, 7 * DAY)).toBe('amber')
    expect(countdownStage(HOUR + 1, 7 * DAY)).toBe('amber')
    expect(countdownStage(HOUR, 7 * DAY)).toBe('red')
    expect(countdownStage(61, 7 * DAY)).toBe('red')
    expect(countdownStage(60, 7 * DAY)).toBe('final')
    expect(countdownStage(1, 7 * DAY)).toBe('final')
    expect(countdownStage(0, 7 * DAY)).toBe('gone')
    expect(countdownStage(-5, 7 * DAY)).toBe('gone')
  })

  it('is not amber from the start of a one-day room', () => {
    expect(countdownStage(DAY, DAY)).toBe('green')
    expect(countdownStage(6 * HOUR + 1, DAY)).toBe('green')
    expect(countdownStage(6 * HOUR, DAY)).toBe('amber')
  })

  it('puts the final minute ahead of amber in a very short room', () => {
    expect(countdownStage(100, 120)).toBe('green')
    expect(countdownStage(60, 120)).toBe('final')
  })
})

describe('countdown words', () => {
  it('says days, then hours and minutes, then a clock once red', () => {
    expect(remainingWords(4 * DAY + 5, 'green')).toBe('4 days')
    expect(remainingWords(DAY + 3 * HOUR, 'green')).toBe('1 day 3 h')
    expect(remainingWords(DAY, 'green')).toBe('1 day')
    expect(remainingWords(5 * HOUR + 12 * 60, 'amber')).toBe('5 h 12 m')
    expect(remainingWords(12 * 60 + 5, 'amber')).toBe('12 m')
    expect(remainingWords(42 * 60 + 7, 'red')).toBe('42:07')
    expect(remainingWords(45, 'final')).toBe('0:45')
  })

  it('spells it out for a screen reader', () => {
    expect(remainingSpoken(5 * HOUR + 12 * 60)).toBe('5 hours 12 minutes')
    expect(remainingSpoken(HOUR)).toBe('1 hour')
    expect(remainingSpoken(4 * DAY)).toBe('4 days')
    expect(remainingSpoken(DAY + HOUR)).toBe('1 day 1 hour')
    expect(remainingSpoken(2 * 60 + 5)).toBe('2 minutes 5 seconds')
    expect(remainingSpoken(42 * 60 + 7)).toBe('42 minutes')
    expect(remainingSpoken(1)).toBe('1 second')
  })

  it('reads "Self-destructs in" for a destruct room and "Ends in" for one that keeps a copy', () => {
    const endsAt = 1_800_000_000
    const startsAt = endsAt - 7 * DAY
    expect(countdown({ endsAt, startsAt, destruct: true, now: endsAt - 4 * DAY })).toEqual({
      stage: 'green', text: 'Self-destructs in 4 days', spoken: 'Self-destructs in 4 days', destruct: true,
    })
    expect(countdown({ endsAt, startsAt, destruct: true, now: endsAt - (5 * HOUR + 12 * 60) })).toMatchObject({
      stage: 'amber', text: 'Self-destructs in 5 h 12 m', spoken: 'Self-destructs in 5 hours 12 minutes',
    })
    expect(countdown({ endsAt, startsAt, destruct: true, now: endsAt - (42 * 60 + 7) })).toMatchObject({ stage: 'red', text: 'Self-destructs in 42:07' })
    expect(countdown({ endsAt, startsAt, destruct: false, now: endsAt - 4 * DAY })).toMatchObject({ text: 'Ends in 4 days', destruct: false })
    expect(countdown({ endsAt, startsAt, destruct: true, now: endsAt })).toMatchObject({ stage: 'gone', text: 'Self-destructed' })
  })

  it('announces stage changes only, and the final minute with what to do', () => {
    expect(stageAnnouncement('green', 4 * DAY)).toBeUndefined()
    expect(stageAnnouncement('amber', 6 * HOUR)).toBe('This room self-destructs in 6 hours.')
    expect(stageAnnouncement('red', HOUR)).toBe('This room self-destructs in 1 hour.')
    expect(stageAnnouncement('final', 60)).toBe('This room self-destructs in under a minute. Save anything you need now.')
    expect(finalBannerText(45)).toBe('This room self-destructs in 0:45. Save anything you need now.')
  })
})

describe('tombstone rows', () => {
  it('name no room, and go when dismissed or after seven days', () => {
    const store = memoryDeviceStore()
    const at = 1_800_000_000
    addTombstone(store, at, 'a'.repeat(32))
    addTombstone(store, at + 60, 'b'.repeat(32))
    expect(tombstones(store, at + 120).map(t => t.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)])
    // The one key, naming nothing but the time.
    expect(store.keys()).toEqual([DESTRUCTED_KEY])
    expect(store.get(DESTRUCTED_KEY)).not.toMatch(/room/i)
    dismissTombstone(store, 'b'.repeat(32))
    expect(tombstones(store, at + 120).map(t => t.id)).toEqual(['a'.repeat(32)])
    expect(tombstones(store, at + TOMBSTONE_SECONDS)).toEqual([])
    expect(store.keys()).toEqual([])
  })

  it('reads "A room self-destructed" and the time', () => {
    const at = 1_800_000_000
    expect(tombstoneText(at)).toBe(`A room self-destructed · ${formatConferenceEnd(at)}`)
  })

  it('ignores a malformed list', () => {
    const store = memoryDeviceStore()
    store.set(DESTRUCTED_KEY, '{"not":"a list"}')
    expect(tombstones(store, 0)).toEqual([])
    store.set(DESTRUCTED_KEY, JSON.stringify([{ id: 'x', at: 1 }, { id: 'c'.repeat(32), at: 5 }]))
    expect(tombstones(store, 10).map(t => t.id)).toEqual(['c'.repeat(32)])
  })
})

describe('a self-destructing room, stored', () => {
  const NOW = 1_800_000_000
  const roomId = 'ab'.repeat(32)
  const newLink = () => {
    const created = createRoomInvitation(true)
    return { link: encodeRoomLink('https://example.test/j/', { invitation: created.invitation, relays: [], iceUrls: [] }), invitation: created.invitation }
  }

  it('keeps the flag on the saved room, and never takes it back', () => {
    const store = memoryDeviceStore()
    const { link } = newLink()
    expect(rememberRoom(store, { roomId, link, openedAt: NOW, endsAt: NOW + DAY, destruct: true })).toMatchObject({ destruct: true, startsAt: NOW })
    // A later visit that did not learn it keeps it, and keeps when it started.
    expect(rememberRoom(store, { roomId, link, openedAt: NOW + 60 })).toMatchObject({ destruct: true, endsAt: NOW + DAY, startsAt: NOW })
    // A room without it has none.
    const other = 'cd'.repeat(32)
    expect(rememberRoom(store, { roomId: other, link: newLink().link, openedAt: NOW }).destruct).toBeUndefined()
    // Learned at closure.
    expect(markDestruct(store, other)).toBe(true)
    expect(knownRoom(store, other)?.destruct).toBe(true)
  })

  it('is due at its end or its closure, and keeps its admission until tidied away', () => {
    const store = memoryDeviceStore()
    const { link, invitation } = newLink()
    const secret = generateRoomSecret()
    storeKeptAdmission(store, deriveInvitationId(invitation), { secret, persistent: true, epoch: 0, endsAt: NOW + DAY, destruct: true }, NOW)
    rememberRoom(store, { roomId, link, openedAt: NOW, endsAt: NOW + DAY, destruct: true })
    expect(destructDue(store, NOW + DAY - 1)).toEqual([])
    expect(endLapsedConferences(store, NOW + DAY)).toEqual([roomId])
    expect(destructDue(store, NOW + DAY).map(room => room.roomId)).toEqual([roomId])
    // The tidy-up still has the room's key to read with.
    expect(loadKeptAdmission(store, deriveInvitationId(invitation), NOW + DAY)).toMatchObject({ destruct: true })

    // A room that keeps a read-only copy loses its admission at the end, as before.
    const kept = newLink()
    const keptId = 'ef'.repeat(32)
    storeKeptAdmission(store, deriveInvitationId(kept.invitation), { secret: generateRoomSecret(), persistent: true, epoch: 0, endsAt: NOW + DAY }, NOW)
    rememberRoom(store, { roomId: keptId, link: kept.link, openedAt: NOW, endsAt: NOW + DAY })
    markEnded(store, keptId, NOW + DAY)
    expect(loadKeptAdmission(store, deriveInvitationId(kept.invitation), NOW + DAY)).toBeUndefined()
    expect(destructDue(store, NOW + DAY).map(room => room.roomId)).toEqual([roomId])
  })

  it('keeps its device key past the usual age until the room is gone', () => {
    const store = memoryDeviceStore()
    const old = 'aa'.repeat(32), other = 'bb'.repeat(32)
    const sk = deviceKeyFor(store, old, NOW, generateSecretKey)
    deviceKeyFor(store, other, NOW, generateSecretKey)
    const later = NOW + DEVICE_KEY_MAX_AGE_SECONDS + 1
    deviceKeyFor(store, 'cc'.repeat(32), later, generateSecretKey, roomId => roomId === old)
    expect(loadDeviceKeyFor(store, old)).toEqual(sk)
    expect(loadDeviceKeyFor(store, other)).toBeUndefined()
  })

  it('carries the flag on the creator’s record and the kept admission', () => {
    const store = memoryDeviceStore()
    const created = createRoomInvitation(true)
    const secret = generateRoomSecret()
    storeInvitationOwner(store, created.invitation, secret, created.inviterSk, NOW, NOW + DAY, true)
    expect(loadInvitationOwner(store, created.invitation, NOW)).toMatchObject({ endsAt: NOW + DAY, destruct: true })
    storeInvitationOwner(store, created.invitation, secret, created.inviterSk, NOW, undefined, false)
    expect(loadInvitationOwner(store, created.invitation, NOW)?.destruct).toBeUndefined()
    storeKeptAdmission(store, 'id', { secret, persistent: true, epoch: 0, destruct: true }, NOW)
    expect(loadKeptAdmission(store, 'id', NOW)).toEqual({ secret, persistent: true, epoch: 0, destruct: true })
  })
})

describe('scrubbing a room out of shared records', () => {
  const room = 'ab'.repeat(32)
  it('cuts the room out of maps and lists and leaves the rest', () => {
    const store = memoryDeviceStore()
    store.set('kithmoot.room-relays-fixed.v1', JSON.stringify({ [room]: { c: ['wss://a'], signed: true }, other: { c: ['wss://b'] } }))
    store.set('kithmoot.pins', JSON.stringify([room, 'other']))
    store.set('kithmoot.projects', JSON.stringify({ p: { rooms: [{ roomId: room, name: 'x' }, { roomId: 'other' }] } }))
    store.set(`kithmoot.device.${room}`, '{}')
    store.set('kithmoot.note', `plain text naming ${room}`)
    store.set('kithmoot.unrelated', '{"a":1}')
    expect(scrubStore(store, [room])).toEqual(['kithmoot.note'])
    expect(JSON.parse(store.get('kithmoot.room-relays-fixed.v1')!)).toEqual({ other: { c: ['wss://b'] } })
    expect(JSON.parse(store.get('kithmoot.pins')!)).toEqual(['other'])
    expect(JSON.parse(store.get('kithmoot.projects')!)).toEqual({ p: { rooms: [{ roomId: 'other' }] } })
    expect(store.get(`kithmoot.device.${room}`)).toBeNull()
    expect(store.get('kithmoot.unrelated')).toBe('{"a":1}')
  })

  it('scrubJson reports whether anything changed', () => {
    expect(scrubJson({ a: [1, 2] }, new Set(['x']))).toEqual({ value: { a: [1, 2] }, changed: false })
    expect(scrubJson({ x: 1 }, new Set(['x']))).toEqual({ value: {}, changed: true })
  })
})
