import { describe, expect, it } from 'vitest'
import { observedCallConnection, selectedCallPair } from './call-connection.js'

const direct = [
  { type: 'transport', selectedCandidatePairId: 'pair' },
  { type: 'candidate-pair', id: 'pair', localCandidateId: 'local', remoteCandidateId: 'remote', bytesSent: 1234, bytesReceived: 5678, currentRoundTripTime: 0.042 },
  { type: 'local-candidate', id: 'local', candidateType: 'host', protocol: 'udp', address: '192.0.2.1' },
  { type: 'remote-candidate', id: 'remote', candidateType: 'srflx', address: '198.51.100.1' },
]
const localRelay = (url: string) => direct.map(s => s.id === 'local' ? { ...s, candidateType: 'relay', relayProtocol: 'tls', url } : s)

describe('observed call routes', () => {
  it('uses the transport selection, not a nominated backup or configured TURN server', () => {
    const stats = [...direct, { type: 'candidate-pair', id: 'backup', nominated: true, selected: true }]
    expect(selectedCallPair(stats)?.id).toBe('pair')
    expect(observedCallConnection('connected', stats).route).toBe('Direct to the other device · UDP')
    expect(observedCallConnection('connected', stats).traffic).toContain('round trip 42 ms')
  })
  it('does not infer direct media from missing stats or nominations', () => {
    expect(observedCallConnection('connected', [{ type: 'candidate-pair', nominated: true }]).route).toContain('unavailable')
    expect(selectedCallPair([{ type: 'transport', selectedCandidatePairId: 'missing' }, ...direct.slice(1).map(s => ({ ...s, selected: true }))])).toBeUndefined()
  })
  it('supports selected flag browsers without a transport record', () => {
    expect(selectedCallPair(direct.slice(1).map(s => ({ ...s, selected: s.id === 'pair' })))?.id).toBe('pair')
  })
  it('keeps ambiguous independent transport routes unknown', () => {
    expect(selectedCallPair([...direct, { type: 'transport', selectedCandidatePairId: 'second' }, { type: 'candidate-pair', id: 'second' }])).toBeUndefined()
  })
  it('identifies the selected local node relay and distinguishes its TLS leg from UDP', () => {
    const result = observedCallConnection('connected', localRelay('turns:node.example:443?transport=tcp'), { nodeHost: 'node.example' })
    expect(result.route).toBe('Room node TURN relay · node.example · this device to relay: TLS')
    expect(result.route).not.toContain('UDP')
  })
  it('does not call another selected relay the room node', () => {
    expect(observedCallConnection('connected', localRelay('turn:other.example:3478'), { nodeHost: 'node.example' }).route).toMatch(/^TURN relay · other.example/)
  })
  it('identifies a remote relay without exposing its address or guessing its operator', () => {
    const stats = direct.map(s => s.id === 'remote' ? { ...s, candidateType: 'relay', url: 'turn:private.example:3478' } : s)
    const result = observedCallConnection('connected', stats)
    expect(result.route).toContain('server name unavailable')
    expect(JSON.stringify(result)).not.toMatch(/198\.51|192\.0|private\.example/)
  })
  it('drops credentials, malicious relay values, queries and peer IPs', () => {
    for (const url of ['turn:user:secret@evil.example:3478', 'https://evil.example', 'turn:<img onerror=bad()>:3478']) {
      expect(observedCallConnection('connected', localRelay(url)).route).toContain('server name unavailable')
    }
    const result = observedCallConnection('connected', localRelay('turns:node.example:443?secret=never-copy'))
    expect(JSON.stringify(result)).not.toMatch(/never-copy|192\.0|198\.51/)
  })
  it('names an assisting endpoint instead of promising a direct connection to the person', () => {
    expect(observedCallConnection('connected', direct, { via: 'volunteer Ada' }).route).toBe('Direct to volunteer Ada · UDP')
    expect(observedCallConnection('connected', localRelay('turn:r.example'), { via: 'a room forwarder' }).route).toContain('endpoint: a room forwarder')
  })
  it('marks disconnected stats as the last selection and bounds invalid measurements', () => {
    const stats = direct.map(s => s.id === 'pair' ? { ...s, bytesSent: -1, bytesReceived: NaN, currentRoundTripTime: Infinity } : s)
    const result = observedCallConnection('disconnected', stats)
    expect(result.route).toMatch(/^Last selected:/)
    expect(result.traffic).toBe('Sent 0 bytes · received 0 bytes')
  })
  it('shows inbound decoded frames and loss without exposing stats objects', () => {
    expect(observedCallConnection('connected', [...direct, { type: 'inbound-rtp', kind: 'video', framesDecoded: 123, packetsLost: 2 }]).video).toBe('Received video: 123 frames decoded · 2 packets lost')
  })
})
