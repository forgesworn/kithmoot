import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createNatPmpClientWithExchangeForTest, exchangeNatPmpDatagramForTest } from '../spry-natpmp.mjs'
import { diagnoseMappings, summariseMappingDiagnostic } from '../spry-mapping-diagnostic.mjs'

async function fixture(t, { failAt, cancelAt } = {}) {
  const gateway = createSocket('udp4')
  await new Promise(resolve => gateway.bind(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const controller = new AbortController()
  const requests = []
  let monotonic = 0
  gateway.on('message', (request, sender) => {
    assert.equal(sender.address, '127.0.0.1')
    assert.equal(request[0], 0)
    const opcode = request[1]
    requests.push(Buffer.from(request))
    assert.ok([0, 1, 2].includes(opcode))
    if (cancelAt === requests.length) { controller.abort(); return }
    const response = Buffer.alloc(opcode === 0 ? 12 : 16)
    response[1] = opcode + 128
    response.writeUInt32BE(500 + monotonic / 1000, 4)
    if (opcode === 0) {
      assert.equal(request.length, 2)
      Buffer.from([192, 0, 2, 70]).copy(response, 8)
    } else {
      assert.equal(request.length, 12)
      assert.equal(request.readUInt16BE(2), 0)
      const internal = request.readUInt16BE(4)
      const external = new Map([[45001, 55001], [45002, 55012], [45003, 55033]]).get(internal)
      assert.ok(external)
      assert.equal(request.readUInt32BE(8), 60) // No deletion or unbounded lifetime.
      assert.equal(request.readUInt16BE(6), monotonic ? external : 0)
      response.writeUInt16BE(internal, 8)
      response.writeUInt16BE(external, 10)
      response.writeUInt32BE(60, 12)
    }
    if (failAt === requests.length) response.writeUInt16BE(4, 2)
    gateway.send(response, sender.port, sender.address)
  })
  const client = createNatPmpClientWithExchangeForTest({ sourceIp: '10.8.0.2', gatewayIp: '10.8.0.1',
    exchange: ({ request, signal }) => exchangeNatPmpDatagramForTest({ sourceIp: '127.0.0.1', gatewayIp: '127.0.0.1',
      gatewayPort: gateway.address().port, request, signal, timeoutMs: 1000 }) })
  return { requests, controller, run: () => diagnoseMappings({ client, listenPort: 45001, relayPorts: [45002, 45003],
    signal: controller.signal, nowMs: () => monotonic, sleep: async ms => { monotonic += ms } }) }
}

test('wire gateway observes explicit UDP/TCP pair and distinct translated allocations, then individual renewals', async t => {
  const { run, requests } = await fixture(t)
  assert.equal(requests.length, 0)
  const result = await run()
  assert.equal(result.status, 'observed')
  assert.equal(result.routeQualified, false)
  assert.equal(result.ownershipEstablished, false)
  assert.equal(result.independentRenewalProven, false)
  assert.equal(result.portTranslationRequired, true)
  assert.deepEqual(result.observations.filter(value => value.type === 'mapping' && value.phase === 'initial')
    .map(value => [value.returned.protocol, value.returned.internalPort, value.returned.externalPort]),
  [['udp', 45001, 55001], ['tcp', 45001, 55001], ['udp', 45002, 55012], ['udp', 45003, 55033]])
  assert.equal(requests.length, 12)
  const text = JSON.stringify(summariseMappingDiagnostic(result))
  for (const sensitive of ['192.0.2.70', '45001', '55033', '10.8.0.2']) assert.equal(text.includes(sensitive), false)
  assert.equal(result.cleanup.deletionSent, false)
  assert.equal(result.cleanup.mappingsMayRemain, true)
})

test('partial gateway refusal preserves observations and stops without deleting earlier mappings', async t => {
  const { run, requests } = await fixture(t, { failAt: 4 })
  const result = await run()
  assert.equal(result.status, 'incomplete')
  assert.equal(result.reason, 'ERR_GATEWAY')
  assert.equal(requests.length, 4)
  assert.equal(result.observations.filter(value => value.type === 'mapping').length, 2)
  assert.equal(result.attempts.at(-1).resultCode, 4)
  assert.equal(result.attempts.at(-1).requested.internalPort, 45002)
  assert.equal(result.attempts.at(-1).role, 'allocation')
  assert.equal(result.cleanup.deletionSent, false)
  assert.equal(result.cleanup.mappingsMayRemain, true)
})

test('abort during a real in-flight mapping closes its socket and sends no cleanup mutation', async t => {
  const { run, requests } = await fixture(t, { cancelAt: 2 })
  const result = await run()
  assert.equal(result.status, 'cancelled')
  assert.equal(requests.length, 2)
  assert.equal(result.cleanup.mappingsMayRemain, true)
  assert.equal(result.cleanup.expiryConfirmed, false)
})
