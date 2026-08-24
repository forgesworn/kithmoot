import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapSignal, unwrapSignal, SIGNAL_MAX_AGE_SECONDS, type SignalBody } from './signal.js'
import { KINDS } from './kinds.js'

const ROOM = 'd'.repeat(64)
const SDP = 'v=0\r\no=- 1 1 IN IP4 192.168.1.42\r\na=candidate:1 1 udp 2130706431 192.168.1.42 54321 typ host'

function fixture() {
  const senderSk = generateSecretKey()
  const recipientSk = generateSecretKey()
  return { senderSk, recipientSk, sender: getPublicKey(senderSk), recipient: getPublicKey(recipientSk) }
}

describe('gift-wrapped signalling', () => {
  const body: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP }

  it('round-trips a signal to the intended recipient', () => {
    const { senderSk, recipientSk, sender, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    const result = unwrapSignal(wrap, { recipientSk, roomId: ROOM })
    expect(result).toEqual({ from: sender, body })
  })

  it('never leaves the SDP readable on the wire', () => {
    const { senderSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    const wire = JSON.stringify(wrap)
    expect(wire).not.toContain('192.168.1.42')
    expect(wire).not.toContain('v=0')
  })

  it('hides the sender pubkey from the relay', () => {
    const { senderSk, sender, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(wrap.pubkey).not.toBe(sender)
    expect(JSON.stringify(wrap)).not.toContain(sender)
  })

  it('uses the ephemeral gift wrap kind', () => {
    const { senderSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(wrap.kind).toBe(KINDS.SIGNAL_WRAP)
    expect(wrap.kind).toBe(21059)
  })

  it('p-tags the recipient so they can subscribe', () => {
    const { senderSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(wrap.tags).toContainEqual(['p', recipient])
  })

  it('returns null for someone else’s wrap', () => {
    const { senderSk, recipient } = fixture()
    const eavesdropperSk = generateSecretKey()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(unwrapSignal(wrap, { recipientSk: eavesdropperSk, roomId: ROOM })).toBeNull()
  })

  it('returns null when the inner body names a different room', () => {
    const { senderSk, recipientSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(unwrapSignal(wrap, { recipientSk, roomId: 'e'.repeat(64) })).toBeNull()
  })

  it('returns null for rubbish rather than throwing', () => {
    const { senderSk, recipientSk, recipient } = fixture()
    const wrap = { ...wrapSignal(body, { senderSk, recipientPubkey: recipient }), content: 'nope' }
    expect(() => unwrapSignal(wrap, { recipientSk, roomId: ROOM })).not.toThrow()
    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM })).toBeNull()
  })

  it('BUG (I5): refuses a signal older than the staleness window', () => {
    // A hostile or simply buggy relay re-delivering a captured wrap must not
    // be able to force a renegotiation nobody asked for. Signalling is live
    // state: an offer that is a minute old describes a connection attempt
    // that has already been superseded.
    const { senderSk, recipientSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    const sentAt = wrap.created_at

    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM, now: sentAt })).not.toBeNull()
    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM, now: sentAt + SIGNAL_MAX_AGE_SECONDS - 1 })).not.toBeNull()
    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM, now: sentAt + SIGNAL_MAX_AGE_SECONDS + 1 })).toBeNull()
  })

  it('BUG (I5): refuses a signal stamped too far in the future', () => {
    // The window is symmetric, so a sender cannot mint a wrap that stays
    // acceptable for ever by stamping it years ahead.
    const { senderSk, recipientSk, recipient } = fixture()
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    const sentAt = wrap.created_at

    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM, now: sentAt - SIGNAL_MAX_AGE_SECONDS - 1 })).toBeNull()
  })

  it('carries an ICE candidate as well as an offer', () => {
    const { senderSk, recipientSk, recipient } = fixture()
    const ice: SignalBody = { type: 'ice', roomId: ROOM, candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' }
    const wrap = wrapSignal(ice, { senderSk, recipientPubkey: recipient })
    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM })?.body).toEqual(ice)
  })
})
