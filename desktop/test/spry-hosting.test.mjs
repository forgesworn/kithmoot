import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHmac } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createSpryHosting } from '../spry-hosting.mjs'

const config = { listenIp: '127.0.0.1', port: 3478, relayPorts: [49160, 49191] }
function harness(options = {}) {
  const calls = []
  const children = []
  const spawn = (executable, args, settings) => {
    calls.push({ executable, args, settings })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.signals = []
    child.kill = signal => {
      child.signals.push(signal)
      if (!options.ignoreKill && (!options.ignoreTerm || signal === 'SIGKILL')) queueMicrotask(() => child.emit('exit', null, signal))
      return true
    }
    children.push(child)
    return child
  }
  const host = createSpryHosting({ executable: '/fixture/spry-turn', spawn, startupTimeoutMs: 40, stopTimeoutMs: 15, ...options })
  const ready = (child = children.at(-1), endpoint = '127.0.0.1:3478') => child.stderr.write(`spry-turn 0.2.1 ready (UDP/TCP ${endpoint})\n`)
  return { host, calls, children, ready }
}

test('construction and invalid configuration perform no process work', async () => {
  const { host, calls } = harness()
  assert.deepEqual(host.state(), { status: 'off' })
  assert.equal(calls.length, 0)
  for (const options of [undefined, {}, { ...config, listenIp: '0.0.0.0' }, { ...config, listenIp: '224.0.0.1' },
    { ...config, listenIp: '255.255.255.255' }, { ...config, port: 49160 }, { ...config, relayPorts: [4, 3] },
    { ...config, listenIp: 'relay.example' }, { ...config, port: '3478' }, { ...config, relayPorts: [49000, 49032] }]) {
    await assert.rejects(host.start(options), { code: 'ERR_CONFIG' })
  }
  assert.equal(calls.length, 0)
  assert.throws(() => createSpryHosting({ executable: 'spry-turn' }), { code: 'ERR_CONFIG' })
  assert.throws(() => host.credentials(), { code: 'ERR_NOT_RUNNING' })
})

test('explicit VPN addresses are allowed without a reachability claim', async () => {
  for (const listenIp of ['10.8.0.2', '100.64.0.2', '192.168.1.2']) {
    const { host, ready } = harness()
    const started = host.start({ ...config, listenIp })
    ready(undefined, `${listenIp}:3478`)
    assert.equal((await started).exposure, 'locally-bound')
    await host.stop()
  }
})

test('secret stays in child environment, caps are fixed and credentials use TURN REST', async () => {
  const previous = process.env.SPRY_PUBLIC
  process.env.SPRY_PUBLIC = 'true'
  try {
    const events = []
    const { host, calls, ready } = harness({ onState: state => events.push(state), nowSeconds: () => 1000 })
    const started = host.start(config)
    const { args, settings } = calls[0]
    const secret = settings.env.SPRY_TURN_SECRET
    assert.match(secret, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(settings.env).filter(key => key.toUpperCase().startsWith('SPRY_')), ['SPRY_TURN_SECRET'])
    assert.equal(settings.shell, false)
    assert.deepEqual(settings.stdio, ['pipe', 'ignore', 'pipe'])
    assert.deepEqual(args, ['serve', '--listen', '127.0.0.1:3478', '--relay-ip', '127.0.0.1', '--relay-ports', '49160:49191',
      '--max-allocations', '32', '--max-per-user', '8', '--max-connections', '32', '--bytes-per-second', '1000000', '--exit-on-stdin-close'])
    ready(); await started
    const result = host.credentials({ ttlSeconds: 60 })
    assert.equal(result.expiresAt, 1060)
    assert.match(result.username, /^1060:[a-f0-9]{32}$/)
    assert.equal(result.credential, createHmac('sha1', secret).update(result.username).digest('base64'))
    assert.notEqual(host.credentials().username, result.username)
    assert.throws(() => host.credentials({ nowSeconds: 1000000000000 }), { code: 'ERR_CONFIG' })
    assert.throws(() => host.credentials({ ttlSeconds: 3601 }), { code: 'ERR_CONFIG' })
    await host.stop()
    assert.equal(JSON.stringify({ events, state: host.state(), result }).includes(secret), false)
  } finally {
    if (previous === undefined) delete process.env.SPRY_PUBLIC; else process.env.SPRY_PUBLIC = previous
  }
})

