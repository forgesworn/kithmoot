import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
const root=resolve(process.argv[2] ?? 'app/public/vmls-wasm')
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
if(!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.target!=='web')throw new Error('Invalid VMLS provenance')
if(!readFileSync('app/src/mls-engine.ts','utf8').includes(manifest.sourceCommit))throw new Error('VMLS loader does not match pinned assets')
for(const file of ['vmls_wasm.js','vmls_wasm.d.ts','vmls_wasm_bg.wasm']){
  const digest=createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')
  if(digest!==manifest.files[file])throw new Error(`VMLS asset hash mismatch: ${file}`)
}
console.log(`Pinned VMLS assets verified: ${manifest.sourceCommit}`)
