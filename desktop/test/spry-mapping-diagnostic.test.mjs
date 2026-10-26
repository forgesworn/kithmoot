import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, writeFile, readFile, stat, rm, mkdir, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseMappings, mappingPlan, summariseMappingDiagnostic } from '../spry-mapping-diagnostic.mjs'
import { loadMappingConfig, runMappingCheck } from '../spry-mapping-check.mjs'

const plan = { listenPort: 3478, relayPorts: [49160, 49162] }
const config = { sourceIp: '10.2.0.2', gatewayIp: '10.2.0.1', ...plan }

function fixture(options = {}) {
  let time = 0
  let addresses = 0
  let maps = 0
  const calls = []
  const sleeps = []
  const epoch = () => options.epoch?.(time) ?? 100 + Math.floor(time / 1000)
  const client = {
    async externalAddress(request) {
      addresses++
      calls.push({ type: 'address', at: time, request })
      if (options.addressErrorAt === addresses) throw new Error('PRIVATE address secret')
      return { externalAddress: options.address?.(addresses) ?? '203.0.113.7', epochSeconds: epoch() }
    },
    async mapping(request) {
      maps++
      calls.push({ type: 'mapping', at: time, request })
      if (options.mapErrorAt === maps) throw Object.assign(new Error('PRIVATE map secret'), { code: options.errorCode })
      if (options.mapAdvanceAt === maps) time += options.mapAdvanceMs
      if (options.abortAt === maps) options.controller.abort()
      const externalPort = options.externalPort?.(request, maps) ?? request.internalPort
      return { requested: { ...request }, returned: { protocol: request.protocol,
        internalPort: request.internalPort, externalPort, lifetimeSeconds: options.lifetime ?? 60,
        ...options.returned }, epochSeconds: epoch() }
    },
  }
  const run = extra => diagnoseMappings({ ...plan, client, nowMs: () => time,
    sleep: async (ms, { signal } = {}) => {
      sleeps.push(ms)
      time += options.sleepAdvanceMs ?? ms
      if (options.abortDuringSleep) options.controller.abort()
      if (signal?.aborted) throw Object.assign(new Error('PRIVATE sleep secret'), { name: 'AbortError' })
    }, ...extra })
  return { run, calls, sleeps, setTime: value => { time = value } }
}

test('small experiment requires a listener and two to four distinct explicit allocation ports', () => {
  assert.deepEqual(mappingPlan(plan), [
    { role: 'listener', protocol: 'udp', internalPort: 3478 },
    { role: 'listener', protocol: 'tcp', internalPort: 3478 },
    { role: 'allocation', protocol: 'udp', internalPort: 49160 },
    { role: 'allocation', protocol: 'udp', internalPort: 49162 },
  ])
  for (const value of [undefined, {}, { ...plan, listenPort: 0 }, { ...plan, listenPort: '3478' },
    { ...plan, listenPort: 1023 }, { ...plan, relayPorts: [49160] },
    { ...plan, relayPorts: [49160, 49160] }, { ...plan, relayPorts: [49160, 3478] },
    { ...plan, relayPorts: [49160, 65536] }, { ...plan, relayPorts: [4000, 4001, 4002, 4003, 4004] }]) {
    assert.throws(() => mappingPlan(value), { code: 'ERR_CONFIG' })
  }
})

test('distinct stable tuples receive one 45-second renewal without a route or ownership claim', async () => {
  const f = fixture()
  const report = await f.run()
  assert.equal(report.status, 'observed')
  assert.deepEqual(f.sleeps, [45000])
  const maps = f.calls.filter(call => call.type === 'mapping')
  assert.equal(maps.length, 8)
  assert.deepEqual(maps.map(call => call.at), [0, 0, 0, 0, 45000, 45000, 45000, 45000])
  assert.ok(maps.slice(0, 4).every(call => call.request.suggestedExternalPort === 0))
  assert.equal(report.perTupleRenewalRepliesObserved, true)
  assert.equal(report.attempts.length, 8)
  assert.ok(report.attempts.every(attempt => attempt.outcome === 'replied'))
  assert.equal(report.independentRenewalProven, false)
  assert.equal(report.portTranslationRequired, false)
  assert.equal(report.routeQualified, false)
  assert.equal(report.ownershipEstablished, false)
  assert.equal(report.externalReachabilityTested, false)
  assert.equal(report.vpnConfinementTested, false)
  assert.ok(maps.every(call => call.request.lifetimeSeconds === 60))
  assert.deepEqual(report.cleanup, { mode: 'stop-renewal-only', deletionSent: false,
    mappingsMayRemain: true, requestedLifetimeSeconds: 60, expiryConfirmed: false })
})

