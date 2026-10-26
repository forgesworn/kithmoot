import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import {
  createNatPmpClient, createNatPmpClientWithExchangeForTest,
  exchangeNatPmpDatagramForTest, parseNatPmpResponse,
} from '../spry-natpmp.mjs'

const configuration = { sourceIp: '10.8.0.2', gatewayIp: '10.8.0.1' }
const mapping = { protocol: 'udp', internalPort: 3478, suggestedExternalPort: 3478, lifetimeSeconds: 60 }
function addressResponse() {
  const reply = Buffer.alloc(12)
  reply[1] = 128
  reply.writeUInt32BE(0xffffffff, 4)
  reply.set([203, 0, 113, 8], 8)
  return reply
}
function mappingResponse(request) {
  const reply = Buffer.alloc(16)
  reply[1] = request[1] + 128
  reply.writeUInt32BE(17, 4)
  reply.writeUInt16BE(request.readUInt16BE(4), 8)
  reply.writeUInt16BE(49000, 10)
  reply.writeUInt32BE(30, 12)
  return reply
}
async function listen(socket, address = '127.0.0.1', port = 0) {
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, address, resolve)
  })
  return socket.address().port
}
async function fixture(t, handler, { timeoutMs = 1000 } = {}) {
  const server = createSocket('udp4')
  const gatewayPort = await listen(server)
  t.after(() => new Promise(resolve => server.close(resolve)))
  const requests = []
  server.on('message', (request, remote) => {
    requests.push({ request, remote })
    handler?.({ request, remote, server })
  })
  const exchange = options => exchangeNatPmpDatagramForTest({ ...options,
    sourceIp: '127.0.0.1', gatewayIp: '127.0.0.1', gatewayPort })
  const client = createNatPmpClientWithExchangeForTest({ ...configuration, timeoutMs, exchange })
  return { server, gatewayPort, requests, client }
}
async function assertClientSocketClosed(remote) {
  const replacement = createSocket('udp4')
  try { await listen(replacement, remote.address, remote.port) }
  finally { replacement.close() }
}

test('construction has no exchange, production endpoints cannot fall back or use DNS', () => {
  let exchanges = 0
  createNatPmpClientWithExchangeForTest({ ...configuration, exchange: () => { exchanges++ } })
  for (const sourceIp of ['10.0.0.2', '172.16.0.2', '172.31.255.254', '192.168.0.2', '100.64.0.2', '100.127.255.254']) {
    createNatPmpClient({ sourceIp, gatewayIp: '10.8.0.1' })
  }
  for (const ip of [undefined, null, '', 'gateway.example', 'localhost', '0.0.0.0', '127.0.0.1', '::1',
    '169.254.1.1', '8.8.8.8', '224.0.0.1', '255.255.255.255', '172.15.1.1', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '010.8.0.1', '10.8.0.1\n', 1, {}]) {
    assert.throws(() => createNatPmpClient({ ...configuration, sourceIp: ip }), { code: 'ERR_CONFIG' })
    assert.throws(() => createNatPmpClient({ ...configuration, gatewayIp: ip }), { code: 'ERR_CONFIG' })
  }
  for (const timeoutMs of [0, -1, 10001, 1.5, NaN, Infinity, '100']) {
    assert.throws(() => createNatPmpClient({ ...configuration, timeoutMs }), { code: 'ERR_CONFIG' })
  }
  assert.throws(() => createNatPmpClient(null), { code: 'ERR_CONFIG' })
  assert.equal(exchanges, 0)
})

test('nonzero per-port requests only; no deletion or Proton private-port-zero flow', async () => {
  let exchanges = 0
  const client = createNatPmpClientWithExchangeForTest({ ...configuration, exchange: () => { exchanges++ } })
  const invalid = [null, undefined, {}, 'secret', { ...mapping, protocol: 'UDP' },
    { ...mapping, internalPort: 0 },
    ...['internalPort', 'suggestedExternalPort'].flatMap(key => [-1, 65536, 1.5, '3478', NaN].map(value => ({ ...mapping, [key]: value }))),
    ...[0, -1, 61, 1.5, '60', Infinity].map(lifetimeSeconds => ({ ...mapping, lifetimeSeconds }))]
  for (const options of invalid) await assert.rejects(client.mapping(options), { code: 'ERR_CONFIG' })
  await assert.rejects(client.mapping({ ...mapping, signal: {} }), { code: 'ERR_CONFIG' })
  assert.equal(exchanges, 0)
})

