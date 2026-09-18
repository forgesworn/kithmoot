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