test('translation remains an observation and renewals request the returned external port', async () => {
  const f = fixture({ externalPort: request => request.internalPort + 100 })
  const report = await f.run()
  assert.equal(report.status, 'observed')
  assert.equal(report.portTranslationRequired, true)
  const maps = f.calls.filter(call => call.type === 'mapping')
  assert.deepEqual(maps.slice(4).map(call => call.request.suggestedExternalPort), [3578, 3578, 49260, 49262])
  assert.equal(report.routeQualified, false)
})

test('different UDP local ports cannot share an external port', async () => {
  const f = fixture({ externalPort: () => 50000 })
  const report = await f.run()
  assert.equal(report.reason, 'ERR_PORT_COLLISION')
  assert.equal(f.calls.filter(call => call.type === 'mapping').length, 3)
  assert.deepEqual(f.sleeps, [])
})

test('the listener TCP and UDP mappings must share their external port', async () => {
  const report = await fixture({ externalPort: request => request.internalPort + (request.protocol === 'tcp' ? 1 : 0) }).run()
  assert.equal(report.reason, 'ERR_LISTENER_PAIR')
})

test('changed renewal port is refused without further renewal', async () => {
  const f = fixture({ externalPort: (request, index) => request.internalPort + (index >= 5 ? 100 : 0) })
  const report = await f.run()
  assert.equal(report.reason, 'ERR_PORT_CHANGED')
  assert.equal(f.calls.filter(call => call.type === 'mapping').length, 5)
})

test('unexpected short, excessive, zero and fractional leases stop observations', async () => {
  for (const lifetime of [0, 49, 61, 3600, 59.5]) {
    const f = fixture({ lifetime })
    const report = await f.run()
    assert.equal(report.reason, 'ERR_LEASE', `lease ${lifetime}`)
    assert.equal(f.calls.filter(call => call.type === 'mapping').length, 1)
    assert.equal(report.cleanup.mappingsMayRemain, true)
    assert.deepEqual(f.sleeps, [])
  }
  assert.equal((await fixture({ lifetime: 50 }).run()).status, 'observed')
})

test('late wake cannot renew expired leases or claim uninterrupted continuity', async () => {
  for (const sleepAdvanceMs of [59000, 60000, 120000]) {
    const f = fixture({ sleepAdvanceMs })
    const report = await f.run()
    assert.equal(report.reason, 'ERR_LEASE')
    assert.equal(f.calls.filter(call => call.type === 'mapping').length, 4)
  }
})

test('a renewal reply arriving beyond the previous expiry is refused', async () => {
  const f = fixture({ mapAdvanceAt: 5, mapAdvanceMs: 15000 })
  const report = await f.run()
  assert.equal(report.reason, 'ERR_LEASE')
  assert.equal(f.calls.filter(call => call.type === 'mapping').length, 5)
})

test('gateway epoch reset, frozen clock and unexpected advance are refused', async () => {
  for (const epoch of [time => time < 45000 ? 100 : 1, () => 100, time => time < 45000 ? 100 : 200]) {
    const f = fixture({ epoch })
    const report = await f.run()
    assert.equal(report.reason, 'ERR_EPOCH_CHANGED')
    assert.equal(f.calls.filter(call => call.type === 'mapping').length, 4)
  }
})

test('changed public address prevents renewals', async () => {
  const f = fixture({ address: count => count < 3 ? '203.0.113.7' : '203.0.113.8' })
  const report = await f.run()
  assert.equal(report.reason, 'ERR_ADDRESS_CHANGED')
  assert.equal(f.calls.filter(call => call.type === 'mapping').length, 4)
})