test('loopback-only test transport rejects non-loopback endpoint overrides before I/O', () => {
  for (const sourceIp of ['10.8.0.2', '0.0.0.0', 'localhost']) {
    assert.throws(() => exchangeNatPmpDatagramForTest({ sourceIp, gatewayIp: '127.0.0.1', gatewayPort: 1 }), { code: 'ERR_CONFIG' })
  }
  assert.throws(() => exchangeNatPmpDatagramForTest({ sourceIp: '127.0.0.1', gatewayIp: '10.8.0.1', gatewayPort: 1 }), { code: 'ERR_CONFIG' })
})

test('the production-shaped client passes only its explicit endpoints and fixed gateway port', async () => {
  const exchanges = []
  const client = createNatPmpClientWithExchangeForTest({ ...configuration,
    exchange: options => {
      exchanges.push(options)
      return options.request[1] === 0 ? addressResponse() : mappingResponse(options.request)
    } })
  await client.externalAddress()
  await client.mapping({ protocol: 'tcp', internalPort: 1, suggestedExternalPort: 65535 })
  await client.mapping({ protocol: 'udp', internalPort: 65535, suggestedExternalPort: 1, lifetimeSeconds: 1 })
  for (const options of exchanges) {
    assert.equal(options.sourceIp, configuration.sourceIp)
    assert.equal(options.gatewayIp, configuration.gatewayIp)
    assert.equal(options.gatewayPort, 5351)
    assert.equal(options.timeoutMs, 2000)
  }
  assert.equal(exchanges[1].request.readUInt32BE(8), 60)
  assert.equal(exchanges[2].request.readUInt32BE(8), 1)
})

test('external suggestion zero requests anonymous assignment and differs from forbidden internal zero', async t => {
  const { client, requests } = await fixture(t, ({ request, remote, server }) => {
    server.send(mappingResponse(request), remote.port, remote.address)
  })
  const result = await client.mapping({ ...mapping, suggestedExternalPort: 0 })
  assert.equal(requests[0].request.readUInt16BE(4), 3478)
  assert.equal(requests[0].request.readUInt16BE(6), 0)
  assert.equal(result.requested.suggestedExternalPort, 0)
  assert.equal(result.returned.externalPort, 49000)
  await assertClientSocketClosed(requests[0].remote)
  const reply = mappingResponse(requests[0].request)
  reply.writeUInt16BE(0, 10)
  assert.throws(() => parseNatPmpResponse(reply, requests[0].request), { code: 'ERR_RESPONSE' })
  const invalidRequest = Buffer.from(requests[0].request)
  invalidRequest.writeUInt16BE(0, 4)
  assert.throws(() => parseNatPmpResponse(reply, invalidRequest), { code: 'ERR_CONFIG' })
})

test('real UDP fixture returns external address and exact UDP/TCP requested and returned tuples', async t => {
  const { client, requests } = await fixture(t, ({ request, remote, server }) => {
    server.send(request[1] === 0 ? addressResponse() : mappingResponse(request), remote.port, remote.address)
  })
  assert.deepEqual(await client.externalAddress(), { externalAddress: '203.0.113.8', epochSeconds: 0xffffffff })
  assert.deepEqual([...requests[0].request], [0, 0])
  await assertClientSocketClosed(requests[0].remote)
  for (const protocol of ['udp', 'tcp']) {
    const result = await client.mapping({ ...mapping, protocol })
    assert.deepEqual(result, { requested: { ...mapping, protocol },
      returned: { protocol, internalPort: 3478, externalPort: 49000, lifetimeSeconds: 30 }, epochSeconds: 17 })
    const { request, remote } = requests.at(-1)
    assert.equal(request.length, 12)
    assert.deepEqual([...request.subarray(0, 4)], [0, protocol === 'udp' ? 1 : 2, 0, 0])
    assert.equal(request.readUInt16BE(4), 3478)
    assert.equal(request.readUInt16BE(6), 3478)
    assert.equal(request.readUInt32BE(8), 60)
    await assertClientSocketClosed(remote)
  }
  assert.equal(requests.length, 3)
})

