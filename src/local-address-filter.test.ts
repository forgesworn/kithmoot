import { describe, expect, it } from 'vitest'
import { hideLocalAddressesInSdp, hideLocalAddressesInSignal, hideLocalCandidate, hideLocalCandidateJson } from './local-address-filter.js'

// Documentation and private ranges only: RFC 5737 for the "public" side,
// RFC 1918, RFC 6598 (Tailscale's 100.64/10), RFC 4193 and link-local for
// the local side.
const host = (address: string, transport = 'udp', tail = 'generation 0 ufrag Kx9m network-id 1') =>
  `candidate:1 1 ${transport} 2122260223 ${address} 54400 typ host ${tail}`.trimEnd()

describe('hideLocalCandidate', () => {
  it.each([
    ['LAN IPv4', '192.168.1.20'],
    ['10/8', '10.2.0.2'],
    ['172.16/12 VPN tunnel', '172.20.10.3'],
    ['Tailscale 100.64/10', '100.101.102.103'],
    ['a public IPv4 host address', '203.0.113.7'],
    ['IPv6 unique-local (Tailscale)', 'fd7a:115c:a1e0::1'],
    ['IPv6 unique-local (mesh)', 'fdf1:11a3:aa07:ccbf:4b7:615a:2b1:26e6'],
    ['IPv6 link-local with a zone', 'fe80::1c2b:3dff:fe4e:5f60%en0'],
    ['IPv6 global host address', '2001:db8:85a3::8a2e:370:7334'],
    ['a hostname that is not mDNS', 'laptop.example.org'],
    ['localhost by name', 'localhost'],
  ])('drops a host candidate on %s', (_label, address) => {
    expect(hideLocalCandidate(host(address))).toBeNull()
  })

  it('drops TCP host candidates the same way', () => {
    expect(hideLocalCandidate(host('192.168.1.20', 'tcp', 'tcptype active generation 0'))).toBeNull()
    expect(hideLocalCandidate(host('fd7a:115c:a1e0::1', 'tcp', 'tcptype passive'))).toBeNull()
  })

  it('keeps an mDNS host candidate untouched', () => {
    const mdns = host('3f1c9e2a-7b4d-4c1e-9a8f-0d2b6c5e4f31.local')
    expect(hideLocalCandidate(mdns)).toBe(mdns)
    const tcp = host('3F1C9E2A-7B4D-4C1E-9A8F-0D2B6C5E4F31.LOCAL', 'tcp', 'tcptype passive')
    expect(hideLocalCandidate(tcp)).toBe(tcp)
  })

  it('keeps loopback host candidates, so two processes on one machine still meet', () => {
    for (const address of ['127.0.0.1', '127.8.9.10', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      expect(hideLocalCandidate(host(address))).toBe(host(address))
    }
    expect(hideLocalCandidate(host('::ffff:192.168.1.20'))).toBeNull()
  })

  it('keeps srflx, prflx and relay candidates with the related address zeroed', () => {
    expect(hideLocalCandidate('candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 192.168.1.20 rport 61144 generation 0 ufrag Kx9m network-id 1'))
      .toBe('candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag Kx9m network-id 1')
    expect(hideLocalCandidate('candidate:3 1 udp 1845501695 198.51.100.4 50000 typ prflx raddr fd7a:115c:a1e0::1 rport 50000'))
      .toBe('candidate:3 1 udp 1845501695 198.51.100.4 50000 typ prflx raddr 0.0.0.0 rport 0')
    expect(hideLocalCandidate('candidate:4 1 udp 41885439 203.0.113.9 49300 typ relay raddr 100.101.102.103 rport 53111 generation 0'))
      .toBe('candidate:4 1 udp 41885439 203.0.113.9 49300 typ relay raddr 0.0.0.0 rport 0 generation 0')
    expect(hideLocalCandidate('candidate:5 1 tcp 1518280447 198.51.100.4 9 typ srflx raddr 10.2.0.2 rport 9 tcptype active'))
      .toBe('candidate:5 1 tcp 1518280447 198.51.100.4 9 typ srflx raddr 0.0.0.0 rport 0 tcptype active')
  })

  it('leaves an already redacted candidate as it was', () => {
    const redacted = 'candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 0.0.0.0 rport 0 generation 0'
    expect(hideLocalCandidate(redacted)).toBe(redacted)
    expect(hideLocalCandidate('candidate:6 1 udp 1686052607 2001:db8::5 61144 typ srflx')).toBe('candidate:6 1 udp 1686052607 2001:db8::5 61144 typ srflx')
  })

  it('passes the empty end-of-candidates through', () => {
    expect(hideLocalCandidate('')).toBe('')
  })

  it.each([
    ['no candidate prefix', '1 1 udp 1686052607 198.51.100.4 61144 typ srflx'],
    ['too few fields', 'candidate:1 1 udp 2122260223 198.51.100.4 54400 typ'],
    ['no typ keyword', 'candidate:1 1 udp 2122260223 198.51.100.4 54400 type srflx'],
    ['an unknown type', 'candidate:1 1 udp 2122260223 198.51.100.4 54400 typ peer'],
    ['a non-numeric port', 'candidate:1 1 udp 2122260223 198.51.100.4 http typ srflx'],
    ['a dangling raddr', 'candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr'],
    ['a double space', 'candidate:2 1 udp 1686052607  198.51.100.4 61144 typ srflx'],
    ['the SDP a= prefix', 'a=candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx'],
  ])('drops a malformed candidate: %s', (_label, line) => {
    expect(hideLocalCandidate(line)).toBeNull()
  })
})

describe('hideLocalCandidateJson', () => {
  it('rewrites the candidate and keeps the other fields', () => {
    const json = JSON.stringify({ candidate: 'candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 192.168.1.20 rport 61144', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'Kx9m' })
    expect(JSON.parse(hideLocalCandidateJson(json)!)).toEqual({ candidate: 'candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 0.0.0.0 rport 0', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'Kx9m' })
  })

  it('returns the same string when nothing changes', () => {
    const json = JSON.stringify({ candidate: host('a1b2c3.local'), sdpMid: '0', sdpMLineIndex: 0 })
    expect(hideLocalCandidateJson(json)).toBe(json)
    const end = JSON.stringify({ candidate: '', sdpMid: '0', sdpMLineIndex: 0 })
    expect(hideLocalCandidateJson(end)).toBe(end)
  })

  it('drops a private host candidate and anything that is not a candidate object', () => {
    expect(hideLocalCandidateJson(JSON.stringify({ candidate: host('192.168.1.20'), sdpMid: '0' }))).toBeNull()
    for (const bad of ['', 'not json', 'null', '[]', '"candidate:1"', '{}', '{"candidate":7}']) expect(hideLocalCandidateJson(bad)).toBeNull()
  })
})

const OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  'm=audio 61144 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 192.168.1.20',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.20 61144 typ host generation 0 network-id 1',
  'a=candidate:7 1 udp 2122194687 100.101.102.103 53111 typ host generation 0 network-id 3',
  'a=candidate:8 1 udp 2122129151 fd7a:115c:a1e0::1 53112 typ host generation 0 network-id 4',
  'a=candidate:9 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 192.168.1.20 rport 61144 generation 0',
  'a=candidate:3 1 udp 2122260223 3f1c9e2a-7b4d.local 61145 typ host generation 0',
  'a=end-of-candidates',
  'a=ice-ufrag:Kx9m',
  'a=ice-pwd:0Gt2vY7qLp',
  'a=mid:0',
  'a=sendrecv',
  'm=video 50000 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP6 fd7a:115c:a1e0::1',
  'a=rtcp:50001 IN IP6 fd7a:115c:a1e0::1',
  'a=mid:1',
  'a=sendrecv',
  '',
]

