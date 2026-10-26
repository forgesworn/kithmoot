#!/usr/bin/env node
/** Check emitted distributions against the exact tracked qualification source. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { candidatePin, verifyCandidateDirectory } from './admin2-product-candidate.mjs'
const profile = process.argv[2]
if (profile !== 'default' && profile !== 'admin2') throw new Error('Usage: node scripts/check-admin2-product-distribution.mjs default|admin2')
const output = resolve('app/dist/vmls-wasm-admin2-candidate')
const serviceWorker = readFileSync('app/dist/sw.js', 'utf8')
assert.equal(serviceWorker.includes('vmls-wasm-admin2-candidate/'), false, 'Candidate runtime must not be precached')
if (profile === 'default') {
  assert.equal(existsSync(output), false, 'Default distribution emitted Admin2 native runtime')
} else {
  const files = verifyCandidateDirectory()
  assert.deepEqual(readdirSync(output).sort(), ['manifest.json', 'vmls_wasm.js', 'vmls_wasm_bg.wasm'].sort())
  for (const name of ['manifest.json', 'vmls_wasm.js', 'vmls_wasm_bg.wasm']) {
    const bytes = readFileSync(resolve(output, name))
    assert.deepEqual(bytes, files.get(name), `Selected distribution differs from exact native source: ${name}`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), name === 'manifest.json' ? candidatePin.manifest : candidatePin.files[name], `Selected distribution hash differs: ${name}`)
  }
}
console.log(`${profile} Admin2 distribution verified`)
