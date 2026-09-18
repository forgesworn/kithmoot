import { describe, it, expect } from 'vitest'
import { sameShape, sdpShape } from './sdp-shape.js'

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:0',
  'a=ice-ufrag:Kx9m',
  'a=ice-pwd:0Gt2vY7qLp',
  'a=sendrecv',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=sendrecv',
  '',
].join('\r\n')

const withLines = (...extra: string[]) => `${SDP}${extra.join('\r\n')}\r\n`
const replace = (from: string, to: string) => SDP.replace(from, to)

describe('sdpShape', () => {
  it('is the same for a description written again with a new o= version', () => {
    expect(sameShape(SDP, replace('4611731400430051336 2', '4611731400430051336 3'))).toBe(true)
  })

  it('is the same once candidates gathered since have been added', () => {
    const retried = withLines(
      'a=candidate:1 1 udp 2113937151 192.0.2.1 50000 typ host',
      'a=candidate:2 1 udp 1677729535 198.51.100.1 50001 typ srflx',
      'a=end-of-candidates',
    )
    expect(sameShape(SDP, retried)).toBe(true)
  })

  it('is the same across line endings and trailing blank lines', () => {
    expect(sameShape(SDP, `${SDP.replace(/\r\n/g, '\n')}\n\n`)).toBe(true)
  })

  it('differs when a direction changes, which is the whole point', () => {
    expect(sameShape(SDP, replace('a=sendrecv', 'a=recvonly'))).toBe(false)
  })

  it('differs when ICE credentials change, so a restart is never swallowed', () => {
    expect(sameShape(SDP, replace('a=ice-ufrag:Kx9m', 'a=ice-ufrag:Zz41'))).toBe(false)
    expect(sameShape(SDP, replace('a=ice-pwd:0Gt2vY7qLp', 'a=ice-pwd:9Qw8rT1nMk'))).toBe(false)
  })

  it('differs when the session id changes, because that is a new session', () => {
    expect(sameShape(SDP, replace('o=- 4611731400430051336', 'o=- 7220984311150263447'))).toBe(false)
  })

  it('differs when an m-line is added', () => {
    expect(sameShape(SDP, withLines('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=sendonly'))).toBe(false)
  })

  it('has nothing to compare for a description that is not there', () => {
    expect(sdpShape(undefined)).toBeUndefined()
    expect(sameShape(undefined, undefined)).toBe(false)
  })

  it('carries an origin line it cannot read through unchanged', () => {
    expect(sdpShape('o=truncated')).toBe('o=truncated')
  })
})

/**
 * BUG: once gathering starts, a connection hands back a description it did
 * not write - the m-line port becomes the default candidate's, the `c=` line
 * becomes that candidate's address, and `a=rtcp:` appears or moves with
 * them. Every retransmitted offer goes out of `localDescription`, so every
 * retry differs from its first copy in exactly those lines. Left in the
 * shape, the answering side stops recognising the offer it has just
 * answered - during the race that needs the recognition - and a re-read
 * answer earns a repair that proposes nothing.
 */
describe('a description re-read after gathering', () => {
  const CHROME_BEFORE = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS stream',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 126',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:Kx9m',
    'a=ice-pwd:0Gt2vY7qLp6nRs4wXy1zAb',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n')

  const CHROME_AFTER = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS stream',
    'm=audio 51423 UDP/TLS/RTP/SAVPF 111 63 9 0 8 126',
    'c=IN IP4 192.0.2.17',
    'a=rtcp:51423 IN IP4 192.0.2.17',
    'a=candidate:1510613869 1 udp 2113937151 192.0.2.17 51423 typ host generation 0',
    'a=candidate:842163049 1 udp 1677729535 198.51.100.4 51424 typ srflx raddr 192.0.2.17 rport 51423',
    'a=end-of-candidates',
    'a=ice-ufrag:Kx9m',
    'a=ice-pwd:0Gt2vY7qLp6nRs4wXy1zAb',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n')

  // Firefox writes its own dialect: `IN IP4 0.0.0.0` becomes the candidate's
  // address the same way, the port moves the same way, and `a=rtcp:` turns up
  // where there was none at all.
  const FIREFOX_BEFORE = [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-99.0 7220984311150263447 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0',
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'm=video 9 UDP/TLS/RTP/SAVPF 120',
    'c=IN IP4 0.0.0.0',
    'a=ice-pwd:9Qw8rT1nMk2pLv5cZx7bYd',
    'a=ice-ufrag:Zz41',
    'a=mid:0',
    'a=recvonly',
    'a=setup:active',
    '',
  ].join('\r\n')

  const FIREFOX_AFTER = [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-99.0 7220984311150263447 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0',
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'm=video 43210 UDP/TLS/RTP/SAVPF 120',
    'c=IN IP4 203.0.113.9',
    'a=candidate:0 1 UDP 2122252543 203.0.113.9 43210 typ host',
    'a=rtcp:43211 IN IP4 203.0.113.9',
    'a=ice-pwd:9Qw8rT1nMk2pLv5cZx7bYd',
    'a=ice-ufrag:Zz41',
    'a=mid:0',
    'a=recvonly',
    'a=setup:active',
    '',
  ].join('\r\n')

  it('is the same proposal in Chrome, port, c=, rtcp and candidates and all', () => {
    expect(sameShape(CHROME_BEFORE, CHROME_AFTER)).toBe(true)
  })

  it('is the same proposal in Firefox, where a=rtcp: appears from nowhere', () => {
    expect(sameShape(FIREFOX_BEFORE, FIREFOX_AFTER)).toBe(true)
  })

  it('still differs when only the direction changed', () => {
    expect(sameShape(CHROME_AFTER, CHROME_AFTER.replace('a=sendrecv', 'a=recvonly'))).toBe(false)
    expect(sameShape(FIREFOX_BEFORE, FIREFOX_AFTER.replace('a=recvonly', 'a=sendrecv'))).toBe(false)
  })

  it('still differs when only the ICE credentials changed, gathered or not', () => {
    expect(sameShape(CHROME_BEFORE, CHROME_AFTER.replace('a=ice-ufrag:Kx9m', 'a=ice-ufrag:Nn72'))).toBe(false)
    expect(sameShape(FIREFOX_BEFORE, FIREFOX_AFTER.replace('a=ice-pwd:9Qw8rT1nMk2pLv5cZx7bYd', 'a=ice-pwd:0000000000000000000000'))).toBe(false)
  })

  it('still differs when the media or its codecs changed', () => {
    expect(sameShape(CHROME_AFTER, CHROME_AFTER.replace('m=audio 51423 UDP/TLS/RTP/SAVPF 111 63 9 0 8 126', 'm=audio 51423 UDP/TLS/RTP/SAVPF 63 9 0 8 126'))).toBe(false)
    expect(sameShape(CHROME_AFTER, CHROME_AFTER.replace('m=audio', 'm=video'))).toBe(false)
  })
})
