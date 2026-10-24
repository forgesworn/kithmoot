import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { reviewRealtimeSource, assertRealtimeSourceStable } = await import(new URL('../scripts/realtime-reviewed-sources.mjs', import.meta.url).href)
const { prepareRealtime } = await import(new URL('../scripts/prepare-realtime.mjs', import.meta.url).href)
const { buildRealtimeOperator } = await import(new URL('../scripts/build-realtime-operator.mjs', import.meta.url).href)
const { copyRealtimeBrowserAssets } = await import(new URL('../scripts/realtime-browser-assets.mjs', import.meta.url).href)
const scratch: string[] = []
const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function put(root: string, path: string, text: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'realtime-build-check-')); scratch.push(path); return path }
async function repository(path: string, files: Record<string, string>) {
  await mkdir(path, { recursive: true }); git(path, ['init', '--quiet'])
  for (const [name, value] of Object.entries(files)) await put(path, name, value)
  git(path, ['add', '.'])
  git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic build inputs'])
  return git(path, ['rev-parse', 'HEAD'])
}
async function suite() {
  const root = await temporary(), projectRoot = join(root, 'application'), relayswarmRoot = join(root, 'relayswarm'), sapflowRoot = join(root, 'sapflow')
  const swarm = await repository(relayswarmRoot, {
    'package.json': '{"name":"fixture-relayswarm","type":"module"}', 'package-lock.json': '{}', LICENSE: 'Synthetic licence fixture',
    'src/relay-session.mjs': 'export class RelayPool {}\nexport class RelaySwarmSession {}',
    'src/browser/realtime-peer.mjs': 'export class RealtimePeer {}',
    'src/node/native-realtime.mjs': 'export const fixtureNative = true;',
    'native-patches/version.patch': 'Synthetic patch input', 'scripts/build-native-realtime.mjs': 'export const fixtureBuild = true;',
    'scripts/native-patches/libjuice.patch': 'Synthetic native source patch',
    '.gitattributes': 'scripts/native-patches/*.patch text eol=lf\n',
  })
  const sapflow = await repository(sapflowRoot, {
    '.gitignore': 'build.rs\n', 'Cargo.toml': '[workspace]\nmembers=["crates/sapflow-core","crates/sapflow-realtime-wasm","crates/other"]\n',
    'Cargo.lock': '# Synthetic lock', '.cargo/config.toml': '[build]\ntarget-dir="target"', 'rust-toolchain.toml': '[toolchain]\nchannel="1.94.1"',
    LICENSE: 'Synthetic licence fixture', 'crates/sapflow-core/Cargo.toml': '[package]\nname="fixture-core"',
    'crates/sapflow-core/src/lib.rs': 'pub fn fixture() {}', 'crates/sapflow-core/README.md': 'Original unrelated documentation',
    'crates/sapflow-realtime-wasm/Cargo.toml': '[package]\nname="fixture-wasm"', 'crates/sapflow-realtime-wasm/src/lib.rs': 'pub fn fixture() {}',
    'crates/sapflow-realtime-wasm/browser.mjs': 'export const fixture = true;',
    'crates/other/Cargo.toml': '[package]\nname="fixture-other"', 'crates/other/src/lib.rs': 'pub fn unrelated() {}',
    'scripts/build-realtime-wasm.sh': '#!/bin/sh\nprintf reached > build-ran\nexit 19\n', 'scripts/third-party-licences.py': '# Synthetic fixture only',
  })
  await put(projectRoot, 'realtime-sources.json', JSON.stringify({ format: 1, relayswarm: swarm, sapflow }))
  return { projectRoot, relayswarmRoot, sapflowRoot, swarm, sapflow,
    swarmSelection: { directory: relayswarmRoot, repository: 'relayswarm', revision: swarm },
    sapflowSelection: { directory: sapflowRoot, repository: 'sapflow', revision: sapflow } }
}
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('reviewed realtime build source closure', () => {
  it('refuses a dirty standalone native facade before creating output or starting a build', async () => {
    const f = await suite()
    await put(f.relayswarmRoot, 'src/node/native-realtime.mjs', 'export const unreviewed = true;')
    // There is deliberately no native dependency/entrypoint in the fixture.
    // The source refusal must happen before reading or building either one.
    await expect(buildRealtimeOperator({ projectRoot: f.projectRoot, relayswarmRoot: f.relayswarmRoot })).rejects.toThrow('source differs')
    await expect(readFile(join(f.projectRoot, 'dist/realtime-forwarder.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(f.projectRoot, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an ignored automatic Cargo build.rs before executing the companion build script', async () => {
    const f = await suite(), path = 'crates/sapflow-core/build.rs'
    await put(f.sapflowRoot, path, 'fn main() { panic!("not reviewed"); }')
    expect(git(f.sapflowRoot, ['check-ignore', path])).toBe(path)
    await expect(prepareRealtime(f)).rejects.toThrow('source differs')
    await expect(readFile(join(f.sapflowRoot, 'build-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(f.projectRoot, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects extra wasm build scripts, source files and legacy Cargo configuration', async () => {
    for (const path of ['crates/sapflow-realtime-wasm/build.rs', 'crates/sapflow-core/src/main.rs', '.cargo/config', 'rust-toolchain']) {
      const f = await suite()
      await put(f.sapflowRoot, path, 'Synthetic unreviewed input')
      await expect(reviewRealtimeSource(f.sapflowSelection)).rejects.toThrow('source differs')
      const qualified = await reviewRealtimeSource({ ...f.sapflowSelection, allowWorkingTree: true })
      expect(qualified).toMatchObject({ reviewedSourceMatch: false, workingTree: true, extraFiles: [path] })
      expect(qualified.files[path]).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('includes native patch inputs and existing workspace manifests without rejecting unrelated source or README edits', async () => {
    const f = await suite()
    await put(f.sapflowRoot, 'crates/sapflow-core/README.md', 'Concurrent documentation edit')
    await put(f.sapflowRoot, 'crates/other/src/lib.rs', 'Concurrent unrelated protocol implementation')
    expect(await reviewRealtimeSource(f.sapflowSelection)).toMatchObject({ reviewedSourceMatch: true, workingTree: false })
    await put(f.sapflowRoot, 'crates/other/Cargo.toml', '[package]\nname="changed-workspace-manifest"')
    await expect(reviewRealtimeSource(f.sapflowSelection)).rejects.toThrow('source differs')
    await put(f.relayswarmRoot, 'native-patches/extra.patch', 'New native compilation input')
    await expect(reviewRealtimeSource(f.swarmSelection)).rejects.toThrow('source differs')
    await rm(join(f.relayswarmRoot, 'native-patches/extra.patch'))
    await put(f.relayswarmRoot, 'scripts/native-patches/extra.patch', 'New native compilation input at the actual builder path')
    await expect(reviewRealtimeSource(f.swarmSelection)).rejects.toThrow('source differs')
    await rm(join(f.relayswarmRoot, 'scripts/native-patches/extra.patch'))
    await put(f.relayswarmRoot, '.gitattributes', '* -text\n')
    await expect(reviewRealtimeSource(f.swarmSelection)).rejects.toThrow('source differs')
  })

  it('records explicit dirty qualification honestly and refuses source changes during a build even if restored to the pin', async () => {
    const f = await suite(), path = 'src/node/native-realtime.mjs'
    const original = await readFile(join(f.relayswarmRoot, path), 'utf8')
    await put(f.relayswarmRoot, path, 'export const dirty = true;')
    const before = await reviewRealtimeSource({ ...f.swarmSelection, allowWorkingTree: true })
    expect(before).toMatchObject({ reviewedSourceMatch: false, workingTree: true, changedFiles: [path] })
    await put(f.relayswarmRoot, path, original)
    const after = await reviewRealtimeSource(f.swarmSelection)
    expect(after.reviewedSourceMatch).toBe(true)
    expect(() => assertRealtimeSourceStable(before, after)).toThrow('changed while the build')
  })

  it('does not confuse an unrelated commit advancing HEAD with a source change', async () => {
    const f = await suite(), before = await reviewRealtimeSource(f.sapflowSelection)
    await put(f.sapflowRoot, 'unrelated-note.txt', 'Synthetic unrelated fixture')
    git(f.sapflowRoot, ['add', 'unrelated-note.txt'])
    git(f.sapflowRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Unrelated fixture commit'])
    const after = await reviewRealtimeSource(f.sapflowSelection)
    expect(after.head).not.toBe(before.head)
    expect(after.reviewedSourceMatch).toBe(true)
    expect(() => assertRealtimeSourceStable(before, after)).not.toThrow()
  })

  it('refuses a relevant source symlink even during explicit dirty qualification', async () => {
    const f = await suite(), outside = join(await temporary(), 'outside.rs')
    await writeFile(outside, 'Synthetic outside source')
    await symlink(outside, join(f.sapflowRoot, 'crates/sapflow-core/build.rs'))
    await expect(reviewRealtimeSource({ ...f.sapflowSelection, allowWorkingTree: true })).rejects.toThrow('regular files')
  })
})

describe('browser-only realtime distribution', () => {
  it('copies only browser assets/notices and retires only its previously generated native files', async () => {
    const root = await temporary(), source = join(root, 'build'), destination = join(root, 'public/realtime')
    const code = ['transport.mjs', 'sapflow.mjs', 'sapflow_realtime_bg.wasm'], assets: Record<string, string> = {}
    for (const name of code) { await put(source, name, `Synthetic ${name}`); assets[name] = createHash('sha256').update(`Synthetic ${name}`).digest('hex') }
    for (const name of ['SAPFLOW_LICENSE', 'SAPFLOW_THIRD_PARTY_LICENSES.txt', 'RELAYSWARM_LICENSE']) await put(source, name, `Synthetic ${name}`)
    const nativeAssets = { 'native-backend.mjs': 'unused', 'native-addon.node': 'unused' }
    await put(source, 'manifest.json', JSON.stringify({ format: 1, sources: [], assets, nativeAssets }))
    for (const name of ['native-backend.mjs', 'native-addon.node', 'operator-backend.json', 'NATIVE_SOURCE_NOTICE.txt', 'NODE_DATA_CHANNEL_LICENSE']) {
      await put(source, name, 'Synthetic native artefact'); await put(destination, name, 'Previous generated native artefact')
    }
    await put(destination, 'manifest.json', JSON.stringify({ nativeAssets: { 'old-native.node': 'unused', '../keep.txt': 'unused' } }))
    await put(destination, 'old-native.node', 'Previous generated native fixture')
    await put(destination, 'keep-user-file.txt', 'Preserve unrelated content')
    await put(root, 'public/keep.txt', 'Preserve parent public content')
    await copyRealtimeBrowserAssets(source, destination)
    expect((await readdir(destination)).sort()).toEqual([...code, 'SAPFLOW_LICENSE', 'SAPFLOW_THIRD_PARTY_LICENSES.txt', 'RELAYSWARM_LICENSE', 'manifest.json', 'keep-user-file.txt'].sort())
    expect(await readFile(join(root, 'public/keep.txt'), 'utf8')).toBe('Preserve parent public content')
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'))
    expect(manifest).toEqual({ format: 1, sources: [], assets })
    expect(await readFile(join(source, 'native-addon.node'), 'utf8')).toBe('Synthetic native artefact')
  })

  it('refuses tampered browser bytes before copying anything to the public tree', async () => {
    const root = await temporary(), source = join(root, 'build'), destination = join(root, 'public/realtime')
    await put(source, 'manifest.json', JSON.stringify({ assets: { 'transport.mjs': '0'.repeat(64) } }))
    await put(source, 'transport.mjs', 'Tampered synthetic transport')
    await expect(copyRealtimeBrowserAssets(source, destination)).rejects.toThrow('differs from its manifest')
    await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
