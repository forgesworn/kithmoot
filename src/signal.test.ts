import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  wrapSignal, unwrapSignal, SIGNAL_MAX_AGE_SECONDS, MAX_ANNOTATION_POINTS,
  MAX_BATCHED_CANDIDATES, MAX_CANDIDATE_LENGTH, validSignalExtensions, type SignalBody,
} from './signal.js'
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
    // Force two successive clock reads across a Unix-second boundary. The
    // inner and outer events must still share the one captured timestamp.
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_999).mockReturnValue(1_001_000)
    try {
      const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
      const sentAt = wrap.created_at

      expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM, now: sentAt - SIGNAL_MAX_AGE_SECONDS - 1 })).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })

  it('carries an ICE candidate as well as an offer', () => {
    const { senderSk, recipientSk, recipient } = fixture()
    const ice: SignalBody = { type: 'ice', roomId: ROOM, candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' }
    const wrap = wrapSignal(ice, { senderSk, recipientPubkey: recipient })
    expect(unwrapSignal(wrap, { recipientSk, roomId: ROOM })?.body).toEqual(ice)
  })

  it('carries bounded screen markup and refuses hostile coordinates', () => {
    const { senderSk, recipientSk, recipient } = fixture()
    const annotation: SignalBody = {
      type: 'annotation', roomId: ROOM,
      annotation: { op: 'stroke', shareId: 'screen-track', strokeId: 'stroke-1', points: [{ x: .1, y: .2 }, { x: .8, y: .7 }] },
    }
    expect(unwrapSignal(wrapSignal(annotation, { senderSk, recipientPubkey: recipient }), { recipientSk, roomId: ROOM })?.body).toEqual(annotation)

    const outside: SignalBody = { ...annotation, annotation: { ...annotation.annotation!, points: [{ x: -.1, y: .2 }, { x: .8, y: .7 }] } }
    expect(unwrapSignal(wrapSignal(outside, { senderSk, recipientPubkey: recipient }), { recipientSk, roomId: ROOM })).toBeNull()

    const flooded: SignalBody = { ...annotation, annotation: { ...annotation.annotation!, points: Array.from({ length: MAX_ANNOTATION_POINTS + 1 }, () => ({ x: .5, y: .5 })) } }
    expect(unwrapSignal(wrapSignal(flooded, { senderSk, recipientPubkey: recipient }), { recipientSk, roomId: ROOM })).toBeNull()
  })
})

