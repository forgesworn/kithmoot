import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signRecordingCaptureNotice, verifyRecordingCaptureNotice, type RecordingCaptureNotice } from './meeting.js'
import { decodeControl, encodeControl } from './control.js'

const authoritySk = generateSecretKey(), authority = getPublicKey(authoritySk)
const roomId = 'ab'.repeat(32)
const notice: RecordingCaptureNotice = { id: '12'.repeat(16), version: 17, capture: 'gallery', recorder: 'aa'.repeat(32), device: 'bb'.repeat(32) }

describe('signed recording capture details', () => {
  it('keeps the published signatures and wire encodings valid without regenerating them', () => {
    const vectors = JSON.parse(readFileSync(new URL('../vectors/recording-capture.json', import.meta.url), 'utf8')) as {
      cases: Array<{ roomId: string; authority: string; notice: RecordingCaptureNotice; sig: string; encoded: string }>
    }
    expect(vectors.cases.map(row => row.notice.capture)).toEqual(['audio', 'gallery', 'speaker', 'screen-camera'])
    for (const row of vectors.cases) {
      expect(verifyRecordingCaptureNotice(row)).toBe(true)
      expect(encodeControl({ op: 'recording-capture', ...row.notice, sig: row.sig })).toBe(row.encoded)
      expect(decodeControl(row.encoded)).toEqual({ op: 'recording-capture', ...row.notice, sig: row.sig })
    }
  })
  it('binds every displayed field and the room to the authority', () => {
    const sig = signRecordingCaptureNotice({ roomId, notice, authoritySk })
    expect(verifyRecordingCaptureNotice({ roomId, notice, sig, authority })).toBe(true)
    for (const change of [
      { id: '34'.repeat(16) }, { version: 18 }, { capture: 'audio' as const },
      { recorder: 'cc'.repeat(32) }, { device: 'dd'.repeat(32) },
    ]) expect(verifyRecordingCaptureNotice({ roomId, notice: { ...notice, ...change }, sig, authority })).toBe(false)
    expect(verifyRecordingCaptureNotice({ roomId: 'cd'.repeat(32), notice, sig, authority })).toBe(false)
    expect(verifyRecordingCaptureNotice({ roomId, notice, sig, authority: getPublicKey(generateSecretKey()) })).toBe(false)
  })

  it.each(['audio', 'gallery', 'speaker', 'screen-camera'] as const)('round-trips signed %s details as an independent control op', capture => {
    const next = { ...notice, capture }
    const op = { op: 'recording-capture' as const, ...next, sig: signRecordingCaptureNotice({ roomId, notice: next, authoritySk }) }
    const decoded = decodeControl(encodeControl(op))
    expect(decoded).toEqual(op)
    expect(verifyRecordingCaptureNotice({ roomId, notice: decoded as typeof op, sig: op.sig, authority })).toBe(true)
  })

  it('refuses malformed, ambiguous and unsupported details before display', () => {
    const sig = signRecordingCaptureNotice({ roomId, notice, authoritySk })
    for (const change of [
      { capture: 'webcam' }, { capture: undefined }, { capture: ['audio'] },
      { version: '17' }, { version: -1 }, { version: 1.5 }, { version: 2 ** 53 },
      { id: 'short' }, { recorder: 'AA'.repeat(32) }, { device: 'short' }, { sig: '00' },
    ]) expect(decodeControl(JSON.stringify({ op: 'recording-capture', ...notice, sig, ...change }))).toBeNull()
    expect(verifyRecordingCaptureNotice({ roomId, notice: { ...notice, capture: 'unsupported' as never }, sig, authority })).toBe(false)
  })
})
