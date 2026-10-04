import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  canonicalSpeakers,
  MAX_MEETING_SPEAKERS,
  meetingAllows,
  RECORDING_FORGET_SECONDS,
  RECORDING_STALE_SECONDS,
  recordingView,
  signMeetingPolicy,
  signRecordingNotice,
  verifyMeetingPolicy,
  verifyRecordingNotice,
  withMeetingMode,
  withSpeaker,
  type MeetingPolicy,
} from './meeting.js'
import { decodeControl, encodeControl } from './control.js'

const roomId = 'ab'.repeat(32)
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)
const alice = 'aa'.repeat(32)
const bob = 'bb'.repeat(32)
const carol = 'cc'.repeat(32)

describe('meeting policy', () => {
  it('canonicalises the speakers: lower-case, deduplicated, sorted', () => {
    expect(canonicalSpeakers([bob, alice.toUpperCase(), alice])).toEqual([alice, bob])
  })

  it('refuses what is not a pubkey, and more than the cap', () => {
    expect(() => canonicalSpeakers(['nobody'])).toThrow()
    expect(() => canonicalSpeakers(Array.from({ length: MAX_MEETING_SPEAKERS + 1 }, (_, i) => i.toString(16).padStart(64, '0')))).toThrow()
  })

  it('is believed on the authority signature, for exactly that room, version, mode and list', () => {
    const policy: MeetingPolicy = { on: true, speakers: [alice, bob], version: 100 }
    const sig = signMeetingPolicy({ roomId, policy, authoritySk })
    expect(verifyMeetingPolicy({ roomId, policy, sig, authority })).toBe(true)
    expect(verifyMeetingPolicy({ roomId, policy: { ...policy, version: 101 }, sig, authority })).toBe(false)
    expect(verifyMeetingPolicy({ roomId, policy: { ...policy, on: false }, sig, authority })).toBe(false)
    expect(verifyMeetingPolicy({ roomId, policy: { ...policy, speakers: [alice, bob, carol] }, sig, authority })).toBe(false)
    expect(verifyMeetingPolicy({ roomId: 'cd'.repeat(32), policy, sig, authority })).toBe(false)
    expect(verifyMeetingPolicy({ roomId, policy, sig, authority: getPublicKey(generateSecretKey()) })).toBe(false)
  })

  it('refuses a signed list offered in another order rather than sorting it', () => {
    const policy: MeetingPolicy = { on: true, speakers: [alice, bob], version: 1 }
    const sig = signMeetingPolicy({ roomId, policy, authoritySk })
    expect(verifyMeetingPolicy({ roomId, policy: { ...policy, speakers: [bob, alice] }, sig, authority })).toBe(false)
  })

  it('never throws on rubbish', () => {
    expect(verifyMeetingPolicy({ roomId: 'x', policy: { on: true, speakers: ['y'], version: -1 }, sig: 'z', authority: 'w' })).toBe(false)
  })

  it('lets everybody talk when off, and only speakers when on', () => {
    expect(meetingAllows(undefined, carol, 'audio')).toBe(true)
    expect(meetingAllows({ on: false, speakers: [alice], version: 1 }, carol, 'video')).toBe(true)
    const on: MeetingPolicy = { on: true, speakers: [alice], version: 1 }
    expect(meetingAllows(on, alice, 'audio')).toBe(true)
    expect(meetingAllows(on, alice.toUpperCase(), 'video')).toBe(true)
    expect(meetingAllows(on, carol, 'audio')).toBe(false)
    expect(meetingAllows(on, carol, 'video')).toBe(false)
  })

  it('moves the version forward on every change, even when the clock went back', () => {
    const start: MeetingPolicy = { on: false, speakers: [], version: 1_000 }
    const on = withMeetingMode(start, true, 500)
    expect(on).toEqual({ on: true, speakers: [], version: 1_001 })
    const withAlice = withSpeaker(on, alice.toUpperCase(), true, 2_000)
    expect(withAlice).toEqual({ on: true, speakers: [alice], version: 2_000 })
    expect(withSpeaker(withAlice, alice, false, 2_000)).toEqual({ on: true, speakers: [], version: 2_001 })
  })

  it('travels as a control op anybody may repost', () => {
    const policy: MeetingPolicy = { on: true, speakers: [alice], version: 7 }
    const op = { op: 'meeting' as const, ...policy, sig: signMeetingPolicy({ roomId, policy, authoritySk }) }
    expect(decodeControl(encodeControl(op))).toEqual(op)
    expect(decodeControl(JSON.stringify({ ...op, on: 'yes' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, speakers: ['nobody'] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, version: -1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, sig: 'x' }))).toBeNull()
  })
})

describe('recording notice', () => {
  const id = '0f'.repeat(16)

  it('is believed on the authority signature, for exactly that room, version, recording and state', () => {
    const notice = { on: true, id, version: 5 }
    const sig = signRecordingNotice({ roomId, notice, authoritySk })
    expect(verifyRecordingNotice({ roomId, notice, sig, authority })).toBe(true)
    expect(verifyRecordingNotice({ roomId, notice: { ...notice, on: false }, sig, authority })).toBe(false)
    expect(verifyRecordingNotice({ roomId, notice: { ...notice, version: 6 }, sig, authority })).toBe(false)
    expect(verifyRecordingNotice({ roomId, notice: { ...notice, id: 'f0'.repeat(16) }, sig, authority })).toBe(false)
    expect(verifyRecordingNotice({ roomId, notice, sig, authority: getPublicKey(generateSecretKey()) })).toBe(false)
    expect(verifyRecordingNotice({ roomId, notice: { ...notice, id: 'short' }, sig, authority })).toBe(false)
  })

  it('travels as a control op', () => {
    const notice = { on: false, id, version: 9 }
    const op = { op: 'recording' as const, ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk }) }
    expect(decodeControl(encodeControl(op))).toEqual(op)
    expect(decodeControl(JSON.stringify({ ...op, id: id.toUpperCase() }))).toBeNull()
  })

  it('stays shown when it goes quiet, as unconfirmed rather than gone', () => {
    const notice = { on: true, id, version: 1 }
    expect(recordingView(undefined, 0, 0, 100)).toEqual({ state: 'off' })
    expect(recordingView({ ...notice, on: false }, 0, 0, 100)).toEqual({ state: 'off' })
    expect(recordingView(notice, 10, 90, 100)).toEqual({ state: 'on', id, since: 10 })
    expect(recordingView(notice, 10, 90, 91 + RECORDING_STALE_SECONDS)).toEqual({ state: 'unconfirmed', id, since: 10, lastHeard: 90 })
    expect(recordingView(notice, 10, 90, 91 + RECORDING_FORGET_SECONDS)).toEqual({ state: 'off' })
  })
})

describe('raised hands', () => {
  it('travel as a control op naming nobody', () => {
    expect(decodeControl(encodeControl({ op: 'hand', up: true }))).toEqual({ op: 'hand', up: true })
    expect(decodeControl(JSON.stringify({ op: 'hand', up: 1 }))).toBeNull()
  })
})
