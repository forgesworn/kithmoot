import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, posix } from 'node:path'
const root = resolve(process.argv[2] ?? 'app/public/link-web')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.target !== 'web') throw new Error('Invalid Link provenance')
if (!readFileSync('app/src/browser-link-runtime.ts', 'utf8').includes(manifest.sourceCommit)) throw new Error('Link runtime version does not match the pinned assets')
for (const required of ['link_web.js', 'link_web.d.ts', 'link_web_bg.wasm']) {
  if (!Object.hasOwn(manifest.files ?? {}, required)) throw new Error(`Missing Link asset: ${required}`)
}
for (const [file, expected] of Object.entries(manifest.files)) {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(file) || file.split('/').some(p => p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid Link asset manifest entry')
  const digest = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')
  if (digest !== expected) throw new Error(`Link asset hash mismatch: ${file}`)
  if (file.endsWith('.js')) {
    const source = readFileSync(resolve(root, file), 'utf8')
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      const dependency = posix.normalize(posix.join(posix.dirname(file), specifier))
      if (!specifier.startsWith('./') || !Object.hasOwn(manifest.files, dependency)) throw new Error(`Unpinned Link dependency: ${specifier}`)
    }
  }
}
function checkFiles(directory = '') {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const file = posix.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Link assets cannot be symbolic links')
    if (entry.isDirectory()) checkFiles(file)
    else if (!entry.isFile() || (file !== 'manifest.json' && !Object.hasOwn(manifest.files, file))) throw new Error(`Unpinned Link asset: ${file}`)
  }
}
checkFiles()
console.log(`Pinned Link assets verified: ${manifest.sourceCommit}`)
