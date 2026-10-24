import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_RELAY_CHECK_FAILED, checkCallRelay } from './call-relay-check.js'

class Channel {
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  other?: Channel
  send(data: string) { this.other?.onmessage?.({ data }) }
  close() {}
}

class Connection {
  static instances: Connection[] = []
  static relayed = true
  static connect = true
  static rejectCandidate = false
  // Candidate gathering deliberately never completes. The successful pair
  // must be usable while an unrelated interface is still probing.
  iceGatheringState = 'gathering'
  signalingState = 'stable'
  remoteDescription?: { type: string }
  localDescription?: { type: string }
  onicecandidate: ((event: { candidate: object }) => void) | null = null
  ondatachannel?: (event: { channel: Channel }) => void
  channel?: Channel
  candidates = 0
  closed = false
  constructor() { Connection.instances.push(this) }
  addEventListener() {}
  removeEventListener() {}
  createDataChannel() { return this.channel = new Channel() }
  async createOffer() { return { type: 'offer' } }
  async createAnswer() { return { type: 'answer' } }
  async setLocalDescription(description: { type: string }) {
    this.localDescription = description
    this.onicecandidate?.({ candidate: {} })
  }
  async setRemoteDescription(description: { type: string }) {
    this.remoteDescription = description
    if (description.type === 'answer' && Connection.connect) {
      const [a, b] = Connection.instances
      const remote = new Channel()
      a.channel!.other = remote; remote.other = a.channel
      b.ondatachannel?.({ channel: remote })
      queueMicrotask(() => a.channel!.onopen?.())
    }
  }
  async addIceCandidate() {
    if (Connection.rejectCandidate) throw new Error('private provider diagnostic')
    this.candidates++
  }
  async getStats() {
    return new Map([
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, bytesReceived: 64,
        localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { candidateType: Connection.relayed ? 'relay' : 'host' }],
      ['remote', { candidateType: 'relay' }],
    ])
  }
  close() { this.closed = true }
}

const relay = { urls: ['turn:relay.example:3478?transport=udp'], username: 'fixture', credential: 'fixture-password' }
beforeEach(() => {
  Connection.instances = []; Connection.relayed = true; Connection.connect = true; Connection.rejectCandidate = false
  vi.stubGlobal('RTCPeerConnection', Connection)
})
afterEach(() => vi.unstubAllGlobals())

describe('call relay path check', () => {
  it('exchanges queued candidates and proves data before gathering completes', async () => {
    await expect(checkCallRelay(relay, new AbortController().signal, 1000)).resolves.toBeUndefined()
    expect(Connection.instances.map(pc => pc.candidates)).toEqual([1, 1])
    expect(Connection.instances.every(pc => pc.closed && pc.onicecandidate === null)).toBe(true)
  })
  it('rejects a working data channel if the selected path is direct', async () => {
    Connection.relayed = false
    await expect(checkCallRelay(relay, new AbortController().signal, 1000)).rejects.toThrow(CALL_RELAY_CHECK_FAILED)
    expect(Connection.instances.every(pc => pc.closed)).toBe(true)
  })
  it('cancels an unfinished attempt and closes both temporary peers', async () => {
    Connection.connect = false
    const controller = new AbortController()
    const check = checkCallRelay(relay, controller.signal, 1000)
    controller.abort()
    await expect(check).rejects.toThrow(CALL_RELAY_CHECK_FAILED)
    expect(Connection.instances).toHaveLength(2)
    expect(Connection.instances.every(pc => pc.closed && pc.onicecandidate === null)).toBe(true)
  })
  it('bounds candidate failures without disclosing the provider error', async () => {
    Connection.rejectCandidate = true
    await expect(checkCallRelay(relay, new AbortController().signal, 1000)).rejects.toThrow(CALL_RELAY_CHECK_FAILED)
    expect(Connection.instances.every(pc => pc.closed)).toBe(true)
  })
})
