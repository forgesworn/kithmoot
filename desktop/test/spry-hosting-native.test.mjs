import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer, connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createSpryHosting } from '../spry-hosting.mjs'

const binary = process.env.KITHMOOT_TEST_SPRY_BINARY
const COOKIE = 0x2112a442
const attr = (kind, value) => {
  const bytes = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4)
  bytes.writeUInt16BE(kind); bytes.writeUInt16BE(value.length, 2)
  value.copy(bytes, 4)
  return bytes
}
function packet(type, attributes = [], key) {
  const body = Buffer.concat(attributes)
  const header = Buffer.alloc(20)
  header.writeUInt16BE(type)
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2)
  header.writeUInt32BE(COOKIE, 4)
  randomBytes(12).copy(header, 8)
  return key
    ? Buffer.concat([header, body, attr(8, createHmac('sha1', key).update(header).update(body).digest())])
    : Buffer.concat([header, body])
}
function parse(bytes, request, key) {
  assert.equal(bytes.readUInt32BE(4), COOKIE)
  assert.equal(bytes.length, 20 + bytes.readUInt16BE(2))
  assert.deepEqual(bytes.subarray(8, 20), request.subarray(8, 20))
  const attributes = new Map()
  let signed = false
  for (let offset = 20; offset < bytes.length;) {
    const kind = bytes.readUInt16BE(offset)
    const length = bytes.readUInt16BE(offset + 2)
    const value = bytes.subarray(offset + 4, offset + 4 + length)
    assert.equal(value.length, length)
    attributes.set(kind, value)
    if (kind === 8 && key) {
      const header = Buffer.from(bytes.subarray(0, 20))
      header.writeUInt16BE(offset + 4, 2)
      assert.deepEqual(value, createHmac('sha1', key).update(header).update(bytes.subarray(20, offset)).digest())
      signed = true
    }
    offset += 4 + Math.ceil(length / 4) * 4
  }
  if (key) assert.equal(signed, true, 'authenticated response must have valid integrity')
  return { type: bytes.readUInt16BE(0), attributes }
}
async function listenTcp(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}
async function bindUdp(port = 0) {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, '127.0.0.1', resolve)
  }).catch(error => { socket.close(); throw error })
  return socket
}
async function freePort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const tcp = await listenTcp(0)
    const port = tcp.address().port
    try {
      const udp = await bindUdp(port)
      udp.close()
      return port
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    } finally {
      await new Promise(resolve => tcp.close(resolve))
    }
  }
  throw new Error('Could not reserve a local fixture port')
}
async function udpExchange(socket, port, request) {
  return new Promise((resolve, reject) => {
    const finish = (error, bytes) => {
      clearTimeout(timer)
      socket.off('message', received); socket.off('error', failed)
      error ? reject(error) : resolve(bytes)
    }
    const received = bytes => finish(null, bytes)
    const failed = error => finish(error)
    const timer = setTimeout(() => finish(new Error('Local UDP fixture timed out')), 2000)
    socket.once('message', received); socket.once('error', failed)
    socket.send(request, port, '127.0.0.1', error => { if (error) finish(error) })
  })
}
async function tcpExchange(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let bytes = Buffer.alloc(0)
    socket.setTimeout(2000)
    socket.once('timeout', () => socket.destroy(new Error('Local TCP fixture timed out')))
    socket.once('error', reject)
    socket.once('connect', () => socket.write(request))
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length >= 20 && bytes.length >= 20 + bytes.readUInt16BE(2)) {
        socket.destroy()
        resolve(bytes.subarray(0, 20 + bytes.readUInt16BE(2)))
      }
    })
  })
}