test('timeout sends one datagram, closes the socket and permits a later request', async t => {
  const { client, requests } = await fixture(t, undefined, { timeoutMs: 300 })
  await assert.rejects(client.externalAddress(), { code: 'ERR_TIMEOUT' })
  assert.equal(requests.length, 1)
  await assertClientSocketClosed(requests[0].remote)
  await assert.rejects(client.externalAddress(), { code: 'ERR_TIMEOUT' })
  assert.equal(requests.length, 2)
  await assertClientSocketClosed(requests[1].remote)
})

test('abort before send creates no datagram and abort in flight closes the socket', async t => {
  const controller = new AbortController()
  const { client, requests } = await fixture(t, () => controller.abort('private-abort-reason'))
  const aborted = AbortSignal.abort('another-private-reason')
  await assert.rejects(client.externalAddress({ signal: aborted }), { code: 'ERR_ABORTED', message: 'NAT-PMP diagnostic aborted.' })
  assert.equal(requests.length, 0)
  await assert.rejects(client.mapping({ ...mapping, signal: controller.signal }), { code: 'ERR_ABORTED' })
  assert.equal(requests.length, 1)
  await assertClientSocketClosed(requests[0].remote)
})

test('one client refuses concurrency and releases its busy state after abort', async t => {
  const controller = new AbortController()
  const { client } = await fixture(t)
  const pending = client.externalAddress({ signal: controller.signal })
  await assert.rejects(client.mapping(mapping), { code: 'ERR_BUSY' })
  controller.abort()
  await assert.rejects(pending, { code: 'ERR_ABORTED' })
  await assert.rejects(client.externalAddress({ signal: controller.signal }), { code: 'ERR_ABORTED' })
})

test('real UDP connected socket discards a reply from a different source port', async t => {
  const wrongPort = createSocket('udp4')
  await listen(wrongPort)
  t.after(() => new Promise(resolve => wrongPort.close(resolve)))
  const fixtureState = await fixture(t, ({ remote }) => {
    wrongPort.send(addressResponse(), remote.port, remote.address)
  }, { timeoutMs: 300 })
  await assert.rejects(fixtureState.client.externalAddress(), { code: 'ERR_TIMEOUT' })
  await assertClientSocketClosed(fixtureState.requests[0].remote)
})

function socketHarness(onSend) {
  const socket = new EventEmitter()
  const calls = []
  socket.bind = (options, ready) => { calls.push(['bind', options]); queueMicrotask(ready) }
  socket.connect = (port, address, ready) => { calls.push(['connect', port, address]); queueMicrotask(ready) }
  socket.send = (request, sent) => { calls.push(['send', request]); sent(); onSend?.(socket) }
  socket.close = done => { calls.push(['close']); queueMicrotask(done) }
  const run = () => exchangeNatPmpDatagramForTest({ sourceIp: '127.0.0.1', gatewayIp: '127.0.0.1',
    gatewayPort: 15351, timeoutMs: 20, request: Buffer.from([0, 0]), socketFactoryForTest: () => socket })
  return { run, calls, socket }
}

test('explicit source checks discard wrong addresses, ports and families even beyond kernel filtering', async () => {
  // macOS cannot bind a second loopback address without changing host interfaces;
  // inject receive events here and exercise real kernel source-port filtering above.
  const { run, calls, socket } = socketHarness(socket => {
    for (const remote of [{ address: '127.0.0.2', port: 15351, family: 'IPv4' },
      { address: '127.0.0.1', port: 15352, family: 'IPv4' },
      { address: '127.0.0.1', port: 15351, family: 'IPv6' }]) {
      socket.emit('message', addressResponse(), remote)
    }
  })
  await assert.rejects(run(), { code: 'ERR_TIMEOUT' })
  assert.deepEqual(calls[0], ['bind', { address: '127.0.0.1', port: 0, exclusive: true }])
  assert.deepEqual(calls[1], ['connect', 15351, '127.0.0.1'])
  assert.equal(calls.filter(([name]) => name === 'send').length, 1)
  assert.equal(calls.filter(([name]) => name === 'close').length, 1)
  assert.equal(socket.listenerCount('message'), 0)
})