describe('profile 2 wire fields', () => {
  const CONN_A = 'a1b2c3d4e5f60718'
  const CONN_B = '0718a1b2c3d4e5f6'
  const SLOTS = { '0': 'mic', '1': 'camera', '2': 'screen', '3': 'screen-audio' } as const

  function roundTrip(body: SignalBody) {
    const { senderSk, recipientSk, recipient } = fixture()
    return unwrapSignal(wrapSignal(body, { senderSk, recipientPubkey: recipient }), { recipientSk, roomId: ROOM })
  }

  it('carries a generation-opening offer with slots, gen and conn', () => {
    const body: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP, gen: 1, conn: CONN_A, seq: 1, slots: { ...SLOTS } }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  it('lower-cases conn and peerConn on decode', () => {
    const body: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP, gen: 1, conn: CONN_A.toUpperCase(), peerConn: CONN_B.toUpperCase(), seq: 1 }
    expect(roundTrip(body)?.body).toEqual({ ...body, conn: CONN_A, peerConn: CONN_B })
  })

  it('carries a batched ice signal with first, seq and candidates', () => {
    const body: SignalBody = { type: 'ice', roomId: ROOM, gen: 3, conn: CONN_A, first: 5, seq: 7, candidates: ['candidate:1 1 udp 1 10.0.0.1 1 typ host', 'candidate:2 1 udp 1 10.0.0.2 1 typ host'] }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  it('carries a standalone ack', () => {
    const body: SignalBody = { type: 'ack', roomId: ROOM, gen: 1, conn: CONN_A, peerConn: CONN_B, ack: 4 }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  it('carries a health report naming one dead slot among several', () => {
    const body: SignalBody = { type: 'health', roomId: ROOM, gen: 1, conn: CONN_A, rx: { camera: 'dead', mic: 'ok' } }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  it('carries a sync naming only the current generation', () => {
    const body: SignalBody = { type: 'sync', roomId: ROOM, gen: 9 }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  it('carries a restart flag and the offer seq an answer replies to', () => {
    const offer: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP, gen: 2, conn: CONN_A, seq: 3, restart: true }
    expect(roundTrip(offer)?.body).toEqual(offer)
    const answer: SignalBody = { type: 'answer', roomId: ROOM, sdp: SDP, gen: 2, conn: CONN_B, seq: 1, re: 3 }
    expect(roundTrip(answer)?.body).toEqual(answer)
  })

  it('an old-shaped body with none of these fields still round-trips exactly as before', () => {
    const body: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP }
    expect(roundTrip(body)?.body).toEqual(body)
  })

  describe('validSignalExtensions rejects malformed profile-2 fields', () => {
    const base: SignalBody = { type: 'offer', roomId: ROOM, sdp: SDP }

    it.each([
      ['gen zero', { gen: 0 }],
      ['gen negative', { gen: -1 }],
      ['gen fractional', { gen: 1.5 }],
      ['gen a string', { gen: '1' }],
      ['conn too short', { conn: 'a1b2c3' }],
      ['conn not hex', { conn: 'zzzzzzzzzzzzzzzz' }],
      ['peerConn wrong length', { peerConn: 'a1b2c3d4e5f6071811' }],
      ['seq zero', { seq: 0 }],
      ['first fractional', { first: 1.2 }],
      ['ack negative', { ack: -1 }],
      ['ack fractional', { ack: 0.5 }],
      ['re zero', { re: 0 }],
      ['restart false', { restart: false }],
      ['restart truthy non-boolean', { restart: 1 }],
      ['candidates empty', { candidates: [] }],
      ['candidates too many', { candidates: Array.from({ length: MAX_BATCHED_CANDIDATES + 1 }, () => 'candidate:1') }],
      ['candidates non-string entry', { candidates: [1] }],
      ['candidates entry too long', { candidates: ['x'.repeat(MAX_CANDIDATE_LENGTH + 1)] }],
      ['slots missing a role', { slots: { '0': 'mic', '1': 'camera', '2': 'screen' } }],
      ['slots wrong count', { slots: { ...SLOTS, '4': 'mic' } }],
      ['slots duplicate role', { slots: { '0': 'mic', '1': 'mic', '2': 'screen', '3': 'screen-audio' } }],
      ['slots unknown role', { slots: { '0': 'mic', '1': 'camera', '2': 'screen', '3': 'speaker' } }],
      ['rx empty', { rx: {} }],
      ['rx unknown role', { rx: { speaker: 'dead' } }],
      ['rx bad verdict', { rx: { camera: 'maybe' } }],
    ])('%s', (_name, patch) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(validSignalExtensions({ ...base, ...(patch as any) })).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(roundTrip({ ...base, ...(patch as any) })).toBeNull()
    })

    it('a sync with no gen is rejected', () => {
      expect(validSignalExtensions({ type: 'sync', roomId: ROOM })).toBe(false)
      expect(roundTrip({ type: 'sync', roomId: ROOM } as SignalBody)).toBeNull()
    })

    it('a health with no rx is rejected', () => {
      expect(validSignalExtensions({ type: 'health', roomId: ROOM, conn: CONN_A })).toBe(false)
      expect(roundTrip({ type: 'health', roomId: ROOM, conn: CONN_A } as SignalBody)).toBeNull()
    })
  })

  it('an unknown type is still rejected exactly as before', () => {
    const body = { type: 'bogus', roomId: ROOM } as unknown as SignalBody
    expect(roundTrip(body)).toBeNull()
  })
})
