import { describe, it, expect, vi } from 'vitest'
import { Peer } from './peer.js'
import { createFakeFactory, fakeTrack, type FakeRTCPeerConnection } from '../test/fake-rtc.js'
import type { SignalBody } from './signal.js'

function stalledSender() {
  const factory = createFakeFactory()
  const states: RTCPeerConnectionState[] = []
  const peer = new Peer({ factory, localDevice: 'a'.repeat(64), remoteDevice: 'b'.repeat(64), onSignal: () => {}, onTrack: () => {},
    onConnectionState: state => states.push(state) })
  const pc = factory.instances[0]!
  const track = fakeTrack('audio')
  const stats = { samples: 0, packets: 0 }
  const sender = {
    track: track as MediaStreamTrack | null,
    getStats: vi.fn(async () => new Map([
      ['source', { type: 'media-source', kind: 'audio', totalSamplesDuration: stats.samples }],
      ['out', { type: 'outbound-rtp', kind: 'audio', packetsSent: stats.packets }],
    ])),
    replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => { sender.track = next }),
  }
  const transceiver = { sender, mid: '0', direction: 'sendrecv', currentDirection: 'sendrecv' }
  Object.assign(pc, { addTrack: () => sender, getSenders: () => [sender], getTransceivers: () => [transceiver] })
  const connect = () => { pc.connectionState = 'connected'; pc.onconnectionstatechange?.() }
  return { peer, pc, track, stats, sender, transceiver, connect, states }
}

describe('Peer audio sender startup', () => {
  it('restarts a negotiated live microphone which never sampled or sent, once per sender', async () => {
    vi.useFakeTimers()
    const h = stalledSender()
    try {
      await h.peer.start([h.track]); h.connect()
      await vi.advanceTimersByTimeAsync(5999)
      expect(h.sender.replaceTrack).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(h.sender.replaceTrack.mock.calls).toEqual([[null], [h.track]])
      expect(h.sender.track).toBe(h.track)
      h.connect(); await vi.advanceTimersByTimeAsync(60_000)
      expect(h.sender.replaceTrack).toHaveBeenCalledTimes(2)
    } finally { h.peer.close(); vi.useRealTimers() }
  })

  for (const condition of ['sampling', 'sending', 'muted', 'ended', 'receive-only', 'closed'] as const) {
    it(`does not rebind when the sender is ${condition}`, async () => {
      vi.useFakeTimers()
      const h = stalledSender()
      try {
        await h.peer.start([h.track]); h.connect()
        if (condition === 'sampling') h.stats.samples = 1
        if (condition === 'sending') h.stats.packets = 1
        if (condition === 'muted') h.track.enabled = false
        if (condition === 'ended') h.track.stop()
        if (condition === 'receive-only') h.transceiver.currentDirection = 'recvonly'
        if (condition === 'closed') h.peer.close()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(h.sender.replaceTrack).not.toHaveBeenCalled()
      } finally { h.peer.close(); vi.useRealTimers() }
    })
  }

  it('does not reattach capture after a close during repair', async () => {
    vi.useFakeTimers()
    const h = stalledSender()
    try {
      h.sender.replaceTrack.mockImplementation(async next => { h.sender.track = next; h.peer.close() })
      await h.peer.start([h.track]); h.connect()
      await vi.advanceTimersByTimeAsync(6000)
      expect(h.sender.replaceTrack.mock.calls).toEqual([[null]])
    } finally { h.peer.close(); vi.useRealTimers() }
  })

  it('closes a pair whose emptied sender refuses reattachment', async () => {
    vi.useFakeTimers()
    const h = stalledSender()
    try {
      h.sender.replaceTrack.mockImplementation(async next => {
        if (next) throw new Error('sender refused track')
        h.sender.track = null
      })
      await h.peer.start([h.track]); h.connect()
      await vi.advanceTimersByTimeAsync(6000)
      expect(h.pc.closed).toBe(true)
      expect(h.states).toContain('failed')
    } finally { h.peer.close(); vi.useRealTimers() }
  })

  it('leaves the original track attached when stats are unavailable', async () => {
    vi.useFakeTimers()
    const h = stalledSender()
    try {
      h.sender.getStats.mockRejectedValue(new Error('stats unavailable'))
      await h.peer.start([h.track]); h.connect()
      await vi.advanceTimersByTimeAsync(6000)
      expect(h.sender.replaceTrack).not.toHaveBeenCalled()
      expect(h.sender.track).toBe(h.track)
      expect(h.pc.connectionState).toBe('connected')
    } finally { h.peer.close(); vi.useRealTimers() }
  })
})

