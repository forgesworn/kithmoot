import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRelayHost, createHostingQuitGuard, defaultRouteAddress, pickControlRelays, sanitiseRelayContext, CANNOT_HOST_TEXT } from '../relay-host.mjs'
import { PORTMAP_REASONS } from '../relay-supervisor.mjs'

const participant = 'd'.repeat(64)
const saved = { v: 1, turnSecret: 'a'.repeat(64), pairingSecret: '0'.repeat(63) + '1', participant, controlRelays: ['wss://relay.example/'], listenPort: 30000 }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

/** A supervisor double that records its start and lets a test end the run. */
function fakeSupervisors() {
  const made = []
  const create = ({ executable, onState }) => {
    let current = { status: 'off' }
    let pending
    const publish = next => { current = next; onState(structuredClone(next)) }
    const supervisor = {
      executable, started: undefined,
      state: () => structuredClone(current),
      start(options) {
        supervisor.started = options
        publish({ status: 'starting', local: { host: options.bind, port: options.listenPort } })
        pending = deferred()
        return pending.promise
      },
      ready() {
        publish({ ...current, status: 'running', endpoint: 'spry://' + 'c'.repeat(64) + '?relay=wss%3A%2F%2Frelay.example%2F', pairing: 'p'.repeat(43), urls: ['turn:203.0.113.7:30000?transport=udp'] })
        pending.resolve(supervisor.state())
      },
      cannotHost(reason) {
        publish({ status: 'cannot-host', reason, error: { code: 'ERR_CANNOT_HOST', message: 'x' } })
        pending?.reject(Object.assign(new Error('x'), { code: 'ERR_CANNOT_HOST' }))
      },
      async stop() { publish({ status: 'off' }); pending?.reject(Object.assign(new Error('cancelled'), { code: 'ERR_START_CANCELLED' })); return { status: 'off' } },
      crash() { publish({ status: 'failed', error: { code: 'ERR_RELAY_EXITED', message: 'x' } }) },
      relayed(bytesRelayed) { publish({ ...current, counts: { allocations: 1, bytesRelayed, lastAllocation: null } }) },
    }
    made.push(supervisor)
    return supervisor
  }
  return { made, create }
}
function harness(options = {}) {
  const { identity, context, ...settings } = { identity: saved, context: { participant, relays: ['wss://relay.example'] }, ...options }
  let stored = identity
  const created = []
  const store = {
    stateFile: '/data/call-relay/node-state.json',
    load: async () => stored,
    create: async value => { created.push(value); stored = { ...saved, ...value }; return stored },
  }
  const supervisors = fakeSupervisors()
  const changes = []
  const host = createRelayHost({ enabled: true, identity: store, executable: async () => '/app/resources/spry/spry-node',
    createSupervisor: supervisors.create, localAddress: async () => '192.168.1.20',
    changed: state => changes.push(state), ...settings })
  if (context) host.setContext(context)
  return { host, supervisors, changes, created }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('start uses the saved identity, this computer\'s address and the saved listener port', async () => {
  const { host, supervisors } = harness()
  const starting = host.start()
  await tick()
  const supervisor = supervisors.made[0]
  assert.equal(supervisor.executable, '/app/resources/spry/spry-node')
  assert.deepEqual({ ...supervisor.started, pairingPublicKey: undefined }, { turnSecret: saved.turnSecret, pairingPublicKey: undefined,
    stateFile: '/data/call-relay/node-state.json', controlRelays: saved.controlRelays, bind: '192.168.1.20', listenPort: 30000 })
  assert.equal(supervisor.started.pairingPublicKey, '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  assert.equal(host.pairing(), undefined, 'no pairing before the node is ready')
  supervisor.ready()
  await starting
  assert.deepEqual(host.pairing(), { v: 1, endpoint: 'spry://' + 'c'.repeat(64) + '?relay=wss%3A%2F%2Frelay.example%2F', id: 'p'.repeat(43),
    secretKey: saved.pairingSecret, participant, local: { host: '192.168.1.20', port: 30000 } })
  const state = host.state()
  assert.equal(state.status, 'running')
  assert.equal(JSON.stringify(state).includes(saved.turnSecret) || JSON.stringify(state).includes(saved.pairingSecret), false)
  await host.stop()
  assert.equal(host.pairing(), undefined)
  assert.equal(host.state().status, 'off')
})

test('the first start makes the identity from the account and its usable relays', async () => {
  const { host, supervisors, created } = harness({ identity: undefined, context: { participant, relays: ['ws://local.test', 'wss://relay.example', 'wss://203.0.113.9/', 'wss://nos.lol'] } })
  const starting = host.start()
  await tick()
  assert.deepEqual(created, [{ participant, controlRelays: ['wss://relay.example/', 'wss://nos.lol/'] }])
  supervisors.made[0].ready()
  await starting
})

test('the relay refuses another account, a hand-paired account and no account', async () => {
  for (const [context, identity, code] of [
    [{ participant: 'e'.repeat(64), relays: ['wss://relay.example'] }, saved, 'ERR_OTHER_ACCOUNT'],
    [{ participant, relays: ['wss://relay.example'], handPaired: true }, saved, 'ERR_HAND_PAIRED'],
    [null, saved, 'ERR_NO_ACCOUNT'],
    [{ participant, relays: ['ws://only.insecure'] }, undefined, 'ERR_NO_CONTROL_RELAYS'],
  ]) {
    const { host, supervisors } = harness({ context, identity })
    await host.start()
    assert.equal(supervisors.made.length, 0)
    assert.equal(host.state().status, 'failed')
    assert.equal(host.state().error.code, code)
  }
})

test('a helper that is missing or does not match is not started', async () => {
  const { host, supervisors } = harness({ executable: async () => { throw new Error('does not match') } })
  await host.start()
  assert.equal(supervisors.made.length, 0)
  assert.equal(host.state().error.code, 'ERR_HELPER')
})

test('a network that cannot host shows its reason in plain words and may be tried again', async () => {
  const { host, supervisors } = harness()
  const starting = host.start()
  await tick()
  supervisors.made[0].cannotHost('double-nat')
  await starting
  assert.equal(host.state().status, 'cannot-host')
  assert.equal(host.state().reasonText, CANNOT_HOST_TEXT['double-nat'])
  const again = host.start()
  await tick()
  assert.equal(supervisors.made.length, 2, 'Try again starts a new run')
  supervisors.made[1].ready()
  await again
  await host.stop()
})

test('every reason the node can give has plain words', () => {
  for (const reason of PORTMAP_REASONS) assert.equal(typeof CANNOT_HOST_TEXT[reason], 'string', reason)
})

test('a blocking stop (sleep, quit, update) holds the relay off until resume', async () => {
  const { host, supervisors } = harness()
  await host.stop({ block: true })
  await host.start()
  assert.equal(supervisors.made.length, 0)
  assert.equal(host.state().blocked, true)
  await host.resume()
  assert.equal(host.state().blocked, false)
})

test('the page starts the relay as the person\'s own Turn on, and Stop ends it and what they wanted', async () => {
  const { host, supervisors } = harness()
  const starting = host.start({ person: true })
  await tick()
  assert.equal(host.state().wanted, true)
  assert.equal(host.state().status, 'starting')
  supervisors.made[0].ready()
  await starting
  assert.equal(host.state().status, 'running')
  await host.stop()
  assert.equal(host.state().status, 'off')
  assert.equal(host.state().wanted, false)
})

test('a disabled host never starts', async () => {
  const { host, supervisors } = harness({ enabled: false })
  await host.start()
  await host.start({ person: true })
  assert.equal(supervisors.made.length, 0)
  assert.equal(host.state().available, false)
})

test('context from the page is checked; relays are filtered to control-capable ones', () => {
  assert.equal(sanitiseRelayContext(null), undefined)
  assert.deepEqual(sanitiseRelayContext({ participant: 'nope', relays: ['wss://a.example', 5], handPaired: 'yes' }),
    { participant: undefined, relays: ['wss://a.example'], handPaired: false })
  assert.deepEqual(pickControlRelays(['wss://a.example', 'wss://a.example/', 'wss://b.example', 'wss://c.example', 'wss://d.example', 'wss://e.example']),
    ['wss://a.example/', 'wss://b.example/', 'wss://c.example/', 'wss://d.example/'])
})

test('this computer\'s address comes from a connected UDP socket, which sends nothing', async () => {
  const fake = address => () => {
    const socket = new EventEmitter()
    socket.connected = undefined
    socket.connect = (port, host, done) => { socket.connected = [port, host]; queueMicrotask(done) }
    socket.address = () => ({ address })
    socket.send = () => assert.fail('nothing is sent')
    socket.close = () => {}
    return socket
  }
  assert.equal(await defaultRouteAddress({ create: fake('192.168.1.20') }), '192.168.1.20')
  for (const bad of ['127.0.0.1', '0.0.0.0', '169.254.3.4']) await assert.rejects(defaultRouteAddress({ create: fake(bad) }), { code: 'ERR_NO_NETWORK' })
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

test('keys this build cannot read can be removed from the page, only while that is why it stopped', async () => {
  let gone = 0
  const store = { stateFile: '/data/call-relay/node-state.json', create: async () => assert.fail('nothing is made over unreadable keys'),
    load: async () => { throw Object.assign(new Error("The call relay's saved keys could not be read."), { code: 'ERR_IDENTITY' }) },
    remove: async () => { gone++ } }
  const host = createRelayHost({ enabled: true, identity: store, executable: async () => '/app/resources/spry/spry-node',
    localAddress: async () => '192.168.1.20' })
  assert.equal(await host.removeKeys(), false, 'nothing to remove while nothing failed')
  host.setContext({ participant, relays: ['wss://relay.example'] })
  await host.start()
  assert.equal(host.state().error.code, 'ERR_IDENTITY')
  assert.equal(await host.removeKeys(), true)
  assert.equal(gone, 1)
  assert.equal(host.state().status, 'off')
  assert.equal(await host.removeKeys(), false)
  assert.equal(gone, 1)
})

/** Timers a test fires by hand. */
function manualTimers() {
  const timeouts = new Map(), intervals = new Map()
  let next = 1
  return {
    setTimeout(fn, ms) { const id = next++; timeouts.set(id, { fn, ms }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn, ms) { const id = next++; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
    async fireTimeouts() { const due = [...timeouts.values()]; timeouts.clear(); for (const { fn } of due) await fn() },
    async fireIntervals() { for (const { fn } of [...intervals.values()]) await fn() },
    get intervals() { return intervals.size },
    get timeouts() { return timeouts.size },
    get timeoutDelays() { return [...timeouts.values()].map(({ ms }) => ms) },
  }
}
function memorySettings(initial = {}) {
  let value = { v: 1, startOnOpen: false, day: '', dayBytes: 0, ...initial }
  const saves = []
  return { saves, value: () => value, load: async () => structuredClone(value), save: async next => { value = structuredClone(next); saves.push(value) } }
}
async function running(host, supervisors, index = supervisors.made.length) {
  await tick()
  supervisors.made[index].ready()
  await tick()
}

test('a crash restarts the relay once after a pause; a second crash leaves it off and says so', async () => {
  const timers = manualTimers()
  const { host, supervisors } = harness({ timers, settings: memorySettings() })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  supervisors.made[0].crash()
  assert.equal(host.state().status, 'failed')
  assert.equal(supervisors.made.length, 1, 'no restart before the pause')
  await timers.fireTimeouts()
  await running(host, supervisors, 1)
  assert.equal(host.state().status, 'running')
  supervisors.made[1].crash()
  await timers.fireTimeouts()
  assert.equal(supervisors.made.length, 2, 'no second automatic restart')
  assert.equal(host.state().error.code, 'ERR_CRASHED_TWICE')
  assert.equal(host.state().wanted, false)
})

test('a network that cannot host is never restarted as if it had crashed', async () => {
  const timers = manualTimers()
  const { host, supervisors } = harness({ timers, settings: memorySettings() })
  void host.start({ person: true })
  await tick()
  supervisors.made[0].cannotHost('no-answer')
  await tick()
  await timers.fireTimeouts()
  assert.equal(supervisors.made.length, 1)
  assert.equal(host.state().status, 'cannot-host')
})

test('waking restarts a relay the person had on; after their own Stop it stays off', async () => {
  const timers = manualTimers()
  const { host, supervisors } = harness({ timers, settings: memorySettings() })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  await host.stop({ block: true })
  assert.equal(host.state().wanted, true, 'sleep does not change what the person chose')
  await host.resume({ restart: true })
  await running(host, supervisors, 1)
  assert.equal(host.state().status, 'running')
  await host.stop()
  assert.equal(host.state().wanted, false)
  await host.stop({ block: true })
  await host.resume({ restart: true })
  await tick()
  assert.equal(supervisors.made.length, 2, 'stopped by the person: waking does not start it')
  // Closing the window resumes without a restart.
  void host.start({ person: true })
  await running(host, supervisors, 2)
  await host.stop({ block: true })
  await host.resume()
  await tick()
  assert.equal(supervisors.made.length, 3)
})

test('Start it when KithMoot opens starts the relay once the account is known, and only then', async () => {
  const settings = memorySettings({ startOnOpen: true })
  const { host, supervisors } = harness({ context: null, settings, timers: manualTimers() })
  await tick()
  assert.equal(supervisors.made.length, 0)
  host.setContext({ participant, relays: ['wss://relay.example'] })
  await running(host, supervisors, 0)
  assert.equal(host.state().status, 'running')
  host.setContext({ participant, relays: ['wss://relay.example'] })
  await tick()
  assert.equal(supervisors.made.length, 1, 'only on the first context of a launch')
  const off = harness({ context: null, settings: memorySettings(), timers: manualTimers() })
  off.host.setContext({ participant, relays: ['wss://relay.example'] })
  await tick()
  assert.equal(off.supervisors.made.length, 0)
})

test('the daily limit stops the relay, counts across runs and lifts the next day', async () => {
  let clock = new Date(2026, 9, 30, 12)
  const settings = memorySettings()
  const { host, supervisors } = harness({ timers: manualTimers(), settings, now: () => clock, dailyLimit: 1000 })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  supervisors.made[0].relayed(600)
  await host.stop({ block: true })
  await host.resume()
  void host.start({ person: true })
  await running(host, supervisors, 1)
  assert.equal(host.state().today, 600, 'a new run counts from its own zero')
  supervisors.made[1].relayed(500)
  await tick()
  assert.equal(host.state().status, 'failed')
  assert.equal(host.state().error.code, 'ERR_DAILY_LIMIT')
  assert.equal(settings.value().dayBytes, 1100, 'saved, so a restart of the app cannot reset it')
  await host.start({ person: true })
  assert.equal(supervisors.made.length, 2, 'refused for the rest of the day')
  clock = new Date(2026, 9, 31, 9)
  void host.start({ person: true })
  await running(host, supervisors, 2)
  assert.equal(host.state().status, 'running')
  assert.equal(host.state().today, 0)
})

test('a new network address stops the relay on the old one and starts it on the new', async () => {
  const timers = manualTimers()
  let address = '192.168.1.20'
  const { host, supervisors } = harness({ timers, settings: memorySettings(), localAddress: async () => address })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  assert.equal(timers.intervals, 1)
  await timers.fireIntervals()
  assert.equal(supervisors.made.length, 1, 'same network: nothing to do')
  address = '10.0.0.7'
  await timers.fireIntervals()
  await running(host, supervisors, 1)
  assert.equal(supervisors.made[1].started.bind, '10.0.0.7')
  await host.stop()
  assert.equal(timers.intervals, 0, 'the person\'s Stop ends the watch')
})

test('Start it when KithMoot opens is saved from the page and reported back', async () => {
  const settings = memorySettings()
  const { host, changes } = harness({ settings, timers: manualTimers() })
  await host.setStartOnOpen(true)
  assert.equal(settings.value().startOnOpen, true)
  assert.equal(host.state().startOnOpen, true)
  assert.equal(changes.at(-1).startOnOpen, true)
  await host.setStartOnOpen('yes')
  assert.equal(settings.value().startOnOpen, false, 'only a real true turns it on')
})

test('lastAllocation reaches the page with the counts', async () => {
  const { host, supervisors } = harness({ settings: memorySettings(), timers: manualTimers() })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  supervisors.made[0].relayed(10)
  assert.deepEqual(host.state().counts, { allocations: 1, bytesRelayed: 10, lastAllocation: null })
})

test('a relay the daily limit paused starts again after local midnight, once, if still wanted', async () => {
  let clock = new Date(2026, 9, 30, 23, 0)
  const timers = manualTimers()
  const { host, supervisors } = harness({ timers, settings: memorySettings(), now: () => clock, dailyLimit: 1000 })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  supervisors.made[0].relayed(1500)
  await tick()
  assert.equal(host.state().error.code, 'ERR_DAILY_LIMIT')
  const [due] = [...timers.timeoutDelays]
  assert.equal(due, 60 * 60 * 1000 + 1000, 'one second past local midnight')
  clock = new Date(2026, 9, 31, 0, 0, 1)
  await timers.fireTimeouts()
  await running(host, supervisors, 1)
  assert.equal(host.state().status, 'running')
  assert.equal(supervisors.made.length, 2)
  await timers.fireTimeouts()
  assert.equal(supervisors.made.length, 2, 'nothing more to fire')
})

test('a person\'s own Stop cancels the midnight restart', async () => {
  let clock = new Date(2026, 9, 30, 23, 0)
  const timers = manualTimers()
  const { host, supervisors } = harness({ timers, settings: memorySettings(), now: () => clock, dailyLimit: 1000 })
  void host.start({ person: true })
  await running(host, supervisors, 0)
  supervisors.made[0].relayed(1500)
  await tick()
  await host.stop()
  clock = new Date(2026, 9, 31, 0, 0, 1)
  await timers.fireTimeouts()
  await tick()
  assert.equal(supervisors.made.length, 1)
  assert.equal(host.state().wanted, false)
})

test('a window that comes back restarts a relay the person had on, and leaves one they stopped', async () => {
  const wanted = harness({ settings: memorySettings(), timers: manualTimers() })
  void wanted.host.start({ person: true })
  await running(wanted.host, wanted.supervisors, 0)
  await wanted.host.stop({ block: true })
  await wanted.host.resume()
  assert.equal(wanted.supervisors.made.length, 1, 'closing the window leaves it off')
  wanted.host.reopen()
  await running(wanted.host, wanted.supervisors, 1)
  assert.equal(wanted.host.state().status, 'running')
  const stopped = harness({ settings: memorySettings(), timers: manualTimers() })
  void stopped.host.start({ person: true })
  await running(stopped.host, stopped.supervisors, 0)
  await stopped.host.stop()
  stopped.host.reopen()
  await tick()
  assert.equal(stopped.supervisors.made.length, 1)
})
