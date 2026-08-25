import { describe, it, expect } from 'vitest'
import {
  ReachabilityProbe,
  classifyReachability,
  isGloballyRoutable,
  parseIceCandidate,
} from './reachability.js'

/**
 * Recorded candidate sets.
 *
 * Every line below is the shape a browser actually emits from
 * `onicecandidate`, with addresses replaced by documentation ranges
 * (RFC 5737's 203.0.113.0/24 and 198.51.100.0/24) so nothing here points at a
 * real host. The point of recording them is that the classification can be
 * checked against a symmetric NAT, a CGNAT and a public box without any of
 * those being present - which is what makes this testable at all.
 */
const CANDIDATES = {
  /** A box with a routable address and no NAT: the reflexive candidate comes
   *  back at exactly the socket the host candidate is bound to. */
  publicHost: [
    'candidate:1 1 udp 2130706431 203.0.113.7 54321 typ host generation 0',
    'candidate:2 1 udp 1694498815 203.0.113.7 54321 typ srflx raddr 203.0.113.7 rport 54321 generation 0',
  ],
  /** An ordinary household NAT: one local socket, one stable external
   *  mapping, seen the same way by both STUN servers (the browser
   *  deduplicates the second, which is why there is only one srflx). */
  homeNat: [
    'candidate:1 1 udp 2130706431 192.168.1.24 51000 typ host generation 0',
    'candidate:2 1 udp 1694498815 203.0.113.44 60001 typ srflx raddr 192.168.1.24 rport 51000 generation 0',
  ],
  /** A symmetric NAT: the same local socket is translated to a different
   *  external port per destination, so two STUN servers report two mappings. */
  symmetricNat: [
    'candidate:1 1 udp 2130706431 192.168.1.24 51000 typ host generation 0',
    'candidate:2 1 udp 1694498815 203.0.113.44 60001 typ srflx raddr 192.168.1.24 rport 51000 generation 0',
    'candidate:3 1 udp 1694498814 203.0.113.44 60002 typ srflx raddr 192.168.1.24 rport 51000 generation 0',
  ],
  /** Carrier-grade NAT on a mobile network: the local address is itself in
   *  RFC 6598 space, and the mapping moves. */
  cgnat: [
    'candidate:1 1 udp 2130706431 100.82.14.9 49152 typ host generation 0',
    'candidate:2 1 udp 1694498815 198.51.100.30 33001 typ srflx raddr 100.82.14.9 rport 49152 generation 0',
    'candidate:3 1 udp 1694498814 198.51.100.30 41999 typ srflx raddr 100.82.14.9 rport 49152 generation 0',
  ],
  /** Chrome before camera permission: every host candidate is an mDNS name,
   *  so there is nothing to compare a reflexive candidate against. */
  mdnsOnly: [
    'candidate:1 1 udp 2130706431 8f4d8a1e-6c2f-4a11-9c0a-2b8f7d3e5a19.local 51000 typ host generation 0',
    'candidate:2 1 udp 1694498815 203.0.113.44 60001 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  ],
  /** Gathering that produced nothing but the machine's own interfaces: no
   *  STUN server was configured, or none answered. */
  hostOnly: ['candidate:1 1 udp 2130706431 192.168.1.24 51000 typ host generation 0'],
  /** A dual-stack machine with a global IPv6 address, confirmed by a
   *  reflexive candidate at the same socket. */
  ipv6Public: [
    'candidate:1 1 udp 2130706431 2001:db8:4::17 51000 typ host generation 0',
    'candidate:2 1 udp 1694498815 2001:db8:4::17 51000 typ srflx raddr 2001:db8:4::17 rport 51000 generation 0',
  ],
}

describe('parseIceCandidate', () => {
  it('reads type, address, port and the related socket off a reflexive candidate', () => {
    const parsed = parseIceCandidate(CANDIDATES.homeNat[1])
    expect(parsed).toEqual({
      type: 'srflx',
      address: '203.0.113.44',
      port: 60001,
      transport: 'udp',
      foundation: '2',
      relatedAddress: '192.168.1.24',
      relatedPort: 51000,
      obfuscated: false,
    })
  })

  it('accepts the bare attribute, the a= line and an RTCIceCandidateInit alike', () => {
    const bare = parseIceCandidate(CANDIDATES.publicHost[0])
    const sdp = parseIceCandidate(`a=${CANDIDATES.publicHost[0]}`)
    const init = parseIceCandidate({ candidate: CANDIDATES.publicHost[0] })
    expect(sdp).toEqual(bare)
    expect(init).toEqual(bare)
  })

  it('flags an mDNS host candidate rather than treating .local as an address', () => {
    const parsed = parseIceCandidate(CANDIDATES.mdnsOnly[0])
    expect(parsed?.obfuscated).toBe(true)
    expect(parsed?.type).toBe('host')
  })

  it('returns null rather than throwing for anything that is not a candidate', () => {
    for (const junk of ['', 'candidate:', 'not a candidate at all', 'a=mid:0', null, undefined, {}, { candidate: null }]) {
      expect(parseIceCandidate(junk as never)).toBeNull()
    }
  })

  it('returns null for a candidate with an unknown type or an impossible port', () => {
    expect(parseIceCandidate('candidate:1 1 udp 1 203.0.113.7 54321 typ wormhole')).toBeNull()
    expect(parseIceCandidate('candidate:1 1 udp 1 203.0.113.7 99999 typ host')).toBeNull()
  })
})

describe('isGloballyRoutable', () => {
  it('accepts ordinary public addresses', () => {
    expect(isGloballyRoutable('203.0.113.7')).toBe(true)
    expect(isGloballyRoutable('198.51.100.30')).toBe(true)
    expect(isGloballyRoutable('2001:db8:4::17')).toBe(true)
  })

  it('refuses every range the rest of the internet cannot route to', () => {
    for (const address of [
      '10.0.0.1',
      '172.16.4.4',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.10.10',
      '100.82.14.9', // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '',
      'not-an-address',
      '999.1.1.1',
    ]) {
      expect(isGloballyRoutable(address), address).toBe(false)
    }
  })
})

describe('classifyReachability', () => {
  it('calls a box public when its reflexive candidate matches its host socket', () => {
    const report = classifyReachability(CANDIDATES.publicHost)
    expect(report.reachability).toBe('public')
    expect(report.publicAddress).toBe('203.0.113.7')
  })

  it('calls a global IPv6 host public on the same evidence', () => {
    expect(classifyReachability(CANDIDATES.ipv6Public).reachability).toBe('public')
  })

  it('calls an ordinary household NAT nat', () => {
    const report = classifyReachability(CANDIDATES.homeNat)
    expect(report.reachability).toBe('nat')
    expect(report.mappings).toBe(1)
  })

  it('calls two mappings of one local socket symmetric', () => {
    const report = classifyReachability(CANDIDATES.symmetricNat)
    expect(report.reachability).toBe('symmetric')
    expect(report.mappings).toBe(2)
  })

  it('calls carrier-grade NAT symmetric rather than being fooled by the 100.64/10 host address', () => {
    expect(classifyReachability(CANDIDATES.cgnat).reachability).toBe('symmetric')
  })

  it('reports unknown when nothing reflexive was gathered', () => {
    const report = classifyReachability(CANDIDATES.hostOnly)
    expect(report.reachability).toBe('unknown')
    expect(report.mappings).toBe(0)
    expect(report.hosts).toBe(1)
  })

  it('reports unknown for an empty candidate set rather than guessing', () => {
    expect(classifyReachability([]).reachability).toBe('unknown')
  })

  it('counts mDNS host candidates and refuses to compare against them', () => {
    const report = classifyReachability(CANDIDATES.mdnsOnly)
    expect(report.hosts).toBe(1)
    expect(report.obfuscatedHosts).toBe(1)
    // The reflexive candidate is real and routable, but there is no host
    // socket to match it against, so this is a NAT as far as we can tell.
    expect(report.reachability).toBe('nat')
  })

  it('never calls a device public on a reflexive address that is not routable', () => {
    // A STUN server inside the same LAN answers with a private address. The
    // socket matches, and it still means nothing to anybody outside.
    const report = classifyReachability([
      'candidate:1 1 udp 2130706431 192.168.1.24 51000 typ host generation 0',
      'candidate:2 1 udp 1694498815 192.168.1.24 51000 typ srflx raddr 192.168.1.24 rport 51000 generation 0',
    ])
    expect(report.reachability).not.toBe('public')
  })

  it('refuses public when the address survives translation but the port does not', () => {
    // Address-preserving, port-translating NAT. The device is not at the
    // socket its host candidate names, so volunteering it would advertise a
    // path that does not exist.
    const report = classifyReachability([
      'candidate:1 1 udp 2130706431 203.0.113.7 54321 typ host generation 0',
      'candidate:2 1 udp 1694498815 203.0.113.7 61000 typ srflx raddr 203.0.113.7 rport 54321 generation 0',
    ])
    expect(report.reachability).toBe('nat')
  })

  it('ignores relay candidates when classifying, and counts them', () => {
    const report = classifyReachability([
      ...CANDIDATES.homeNat,
      'candidate:4 1 udp 41885439 198.51.100.9 3478 typ relay raddr 192.168.1.24 rport 51000 generation 0',
    ])
    // A TURN server being reachable says nothing whatever about this device.
    expect(report.reachability).toBe('nat')
    expect(report.relayed).toBe(1)
  })

  it('ignores unparseable lines rather than abandoning the whole set', () => {
    expect(classifyReachability([...CANDIDATES.publicHost, 'rubbish', '']).reachability).toBe('public')
  })

  it('is the same answer whatever order the candidates trickled in', () => {
    const forwards = classifyReachability(CANDIDATES.symmetricNat)
    const backwards = classifyReachability([...CANDIDATES.symmetricNat].reverse())
    expect(backwards).toEqual(forwards)
  })
})

describe('ReachabilityProbe', () => {
  it('sharpens from unknown to an answer as candidates arrive', () => {
    const probe = new ReachabilityProbe()
    expect(probe.reachability).toBe('unknown')

    probe.add(CANDIDATES.publicHost[0])
    // A host candidate on its own is not a measurement of anything outside.
    expect(probe.reachability).toBe('unknown')

    probe.add(CANDIDATES.publicHost[1])
    expect(probe.reachability).toBe('public')
  })

  it('reports whether a candidate was usable, and keeps the ones that were', () => {
    const probe = new ReachabilityProbe()
    expect(probe.add(CANDIDATES.homeNat[0])).toBe(true)
    expect(probe.add('nonsense')).toBe(false)
    expect(probe.add(null)).toBe(false)
    expect(probe.candidates).toHaveLength(1)
  })

  it('takes candidates in the RTCIceCandidateInit shape onicecandidate hands out', () => {
    const probe = new ReachabilityProbe()
    for (const line of CANDIDATES.symmetricNat) probe.add({ candidate: line })
    expect(probe.reachability).toBe('symmetric')
  })
})
