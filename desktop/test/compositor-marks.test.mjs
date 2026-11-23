import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompositorMarks } from '../compositor-marks.mjs'
const points = [{ x: 0, y: 0.3 }, { x: 1, y: 0.8 }]
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kithmoot-compositor-test-'))
  const bridge = new CompositorMarks(directory)
  t.after(async () => { await bridge.stop(); await rm(directory, { recursive: true, force: true }) })
  const commands = []
  assert.equal(await bridge.start('window', value => commands.push(value)), true)
  const connection = JSON.parse(await readFile(join(directory, 'annotations.json'), 'utf8'))
  const headers = { Authorization: `Bearer ${connection.token}` }
  const state = await (await fetch(`${connection.url}/state`, { headers })).json()
  const post = (path, body, extra = {}) => fetch(connection.url + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  return { bridge, commands, directory, connection, headers, state, post }
}
test('only private, bounded drawing data crosses the authenticated local link', async t => {
  const { bridge, commands, directory, connection, headers, state, post } = await fixture(t)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, 'annotations.json'))).mode & 0o777, 0o600)
  assert.equal(new URL(connection.url).hostname, '127.0.0.1')
  assert.equal((await fetch(connection.url + '/state')).status, 403)
  assert.equal((await fetch(connection.url + '/state', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await post('/stroke', { session: state.session, points })).status, 204)
  assert.deepEqual(commands, [{ op: 'stroke', points }])
  const strokes = [{ points, color: '#5ec8ff', alpha: 0.5, secret: 'not exported' }]
  assert.equal(bridge.render(strokes), true)
  const visible = await (await fetch(connection.url + '/state', { headers })).json()
  assert.deepEqual(visible.strokes, [{ points, color: '#5ec8ff', alpha: 0.5 }])
  assert.deepEqual(Object.keys(visible).sort(), ['kind', 'session', 'strokes'])
  for (const action of ['clear', 'stop']) assert.equal((await post('/action', { session: state.session, action })).status, 204)
  assert.deepEqual(commands.slice(1), [{ op: 'clear' }, { op: 'stop' }])
})
test('rejects stale, malformed, oversized and out-of-bounds commands', async t => {
  const { bridge, commands, state, post } = await fixture(t)
  assert.equal((await post('/stroke', { session: 'old', points })).status, 409)
  for (const bad of [null, [], [{ x: 0, y: 0 }], [{ x: -0.01, y: 0 }, points[1]], Array(257).fill(points[0]), [{ x: null, y: 0 }, points[1]]]) {
    assert.equal((await post('/stroke', { session: state.session, points: bad })).status, 400)
  }
  assert.equal((await post('/stroke', { session: state.session, points, padding: 'x'.repeat(33000) })).status, 413)
  assert.equal((await post('/action', { session: state.session, action: 'launch' })).status, 400)
  assert.equal(bridge.render([{ points, color: 'red', alpha: 1 }]), false)
  assert.equal(bridge.render([{ points, color: '#ffffff', alpha: -1 }]), false)
  assert.deepEqual(commands, [])
})
test('stop wins an acquiring start and rejoining rotates the capability', async t => {
  const { bridge, directory, connection, state, post } = await fixture(t)
  const restarting = bridge.start('screen', () => assert.fail('revoked callback'))
  const stopping = bridge.stop()
  assert.equal(await restarting, false)
  await stopping
  await assert.rejects(readFile(join(directory, 'annotations.json')), { code: 'ENOENT' })
  await assert.rejects(fetch(connection.url + '/state'))
  assert.equal(bridge.render([]), false)
  assert.equal(await bridge.start('screen', () => {}), true)
  const next = JSON.parse(await readFile(join(directory, 'annotations.json'), 'utf8'))
  assert.notEqual(next.token, connection.token)
  const fresh = await (await fetch(next.url + '/state', { headers: { Authorization: `Bearer ${next.token}` } })).json()
  assert.notEqual(fresh.session, state.session)
  assert.equal(fresh.kind, 'screen')
  assert.equal((await fetch(next.url + '/state', { headers: { Authorization: `Bearer ${connection.token}` } })).status, 403)
})
test('cleanup preserves another instance discovery record', async t => {
  const { bridge, directory } = await fixture(t)
  await writeFile(join(directory, 'annotations.json'), JSON.stringify({ token: 'another instance' }))
  await bridge.stop()
  assert.equal(JSON.parse(await readFile(join(directory, 'annotations.json'), 'utf8')).token, 'another instance')
})
test('explicit companion target changes mode without publishing input', async t => {
  const { bridge, commands, connection, headers, state, post } = await fixture(t)
  assert.equal(await bridge.waitForCompanion(), true)
  assert.equal((await post('/target', { session: state.session, kind: 'screen' })).status, 204)
  const next = await (await fetch(connection.url + '/state', { headers })).json()
  assert.equal(next.kind, 'screen')
  assert.equal(next.session, state.session)
  assert.deepEqual(commands, [])
  assert.equal((await post('/target', { session: 'revoked', kind: 'window' })).status, 409)
  assert.equal((await post('/target', { session: state.session, kind: 'unknown' })).status, 400)
})
