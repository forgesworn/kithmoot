import test from 'node:test'
import assert from 'node:assert/strict'
import features from '../platform-features.cjs'

test('share area is available on Linux X11', () => {
  assert.equal(features.supportsShareArea('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), true)
  assert.equal(features.supportsShareArea('linux', { DISPLAY: ':0' }), true)
})

test('native Wayland keeps the ordinary share fallback', () => {
  assert.equal(features.supportsShareArea('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }), false)
  assert.equal(features.supportsShareArea('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false)
})

test('macOS and Windows retain share area', () => {
  assert.equal(features.supportsShareArea('darwin', {}), true)
  assert.equal(features.supportsShareArea('win32', {}), true)
})

test('the sandboxed preload requires nothing but electron', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../preload.cjs', import.meta.url), 'utf8')
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
  assert.deepEqual(required, ['electron'])
  assert.ok(source.includes(`'${features.SHARE_AREA_SWITCH}'`))
})