const LOW = 'a'.repeat(64)
const HIGH = 'b'.repeat(64)

/** Two structured fakes whose microphone exchange has completed, so the
 *  audio section is negotiated `sendrecv` before anything rolls back. */
async function negotiatedAudio(localDevice: string, tick: () => Promise<void>, extra: Partial<ConstructorParameters<typeof Peer>[0]> = {}) {
  const factory = createFakeFactory({ structuredSdp: true })
  const signals: SignalBody[] = []
  const states: RTCPeerConnectionState[] = []
  const peer = new Peer({
    factory, localDevice, remoteDevice: localDevice === LOW ? HIGH : LOW, candidateGatherMs: 0,
    onSignal: body => signals.push(body), onTrack: () => {}, onConnectionState: state => states.push(state), ...extra,
  })
  const remote = createFakeFactory({ structuredSdp: true })()
  const mic = fakeTrack('audio')
  void peer.start([mic]); await tick()
  const pc = factory.instances[0]!
  await answerLatestOffer(peer, remote, signals, tick, () => remote.addTrack(fakeTrack('audio')))
  const audio = pc.getTransceivers().find(t => t.kind === 'audio')!
  expect(audio.currentDirection).toBe('sendrecv')
  return { peer, pc, remote, mic, audio, signals, states }
}

async function answerLatestOffer(peer: Peer, remote: FakeRTCPeerConnection, signals: SignalBody[], tick: () => Promise<void>, before?: () => void) {
  const offer = signals.filter(s => s.type === 'offer').at(-1)! as SignalBody & { sdp: string; seq: number }
  await remote.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
  before?.()
  const answer = await remote.createAnswer()
  await remote.setLocalDescription(answer)
  await peer.handleSignal({ type: 'answer', roomId: '', sdp: answer.sdp!, re: offer.seq })
  await tick()
}

/** The far end proposes too, while this side's own offer is outstanding. */
async function crossingOffer(peer: Peer, remote: FakeRTCPeerConnection, seq: number, tick: () => Promise<void>) {
  remote.addTrack(fakeTrack('video'))
  const offer = await remote.createOffer()
  await remote.setLocalDescription(offer)
  await peer.handleSignal({ type: 'offer', roomId: '', sdp: offer.sdp!, seq })
  await tick()
}

const callIndex = (pc: FakeRTCPeerConnection, method: string, type?: string, from = 0) =>
  pc.calls.findIndex((c, i) => i >= from && c.method === method &&
    (type === undefined || (c.args[0] as { type?: string } | undefined)?.type === type))
const rebindsAfter = (pc: FakeRTCPeerConnection, mid: string | null, from: number) =>
  pc.calls.slice(from).filter(c => c.method === 'replaceTrack' && c.args[0] === mid).map(c => c.args[1])
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

/**
 * BUG: a renegotiation glare silenced a microphone for the rest of the call.
 *
 * Chromium 151 stops feeding a microphone to its connection when that
 * connection rolls back an offer after its audio was negotiated, and the far
 * end hears nothing from then on. Measured over TURN with two bare
 * connections and none of this code. Rebinding the track restarts it, but
 * only after the exchange that follows the rollback has completed. The start
 * check caught the join case six seconds late and a later glare not at all.
 */
