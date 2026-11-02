import { describe, it, expect, vi } from 'vitest'
import { Peer } from './peer.js'
import { createFakeFactory, fakeTrack } from '../test/fake-rtc.js'

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
