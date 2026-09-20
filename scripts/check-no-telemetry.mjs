// Fails the build if a known third-party telemetry endpoint has made it
// into the built app.
//
// `@mediapipe/tasks-vision` >=1.0.1-rc has an ungated usage logger: creating
// any task constructs it, and it POSTs protobuf to
// https://odml.pa.googleapis.com/v1/log every 60s and on close(), with an
// `x-goog-api-key` header baked into the wasm. That is exactly the kind of
// call a room reaching a third party the app never asked to trust - the
// same failure mode the MediaPipe runtime is already served from our own
// origin to avoid (see app/vite.config.ts). The dependency is pinned to an
// exact version proven clean of it, but a bump - by hand or by a careless
// `npm update` - would silently reintroduce it, so the build checks the
// output rather than trusting the pin.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const FORBIDDEN = ['odml.pa.googleapis.com', 'x-goog-api-key', '_mediapipeLoggerGetEncodedApiKey']

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
      'Pin @mediapipe/tasks-vision to a version proven clean of these strings.',
  )
  process.exit(1)
}

console.log(`No telemetry markers found in ${dir}.`)
