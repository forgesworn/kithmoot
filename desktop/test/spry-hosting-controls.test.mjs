import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHostingControls, createHostingQuitGuard, parseHostingConfig, loadHostingConfig } from '../spry-hosting-controls.mjs'

const config = { executable: '/reviewed/spry-turn', listenIp: '10.8.0.2', port: 3478, relayPorts: [49160, 49191] }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(overrides = {}) {
  const calls = { loads: 0, starts: 0, stops: 0, dialogs: [] }
  let notify
  const host = { async start() { calls.starts++; notify({ status: 'running', endpoint: '10.8.0.2:3478' }) }, async stop() { calls.stops++; notify({ status: 'off' }) } }
  const controls = createHostingControls({ enabled: true, configPath: '/owner/config.json',
    load: async () => { calls.loads++; return config },
    createHost: options => { notify = options.onState; return host },
    showDialog: async options => { calls.dialogs.push(options); return { response: 1 } }, ...overrides })
  return { controls, calls, host }
}

test('strict config accepts concrete IPv4 and bounds all inputs', () => {
  assert.deepEqual(parseHostingConfig(JSON.stringify(config)), config)
  for (const value of [{ ...config, executable: 'spry-turn' }, { ...config, extra: true }, { ...config, listenIp: '0.0.0.0' },
    { ...config, relayPorts: [49160, 49192] }, { ...config, port: 49160 }, null, [], { ...config, secret: 'private' }]) {
    assert.throws(() => parseHostingConfig(JSON.stringify(value)), { message: 'The local relay configuration is unavailable or invalid.' })
  }
  assert.throws(() => parseHostingConfig(' '.repeat(8193)))
})

test('file errors are redacted and relative paths are refused', async () => {
  for (const path of ['relative', '/nonexistent/private-owner-config.json']) {
    await assert.rejects(loadHostingConfig(path), { message: 'The local relay configuration is unavailable or invalid.' })
  }
})

test('bounded configuration loader rejects oversized files and reads a strict owner file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kithmoot-hosting-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'owner.json')
  await writeFile(file, JSON.stringify(config), { mode: 0o600 })
  assert.deepEqual(await loadHostingConfig(file), config)
  await writeFile(file, ' '.repeat(8193))
  await assert.rejects(loadHostingConfig(file), { message: 'The local relay configuration is unavailable or invalid.' })
})

test('FIFO configuration is rejected without waiting for a writer', { skip: process.platform === 'win32', timeout: 2000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kithmoot-hosting-fifo-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'owner.fifo')
  await promisify(execFile)('/usr/bin/mkfifo', [file])
  await assert.rejects(loadHostingConfig(file), { message: 'The local relay configuration is unavailable or invalid.' })
})

test('unavailable control never reads configuration or starts a host', async () => {
  for (const overrides of [{ enabled: false }, { configPath: undefined }, { configPath: 'relative' }]) {
    const { controls, calls } = fixture(overrides)
    assert.equal(controls.state().status, 'off')
    await controls.present()
    assert.equal(calls.loads, 0); assert.equal(calls.starts, 0)
    assert.match(calls.dialogs[0].message, /unavailable/)
  }
})

test('native Start is explicit, Cancel is default and Stop releases the host', async () => {
  const { controls, calls } = fixture()
  assert.equal(calls.loads, 0)
  await controls.present()
  assert.equal(calls.starts, 1)
  assert.equal(controls.state().status, 'running')
  assert.equal(calls.dialogs[0].defaultId, 0)
  assert.equal(calls.dialogs[0].cancelId, 0)
  assert.match(calls.dialogs[0].detail, /per allocation/)
  assert.match(calls.dialogs[0].detail, /does not prove Proton/)
  await controls.present()
  assert.equal(calls.stops, 1)
  assert.equal(controls.state().status, 'off')
})

test('cancel and duplicate native actions cannot start twice', async () => {
  const consent = deferred()
  let dialogs = 0
  const { controls, calls } = fixture({ showDialog: () => { dialogs++; return consent.promise } })
  const first = controls.present(); const second = controls.present()
  await Promise.resolve()
  consent.resolve({ response: 0 })
  await Promise.all([first, second])
  assert.equal(dialogs, 1); assert.equal(calls.starts, 0)
})

