import { describe, it, expect } from 'vitest'
import { base64urlnopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import { parseRoomLink, encodeRoomLink } from './link.js'
import { createRoomInvitation } from './invitation.js'
import { encodeJoinUrl } from './room.js'

const BASE = 'https://example.test/j/'

describe('room links', () => {
  it('round-trips a version 2 invitation link with every hint the app writes', () => {
    const { invitation } = createRoomInvitation()
    const url = encodeRoomLink(BASE, {
      invitation,
      relays: ['wss://a.example', 'wss://b.example'],
      iceUrls: ['stun:stun.example:3478', 'turn:turn.example:3478'],
      policy: { tier: 'kith', admitted: ['AB'.repeat(32)] },
      pairingCode: new Uint8Array(16).fill(3),
    })
    const link = parseRoomLink(url)
    expect(link.invitation?.inviter).toBe(invitation.inviter)
    expect(bytesToHex(link.invitation!.bearer)).toBe(bytesToHex(invitation.bearer))
    expect(link.secret).toBeUndefined()
    expect(link.relays).toEqual(['wss://a.example', 'wss://b.example'])
    expect(link.iceUrls).toEqual(['stun:stun.example:3478', 'turn:turn.example:3478'])
    expect(link.policy).toEqual({ tier: 'kith', admitted: ['ab'.repeat(32)] })
    expect(bytesToHex(link.pairingCode!)).toBe('03'.repeat(16))
  })

  it('reads a legacy version 1 link the library itself wrote', () => {
    const secret = new Uint8Array(32).fill(5)
    const link = parseRoomLink(encodeJoinUrl(BASE, secret, ['wss://a.example']))
    expect(bytesToHex(link.secret!)).toBe('05'.repeat(32))
    expect(link.invitation).toBeUndefined()
    expect(link.relays).toEqual(['wss://a.example'])
    expect(link.iceUrls).toEqual([])
  })

  it('drops an ICE hint that is not a STUN or TURN url', () => {
    const { invitation } = createRoomInvitation()
    const url = encodeRoomLink(BASE, { invitation, relays: [], iceUrls: ['stun:ok.example', 'https://not-ice.example', 'javascript:alert(1)'] })
    expect(parseRoomLink(url).iceUrls).toEqual(['stun:ok.example'])
  })

  it('refuses a link whose admission rule it cannot read, rather than opening the room', () => {
    const payload = base64urlnopad.encode(
      new TextEncoder().encode(JSON.stringify({ v: 2, j: base64urlnopad.encode(new Uint8Array(32)), h: 'ab'.repeat(32), r: [], i: [], a: { tier: 'vip' } })),
    )
    expect(() => parseRoomLink(`${BASE}#${payload}`)).toThrow(/tier/)
  })

  it('refuses a link with no fragment, a fragment that is not base64, and one with neither invitation nor secret', () => {
    expect(() => parseRoomLink(BASE)).toThrow(/fragment/)
    expect(() => parseRoomLink(`${BASE}#not*base64`)).toThrow(/not valid/)
    const empty = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ r: [] })))
    expect(() => parseRoomLink(`${BASE}#${empty}`)).toThrow(/neither/)
  })

  it('refuses a malformed version 2 invitation', () => {
    const payload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, j: 'x', r: [] })))
    expect(() => parseRoomLink(`${BASE}#${payload}`)).toThrow(/invitation/)
  })
})
