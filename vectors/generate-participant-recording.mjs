// Run npm run build:lib first. These keys identify synthetic fixture people.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getPublicKey } from 'nostr-tools/pure'
import { signRecordingNotice, signRecordingCaptureNotice } from '../dist/src/meeting.js'
import { verifyLiveRecordingState } from '../dist/src/live-recording.js'

const roomId = 'ab'.repeat(32), call = '12'.repeat(16)
const deviceSk = new Uint8Array(32).fill(8), device = getPublicKey(deviceSk), participant = getPublicKey(new Uint8Array(32).fill(9))
const cases = ['audio', 'gallery', 'speaker', 'screen-camera', 'off'].map((mode, index) => {
  const notice = { on: mode !== 'off', id: '34'.repeat(16), version: 100 + index }
  const capture = { id: notice.id, version: notice.version, capture: mode, recorder: participant, device }
  const state = { call, recorder: participant, device,
    recording: { op: 'recording', ...notice, sig: signRecordingNotice({ roomId, notice, authoritySk: deviceSk }) },
    ...(notice.on ? { capture: { op: 'recording-capture', ...capture, sig: signRecordingCaptureNotice({ roomId, notice: capture, authoritySk: deviceSk }) } } : {}) }
  if (!verifyLiveRecordingState({ roomId, state, participant, device, call, profile: 4 })) throw new Error(`Invalid fixture: ${mode}`)
  return { name: mode, state }
})
const sourceHashes = Object.fromEntries(['meeting.ts', 'live-recording.ts'].map(name =>
  [`src/${name}`, createHash('sha256').update(readFileSync(new URL(`../src/${name}`, import.meta.url))).digest('hex')]))
writeFileSync(new URL('./participant-recording.json', import.meta.url), JSON.stringify({ format: 'kithmoot.participant-recording.v1',
  source: 'forgesworn/kithmoot', sourceHashes, roomId, participant, device, call, cases }, null, 2) + '\n')
console.log(`${cases.length} TypeScript-signed participant recording fixtures`)
