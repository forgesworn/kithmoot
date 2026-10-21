import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const scratch = resolve('release/staging/link-provenance-tests')
const owned: string[] = []
function fixture() {
  mkdirSync(scratch,{recursive:true})
  const root = mkdtempSync(join(scratch,'assets-')); owned.push(root)
  cpSync('app/public/link-web',root,{recursive:true})
  const manifest = JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'))
  return { root, manifest, save: () => writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest)),
    run: () => spawnSync(process.execPath,['scripts/check-link-web.mjs',root],{encoding:'utf8'}) }
}
afterEach(() => { for (const path of owned.splice(0)) rmSync(path,{recursive:true,force:true}) })
describe('pinned Link runtime dependencies', () => {
  it('accepts the complete pinned package including its imported JavaScript snippet', () => {
    expect(fixture().run().status).toBe(0)
  })
  it('rejects changed snippet bytes even though all three legacy assets match', () => {
    const f = fixture(), snippet = Object.keys(f.manifest.files).find(name => name.startsWith('snippets/'))!
    writeFileSync(join(f.root,snippet),'export const tampered = true')
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Link asset hash mismatch')
  })
  it('rejects an imported dependency removed from the manifest', () => {
    const f = fixture(), snippet = Object.keys(f.manifest.files).find(name => name.startsWith('snippets/'))!
    delete f.manifest.files[snippet]; f.save()
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Unpinned Link dependency')
  })
  it('rejects undeclared package files', () => {
    const f = fixture(); writeFileSync(join(f.root,'unexpected.js'),'export {}')
    expect(f.run().stderr).toContain('Unpinned Link asset')
  })
  it('rejects path traversal before reading manifest targets', () => {
    const f = fixture(); f.manifest.files['../outside.js'] = 'a'.repeat(64); f.save()
    expect(f.run().stderr).toContain('Invalid Link asset manifest entry')
  })
})
