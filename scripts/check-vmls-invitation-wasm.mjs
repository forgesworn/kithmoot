import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve('app/public/vmls-wasm-invitation')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const commit = '6d36f5f5faecfa71d3437108defb40e19df19d9d'
const expected = {
  'vmls_wasm.js': '9b01589eddd99a6c2cc6823c4f4a6be151011746d1cdf45a224162e8675f2fcc',
  'vmls_wasm_bg.wasm': 'fae524c85758ba90e14fea61ee3706ad2e47cc9ee12e569fb086ab90cc9e7dbc',
  'vmls_wasm.d.ts': 'ab4a497d3178ed594c9cf5a91fdf0a906e113e93fd124746911da8b961b8b545',
}
if (manifest.experimental !== true || manifest.sourceCommit !== commit || manifest.target !== 'web' || manifest.snapshotVersion !== 4) throw new Error('Invalid experimental VMLS provenance')
const loader = readFileSync('app/src/mls-invitation-engine.ts', 'utf8')
if (!loader.includes(commit)) throw new Error('Experimental VMLS loader source pin differs')
for (const [file, expectedHash] of Object.entries(expected)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')
  if (manifest.files[file] !== expectedHash || actual !== expectedHash) throw new Error(`Experimental VMLS hash differs: ${file}`)
  if (!file.endsWith('.d.ts') && !loader.includes(expectedHash)) throw new Error(`Experimental loader pin differs: ${file}`)
}
console.log(`Development invitation engine verified: ${commit}`)
