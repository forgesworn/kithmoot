import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(process.argv[2] ?? 'app/public/link-web')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.target !== 'web') throw new Error('Invalid Link provenance')
if (!readFileSync('app/src/browser-link-runtime.ts', 'utf8').includes(manifest.sourceCommit)) throw new Error('Link runtime version does not match the pinned assets')
for (const file of ['link_web.js', 'link_web.d.ts', 'link_web_bg.wasm']) {
  const digest = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')
  if (digest !== manifest.files[file]) throw new Error(`Link asset hash mismatch: ${file}`)
}
console.log(`Pinned Link assets verified: ${manifest.sourceCommit}`)
