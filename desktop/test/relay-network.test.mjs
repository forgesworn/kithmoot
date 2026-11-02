import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { candidateGateway, classifyNetwork, interfaceFor, isTunnel, probeNatPmp, publicAddress } from '../relay-network.mjs'

const interfaces = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4' }],
  en1: [{ address: '192.168.0.104', family: 'IPv4' }],
  utun10: [{ address: '10.2.0.2', family: 'IPv4' }],
}

test('the interface holding an address, and which names are tunnels', () => {
  assert.equal(interfaceFor('10.2.0.2', interfaces), 'utun10')
  assert.equal(interfaceFor('192.168.0.104', interfaces), 'en1')
  assert.equal(interfaceFor('203.0.113.9', interfaces), undefined)
  for (const name of ['utun10', 'ipsec0', 'ppp0', 'tun0', 'wg0', 'tap1']) assert.equal(isTunnel(name), true, name)
  for (const name of ['en0', 'en1', 'bridge100', 'eth0', 'wlan0', undefined]) assert.equal(isTunnel(name), false, String(name))
})

test('the candidate gateway is the first host of the bind\'s /24', () => {
  assert.equal(candidateGateway('10.2.0.2'), '10.2.0.1')
  assert.equal(candidateGateway('10.8.3.77'), '10.8.3.1')
  assert.equal(candidateGateway('10.2.0.1'), undefined)
  assert.equal(candidateGateway('nope'), undefined)
})

test('only public unicast addresses count as reachable', () => {
  for (const ok of ['84.252.115.7', '203.0.114.1', '8.8.8.8']) assert.equal(publicAddress(ok), true, ok)
  for (const bad of ['10.2.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '100.127.0.1', '127.0.0.1',
    '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', 'x']) assert.equal(publicAddress(bad), false, bad)
})

/** A dgram socket double: answers each send with `reply(n)` from the gateway. */
function socketDouble({ reply, from = { address: '10.2.0.1', port: 5351 } }) {
  const sent = []
  const create = () => {
    const socket = new EventEmitter()
    socket.bound = undefined
    socket.bind = (options, ready) => { socket.bound = options; setImmediate(ready) }
    socket.send = (buffer, port, host) => {
      sent.push({ bytes: [...buffer], port, host, from: socket.bound })
      const answer = reply(sent.length)
      if (answer) setImmediate(() => socket.emit('message', Buffer.from(answer), from))
    }
    socket.close = () => { socket.closed = true }
    return socket
  }
  return { create, sent }
}
const answer = (result, address) => [0, 128, result >> 8, result & 255, 0, 0, 0, 1, ...address]

test('the probe asks for the external address from the bind and accepts a public answer', async () => {
  const { create, sent } = socketDouble({ reply: () => answer(0, [84, 252, 115, 7]) })
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', create }), '84.252.115.7')
  assert.deepEqual(sent, [{ bytes: [0, 0], port: 5351, host: '10.2.0.1', from: { address: '10.2.0.2', port: 0 } }])
})

test('the probe refuses errors, private answers, strangers and silence, and retries once', async () => {
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', create: socketDouble({ reply: () => answer(3, [84, 252, 115, 7]) }).create }), undefined)
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', create: socketDouble({ reply: () => answer(0, [10, 2, 0, 1]) }).create }), undefined)
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', timeoutMs: 20,
    create: socketDouble({ reply: () => answer(0, [84, 252, 115, 7]), from: { address: '10.9.9.9', port: 5351 } }).create }), undefined)
  const silent = socketDouble({ reply: () => undefined })
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', timeoutMs: 20, create: silent.create }), undefined)
  assert.equal(silent.sent.length, 2)
  const second = socketDouble({ reply: n => n === 2 ? answer(0, [84, 252, 115, 7]) : undefined })
  assert.equal(await probeNatPmp('10.2.0.1', { bind: '10.2.0.2', timeoutMs: 20, create: second.create }), '84.252.115.7')
  assert.equal(await probeNatPmp('not-an-address', { bind: '10.2.0.2', create: second.create }), undefined)
})

test('a normal network is direct and never probed; a VPN is probed at its gateway', async () => {
  const asked = []
  const probe = async (gateway, options) => { asked.push([gateway, options.bind]); return '84.252.115.7' }
  assert.deepEqual(await classifyNetwork({ bind: '192.168.0.104', interfaces, probe }), { kind: 'direct' })
  assert.deepEqual(asked, [])
  assert.deepEqual(await classifyNetwork({ bind: '10.2.0.2', interfaces, probe }), { kind: 'vpn-forwarding', gateway: '10.2.0.1', publicAddress: '84.252.115.7' })
  assert.deepEqual(asked, [['10.2.0.1', '10.2.0.2']])
  assert.deepEqual(await classifyNetwork({ bind: '10.2.0.2', interfaces, probe: async () => undefined }), { kind: 'vpn' })
  assert.deepEqual(await classifyNetwork({ bind: '10.2.0.1', interfaces: { utun3: [{ address: '10.2.0.1' }] }, probe }), { kind: 'vpn' })
  assert.deepEqual(await classifyNetwork({ bind: '192.168.0.104', interfaces: () => interfaces, probe }), { kind: 'direct' })
})
