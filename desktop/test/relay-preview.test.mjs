import test from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_IDS, createPreviewRelayHost, parsePreview, previewFromEnvironment } from '../relay-preview.mjs'

test('a packaged build never reads the preview switches', () => {
  const env = { KITHMOOT_DESKTOP_RELAY_PREVIEW: 'S5', KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK: 'reachable' }
  assert.equal(previewFromEnvironment({ env, packaged: true }), undefined)
  assert.deepEqual(previewFromEnvironment({ env, packaged: false }), { id: 'S5', reason: 'carrier-grade-nat', check: 'reachable' })
})

test('a switch names a state, and for S7 a reason; anything else is ignored', () => {
  assert.deepEqual(parsePreview('S7:double-nat'), { id: 'S7', reason: 'double-nat' })
  for (const bad of [undefined, '', 'S99', 'S7:Double', 'S7:a:b', 'constructor', '__proto__', 42]) assert.equal(parsePreview(bad), undefined, String(bad))
  assert.equal(previewFromEnvironment({ env: { KITHMOOT_DESKTOP_RELAY_PREVIEW: 'S4', KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK: 'x' }, packaged: false }).check, undefined)
})

test('every state id reports an available relay and ignores start and stop', async () => {
  assert.equal(PREVIEW_IDS.length, 23)
  for (const id of PREVIEW_IDS) {
    const logged = []
    const host = createPreviewRelayHost({ id, reason: 'vpn', log: (...line) => logged.push(line) })
    const before = JSON.stringify(host.state())
    assert.equal(host.state().available, true, id)
    await host.start({ person: true })
    await host.stop()
    assert.equal(JSON.stringify(host.state()), before, id)
    assert.equal(logged.length, 2)
  }
})

test('the preview carries a forced check, and the checkbox is remembered in memory only', async () => {
  const seen = []
  const host = createPreviewRelayHost({ id: 'S4', check: 'same-network', changed: state => seen.push(state) })
  assert.deepEqual(host.state().preview, { check: 'same-network' })
  await host.setStartOnOpen(true)
  assert.equal(host.state().startOnOpen, true)
  assert.equal(seen.length, 1)
})
