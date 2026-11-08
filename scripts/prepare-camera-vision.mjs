import { readFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('./camera-vision-runtime.json', import.meta.url)))
const dependency = resolve(root, 'node_modules/@mediapipe/tasks-vision')
const output = resolve(root, 'app/public/camera-vision')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
if (JSON.parse(readFileSync(resolve(dependency, 'package.json'))).version !== manifest.version) throw Error('Unreviewed camera runtime version')
if (sha(readFileSync(resolve(dependency, 'vision_bundle.mjs'))) !== manifest.bundleSha256) throw Error('Unreviewed camera JavaScript runtime')
if (sha(readFileSync(resolve(output, 'selfie_segmenter.tflite'))) !== manifest.modelSha256) throw Error('Unreviewed foreground model')
// Review every byte before copying any runtime asset. A dependency update
// requires a fresh telemetry review, not only a package-lock change.
for (const [name, digest] of Object.entries(manifest.files)) {
  if (sha(readFileSync(resolve(dependency, 'wasm', name))) !== digest) throw Error(`Unreviewed camera runtime: ${name}`)
}
for (const name of Object.keys(manifest.files)) copyFileSync(resolve(dependency, 'wasm', name), resolve(output, name))
console.log(`Prepared reviewed local camera runtime ${manifest.version}`)
