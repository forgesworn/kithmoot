// Exercise the actual packed artifact, not an import directly into dist/.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

// Keep unpacked code beside this checkout so its normal dependencies resolve.
const dir = mkdtempSync(join(process.cwd(), '.package-check-'))
const tarDir = mkdtempSync(join(tmpdir(), 'kithmoot-package-'))
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', tarDir], { encoding: 'utf8' }))
  execFileSync('tar', ['-xzf', join(tarDir, packed[0].filename), '-C', dir])
  const root = join(dir, 'package')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(existsSync(join(root, manifest.types)), 'packed type entry point is missing')
  const { createRequire } = await import('node:module')
  const require = createRequire(pathToFileURL(join(dir, 'consumer.cjs')))
  const resolved = require.resolve(root)
  const api = await import(pathToFileURL(resolved).href)
  assert.equal(api.generateRoomSecret().length, 32)
  console.log('Packed library resolves, imports and exposes its declarations.')
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(tarDir, { recursive: true, force: true })
}
