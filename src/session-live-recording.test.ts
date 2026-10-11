import { afterEach, expect, test } from 'vitest'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import { type LiveRecordingState } from './live-recording.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000, call = '12'.repeat(16), secret = new Uint8Array(32).fill(11)
const opened: RoomSession[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(s => s.leave())) })
class ConfirmedTransport extends SimTransport {
  fail = false
  beforeAck?: () => Promise<void>
  async publishGuarded(event: Event, allowed: () => boolean): Promise<void> {
    if (!allowed()) throw new Error('cancelled')
    await this.publish(event)
    await this.beforeAck?.()
    if (this.fail) throw new Error('relay refused')
    if (!allowed()) throw new Error('cancelled')
  }
}
function client(relay: SimRelay, profile?: 2 | 4) {
  const deviceSk = generateSecretKey(), transport = new ConfirmedTransport(relay)
  const s = new RoomSession({ transport, secret, identity: localIdentity(generateSecretKey()), deviceSk,
    recordingProfile: profile, now: () => NOW, announceJitterMs: 0 })
  opened.push(s)
  const warning = (on = true, version = NOW * 1000, id = '23'.repeat(16)): LiveRecordingState => {
    const notice = { on, version, id }, capture = { id, version, capture: 'audio' as const, recorder: s.participant, device: s.device }
    return { call, recorder: s.participant, device: s.device,
      recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId: s.roomId, notice, authoritySk: deviceSk }) },
      ...(on ? { capture: { op: 'recording-capture' as const, ...capture, sig: signRecordingCaptureNotice({ roomId: s.roomId, notice: capture, authoritySk: deviceSk }) } } : {}) }
  }
  return { s, transport, warning }
}
async function join(...clients: ReturnType<typeof client>[]) {
  for (const { s } of clients) { await s.join([], {}); await s.setCall({ id: call, since: NOW }) }
}

test('either participant records a legacy room without an authority; stopping one preserves the other', async () => {
  const relay = new SimRelay(), a = client(relay, 4), b = client(relay, 4)
  await join(a, b)
  await a.s.publishLiveRecording(a.warning())
  await b.s.publishLiveRecording(b.warning())
  expect(b.s.liveRecordings().filter(w => w.state.recording.on)).toHaveLength(2)
  await a.s.publishLiveRecording(a.warning(false, NOW * 1000 + 1))
  expect(b.s.liveRecordings().filter(w => w.state.recording.on).map(w => w.state.device)).toEqual([b.s.device])
  // A delayed earlier On must not replace this device's confirmed Off.
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('newer recording notice')
  expect(b.s.liveRecordings().find(w => w.state.device === a.s.device)?.state.recording.on).toBe(false)
})

test('an older call client blocks member recording; an idle old client does not', async () => {
  const relay = new SimRelay(), a = client(relay, 4), old = client(relay, 2)
  await join(a, old)
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('current KithMoot version')
  await old.s.setCall(null)
  await a.s.publishLiveRecording(a.warning())
  expect(a.s.liveRecordings().some(w => w.state.recording.on)).toBe(true)
})

test('a local echo cannot substitute for the relay acknowledgement', async () => {
  const relay = new SimRelay(), a = client(relay, 4)
  await join(a)
  a.transport.fail = true
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('relay refused')
})

test('call change before acknowledgement refuses capture; Off can be confirmed after leaving', async () => {
  const relay = new SimRelay(), a = client(relay, 4)
  await join(a)
  a.transport.beforeAck = () => a.s.setCall(null)
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('cancelled')
  a.transport.beforeAck = undefined
  await a.s.publishLiveRecording(a.warning(false, NOW * 1000 + 1))
  expect(a.s.liveRecordings()[0]?.state.recording.on).toBe(false)
})

test('a device cannot publish another participant or device as the recorder', async () => {
  const relay = new SimRelay(), a = client(relay, 4), b = client(relay, 4)
  await join(a, b)
  await expect(a.s.publishLiveRecording(b.warning())).rejects.toThrow('does not belong')
  expect(a.s.liveRecordings()).toHaveLength(0)
})
