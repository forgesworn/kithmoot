import { afterEach, expect, test, vi } from 'vitest'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import { type LiveRecordingState } from './live-recording.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000, call = '12'.repeat(16), secret = new Uint8Array(32).fill(11)
const opened: RoomSession[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(opened.splice(0).map(s => s.leave())) })
class ConfirmedTransport extends SimTransport {
  fail = false
  rejectBeforePublish = false
  beforeAck?: () => Promise<void>
  async publishGuarded(event: Event, allowed: () => boolean): Promise<void> {
    if (!allowed()) throw new Error('cancelled')
    if (this.rejectBeforePublish) throw new Error('relay refused')
    await this.publish(event)
    await this.beforeAck?.()
    if (this.fail) throw new Error('relay refused')
    if (!allowed()) throw new Error('cancelled')
  }
}
function client(relay: SimRelay, profile?: 2 | 4, now: () => number = () => NOW) {
  const deviceSk = generateSecretKey(), transport = new ConfirmedTransport(relay)
  const s = new RoomSession({ transport, secret, identity: localIdentity(generateSecretKey()), deviceSk,
    recordingProfile: profile, now, announceJitterMs: 0 })
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


test('ordinary heartbeats stop refreshing a warning when capture ownership is revoked', async () => {
  let at = NOW, captureOwned = true
  const a = client(new SimRelay(), 4, () => at)
  await join(a)
  await a.s.publishLiveRecording(a.warning(), () => captureOwned)
  captureOwned = false
  at += 30
  await a.s.announce()
  expect(a.s.liveRecordings()[0]?.sentAt).toBe(NOW)
  expect(a.s.liveRecordings()[0]?.state.recording.on).toBe(true)
})

test('failed Off delivery cannot keep the previous On fresh through heartbeats', async () => {
  let at = NOW
  const a = client(new SimRelay(), 4, () => at)
  await join(a)
  await a.s.publishLiveRecording(a.warning())
  a.transport.rejectBeforePublish = true
  await expect(a.s.publishLiveRecording(a.warning(false, NOW * 1000 + 1))).rejects.toThrow('relay refused')
  at += 30
  await a.s.announce()
  expect(a.s.liveRecordings()[0]?.sentAt).toBe(NOW)
  expect(a.s.liveRecordings()[0]?.state.recording.on).toBe(true)
})

test('an unreadable capture owner revokes heartbeat refresh without breaking ordinary presence', async () => {
  let at = NOW, unreadable = false
  const a = client(new SimRelay(), 4, () => at)
  await join(a)
  await a.s.publishLiveRecording(a.warning(), () => { if (unreadable) throw new Error('owner unavailable'); return true })
  unreadable = true
  at += 30
  await a.s.announce()
  expect(a.s.liveRecordings()[0]?.sentAt).toBe(NOW)
})

test('a withheld acknowledgement times out and a late completion cannot revive the On', async () => {
  let at = NOW
  const a = client(new SimRelay(), 4, () => at)
  await join(a)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  a.transport.beforeAck = async () => { entered(); await gate }
  vi.useFakeTimers()
  const publication = a.s.publishLiveRecording(a.warning())
  const failure = expect(publication).rejects.toThrow('not confirmed')
  await started
  await vi.advanceTimersByTimeAsync(15_001)
  await failure
  release()
  await Promise.resolve()
  at += 30
  await a.s.announce()
  // The relay echo may already have been seen; it never becomes a new
  // successfully published owner capable of keeping that warning fresh.
  expect(a.s.liveRecordings()).toHaveLength(1)
  expect(a.s.liveRecordings()[0]?.sentAt).toBe(NOW)
})

test('leaving and returning to the same call during ACK cannot revive the original capture', async () => {
  const a = client(new SimRelay(), 4)
  await join(a)
  a.transport.beforeAck = async () => { await a.s.setCall(null); await a.s.setCall({ id: call, since: NOW }) }
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('cancelled')
})


test('a newer Off received during an older On ACK wins before capture is authorised', async () => {
  const a = client(new SimRelay(), 4)
  await join(a)
  a.transport.beforeAck = async () => {
    a.transport.beforeAck = undefined
    await a.s.publishLiveRecording(a.warning(false, NOW * 1000 + 1))
  }
  await expect(a.s.publishLiveRecording(a.warning())).rejects.toThrow('cancelled')
  expect(a.s.liveRecordings()[0]?.state.recording.on).toBe(false)
  await a.s.announce()
  expect(a.s.liveRecordings()[0]?.state.recording.on).toBe(false)
})


test('a new recorder retires stale ownership before its warning ACK', async () => {
  let owned = true
  const a = client(new SimRelay(), 4)
  await join(a)
  await a.s.publishLiveRecording(a.warning(), () => owned)
  owned = false
  a.transport.beforeAck = async () => { await a.s.announce() }
  await a.s.publishLiveRecording(a.warning(true, NOW * 1000 + 2, '45'.repeat(16)))
  expect(a.s.liveRecordings()[0]?.state.recording.id).toBe('45'.repeat(16))
})
