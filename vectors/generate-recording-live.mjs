// Additive wire fixtures; all secrets and randomness are public test material.
// Build dist first. Every generated result is checked by the real decoder.
import { readFileSync, writeFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { nip44 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'
import { seed32, finalizeDeterministic, withStubbedRandomness } from './lib/determinism.mjs'
import { KINDS } from '../dist/src/kinds.js'
import { decodeRosterEvent } from '../dist/src/roster.js'
import { signRecordingNotice, signRecordingCaptureNotice } from '../dist/src/meeting.js'
import { sanitiseLiveRecordingState, verifyLiveRecordingState } from '../dist/src/live-recording.js'

const published = JSON.parse(readFileSync(new URL('./kithmoot-vectors.json', import.meta.url), 'utf8'))
const base = published.groups.rosterEvent.find(row => row.name === 'valid').input
const roomId = base.roomId, roomKey = hexToBytes(base.roomKeyHex), deviceSk = hexToBytes(base.deviceSkHex)
const authoritySk = new Uint8Array(32).fill(1), authority = getPublicKey(authoritySk)
const pair = capture => {
  const notice = { on: true, id: '12'.repeat(16), version: 17 }
  const details = { id: notice.id, version: notice.version, capture, recorder: base.entry.participant, device: base.entry.device }
  const recordingAux = seed32(`live-recording-${capture}-recording-aux`)
  const captureAux = seed32(`live-recording-${capture}-capture-aux`)
  return {
    recording: { op: 'recording', ...notice, sig: withStubbedRandomness([recordingAux], () => signRecordingNotice({ roomId, notice, authoritySk })) },
    capture: { op: 'recording-capture', ...details, sig: withStubbedRandomness([captureAux], () => signRecordingCaptureNotice({ roomId, notice: details, authoritySk })) },
  }
}
const gallery = pair('gallery'), offNotice = { on: false, id: gallery.recording.id, version: 18 }
const off = { recording: { op: 'recording', ...offNotice, sig: withStubbedRandomness([seed32('live-recording-off-aux')], () => signRecordingNotice({ roomId, notice: offNotice, authoritySk })) } }
const rows = [
  ['legacy-absent', undefined, undefined], ['legacy-profile-2', 2, undefined], ['profile-3-no-warning', 3, undefined],
  ...['audio', 'gallery', 'speaker', 'screen-camera'].map(layout => [`on-${layout}`, 3, pair(layout)]),
  ['off', 3, off], ['profile-2-drops-live', 2, gallery], ['absent-profile-drops-live', undefined, gallery],
  ['unknown-profile-drops-live', 4, gallery],
  ['on-missing-capture', 3, { recording: gallery.recording }],
  ['capture-wrong-id', 3, { ...gallery, capture: { ...gallery.capture, id: '34'.repeat(16) } }],
  ['capture-wrong-version', 3, { ...gallery, capture: { ...gallery.capture, version: 18 } }],
  ['capture-unknown-layout', 3, { ...gallery, capture: { ...gallery.capture, capture: 'unknown' } }],
  ['off-with-capture', 3, { ...off, capture: gallery.capture }],
  ['unknown-live-field', 3, { ...gallery, extra: true }],
  ['malformed-signature', 3, { ...gallery, recording: { ...gallery.recording, sig: 'bad' } }],
  ['tampered-recorder', 3, { ...gallery, capture: { ...gallery.capture, recorder: 'cc'.repeat(32) } }],
  ['tampered-device', 3, { ...gallery, capture: { ...gallery.capture, device: 'dd'.repeat(32) } }],
  ['tampered-layout', 3, { ...gallery, capture: { ...gallery.capture, capture: 'speaker' } }],
  ['tampered-matched-id', 3, { recording: { ...gallery.recording, id: '34'.repeat(16) }, capture: { ...gallery.capture, id: '34'.repeat(16) } }],
  ['tampered-matched-version', 3, { recording: { ...gallery.recording, version: 19 }, capture: { ...gallery.capture, version: 19 } }],
  ['malformed-on-boolean', 3, { ...gallery, recording: { ...gallery.recording, on: 'true' } }],
  ['forged-recording-signature', 3, { ...gallery, recording: { ...gallery.recording, sig: '00'.repeat(64) } }],
  ['forged-capture-signature', 3, { ...gallery, capture: { ...gallery.capture, sig: '00'.repeat(64) } }],
  ['wrong-room-authority', 3, gallery, getPublicKey(new Uint8Array(32).fill(2))],
  ['signature-for-another-room', 3, gallery, authority, 'cd'.repeat(32)],
]
const cases = rows.map(([name, profile, state, root = authority, verificationRoom = roomId]) => {
  const entry = { ...base.entry, ...(profile === undefined ? {} : { recordingProfile: profile }), ...(state === undefined ? {} : { liveRecording: state }) }
  const nonce = seed32(`recording-live-${name}-nonce`), auxRand = seed32(`recording-live-${name}-event-aux`)
  const event = finalizeDeterministic({ kind: KINDS.ROSTER, created_at: entry.updatedAt, tags: [['d', roomId]], content: nip44.v2.encrypt(JSON.stringify(entry), roomKey, nonce) }, deviceSk, auxRand)
  const decoded = decodeRosterEvent(event, { roomId, roomKey, now: entry.updatedAt })
  if (!decoded) throw new Error(`Invalid roster fixture: ${name}`)
  const parsed = sanitiseLiveRecordingState(state)
  return { name, input: { entry, roomId, roomKeyHex: base.roomKeyHex, deviceSkHex: base.deviceSkHex, nonceHex: bytesToHex(nonce), auxRandHex: bytesToHex(auxRand), authority: root, verificationRoom }, event, expected: { entry: decoded, state: parsed ?? null, authorised: !!parsed && verifyLiveRecordingState(verificationRoom, parsed, root), liveAuthorised: !!decoded.liveRecording && verifyLiveRecordingState(verificationRoom, decoded.liveRecording, root) } }
})
writeFileSync(process.argv[2] ?? new URL('./recording-live.json', import.meta.url), JSON.stringify({ protocolVersion: 'kithmoot/v1', generatedBy: 'vectors/generate-recording-live.mjs', description: 'Profile 3 live recording and legacy roster compatibility; public test material only', cases }, null, 2) + '\n')
