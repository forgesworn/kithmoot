// Additive interop fixtures. The all-01 secret is public test material only.
// Run npm run build:lib first; existing kithmoot-vectors.json stays unchanged.
import { writeFileSync } from 'node:fs'
import { getPublicKey } from 'nostr-tools/pure'
import { signRecordingCaptureNotice, encodeControl } from '../dist/src/index.js'

const authoritySk = new Uint8Array(32).fill(1)
const authority = getPublicKey(authoritySk)
const roomId = 'ab'.repeat(32)
const cases = ['audio', 'gallery', 'speaker', 'screen-camera'].map((capture, i) => {
  const notice = { id: '12'.repeat(16), version: 17 + i, capture, recorder: 'aa'.repeat(32), device: 'bb'.repeat(32) }
  const sig = signRecordingCaptureNotice({ roomId, notice, authoritySk })
  return { roomId, authority, notice, sig, encoded: encodeControl({ op: 'recording-capture', ...notice, sig }) }
})
writeFileSync(new URL('./recording-capture.json', import.meta.url), JSON.stringify({ description: 'Signed recording capture companion fixtures; public test key only; legacy recording vectors are unchanged', cases }, null, 2) + '\n')
