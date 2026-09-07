// Install real tarballs outside the workspace. No symlink or source-tree fallback.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const checkout = process.cwd()
const temp = mkdtempSync(join(tmpdir(), 'context-package-check-'))
const npm = (args, cwd = checkout) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function pack(name) {
  const result = JSON.parse(npm(['pack', '--workspace', name, '--json', '--pack-destination', temp]))[0]
  assert.ok(result.files.some(f => f.path === 'dist/index.d.ts'))
  assert.ok(result.files.some(f => f.path === 'LICENSE'))
  assert.ok(result.files.some(f => f.path === 'THIRD_PARTY_NOTICES.md'))
  assert.ok(result.files.every(f => !f.path.startsWith('src/') && !f.path.includes('node_modules')))
  return join(temp, result.filename)
}
function install(name, tarballs) {
  const dir = join(temp, name); mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }))
  npm(['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], dir)
  return dir
}
function checkNotices(consumer, name) {
  const installed = join(consumer, 'node_modules', name)
  assert.match(readFileSync(join(installed, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 TheCryptoDonkey/)
  const notices = readFileSync(join(installed, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  for (const [dependency, version] of Object.entries(manifest.dependencies)) {
    assert.ok(notices.includes(`${dependency}@${version}`), `Missing notice for ${dependency}@${version}`)
  }
  assert.match(notices, /nostr-wasm@0\.1\.0/)
  if (name === '@forgesworn/context') assert.match(notices, /Copyright \(c\) 2013 Pieter Wuille/)
}
try {
  const core = pack('@forgesworn/context')
  const tools = pack('@forgesworn/context-tools')
  const consumer = install('core-consumer', [core])
  checkNotices(consumer, '@forgesworn/context')
  const source = `import { ContextVault, type ContextIdentity } from '@forgesworn/context'
import { createNostrIdentity } from '@forgesworn/context/nostr'
const identity: ContextIdentity = createNostrIdentity(new Uint8Array(32).fill(9))
export const vault = new ContextVault({ identity })
export const view = await vault.create({ title: 'Independent consumer', scope: 'kith' })
`
  writeFileSync(join(consumer, 'consumer.mts'), source)
  execFileSync(resolve('node_modules/.bin/tsc'), ['consumer.mts', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck'], { cwd: consumer, stdio: 'pipe' })
  // Browser bundling fails on accidental Node imports; resolution starts in the
  // isolated installation, not this repository's node_modules.
  execFileSync(resolve('node_modules/.bin/esbuild'), ['consumer.mts', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.mjs', '--metafile=browser-meta.json'], { cwd: consumer, stdio: 'pipe' })
  const bundle = JSON.parse(readFileSync(join(consumer, 'browser-meta.json'), 'utf8'))
  assert.ok(Object.keys(bundle.inputs).every(input => !input.includes('nostr-wasm')), 'Core browser consumer unexpectedly bundles nostr-wasm')
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    const require = createRequire(import.meta.url)
    for (const name of ['kithmoot', '@modelcontextprotocol/sdk', 'zod']) assert.throws(() => require.resolve(name))
    globalThis.fetch = () => { throw new Error('Unexpected network access') }
    const { canonicalEnvelopeName } = await import('@forgesworn/context/blossom')
    assert.equal(canonicalEnvelopeName('a'.repeat(179) + '😀.txt'), 'a'.repeat(179))
    const { vault, view } = await import('./consumer.mjs')
    assert.equal(vault.read(view.id).title, 'Independent consumer')
    const cache = await vault.save()
    assert.ok(!cache.includes('Independent consumer'))
    await vault.restore(cache)
    const browser = await import('./browser.mjs')
    assert.equal(browser.vault.read(browser.view.id).title, 'Independent consumer')
  `], { cwd: consumer, stdio: 'pipe' })
  const toolsConsumer = install('tools-consumer', [core, tools])
  checkNotices(toolsConsumer, '@forgesworn/context-tools')
  const cli = join(toolsConsumer, 'node_modules/@forgesworn/context-tools/bin/encrypted-context.mjs')
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /encrypted-context mcp/)
  writeFileSync(join(toolsConsumer, 'test-key'), '09'.repeat(32), { mode: 0o600 })
  const pubkey = execFileSync(process.execPath, ['--input-type=module', '-e', "import {createNostrIdentity} from '@forgesworn/context/nostr'; process.stdout.write(createNostrIdentity(new Uint8Array(32).fill(9)).pubkey)"], { cwd: toolsConsumer, encoding: 'utf8' })
  const args = ['--identity', join(toolsConsumer, 'test-key'), '--expect-pubkey', pubkey, '--state', join(toolsConsumer, 'state.json'), '--personal']
  const call = (name, input) => JSON.parse(execFileSync(process.execPath, [cli, 'call', name, ...args], { input: JSON.stringify(input), encoding: 'utf8' }))
  const created = call('context_create', { title: 'Packed CLI state', scope: 'personal' })
  const appended = call('context_append', { collection: created.id, expectedHead: created.head, kind: 'fact', text: 'The packed CLI can persist records.', source: 'fixture://packaging', observedAt: 1800000000 })
  assert.equal(call('context_read', { collection: created.id }).head, appended.head)
  assert.ok(!readFileSync(join(toolsConsumer, 'state.json'), 'utf8').includes('Packed CLI state'))
  execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; assert.throws(()=>createRequire(import.meta.url).resolve('kithmoot'))"], { cwd: toolsConsumer, stdio: 'pipe' })
  console.log('Packed core: independent Node import, declarations and browser bundle passed.')
  console.log('Packed Node tools: independent CLI create, append and restart recovery passed.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
