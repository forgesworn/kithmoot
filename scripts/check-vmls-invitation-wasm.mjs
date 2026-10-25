import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve('app/public/vmls-wasm-invitation')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const commit = 'fa366b49adcb5ff9b541209fe9ccda31f5d0d15f'
const expected = {
  'vmls_wasm.js': '9b01589eddd99a6c2cc6823c4f4a6be151011746d1cdf45a224162e8675f2fcc',
  'vmls_wasm_bg.wasm': '9963d5c5ee6e744a15ac0ebb303bdd71645d65683d003300ed4459e80ffef134',
  'vmls_wasm.d.ts': 'ab4a497d3178ed594c9cf5a91fdf0a906e113e93fd124746911da8b961b8b545',
}
if (manifest.experimental !== true || manifest.sourceCommit !== commit || manifest.target !== 'web') throw new Error('Invalid experimental VMLS provenance')
const loader = readFileSync('app/src/mls-invitation-engine.ts', 'utf8')
if (!loader.includes(commit)) throw new Error('Experimental VMLS loader source pin differs')
for (const [file, expectedHash] of Object.entries(expected)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')
  if (manifest.files[file] !== expectedHash || actual !== expectedHash) throw new Error(`Experimental VMLS hash differs: ${file}`)
  if (!file.endsWith('.d.ts') && !loader.includes(expectedHash)) throw new Error(`Experimental loader pin differs: ${file}`)
}
console.log(`Development invitation engine verified: ${commit}`)