test('stop invalidates a pending file read or consent, even if subsequently resumed', async () => {
  for (const waitingFor of ['load', 'consent']) {
    const pending = deferred()
    const { controls, calls } = fixture(waitingFor === 'load' ? { load: () => pending.promise } : { showDialog: () => pending.promise })
    const action = controls.present()
    await Promise.resolve()
    await controls.stop({ block: true })
    await controls.resume()
    pending.resolve(waitingFor === 'load' ? config : { response: 1 })
    await action
    assert.equal(calls.starts, 0)
  }
})

test('suspend during start waits for Stop and never restarts on resume', async () => {
  const started = deferred(); const stopped = deferred()
  let stops = 0
  const { controls } = fixture({ createHost: () => ({ start: () => started.promise, stop: () => { stops++; return stopped.promise } }) })
  const action = controls.present()
  await Promise.resolve(); await Promise.resolve()
  const stopping = controls.stop({ block: true })
  assert.equal(controls.state().blocked, true)
  stopped.resolve(); await stopping
  started.resolve(); await action
  await controls.resume()
  assert.equal(stops, 1)
  assert.equal(controls.state().status, 'off')
  assert.equal(controls.state().blocked, false)
})

test('unconfirmed exit stays failed and blocked; concurrent lifecycle stops coalesce', async () => {
  const stopped = deferred()
  const { controls, host, calls } = fixture()
  await controls.present()
  host.stop = async () => { calls.stops++; await stopped.promise; throw new Error('private-native-error') }
  const first = controls.stop({ block: true }); const second = controls.stop({ block: true })
  stopped.resolve()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(calls.stops, 1)
  assert.equal(controls.state().status, 'failed')
  assert.equal(controls.state().blocked, true)
  assert.equal(JSON.stringify(controls.state()).includes('private'), false)
})

test('a new suspend cannot be undone by an older pending resume', async () => {
  const stopped = deferred()
  const { controls, host } = fixture()
  await controls.present()
  host.stop = () => stopped.promise
  const resume = controls.resume()
  const suspend = controls.stop({ block: true })
  stopped.resolve()
  await Promise.all([resume, suspend])
  assert.equal(controls.state().blocked, true)
})

test('a failed configuration never exposes owner paths or file contents', async () => {
  const messages = []
  const { controls, calls } = fixture({ load: async () => { throw new Error('private-owner-path-and-secret') },
    showDialog: async options => { messages.push(options); return { response: 0 } } })
  await controls.present()
  assert.equal(calls.starts, 0)
  assert.equal(controls.state().status, 'failed')
  assert.equal(JSON.stringify(messages).includes('private-owner'), false)
})

test('cancelled quit cannot reissue Quit after an older asynchronous Stop completes', async () => {
  const pending = deferred()
  let quits = 0
  let failures = 0
  const guard = createHostingQuitGuard({ stop: () => pending.promise, quit: () => quits++, failed: () => failures++ })
  const attempt = guard.request()
  assert.equal(guard.quitting, true)
  guard.cancel()
  pending.resolve(true)
  assert.equal(await attempt, false)
  assert.equal(quits, 0)
  assert.equal(failures, 0)
  assert.equal(guard.confirmed, false)
  assert.equal(guard.quitting, false)
})

test('a newer quit supersedes cancelled work and only confirms its own Stop', async () => {
  const first = deferred(); const second = deferred()
  let stops = 0
  let quits = 0
  const guard = createHostingQuitGuard({ stop: () => (++stops === 1 ? first.promise : second.promise), quit: () => quits++, failed: () => assert.fail('unexpected stop failure') })
  const oldAttempt = guard.request()
  guard.cancel()
  const newAttempt = guard.request()
  first.resolve(true)
  await oldAttempt
  assert.equal(quits, 0)
  assert.equal(guard.confirmed, false)
  second.resolve(true)
  assert.equal(await newAttempt, true)
  assert.equal(quits, 1)
  assert.equal(guard.confirmed, true)
})

test('quit refusal on unconfirmed exit can be retried without automatic quit', async () => {
  let succeeds = false
  let quits = 0
  let failures = 0
  const guard = createHostingQuitGuard({ stop: async () => succeeds, quit: () => quits++, failed: async () => failures++ })
  assert.equal(await guard.request(), false)
  assert.equal(quits, 0)
  assert.equal(failures, 1)
  assert.equal(guard.confirmed, false)
  succeeds = true
  assert.equal(await guard.request(), true)
  assert.equal(quits, 1)
})