test('socket failures redact operating-system details and close once', async () => {
  const { run, calls, socket } = socketHarness(socket => socket.emit('error', new Error('secret address 10.8.0.2')))
  await assert.rejects(run(), { code: 'ERR_SOCKET', message: 'NAT-PMP diagnostic socket failed.' })
  assert.equal(calls.filter(([name]) => name === 'close').length, 1)
  assert.equal(socket.listenerCount('error'), 0)
})

test('socket failure codes are classified without exposing OS errors or changing endpoints', async t => {
  const cases = [
    ['ECONNREFUSED', 'ERR_CONNECTION_REFUSED', 'NAT-PMP diagnostic connection refused.'],
    ['EADDRNOTAVAIL', 'ERR_SOURCE_UNAVAILABLE', 'NAT-PMP diagnostic source address unavailable.'],
    ['ENETUNREACH', 'ERR_ROUTE_UNAVAILABLE', 'NAT-PMP diagnostic route unavailable.'],
    ['EHOSTUNREACH', 'ERR_ROUTE_UNAVAILABLE', 'NAT-PMP diagnostic route unavailable.'],
    ['EACCES', 'ERR_SOCKET', 'NAT-PMP diagnostic socket failed.'],
    [undefined, 'ERR_SOCKET', 'NAT-PMP diagnostic socket failed.'],
  ]
  for (const [osCode, expectedCode, expectedMessage] of cases) {
    for (const phase of ['event', 'bind', 'connect', 'send', 'send-callback', 'factory']) {
      await t.test(`${osCode ?? 'no code'} at ${phase}`, async () => {
        const privateDetail = 'private OS error 10.8.0.2:5351 via secret interface'
        const osError = Object.assign(new Error(privateDetail), {
          code: osCode, address: '10.8.0.2', port: 5351, syscall: 'private-syscall',
        })
        const { calls, socket } = socketHarness(socket => socket.emit('error', osError))
        if (phase === 'bind') socket.bind = options => { calls.push(['bind', options]); throw osError }
        if (phase === 'connect') socket.connect = (port, address) => { calls.push(['connect', port, address]); throw osError }
        if (phase === 'send') socket.send = request => { calls.push(['send', request]); throw osError }
        if (phase === 'send-callback') socket.send = (request, sent) => { calls.push(['send', request]); sent(osError) }
        const controller = new AbortController()
        const operation = exchangeNatPmpDatagramForTest({ sourceIp: '127.0.0.1', gatewayIp: '127.0.0.1',
          gatewayPort: 15351, timeoutMs: 100, request: Buffer.from([0, 0]), signal: controller.signal,
          socketFactoryForTest: () => { if (phase === 'factory') throw osError; return socket } })
        await assert.rejects(operation, error => {
          assert.equal(error.code, expectedCode)
          assert.equal(error.message, expectedMessage)
          assert.deepEqual(Object.keys(error), ['name', 'code'])
          assert.equal(error.cause, undefined)
          assert.equal(error.stack.includes(privateDetail), false)
          assert.equal(JSON.stringify(error).includes('10.8.0.2'), false)
          return true
        })
        assert.equal(calls.filter(([name]) => name === 'close').length, phase === 'factory' ? 0 : 1)
        assert.equal(calls.filter(([name]) => name === 'bind').length, phase === 'factory' ? 0 : 1)
        assert.equal(calls.filter(([name]) => name === 'connect').length, ['factory', 'bind'].includes(phase) ? 0 : 1)
        assert.equal(calls.filter(([name]) => name === 'send').length, ['factory', 'bind', 'connect'].includes(phase) ? 0 : 1)
        for (const [name, first, second] of calls) {
          if (name === 'bind') assert.deepEqual(first, { address: '127.0.0.1', port: 0, exclusive: true })
          if (name === 'connect') assert.deepEqual([first, second], [15351, '127.0.0.1'])
        }
        assert.equal(socket.listenerCount('message'), 0)
        assert.equal(socket.listenerCount('error'), 0)
        controller.abort('private abort reason after failure')
        assert.equal(calls.filter(([name]) => name === 'close').length, phase === 'factory' ? 0 : 1)
      })
    }
  }
})