describe('hideLocalAddressesInSdp', () => {
  const sdp = OFFER.join('\r\n')
  const out = hideLocalAddressesInSdp(sdp)

  it('removes every private host address from the description', () => {
    for (const address of ['192.168.1.20', '100.101.102.103', 'fd7a:115c:a1e0::1']) expect(out).not.toContain(address)
  })

  it('applies the candidate rule line by line', () => {
    const candidates = out.split('\r\n').filter((line) => line.startsWith('a=candidate:'))
    expect(candidates).toEqual([
      'a=candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 0.0.0.0 rport 0 generation 0',
      'a=candidate:3 1 udp 2122260223 3f1c9e2a-7b4d.local 61145 typ host generation 0',
    ])
  })

  it('zeroes c= and a=rtcp: addresses that no kept candidate carries, IPv4 form', () => {
    const lines = out.split('\r\n')
    expect(lines.filter((line) => line.startsWith('c='))).toEqual(['c=IN IP4 0.0.0.0', 'c=IN IP4 0.0.0.0'])
    expect(lines.filter((line) => line.startsWith('a=rtcp:'))).toEqual(['a=rtcp:9 IN IP4 0.0.0.0', 'a=rtcp:50001 IN IP4 0.0.0.0'])
  })

  it('keeps a c= or a=rtcp: address that a kept candidate carries', () => {
    const srflx = ['m=audio 61144 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 198.51.100.4', 'a=rtcp:61144 IN IP4 198.51.100.4', 'a=candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 10.0.0.2 rport 61144', '']
    expect(hideLocalAddressesInSdp(srflx.join('\r\n'))).toBe([...srflx.slice(0, 3), 'a=candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 0.0.0.0 rport 0', ''].join('\r\n'))
    const loop = ['c=IN IP4 127.0.0.1', 'a=candidate:1 1 udp 2122260223 127.0.0.1 5000 typ host', '']
    expect(hideLocalAddressesInSdp(loop.join('\n'))).toBe(loop.join('\n'))
  })

  it('leaves every other line exactly as written, CRLF endings included', () => {
    const untouched = (text: string) => text.split('\r\n').filter((line) => !/^(a=candidate:|c=|a=rtcp:)/.test(line))
    expect(untouched(out)).toEqual(untouched(sdp))
    expect(out.endsWith('\r\n')).toBe(true)
    expect(out.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true)
  })

  it('preserves bare LF endings and drops a malformed candidate line', () => {
    const lf = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=candidate:garbage', 'a=candidate:', 'a=mid:0', ''].join('\n')
    expect(hideLocalAddressesInSdp(lf)).toBe(['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:0', ''].join('\n'))
  })

  it('is idempotent and leaves a candidate-free description alone', () => {
    expect(hideLocalAddressesInSdp(out)).toBe(out)
    const bare = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0', ''].join('\r\n')
    expect(hideLocalAddressesInSdp(bare)).toBe(bare)
    expect(hideLocalAddressesInSdp('')).toBe('')
  })
})

