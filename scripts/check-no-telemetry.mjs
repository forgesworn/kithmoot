// Fails the build if a known third-party telemetry endpoint has made it
// into the built app.
//
// The old MediaPipe stack is removed. Keep checking the built bytes for
// its usage logger and camera-model assets so it cannot return silently.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const FORBIDDEN = ['odml.pa.googleapis.com', 'x-goog-api-key', '_mediapipeLoggerGetEncodedApiKey', '@mediapipe/tasks-vision', 'selfie_segmenter.tflite', 'blaze_face_short_range.tflite']

const dir = process.argv[2]
if (!dir) throw new Error('Usage: check-no-telemetry.mjs <built-output-dir>')

async function* files(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) yield* files(full)
    else yield full
  }
}

const hits = []
for await (const file of files(dir)) {
  const bytes = await readFile(file)
  const text = bytes.toString('latin1') // byte-preserving: catches the string inside wasm too
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) hits.push({ file, needle })
  }
}

if (hits.length > 0) {
  console.error(`Found telemetry markers in the built app (${dir}):`)
  for (const { file, needle } of hits) console.error(`  ${file}: "${needle}"`)
  console.error(
    '\nThis app promises that turning on a camera effect never phones home. ' +
      'A dependency bump likely reintroduced the MediaPipe usage logger - see ' +
      'docs/decisions.md and scripts/check-no-telemetry.mjs for the history. ' +
      'Remove the reintroduced camera SDK or telemetry rather than pinning it.',
  )
  process.exit(1)
}

console.log(`No telemetry markers found in ${dir}.`)