test('malformed and mismatched gateway responses fail and close their individual sockets', async t => {
  const variations = [
    () => Buffer.alloc(0), () => Buffer.alloc(32), () => Buffer.alloc(11),
    () => { const b = addressResponse(); b[0] = 2; return b },
    () => { const b = addressResponse(); b[1] = 129; return b },
    () => { const b = addressResponse(); b.fill(0, 8); return b },
  ]
  for (const variation of variations) {
    await t.test('invalid response', async t => {
      const { client, requests } = await fixture(t, ({ remote, server }) => server.send(variation(), remote.port, remote.address))
      await assert.rejects(client.externalAddress(), { code: 'ERR_RESPONSE', message: 'Invalid NAT-PMP diagnostic response.' })
      await assertClientSocketClosed(requests[0].remote)
    })
  }
})

test('mapping parser rejects cross-protocol, wrong internal port, zero lease and zero external port', async t => {
  const mutations = [b => { b[1] = 130 }, b => b.writeUInt16BE(3479, 8), b => b.writeUInt32BE(0, 12),
    b => b.writeUInt16BE(0, 10), b => { b[0] = 1 }]
  for (const mutate of mutations) {
    await t.test('invalid mapping', async t => {
      const { client, requests } = await fixture(t, ({ request, remote, server }) => {
        const reply = mappingResponse(request); mutate(reply); server.send(reply, remote.port, remote.address)
      })
      await assert.rejects(client.mapping(mapping), { code: 'ERR_RESPONSE' })
      await assertClientSocketClosed(requests[0].remote)
    })
  }
})

test('gateway refusal and unknown result codes are bounded and ignore undefined success fields', async t => {
  for (const resultCode of [1, 2, 3, 4, 5, 65535]) {
    await t.test(`result ${resultCode}`, async t => {
      const { client, requests } = await fixture(t, ({ request, remote, server }) => {
        const reply = mappingResponse(request)
        reply.writeUInt16BE(resultCode, 2)
        reply.fill(0, 10)
        server.send(reply, remote.port, remote.address)
      })
      await assert.rejects(client.mapping(mapping), error => {
        assert.equal(error.code, 'ERR_GATEWAY')
        assert.equal(error.resultCode, resultCode)
        assert.equal(error.message, 'NAT-PMP gateway refused the diagnostic request.')
        assert.deepEqual(Object.keys(error), ['name', 'code', 'resultCode'])
        return true
      })
      await assertClientSocketClosed(requests[0].remote)
    })
  }
})

test('adversarial parser input never accepts short, long, foreign or coerced datagrams', () => {
  const request = Buffer.from([0, 0])
  for (const value of [undefined, null, {}, [], '203.0.113.8', new Uint8Array(addressResponse()),
    Buffer.alloc(65507), ...Array.from({ length: 40 }, (_, length) => Buffer.alloc(length))]) {
    assert.throws(() => parseNatPmpResponse(value, request), { code: 'ERR_RESPONSE' })
  }
  for (const request of [undefined, null, {}, Buffer.from([0]), Buffer.from([0, 3]), Buffer.from([2, 0]), Buffer.alloc(12)]) {
    assert.throws(() => parseNatPmpResponse(addressResponse(), request), { code: 'ERR_CONFIG' })
  }
  for (const first of [0, 127, 224, 239, 240, 255]) {
    const reply = addressResponse(); reply[8] = first
    assert.throws(() => parseNatPmpResponse(reply, request), { code: 'ERR_RESPONSE' })
  }
  const reply = addressResponse(); reply.writeUInt16BE(65535, 2)
  assert.throws(() => parseNatPmpResponse(reply, request), { code: 'ERR_GATEWAY', resultCode: 65535 })
})

test('gateway lease longer than requested is reported truthfully without scheduling renewal', async t => {
  const { client, requests } = await fixture(t, ({ request, remote, server }) => {
    const reply = mappingResponse(request); reply.writeUInt32BE(7200, 12)
    server.send(reply, remote.port, remote.address)
  })
  const result = await client.mapping(mapping)
  assert.equal(result.requested.lifetimeSeconds, 60)
  assert.equal(result.returned.lifetimeSeconds, 7200)
  assert.equal(requests.length, 1)
  await assertClientSocketClosed(requests[0].remote)
})