describe('hideLocalAddressesInSignal', () => {
  const lan = JSON.stringify({ candidate: host('192.168.1.20'), sdpMid: '0', sdpMLineIndex: 0 })
  const srflx = JSON.stringify({ candidate: 'candidate:2 1 udp 1686052607 198.51.100.4 61144 typ srflx raddr 192.168.1.20 rport 61144', sdpMid: '0', sdpMLineIndex: 0 })

  it('rewrites an offer or answer and keeps every other field', () => {
    const body = { type: 'offer', roomId: 'r', seq: 3, tier: 'direct', sdp: OFFER.join('\r\n') }
    const out = hideLocalAddressesInSignal(body)!
    expect(out).toEqual({ ...body, sdp: hideLocalAddressesInSdp(body.sdp) })
    expect(JSON.stringify(out)).not.toMatch(/192\.168\.|100\.101\.|fd7a:/)
  })

  it('drops a single-candidate signal that would reveal a local address', () => {
    expect(hideLocalAddressesInSignal({ type: 'ice', roomId: 'r', candidate: lan })).toBeNull()
  })

  it('redacts a reflexive candidate rather than dropping it', () => {
    const out = hideLocalAddressesInSignal({ type: 'ice', roomId: 'r', candidate: srflx })!
    expect(JSON.parse(out.candidate!).candidate).toContain('raddr 0.0.0.0 rport 0')
  })

  it('filters a batch and keeps the batch fields', () => {
    const out = hideLocalAddressesInSignal({ type: 'ice', candidates: [lan, srflx, 'garbage'], first: 4, seq: 6 })!
    expect(out.first).toBe(4)
    expect(out.seq).toBe(6)
    expect(out.candidates).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('192.168.')
  })

  it('returns a signal with nothing to hide as the same object', () => {
    const body: { type: string; ack: number; sdp?: string } = { type: 'ack', ack: 4 }
    expect(hideLocalAddressesInSignal(body)).toBe(body)
  })
})