test('partial failure preserves bounded observations and never attempts deletion', async () => {
  const f = fixture({ mapErrorAt: 3, errorCode: 'ERR_GATEWAY' })
  const report = await f.run()
  assert.equal(report.reason, 'ERR_GATEWAY')
  assert.equal(report.observations.filter(row => row.type === 'mapping').length, 2)
  assert.deepEqual(report.attempts.map(attempt => attempt.outcome), ['replied', 'replied', 'refused'])
  assert.deepEqual(report.attempts[2].requested, { protocol: 'udp', internalPort: 49160,
    suggestedExternalPort: 0, lifetimeSeconds: 60 })
  assert.equal(report.cleanup.mappingsMayRemain, true)
  assert.equal(report.cleanup.deletionSent, false)
  assert.ok(f.calls.filter(row => row.type === 'mapping').every(row => row.request.lifetimeSeconds > 0))
})

test('an unanswered request remains unconfirmed and its requested tuple is retained', async () => {
  const report = await fixture({ mapErrorAt: 2, errorCode: 'ERR_TIMEOUT' }).run()
  assert.equal(report.reason, 'ERR_TIMEOUT')
  assert.equal(report.attempts.at(-1).outcome, 'unconfirmed')
  assert.equal(report.attempts.at(-1).requested.protocol, 'tcp')
  assert.equal(report.cleanup.mappingsMayRemain, true)
})

test('mismatched response tuples and invalid returned ports stop before further mapping', async () => {
  for (const returned of [{ protocol: 'tcp' }, { internalPort: 0 }, { internalPort: 3479 },
    { externalPort: 0 }, { externalPort: 65536 }, { externalPort: 49160.5 }]) {
    const f = fixture({ returned })
    const report = await f.run()
    assert.equal(report.reason, 'ERR_RESPONSE')
    assert.equal(report.attempts.length, 1)
  }
})

test('pre-abort sends nothing; abort after a mapping or during sleep stops all further requests', async () => {
  const already = new AbortController()
  already.abort()
  const untouched = fixture()
  const pre = await untouched.run({ signal: already.signal })
  assert.equal(pre.status, 'cancelled')
  assert.equal(pre.cleanup.mappingsMayRemain, false)
  assert.deepEqual(untouched.calls, [])
  for (const stage of ['mapping', 'sleep']) {
    const controller = new AbortController()
    const f = fixture({ controller, abortAt: stage === 'mapping' ? 2 : undefined, abortDuringSleep: stage === 'sleep' })
    const report = await f.run({ signal: controller.signal })
    assert.equal(report.status, 'cancelled')
    assert.equal(report.reason, 'ERR_ABORTED')
    assert.equal(report.cleanup.mappingsMayRemain, true)
    assert.equal(f.calls.filter(row => row.type === 'mapping').length, stage === 'mapping' ? 2 : 4)
  }
})

test('public summary omits identifying tuples and arbitrary exception messages', async () => {
  for (const options of [{}, { mapErrorAt: 2, errorCode: 'PRIVATE_UNKNOWN_CODE' }, { addressErrorAt: 1 }]) {
    const report = await fixture(options).run()
    const summary = summariseMappingDiagnostic(report)
    const json = JSON.stringify(summary)
    for (const privateValue of ['203.0.113.7', '10.2.0.1', '3478', '49160', '49162', 'PRIVATE', 'internalPort', 'externalPort']) {
      assert.equal(json.includes(privateValue), false, privateValue)
    }
    assert.equal(summary.routeQualified, false)
    if (options.mapErrorAt || options.addressErrorAt) assert.equal(summary.reason, 'ERR_NETWORK')
  }
})

test('monotonic clock regression fails closed', async () => {
  const f = fixture()
  let reads = 0
  const report = await f.run({ nowMs: () => ++reads < 4 ? 100 : 99 })
  assert.equal(report.reason, 'ERR_CLOCK')
})

