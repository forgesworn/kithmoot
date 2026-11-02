#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, statSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Private inputs are supplied locally. This command never uploads binaries or
// turns a private Shelter build into a public release.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--inputs', '--output', '--platform'].includes(key) || !value || options.has(key)) throw Error('Use --inputs DIRECTORY --output NEW_DIRECTORY --platform linux-arm64|linux-x64')
  options.set(key, value)
}
if (options.size !== 3 || !['linux-arm64', 'linux-x64'].includes(options.get('--platform'))) throw Error('Explicit input directory, new output directory and Linux architecture are required')
const inputs = resolve(options.get('--inputs')), output = resolve(options.get('--output'))
if (existsSync(output)) throw Error('Release output must be a new directory')
mkdirSync(output, { mode: 0o700 })
try {
const files = [], digest = value => createHash('sha256').update(value).digest('hex')
function add(path, source, executable = false) {
  const target = join(output, path); mkdirSync(dirname(target), { recursive: true, mode: 0o755 }); copyFileSync(source, target); chmodSync(target, executable ? 0o755 : 0o644)
}
add('runtime/bin/node', join(inputs, 'node'), true)
add('bin/spry-node', join(inputs, 'spry-node'), true); add('bin/bothyd', join(inputs, 'bothyd'), true)
for (const name of ['Node', 'Spry', 'Shelter']) add(`licenses/${name}-LICENSE.txt`, join(inputs, `${name}-LICENSE.txt`))
for (const name of ['kithmoot-node.service', 'kithmoot-node-front.service']) add(`deploy/${name}`, join(repository, 'deploy/node', name))
mkdirSync(join(output, 'lib'), { mode: 0o755 })
const bundled = await build({ absWorkingDir: repository, entryPoints: ['bin/kithmoot-node.mjs'], outfile: join(output, 'lib/kithmoot-node.mjs'),
  plugins: [{ name: 'current-node-source', setup(build) {
    build.onResolve({ filter: /^\.\.\/dist\/src\// }, args => ({ path: resolve(repository, args.path.replace('../dist/', '').replace(/\.js$/, '.ts')) }))
  } }],
  platform: 'node', format: 'esm', bundle: true, target: 'node24', minify: true, legalComments: 'none', metafile: true,
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
const notices = ['KithMoot node: private engineering candidate.', 'External archive provenance, complete native dependency notices and publisher approval remain release gates.', readFileSync(join(repository, 'LICENSE'), 'utf8')]
const packages = new Map()
for (const file of Object.keys(bundled.metafile.inputs)) {
  let directory = dirname(resolve(repository, file))
  while (directory !== dirname(directory)) {
    const metadata = join(directory, 'package.json')
    if (existsSync(metadata)) {
      const pkg = JSON.parse(readFileSync(metadata, 'utf8'))
      if (pkg.name && !pkg.name.startsWith('@forgesworn/kithmoot')) packages.set(`${pkg.name}@${pkg.version}`, directory)
      break
    }
    directory = dirname(directory)
  }
}
for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'license', 'license.txt'].map(file => join(directory, file)).find(existsSync)
  if (!license) throw Error(`Bundled package needs its licence notice: ${name}`)
  notices.push(`\n${name}\n${readFileSync(license, 'utf8')}`)
}
writeFileSync(join(output, 'licenses/NOTICE.txt'), notices.join('\n\n') + '\n', { mode: 0o644 })
writeFileSync(join(output, 'kithmoot-node'), '#!/bin/sh\nset -eu\nnode_release_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$node_release_dir/runtime/bin/node" "$node_release_dir/lib/kithmoot-node.mjs" "$@"\n', { mode: 0o755 })
chmodSync(join(output, 'kithmoot-node'), 0o755)
const provenance = JSON.parse(readFileSync(join(inputs, 'provenance.json'), 'utf8'))
if (!Array.isArray(provenance) || provenance.length !== 3) throw Error('Supply provenance for node, spry and shelter inputs')
const { readdirSync } = await import('node:fs')
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute, path)
    else if (entry.isFile()) { const info = statSync(absolute); files.push({ path, bytes: info.size, sha256: digest(readFileSync(absolute)), executable: !!(info.mode & 0o111) }) }
    else throw Error('Release output contains an unexpected link or special file')
  }
}
walk(output); files.sort((a, b) => a.path.localeCompare(b.path))
const { NODE_VERSION } = await import(join(repository, 'src/node/kithmoot-node/version.ts'))
writeFileSync(join(output, 'release.json'), JSON.stringify({ v: 1, name: 'kithmoot-node', version: NODE_VERSION, platform: options.get('--platform'), distribution: 'private-candidate', dependencies: provenance, files }, null, 2) + '\n', { mode: 0o644 })
const verifier = await build({ entryPoints: [join(repository, 'src/node/kithmoot-node/release.ts')], bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false })
const { verifyRelease } = await import('data:text/javascript;base64,' + Buffer.from(verifier.outputFiles[0].text).toString('base64'))
const verified = verifyRelease(output)
console.log(JSON.stringify({ distribution: verified.release.distribution, version: verified.release.version, platform: verified.release.platform, files: files.length, manifestSha256: verified.digest }))

} catch (error) { rmSync(output, { recursive: true, force: true }); throw error }