test('credential clock is host-only and unsafe clock values fail without minting', async () => {
  assert.throws(() => createSpryHosting({ executable: '/fixture/spry-turn', nowSeconds: 1 }), { code: 'ERR_CONFIG' })
  for (const nowSeconds of [() => NaN, () => -1, () => 1.5, () => Number.MAX_SAFE_INTEGER, () => { throw new Error('private-clock-value'); }]) {
    const { host, ready } = harness({ nowSeconds })
    const started = host.start(config); ready(); await started
    assert.throws(() => host.credentials(), { code: 'ERR_CONFIG', message: 'Invalid local hosting configuration.' })
    await host.stop()
  }
  const { host, ready } = harness()
  const started = host.start(config); ready(); await started
  const before = Math.floor(Date.now() / 1000)
  const result = host.credentials({ ttlSeconds: 3600 })
  assert.ok(result.expiresAt >= before + 3600 && result.expiresAt <= Math.floor(Date.now() / 1000) + 3600)
  await host.stop()
})

test('duplicate start refuses and concurrent stops reap only once', async () => {
  const { host, children, ready } = harness()
  const started = host.start(config); ready(); await started
  await assert.rejects(host.start(config), { code: 'ERR_ALREADY_STARTED' })
  await Promise.all([host.stop(), host.stop()])
  assert.deepEqual(children[0].signals, ['SIGTERM'])
  assert.equal(children[0].stdin.writableEnded, true)
  assert.equal(host.state().status, 'off')
})

test('Off observer may restart immediately while the previous stop still resolves Off', async () => {
  let replacement
  let restarted = false
  const fixture = harness({ onState(state) {
    if (state.status === 'off' && !restarted) {
      restarted = true
      replacement = fixture.host.start(config)
      fixture.ready()
    }
  } })
  const first = fixture.host.start(config); fixture.ready(); await first
  assert.deepEqual(await fixture.host.stop(), { status: 'off' })
  await replacement
  assert.equal(fixture.host.state().status, 'running')
  assert.deepEqual(fixture.children[0].signals, ['SIGTERM'])
  assert.deepEqual(fixture.children[1].signals, [])
  await fixture.host.stop()
})

test('stop during startup cancels and late output cannot resurrect a restarted run', async () => {
  const { host, children, ready, calls } = harness()
  const first = host.start(config)
  const cancelled = assert.rejects(first, { code: 'ERR_START_CANCELLED' })
  await host.stop(); await cancelled
  const second = host.start(config)
  ready(children[0])
  children[0].emit('error', new Error(calls[0].settings.env.SPRY_TURN_SECRET))
  assert.equal(host.state().status, 'starting')
  ready(children[1]); await second
  assert.notEqual(calls[0].settings.env.SPRY_TURN_SECRET, calls[1].settings.env.SPRY_TURN_SECRET)
  await host.stop()
})

test('timeout escalates TERM to KILL and reaps before start failure returns', async () => {
  const { host, children } = harness({ ignoreTerm: true, startupTimeoutMs: 10 })
  await assert.rejects(host.start(config), { code: 'ERR_START_TIMEOUT' })
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(host.state().status, 'failed')
  await host.stop()
  assert.equal(host.state().status, 'off')
})

test('readiness endpoint mismatch and oversized untrusted lines fail safely', async () => {
  const { host, ready, children } = harness()
  const started = host.start(config)
  children[0].stderr.write('private-data'.repeat(1000) + '\n')
  ready(undefined, '0.0.0.0:3478')
  await assert.rejects(started, { code: 'ERR_START_FAILED' })
  assert.equal(JSON.stringify(host.state()).includes('private-data'), false)
})

