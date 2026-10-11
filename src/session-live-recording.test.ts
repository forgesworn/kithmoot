import { expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { deriveRoom } from './room.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { encodeRosterEvent } from './roster.js'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import type { LiveRecordingState } from './live-recording.js'

it('receives only complete authority-signed live warnings and retains Off against replay', async () => {
  const now = 1_800_000_000
  const secret = new Uint8Array(32).fill(11), authoritySk = new Uint8Array(32).fill(7)
  const authority = getPublicKey(authoritySk), deviceSk = new Uint8Array(32).fill(8)
  const { roomId, roomKey } = deriveRoom(secret)
  const relay = new SimRelay()
  const reader = new RoomSession({ transport: new SimTransport(relay), secret, authority,
    identity: localIdentity(new Uint8Array(32).fill(9)), deviceSk: new Uint8Array(32).fill(10),
    now: () => now, announceJitterMs: 0 })
  const credential = await createDeviceCredential({ identity: localIdentity(authoritySk),
    devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: now + 3600 })
  const notice = { on: true, id: '12'.repeat(16), version: 17 }
  const capture = { id: notice.id, version: 17, capture: 'gallery' as const, recorder: authority, device: getPublicKey(deviceSk) }
  const live: LiveRecordingState = {
    recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk }) },
    capture: { op: 'recording-capture', ...capture, sig: signRecordingCaptureNotice({ roomId, notice: capture, authoritySk }) },
  }
  const deliver = (state: LiveRecordingState) => relay.publish(encodeRosterEvent({
    participant: authority, device: getPublicKey(deviceSk), credential, tracks: [], claims: {},
    updatedAt: now, recordingProfile: 3, liveRecording: state,
  }, { roomId, roomKey, deviceSk }))
  try {
    await reader.join([], {})
    deliver({ ...live, capture: { ...live.capture!, sig: '00'.repeat(64) } })
    expect(reader.liveRecording).toBeUndefined()
    deliver(live)
    expect(reader.liveRecording?.state).toEqual(live)
    const snapshot = reader.liveRecording!
    snapshot.state.recording.on = false
    expect(reader.liveRecording?.state.recording.on).toBe(true)
    const changed = { ...capture, recorder: 'cc'.repeat(32) }
    deliver({ ...live, capture: { op: 'recording-capture', ...changed,
      sig: signRecordingCaptureNotice({ roomId, notice: changed, authoritySk }) } })
    expect(reader.liveRecording?.state).toEqual(live)
    const stopped = { on: false, id: notice.id, version: 18 }
    const off: LiveRecordingState = { recording: { op: 'recording', ...stopped,
      sig: signRecordingNotice({ roomId, notice: stopped, authoritySk }) } }
    deliver(off)
    deliver(live)
    expect(reader.liveRecording?.state).toEqual(off)
  } finally {
    await reader.leave()
  }
})
