import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRelaySupervisor, parseNodeLine, supervisedArgs, childEnvironment, RELAY_CAPS } from '../relay-supervisor.mjs'

const secret = 'a'.repeat(64)
const options = { turnSecret: secret, pairingPublicKey: 'b'.repeat(64), stateFile: '/data/call-relay/node-state.json',
  controlRelays: ['wss://relay.example/'], bind: '192.168.1.20', listenPort: 30000 }
const endpoint = 'spry://' + 'c'.repeat(64) + '?relay=wss%3A%2F%2Frelay.example%2F'
const ready = { v: 1, event: 'ready', endpoint, pairing: 'p'.repeat(43),
  urls: ['turn:203.0.113.7:30000?transport=udp', 'turn:203.0.113.7:30000?transport=tcp'], relayPortMap: [[50000, 50000], [50001, 50001]] }

function harness(settings = {}) {
  const calls = []
  const children = []
  const spawn = (executable, args, spawnSettings) => {
    calls.push({ executable, args, settings: spawnSettings })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.signals = []
    // The node's orderly stop on stdin EOF, unless a test wedges it.
    child.stdin.on('finish', () => { if (!settings.ignoreEof) queueMicrotask(() => child.emit('exit', 0, null)) })
    child.kill = signal => {
      child.signals.push(signal)
      if (signal === 'SIGKILL' && !settings.ignoreKill) queueMicrotask(() => child.emit('exit', null, signal))
      return true
    }
    children.push(child)
    return child
  }
  const states = []
  const supervisor = createRelaySupervisor({ executable: '/app/resources/spry/spry-node', spawn, startupTimeoutMs: 200,
    stopTimeoutMs: 30, killTimeoutMs: 30, onState: state => states.push(state), ...settings })
  const line = (value, child = children.at(-1)) => child.stdout.write(JSON.stringify(value) + '\n')
  return { supervisor, calls, children, states, line }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('the command line is supervised standard mode with router mapping and the owner\'s caps', () => {
  const args = supervisedArgs(options)
  assert.deepEqual(args.slice(0, 3), ['supervised', '--exit-on-stdin-close', '--map-ports'])
  const value = flag => args[args.indexOf(flag) + 1]
  assert.equal(value('--pairing-key'), 'b'.repeat(64))
  assert.equal(value('--bind'), '192.168.1.20')
  assert.equal(value('--listen-port'), '30000')
  assert.equal(value('--max-allocations'), String(RELAY_CAPS.maxAllocations))
  assert.equal(value('--max-per-user'), '2')
  assert.equal(value('--max-tcp-connections'), '16')
  assert.equal(value('--bytes-per-second'), '125000')
  assert.equal(args.includes(secret), false, 'the TURN secret never goes on the command line')
  for (const bad of [{ bind: '127.0.0.1' }, { bind: '0.0.0.0' }, { bind: '169.254.1.2' }, { listenPort: 80 }, { controlRelays: [] },
    { controlRelays: ['ws://relay.example/'] }, { stateFile: 'relative.json' }, { pairingPublicKey: 'B'.repeat(64) }]) {
    assert.throws(() => supervisedArgs({ ...options, ...bad }), { code: 'ERR_CONFIG' })
  }
})

test('the child gets a cleared environment: the secret, and SystemRoot on Windows only', () => {
  assert.deepEqual(childEnvironment(secret, { PATH: '/bin', SPRY_PUBLIC: 'true', HOME: '/home/x' }, 'darwin'), { SPRY_TURN_SECRET: secret })
  assert.deepEqual(childEnvironment(secret, { SystemRoot: 'C:\\Windows', PATH: 'C:\\' }, 'win32'), { SPRY_TURN_SECRET: secret, SystemRoot: 'C:\\Windows' })
  assert.throws(() => childEnvironment('short'), { code: 'ERR_CONFIG' })
})

test('only well-formed node lines are read', () => {
  assert.deepEqual(parseNodeLine(JSON.stringify(ready)).event, 'ready')
  assert.deepEqual(parseNodeLine('{"v":1,"event":"status","allocations":2,"bytesRelayed":412000,"lastAllocation":null}'),
    { event: 'status', allocations: 2, bytesRelayed: 412000, lastAllocation: null })
  assert.deepEqual(parseNodeLine('{"v":1,"event":"portmap","state":"lost","reason":"expired"}'), { event: 'portmap', state: 'lost', reason: 'expired' })
  assert.equal(parseNodeLine('{"v":1,"event":"portmap","state":"lost","reason":"203.0.113.7"}'), undefined)
  for (const bad of ['not json', '[]', '{"v":2,"event":"status"}', JSON.stringify({ ...ready, pairing: 'short' }),
    JSON.stringify({ ...ready, urls: ['turns:relay.example:5349?transport=tcp'] }), JSON.stringify({ ...ready, endpoint: 'https://x/' }),
    '{"v":1,"event":"status","allocations":-1,"bytesRelayed":0,"lastAllocation":null}']) {
    assert.equal(parseNodeLine(bad), undefined, bad)
  }
})

test('ready, status, control and portmap lines become the state, without the secret', async () => {
  const { supervisor, calls, line } = harness()
  const started = supervisor.start(options)
  assert.equal(supervisor.state().status, 'starting')
  assert.deepEqual(calls[0].settings.env, { SPRY_TURN_SECRET: secret })
  assert.deepEqual(calls[0].settings.stdio, ['pipe', 'pipe', 'ignore'], 'stderr is never kept')
  line({ v: 1, event: 'portmap', state: 'mapped', method: 'upnp', allocationPorts: 8, requested: 8, permanent: false })
  line(ready)
  const state = await started
  assert.equal(state.status, 'running')
  assert.equal(state.endpoint, endpoint)
  assert.deepEqual(state.local, { host: '192.168.1.20', port: 30000 })
  line({ v: 1, event: 'status', allocations: 1, bytesRelayed: 10, lastAllocation: 1800000000 })
  line({ v: 1, event: 'control', relays: 1 })
  line({ v: 1, event: 'portmap', state: 'restored', restored: 2 })
  await tick()
  const now = supervisor.state()
  assert.deepEqual(now.counts, { allocations: 1, bytesRelayed: 10, lastAllocation: 1800000000 })
  assert.deepEqual(now.control, { relays: 1 })
  assert.deepEqual(now.mapping, { method: 'upnp', allocationPorts: 8, requested: 8, permanent: false, restored: 2 })
  assert.equal(JSON.stringify(now).includes(secret), false)
  await supervisor.stop()
  assert.equal(supervisor.state().status, 'off')
})

test('exit code 3 is a network that cannot host, with the node\'s reason, not a crash', async () => {
  const { supervisor, children, line } = harness()
  const started = supervisor.start(options)
  line({ v: 1, event: 'portmap', state: 'failed', reason: 'carrier-grade-nat' })
  children[0].emit('exit', 3, null)
  await assert.rejects(started, { code: 'ERR_CANNOT_HOST' })
  await tick()
  assert.equal(supervisor.state().status, 'cannot-host')
  assert.equal(supervisor.state().reason, 'carrier-grade-nat')
})

test('a crash after ready is reported as a failure', async () => {
  const { supervisor, children, line } = harness()
  const started = supervisor.start(options)
  line(ready)
  await started
  children[0].emit('exit', 1, null)
  await tick()
  assert.equal(supervisor.state().status, 'failed')
  assert.equal(supervisor.state().error.code, 'ERR_RELAY_EXITED')
})

test('stop waits for the node\'s orderly release on stdin EOF before any signal', async () => {
  const { supervisor, children, line } = harness()
  const started = supervisor.start(options)
  line(ready)
  await started
  await supervisor.stop()
  assert.deepEqual(children[0].signals, [], 'EOF alone stopped it, so router mappings were given back')
})

test('a wedged node is killed after the stop window, and a node that will not die is reported', async () => {
  const wedged = harness({ ignoreEof: true })
  const started = wedged.supervisor.start(options)
  wedged.line(ready)
  await started
  await wedged.supervisor.stop()
  assert.deepEqual(wedged.children[0].signals, ['SIGKILL'])
  const stuck = harness({ ignoreEof: true, ignoreKill: true })
  const run = stuck.supervisor.start(options)
  stuck.line(ready)
  await run
  await assert.rejects(stuck.supervisor.stop(), { code: 'ERR_STOP_TIMEOUT' })
  assert.equal(stuck.supervisor.state().status, 'failed')
})

test('no ready line in time fails the start and stops the node', async () => {
  const { supervisor, children } = harness()
  await assert.rejects(supervisor.start(options), { code: 'ERR_START_TIMEOUT' })
  await tick()
  assert.equal(children[0].stdin.writableEnded, true)
})

test('a second start while running is refused, and stop during start cancels it', async () => {
  const { supervisor, line } = harness()
  const first = supervisor.start(options)
  await assert.rejects(supervisor.start(options), { code: 'ERR_ALREADY_STARTED' })
  const stopping = supervisor.stop()
  await assert.rejects(first, { code: 'ERR_START_CANCELLED' })
  await stopping
  line(ready)
  await tick()
  assert.equal(supervisor.state().status, 'off', 'a late ready line from a stopped run changes nothing')
})

test('oversized lines are dropped without stalling later ones', async () => {
  const { supervisor, children, line } = harness()
  const started = supervisor.start(options)
  children[0].stdout.write('x'.repeat(20000) + '\n')
  line(ready)
  assert.equal((await started).status, 'running')
  await supervisor.stop()
})
