import { expect, it } from 'vitest'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { deriveRoom } from './room.js'
import { decodeRosterEvent } from './roster.js'
import { signRecordingNotice, signRecordingCaptureNotice } from './meeting.js'
import type { LiveRecordingState } from './live-recording.js'
import { quietRoomTransport, QUIET_KINDS, QUIET_BLOCKED_KINDS } from './quiet.js'
import { encodeRekeyEvent } from './epoch.js'

class GuardedTransport extends SimTransport {
  beforeDispatch: () => void = () => {}
  beforeReceipt: () => void = () => {}
  async publishGuarded(event: Event, allowed: () => boolean): Promise<void> {
    this.beforeDispatch()
    if (!allowed()) throw new Error('Not offered')
    await this.publish(event)
    this.beforeReceipt()
  }
}
function fixture(quiet = false) {
  let now = 1_800_000_000
  const secret = new Uint8Array(32).fill(11), authoritySk = new Uint8Array(32).fill(7), deviceSk = new Uint8Array(32).fill(8)
  const authority = getPublicKey(authoritySk), device = getPublicKey(deviceSk)
  const room = deriveRoom(secret), relay = new SimRelay(), carrier = new GuardedTransport(relay)
  const policy = { tier: 'open' as const, members: [authority], quiet: true as const }
  const transport = quiet ? quietRoomTransport(carrier, { policy, participant: authority, slot: 0,
    now: () => now, schedule: () => () => {} }) : carrier
  const session = new RoomSession({ transport, secret, authority, identity: localIdentity(authoritySk), deviceSk,
    now: () => now, announceJitterMs: 0, epochSettleMs: 0, recordingProfile: 2, ...(quiet ? { policy } : {}) })
  const state = (on = true, version = 17): LiveRecordingState => {
    const recording = { on, id: '12'.repeat(16), version }
    const capture = { id: recording.id, version, capture: 'gallery' as const, recorder: authority, device }
    return { recording: { op: 'recording', ...recording, sig: signRecordingNotice({ roomId: room.roomId, notice: recording, authoritySk }) },
      ...(on ? { capture: { op: 'recording-capture' as const, ...capture, sig: signRecordingCaptureNotice({ roomId: room.roomId, notice: capture, authoritySk }) } } : {}) }
  }
  const last = () => decodeRosterEvent(relay.published.at(-1)!, { ...room, now, epoch: session.epochKeys() })
  const rekey = async () => {
    relay.publish(encodeRekeyEvent({ roomId: room.roomId, authoritySk, current: session.epochKeys(),
      next: { epoch: session.epoch + 1, secret: new Uint8Array(32).fill(44) }, recipients: [device],
      removed: [], commit: true, now }))
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { session, carrier, transport, relay, state, last, rekey, advance: () => { now += 300 } }
}

it('arms the complete state only after acknowledgement and carries it on heartbeats', async () => {
  const f = fixture()
  try {
    await f.session.join([], {})
    const live = f.state()
    f.carrier.beforeReceipt = () => expect(f.session.liveRecording).toBeUndefined()
    await f.session.publishLiveRecordingConfirmed(live)
    expect(f.session.liveRecording?.state).toEqual(live)
    await f.session.announce()
    expect(f.last()?.liveRecording).toEqual(live)
    f.carrier.beforeReceipt = () => {}
    await f.session.publishLiveRecordingConfirmed(f.state(false, 18))
    await expect(f.session.publishLiveRecordingConfirmed(f.state())).rejects.toThrow('no longer allowed')
    await f.session.announce()
    expect(f.last()?.liveRecording?.recording.on).toBe(false)
  } finally { await f.session.leave() }
})

it('refuses unsupported carriers without falling back to an ordinary publish', async () => {
  const f = fixture()
  f.carrier.publishGuarded = undefined as unknown as GuardedTransport['publishGuarded']
  try {
    await f.session.join([], {})
    const before = f.relay.published.length
    await expect(f.session.publishLiveRecordingConfirmed(f.state())).rejects.toThrow('unavailable')
    expect(f.relay.published).toHaveLength(before)
    expect(f.session.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('rejects cancellation before dispatch and after acknowledgement without retaining On', async () => {
  const f = fixture()
  let owned = true
  try {
    await f.session.join([], {})
    f.carrier.beforeDispatch = () => { owned = false }
    const before = f.relay.published.length
    await expect(f.session.publishLiveRecordingConfirmed(f.state(), () => owned)).rejects.toThrow('Not offered')
    expect(f.relay.published).toHaveLength(before)
    owned = true
    f.carrier.beforeDispatch = () => {}
    f.carrier.beforeReceipt = () => { owned = false }
    await expect(f.session.publishLiveRecordingConfirmed(f.state(), () => owned)).rejects.toThrow('no longer allowed')
    expect(f.session.liveRecording).toBeUndefined()
    await f.session.announce()
    expect(f.last()?.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('withdraws a confirmed On from heartbeats when its owner cancels', async () => {
  const f = fixture()
  let owned = true
  try {
    await f.session.join([], {})
    await f.session.publishLiveRecordingConfirmed(f.state(), () => owned)
    owned = false
    await f.session.announce()
    expect(f.last()?.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('rejects an expired presence before dispatch', async () => {
  const f = fixture()
  try {
    await f.session.join([], {})
    f.carrier.beforeDispatch = f.advance
    const before = f.relay.published.length
    await expect(f.session.publishLiveRecordingConfirmed(f.state())).rejects.toThrow('Not offered')
    expect(f.relay.published).toHaveLength(before)
    expect(f.session.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('rejects publication before join and after leaving during dispatch', async () => {
  const f = fixture()
  try {
    await expect(f.session.publishLiveRecordingConfirmed(f.state())).rejects.toThrow('no longer allowed')
    await f.session.join([], {})
    f.carrier.beforeDispatch = () => { void f.session.leave() }
    await expect(f.session.publishLiveRecordingConfirmed(f.state())).rejects.toThrow('Not offered')
    expect(f.session.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('refreshes live warnings for 45 minutes without quiet chat queues or counters', async () => {
  const f = fixture(true), quiet = f.transport as ReturnType<typeof quietRoomTransport>
  try {
    await f.session.join([], {})
    for (let index = 0; index < 10; index++) {
      if (index) f.advance()
      await f.session.publishLiveRecordingConfirmed(f.state())
    }
    expect(quiet.pending).toBe(0)
    expect(quiet.queued()).toEqual([])
    expect(quiet.exportUsed()).toEqual({})
    await f.session.publishLiveRecordingConfirmed(f.state(false, 18))
  } finally { await f.session.leave(); quiet.close() }
})

it('does not carry a confirmed On into the successor room epoch', async () => {
  const f = fixture()
  try {
    await f.session.join([], {})
    await f.session.publishLiveRecordingConfirmed(f.state())
    await f.rekey()
    expect(f.session.epoch).toBe(1)
    await f.session.announce()
    expect(f.last()?.liveRecording).toBeUndefined()
  } finally { await f.session.leave() }
})

it('does not let the live carrier bypass quiet chat or public file restrictions', async () => {
  const f = fixture(true)
  try {
    await f.session.join([], {})
    const before = f.relay.published.length
    for (const kind of [...QUIET_KINDS, ...QUIET_BLOCKED_KINDS]) {
      const event = finalizeEvent({ kind, created_at: 1_800_000_000, tags: [], content: '' }, new Uint8Array(32).fill(8))
      await expect(f.transport.publishGuarded!(event, () => true)).rejects.toThrow()
    }
    expect(f.relay.published).toHaveLength(before)
    expect((f.transport as ReturnType<typeof quietRoomTransport>).pending).toBe(0)
  } finally { await f.session.leave(); f.transport.close() }
})

it('invalidates a warning queued before a secure room update', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const dispatch = f.carrier.publishGuarded.bind(f.carrier)
  f.carrier.publishGuarded = async (event, allowed) => { await dispatch(event, allowed); await gate }
  try {
    await f.session.join([], {})
    const first = f.session.publishLiveRecordingConfirmed(f.state()).catch(error => error)
    // Let the first publication enter the guarded carrier before queueing the next.
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = f.session.publishLiveRecordingConfirmed(f.state(true, 19)).catch(error => error)
    await f.rekey()
    expect(f.session.epoch).toBe(1)
    release()
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    expect(f.session.liveRecording).toBeUndefined()
  } finally { release(); await f.session.leave() }
})