async function files(t) {
  const directory = await mkdtemp(join(tmpdir(), 'spry-mapping-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'owner.json')
  await writeFile(file, JSON.stringify(config))
  return { directory, file }
}

test('CLI default validates strictly and creates no datagram sockets', async t => {
  const { file } = await files(t)
  let sockets = 0
  const original = dgram.createSocket
  dgram.createSocket = () => { sockets++; throw new Error('NETWORK FORBIDDEN') }
  syncBuiltinESMExports()
  try {
    const output = []
    assert.equal(await runMappingCheck(['--config', file], { output: value => output.push(value) }), 0)
    assert.deepEqual(output, [{ status: 'validated-only', networkRequests: 0, mappingCount: 4, routeQualified: false }])
    assert.equal(sockets, 0)
  } finally {
    dgram.createSocket = original
    syncBuiltinESMExports()
  }
})

test('CLI rejects duplicate, unknown, missing and relative flags before a run', async t => {
  const { directory, file } = await files(t)
  for (const args of [[], ['--run'], ['--config'], ['--config', 'relative.json'],
    ['--config', file, '--run', '--run'], ['--config', file, '--unknown'],
    ['--config', file, '--config', file], ['--config', file, '--private-report', join(directory, 'report.json')],
    ['--config', file, '--run', '--private-report', 'relative.json']]) {
    await assert.rejects(runMappingCheck(args, { output: () => assert.fail('unexpected output') }), { code: 'ERR_CONFIG' })
  }
})

test('config files reject extra fields, malformed addresses, oversized content and non-files', async t => {
  const { directory, file } = await files(t)
  assert.deepEqual(await loadMappingConfig(file), config)
  for (const value of [{ ...config, extra: true }, { ...config, sourceIp: '0.0.0.0' },
    { ...config, gatewayIp: 'gateway.example' }, { ...config, sourceIp: '127.0.0.1' },
    { ...config, gatewayIp: '8.8.8.8' }, { ...config, relayPorts: [49160, 49160] }, null, []]) {
    await writeFile(file, JSON.stringify(value))
    await assert.rejects(loadMappingConfig(file), { code: 'ERR_CONFIG' })
  }
  await writeFile(file, ' '.repeat(8193))
  await assert.rejects(loadMappingConfig(file), { code: 'ERR_CONFIG' })
  const folder = join(directory, 'folder')
  await mkdir(folder)
  await assert.rejects(loadMappingConfig(folder), { code: 'ERR_CONFIG' })
  if (process.platform !== 'win32') {
    const fifo = join(directory, 'fifo')
    execFileSync('mkfifo', [fifo])
    await assert.rejects(loadMappingConfig(fifo), { code: 'ERR_CONFIG' })
  }
})

test('private report refuses existing files and symlinks before any socket creation', async t => {
  const { directory, file } = await files(t)
  const existing = join(directory, 'existing.json')
  const link = join(directory, 'link.json')
  await writeFile(existing, 'preserved')
  await symlink(existing, link)
  let sockets = 0
  const original = dgram.createSocket
  dgram.createSocket = () => { sockets++; throw new Error('NETWORK FORBIDDEN') }
  syncBuiltinESMExports()
  try {
    for (const outputPath of [existing, link]) {
      await assert.rejects(runMappingCheck(['--config', file, '--run', '--private-report', outputPath]), { code: 'EEXIST' })
    }
    assert.equal(sockets, 0)
  } finally {
    dgram.createSocket = original
    syncBuiltinESMExports()
  }
})

test('an explicitly requested private report is created with owner-only permissions on cancellation', async t => {
  const { directory, file } = await files(t)
  const controller = new AbortController()
  controller.abort()
  const outputPath = join(directory, 'private-report.json')
  const output = []
  assert.equal(await runMappingCheck(['--config', file, '--run', '--private-report', outputPath],
    { signal: controller.signal, output: value => output.push(value) }), 1)
  const report = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(report.status, 'cancelled')
  assert.deepEqual(report.configuration, config)
  assert.deepEqual(report.attempts, [])
  assert.equal(report.cleanup.mappingsMayRemain, false)
  if (process.platform !== 'win32') assert.equal((await stat(outputPath)).mode & 0o777, 0o600)
  assert.equal(output.length, 1)
  assert.equal(JSON.stringify(output).includes(config.sourceIp), false)
})
