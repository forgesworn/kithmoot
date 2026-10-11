import { expect, test } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import { readLiveRecordingState, verifyLiveRecordingState, type LiveRecordingState } from './live-recording.js'

const roomId = '12'.repeat(32), call = '23'.repeat(16)
const deviceSk = generateSecretKey(), device = getPublicKey(deviceSk), recorder = getPublicKey(generateSecretKey())
function state(on = true, key = deviceSk): LiveRecordingState {
  const notice = { on, id: '34'.repeat(16), version: 1000 }
  const capture = { id: notice.id, version: notice.version, capture: 'gallery' as const, recorder, device }
  return { recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk: key }) },
    ...(on ? { capture: { op: 'recording-capture' as const, ...capture, sig: signRecordingCaptureNotice({ roomId, notice: capture, authoritySk: key }) } } : {}),
    call, recorder, device }
}
const source = { roomId, participant: recorder, device, call, profile: 4 }

test('a call device signs its own complete warning without the room authority key', () => {
  expect(verifyLiveRecordingState({ ...source, state: state() })).toBe(true)
  expect(verifyLiveRecordingState({ ...source, state: state(false) })).toBe(true)
  const warning = state()
  expect(readLiveRecordingState(warning)).toEqual(warning)
})

test('a member cannot claim another recorder, stop another device or transplant a warning', () => {
  const warning = state(), other = getPublicKey(generateSecretKey())
  for (const changed of [{ roomId: other }, { participant: other }, { device: other }, { call: '45'.repeat(16) }, { profile: 3 }, { call: undefined }]) {
    expect(verifyLiveRecordingState({ ...source, ...changed, state: warning })).toBe(false)
    if (!('call' in changed)) expect(verifyLiveRecordingState({ ...source, ...changed, state: state(false) })).toBe(false)
  }
  expect(verifyLiveRecordingState({ ...source, state: state(true, generateSecretKey()) })).toBe(false)
  expect(verifyLiveRecordingState({ ...source, state: { ...warning, capture: { ...warning.capture!, recorder: other } } })).toBe(false)
})

test('a device can confirm its own stopped recording after leaving that call', () => {
  expect(verifyLiveRecordingState({ ...source, call: undefined, state: state(false) })).toBe(true)
  expect(verifyLiveRecordingState({ ...source, call: '45'.repeat(16), state: state(false) })).toBe(true)
})

test('incomplete, mismatched and ambiguous warnings cannot authorise capture', () => {
  const warning = state()
  for (const bad of [null, true, {}, { ...warning, capture: undefined }, { ...warning, call: undefined },
    { ...warning, capture: { ...warning.capture!, version: 2000 } }, { ...state(false), capture: warning.capture },
    { ...warning, extra: 'unmodelled' }, { ...warning, device: 7 }]) expect(readLiveRecordingState(bad)).toBeUndefined()
})

test('legacy profile 3 still requires the pinned authority signature', () => {
  const rootSk = generateSecretKey(), authority = getPublicKey(rootSk), full = state(true, rootSk)
  const legacy = { recording: full.recording, capture: full.capture }
  expect(verifyLiveRecordingState({ ...source, profile: 3, authority, state: legacy })).toBe(true)
  expect(verifyLiveRecordingState({ ...source, profile: 3, state: legacy })).toBe(false)
  expect(verifyLiveRecordingState({ ...source, profile: 3, authority: device, state: legacy })).toBe(false)
})
