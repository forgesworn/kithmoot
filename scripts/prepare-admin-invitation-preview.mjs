#!/usr/bin/env node
/** Copy only the exact reviewed local qualification asset; no download/build. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-admin-invitation-preview.mjs <exact local web bundle directory>')
const pin = { sourceCommit: '5b3eb5fe28255b5c0cc09d959a3010a3d48f9562', files: {
  'vmls_wasm.js': '2c07c8c3f0a883440ee9a3c4c2a300bdb20b5e8c9e6d3ff0b65c7b904786c099',
  'vmls_wasm_bg.wasm': '8c593171bafa5d205e570f58ab1171894b70e5f05d5361b95254228702621560',
  'vmls_wasm.d.ts': 'd0fc76ab83dc12cb69c92ed86a69af318411212a5ca8bb49b8ae09a205de7307',
} }
const manifestBytes = await readFile(resolve(source, 'manifest.json')), m = JSON.parse(manifestBytes)
if (m.sourceCommit !== pin.sourceCommit || m.target !== 'web' || m.qualificationOnly !== true || m.experimental !== true || m.snapshotVersion !== 5 ||
    m.profile !== 'Vennel/invitation-admins/2' || m.policy !== 'designated-leaf-admins/1') throw new Error('Wrong Admin2 qualification provenance')
const verified = new Map()
for (const [name, hash] of Object.entries(pin.files)) {
  const bytes = await readFile(resolve(source, name))
  if (m.files?.[name] !== hash || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Wrong Admin2 qualification bytes: ${name}`)
  verified.set(name, bytes)
}
const destination = resolve(root, 'app/public/vmls-wasm-admin-invitation')
await mkdir(destination, { recursive: true })
for (const [name, bytes] of verified) await writeFile(resolve(destination, name), bytes)
await writeFile(resolve(destination, 'manifest.json'), manifestBytes)
console.log('Prepared exact local Admin2 qualification asset. Production remains disabled.')
