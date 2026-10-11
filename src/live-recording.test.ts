import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import { sanitiseLiveRecordingState, verifyLiveRecordingState, type LiveRecordingState } from './live-recording.js'

const authoritySk = new Uint8Array(32).fill(7), authority = getPublicKey(authoritySk)
const roomId = 'ab'.repeat(32)
const notice = { on: true, id: '12'.repeat(16), version: 17 }
const capture = { id: notice.id, version: notice.version, capture: 'gallery' as const, recorder: 'aa'.repeat(32), device: 'bb'.repeat(32) }
const live: LiveRecordingState = {
  recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk }) },
  capture: { op: 'recording-capture', ...capture, sig: signRecordingCaptureNotice({ roomId, notice: capture, authoritySk }) },
}

describe('live authority-signed recording warning', () => {
  it('preserves the matched pair and verifies both signatures', () => {
    expect(sanitiseLiveRecordingState(JSON.parse(JSON.stringify(live)))).toEqual(live)
    expect(verifyLiveRecordingState(roomId, live, authority)).toBe(true)
    expect(verifyLiveRecordingState('cd'.repeat(32), live, authority)).toBe(false)
    expect(verifyLiveRecordingState(roomId, { ...live, capture: { ...live.capture!, recorder: 'cc'.repeat(32) } }, authority)).toBe(false)
    expect(verifyLiveRecordingState(roomId, { ...live, recording: { ...live.recording, sig: '00'.repeat(64) } }, authority)).toBe(false)
  })
  it('rejects incomplete, mismatched, unknown and malformed live state', () => {
    for (const value of [null, [], { recording: live.recording }, { ...live, capture: { ...live.capture, version: 18 } },
      { ...live, extra: true }, { recording: 1n }, { recording: { ...live.recording, on: false }, capture: live.capture }]) {
      expect(sanitiseLiveRecordingState(value)).toBeUndefined()
    }
    expect(verifyLiveRecordingState(roomId, { recording: live.recording }, authority)).toBe(false)
  })
  it('allows an authority-signed Off without capture details', () => {
    const notice = { on: false, id: live.recording.id, version: 18 }
    const off: LiveRecordingState = { recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk }) } }
    expect(sanitiseLiveRecordingState(off)).toEqual(off)
    expect(verifyLiveRecordingState(roomId, off, authority)).toBe(true)
  })
})