test('spawn error and unexpected exit expose only bounded safe messages', async () => {
  const throwing = harness({ spawn() { throw new Error('private-machine-path'); } })
  await assert.rejects(throwing.host.start(config), { code: 'ERR_START_FAILED' })
  assert.equal(JSON.stringify(throwing.host.state()).includes('private-machine-path'), false)
  const { host, children, ready } = harness()
  const started = host.start(config); ready(); await started
  children[0].emit('exit', 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.state().error.code, 'ERR_RELAY_EXITED')
  assert.throws(() => host.credentials(), { code: 'ERR_NOT_RUNNING' })
})

test('real failed spawn emits error/close without leaving a running child', async () => {
  const host = createSpryHosting({ executable: '/nonexistent/kithmoot-spry-fixture', startupTimeoutMs: 100, stopTimeoutMs: 100 })
  await assert.rejects(host.start(config), { code: 'ERR_START_FAILED' })
  assert.equal(host.state().status, 'failed')
  await host.stop()
  assert.equal(host.state().status, 'off')
})

test('broken native lifetime pipe fails closed and revokes credentials', async () => {
  for (const event of ['error', 'close']) {
    const { host, children, ready } = harness()
    const started = host.start(config); ready(); await started
    children[0].stdin.emit(event, new Error('private-pipe-error'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(host.state().status, 'failed')
    assert.equal(host.state().error.code, 'ERR_RELAY_EXITED')
    assert.throws(() => host.credentials(), { code: 'ERR_NOT_RUNNING' })
    assert.deepEqual(children[0].signals, ['SIGTERM'])
    assert.equal(JSON.stringify(host.state()).includes('private-pipe-error'), false)
    await host.stop()
  }
})

test('observer can stop during startup and cannot prevent cleanup by throwing', async () => {
  let host
  let stopped
  const fixture = harness({ onState(state) {
    if (state.status === 'starting') stopped = host.stop()
    throw new Error('observer failure')
  } })
  host = fixture.host
  await assert.rejects(host.start(config), { code: 'ERR_START_CANCELLED' })
  await stopped
  assert.equal(host.state().status, 'off')
})

test('unreaped child never reports off or permits replacement; late exit recovers', async () => {
  const { host, children, ready } = harness({ ignoreKill: true })
  const started = host.start(config); ready(); await started
  await assert.rejects(host.stop(), { code: 'ERR_STOP_TIMEOUT' })
  assert.equal(host.state().status, 'failed')
  await assert.rejects(host.start(config), { code: 'ERR_ALREADY_STARTED' })
  children[0].emit('exit', 0)
  assert.equal(host.state().status, 'off')
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL'])
})

test('real fixture binds TCP/UDP, readiness is parsed across chunks, and stop releases port', async t => {
  if (process.platform === 'win32') return t.skip('Executable script fixture requires a Unix shebang.')
  const directory = await mkdtemp(join(tmpdir(), 'kithmoot-spry-supervisor-'))
  const executable = join(directory, 'spry-turn')
  let host
  t.after(async () => { await host?.stop(); await rm(directory, { recursive: true, force: true }); })
  await writeFile(executable, `#!${process.execPath}\nimport net from 'node:net';import dgram from 'node:dgram'
const address=process.argv[process.argv.indexOf('--listen')+1];const [ip,port]=address.split(':')
const tcp=net.createServer();const udp=dgram.createSocket('udp4')
tcp.listen(Number(port),ip,()=>udp.bind(Number(port),ip,()=>{process.stderr.write('spry-turn 0.2.1 ready (UDP/TCP ');setTimeout(()=>process.stderr.write(address+')\\n'),5);}))
`, { mode: 0o700 })
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  host = createSpryHosting({ executable, startupTimeoutMs: 3000, stopTimeoutMs: 500 })
  await host.start({ ...config, port, relayPorts: port >= 49160 && port <= 49191 ? [49200, 49231] : config.relayPorts })
  assert.equal(host.state().endpoint, `127.0.0.1:${port}`)
  await host.stop()
  const rebound = createServer()
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); })
  await new Promise(resolve => rebound.close(resolve))
})