describe('Peer audio after a rollback', () => {
  for (const muted of [false, true]) {
    it(`rebinds a negotiated${muted ? ' and muted' : ''} microphone once the answer to the crossing offer is set`, async () => {
      const h = await negotiatedAudio(LOW, settle)
      try {
        if (muted) h.mic.enabled = false
        void h.peer.start([h.mic, fakeTrack('video')]); await settle()
        expect(h.pc.signalingState).toBe('have-local-offer')
        await crossingOffer(h.peer, h.remote, 50, settle)

        const rollback = callIndex(h.pc, 'setLocalDescription', 'rollback')
        const answer = callIndex(h.pc, 'setLocalDescription', 'answer', rollback)
        expect(rollback).toBeGreaterThanOrEqual(0)
        expect(answer).toBeGreaterThan(rollback)
        // Nothing at the rollback itself, where a rebind does not take.
        expect(rebindsAfter(h.pc, h.audio.mid, rollback).length).toBe(rebindsAfter(h.pc, h.audio.mid, answer).length)
        expect(rebindsAfter(h.pc, h.audio.mid, answer)).toEqual([null, h.mic])
        expect(h.audio.sender.track).toBe(h.mic)
        expect(h.pc.signalingState).toBe('stable')
      } finally { h.peer.close() }
    })
  }

  it('leaves the microphone alone when the rolled-back offer was the first', async () => {
    const factory = createFakeFactory({ structuredSdp: true })
    const peer = new Peer({ factory, localDevice: LOW, remoteDevice: HIGH, candidateGatherMs: 0, onSignal: () => {}, onTrack: () => {} })
    const remote = createFakeFactory({ structuredSdp: true })()
    try {
      void peer.start([fakeTrack('audio')]); await settle()
      const pc = factory.instances[0]!
      remote.addTrack(fakeTrack('audio'))
      const offer = await remote.createOffer()
      await remote.setLocalDescription(offer)
      await peer.handleSignal({ type: 'offer', roomId: '', sdp: offer.sdp!, seq: 1 })
      await settle()
      expect(callIndex(pc, 'setLocalDescription', 'rollback')).toBeGreaterThanOrEqual(0)
      expect(pc.calls.filter(c => c.method === 'replaceTrack')).toEqual([])
    } finally { peer.close() }
  })

  it('rebinds again for a second glare later in the call', async () => {
    const h = await negotiatedAudio(LOW, settle)
    try {
      void h.peer.start([h.mic, fakeTrack('video')]); await settle()
      await crossingOffer(h.peer, h.remote, 50, settle)
      const firstAnswer = callIndex(h.pc, 'setLocalDescription', 'answer', callIndex(h.pc, 'setLocalDescription', 'rollback'))
      void h.peer.start([h.mic, fakeTrack('video'), fakeTrack('video')]); await settle()
      expect(h.pc.signalingState).toBe('have-local-offer')
      await crossingOffer(h.peer, h.remote, 51, settle)
      expect(rebindsAfter(h.pc, h.audio.mid, firstAnswer)).toEqual([null, h.mic, null, h.mic])
    } finally { h.peer.close() }
  })

  it('rebinds after the answer to the offer that follows a wedge rollback, not at the rollback', async () => {
    vi.useFakeTimers()
    const tick = async () => { await vi.advanceTimersByTimeAsync(0) }
    try {
      const h = await negotiatedAudio(HIGH, tick, {
        offerRetry: { intervalMs: 1_000, maxIntervalMs: 8_000, jitter: 0, wedgeMs: 10_000 }, random: () => 0.5,
      })
      try {
        void h.peer.start([h.mic, fakeTrack('video')]); await tick()
        expect(h.pc.signalingState).toBe('have-local-offer')
        await vi.advanceTimersByTimeAsync(10_000)
        const rollback = callIndex(h.pc, 'setLocalDescription', 'rollback')
        expect(rollback, 'the wedge breaker never rolled back').toBeGreaterThanOrEqual(0)
        expect(rebindsAfter(h.pc, h.audio.mid, rollback)).toEqual([])

        await vi.advanceTimersByTimeAsync(1_000)
        expect(h.pc.signalingState).toBe('have-local-offer')
        const answerAt = h.pc.calls.length
        await answerLatestOffer(h.peer, h.remote, h.signals, tick)
        expect(callIndex(h.pc, 'setRemoteDescription', 'answer', answerAt)).toBeGreaterThanOrEqual(0)
        expect(rebindsAfter(h.pc, h.audio.mid, rollback)).toEqual([null, h.mic])
      } finally { h.peer.close() }
    } finally { vi.useRealTimers() }
  })

  it('closes the pair when the emptied sender refuses its microphone back', async () => {
    const h = await negotiatedAudio(LOW, settle)
    try {
      const sender = h.audio.sender
      const replace = sender.replaceTrack.bind(sender)
      sender.replaceTrack = async (track: MediaStreamTrack | null) => {
        if (track) throw new Error('sender refused track')
        await replace(null)
      }
      void h.peer.start([h.mic, fakeTrack('video')]); await settle()
      await crossingOffer(h.peer, h.remote, 50, settle)
      expect(h.states).toContain('failed')
      expect(h.pc.closed).toBe(true)
    } finally { h.peer.close() }
  })
})