test('real native Spry authenticates supervisor credentials and releases allocations on Stop', {
  skip: binary ? false : 'Set KITHMOOT_TEST_SPRY_BINARY to a task-owned native executable',
  timeout: 15000,
}, async t => {
  assert.equal(isAbsolute(binary), true)
  t.diagnostic(`Native executable SHA-256: ${createHash('sha256').update(await readFile(binary)).digest('hex')}`)
  const host = createSpryHosting({ executable: binary, startupTimeoutMs: 3000, stopTimeoutMs: 500 })
  const udp = await bindUdp()
  t.after(async () => { try { await host.stop() } finally { udp.close() } })
  const port = await freePort()
  const relayPort = await freePort()
  assert.notEqual(port, relayPort)
  const config = { listenIp: '127.0.0.1', port, relayPorts: [relayPort, relayPort] }
  await host.start(config)
  assert.equal(host.state().exposure, 'locally-bound')

  for (const exchange of [request => udpExchange(udp, port, request), request => tcpExchange(port, request)]) {
    const request = packet(1)
    assert.equal(parse(await exchange(request), request).type, 0x0101)
  }
  const transport = attr(25, Buffer.from([17, 0, 0, 0]))
  const challengeRequest = packet(3, [transport])
  const challenge = parse(await udpExchange(udp, port, challengeRequest), challengeRequest)
  assert.equal(challenge.type, 0x0113, 'anonymous allocation must be refused')
  const error = challenge.attributes.get(9)
  assert.equal(error[2] * 100 + error[3], 401, 'anonymous allocation must require authentication')
  const realm = challenge.attributes.get(20)
  const nonce = challenge.attributes.get(21)
  const credentials = host.credentials()
  const key = createHash('md5').update(`${credentials.username}:${realm}:${credentials.credential}`).digest()
  const attributes = [transport, attr(6, Buffer.from(credentials.username)), attr(20, realm), attr(21, nonce)]
  const allocate = packet(3, attributes, key)
  const allocated = parse(await udpExchange(udp, port, allocate), allocate, key)
  assert.equal(allocated.type, 0x0103)
  assert.equal(allocated.attributes.get(22).readUInt16BE(2) ^ (COOKIE >>> 16), relayPort)
  await assert.rejects(bindUdp(relayPort), { code: 'EADDRINUSE' })

  await host.stop()
  assert.deepEqual(host.state(), { status: 'off' })
  const freed = await bindUdp(relayPort)
  freed.close()
  const tcp = await listenTcp(port)
  await new Promise(resolve => tcp.close(resolve))
  const listener = await bindUdp(port)
  listener.close()
  assert.throws(() => host.credentials(), { code: 'ERR_NOT_RUNNING' })

  await host.start(config)
  const freshChallengeRequest = packet(3, [transport])
  const freshChallenge = parse(await udpExchange(udp, port, freshChallengeRequest), freshChallengeRequest)
  const oldLogin = packet(3, [transport, attr(6, Buffer.from(credentials.username)),
    attr(20, freshChallenge.attributes.get(20)), attr(21, freshChallenge.attributes.get(21))], key)
  assert.notEqual(parse(await udpExchange(udp, port, oldLogin), oldLogin).type, 0x0103,
    'credentials from the previous run must not grant a new allocation')
  await host.stop()
})

test('forced supervisor crash releases native listeners and an authenticated allocation during traffic', {
  skip: binary ? false : 'Set KITHMOOT_TEST_SPRY_BINARY to a task-owned native executable',
  timeout: 15000,
}, async t => {
  const port = await freePort()
  const relayPort = await freePort()
  assert.notEqual(port, relayPort)
  const udp = await bindUdp()
  let nativePid
  let traffic
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process'
    import { createSpryHosting } from ${JSON.stringify(new URL('../spry-hosting.mjs', import.meta.url).href)}
    const host = createSpryHosting({ executable: process.env.TEST_SPRY_BINARY, spawn(...args) {
      const child = spawn(...args)
      process.send({ nativePid: child.pid })
      return child
    } })
    process.once('message', async config => {
      try { await host.start(config); process.send({ credentials: host.credentials() }) }
      catch { process.send({ failed: true }); await host.stop(); process.exit(1) }
    })
  `], { env: { ...process.env, TEST_SPRY_BINARY: binary }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const parentExited = new Promise(resolve => parent.once('exit', resolve))
  t.after(async () => {
    clearInterval(traffic)
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    await parentExited
    if (nativePid) { try { process.kill(nativePid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    udp.close()
  })
  const credentials = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Supervisor fixture did not start')), 5000)
    parent.once('error', error => { clearTimeout(timer); reject(error) })
    parent.once('exit', () => { clearTimeout(timer); reject(new Error('Supervisor fixture exited before ready')) })
    parent.on('message', message => {
      if (message.nativePid) nativePid = message.nativePid
      if (message.failed) { clearTimeout(timer); reject(new Error('Supervisor fixture could not start native Spry')) }
      if (message.credentials) { clearTimeout(timer); resolve(message.credentials) }
    })
    parent.send({ listenIp: '127.0.0.1', port, relayPorts: [relayPort, relayPort] })
  })
  assert.ok(nativePid > 0)
  const transport = attr(25, Buffer.from([17, 0, 0, 0]))
  const request = packet(3, [transport])
  const challenge = parse(await udpExchange(udp, port, request), request)
  const realm = challenge.attributes.get(20)
  const key = createHash('md5').update(`${credentials.username}:${realm}:${credentials.credential}`).digest()
  const allocate = packet(3, [transport, attr(6, Buffer.from(credentials.username)), attr(20, realm), attr(21, challenge.attributes.get(21))], key)
  assert.equal(parse(await udpExchange(udp, port, allocate), allocate, key).type, 0x0103)
  await assert.rejects(bindUdp(relayPort), { code: 'EADDRINUSE' })
  // Keep native forwarding work active while the supervisor disappears without Stop.
  const binding = packet(1)
  traffic = setInterval(() => {
    for (let index = 0; index < 32; index++) udp.send(binding, port, '127.0.0.1', () => {})
  }, 2)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(parent.kill('SIGKILL'), true)
  await parentExited
  assert.equal(parent.signalCode, 'SIGKILL')
  const deadline = Date.now() + 3000
  for (;;) {
    let listener, allocation, tcp
    try {
      listener = await bindUdp(port)
      allocation = await bindUdp(relayPort)
      tcp = await listenTcp(port)
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      listener?.close()
      allocation?.close()
      if (tcp) await new Promise(resolve => tcp.close(resolve))
    }
  }
  clearInterval(traffic)
  t.diagnostic('SIGKILL parent: UDP/TCP listener and authenticated allocation ports released within 3 seconds')
})
