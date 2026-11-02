// Independent stdlib TURN wire client for generated loopback node fixtures.
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

function attribute(kind, value) {
  const out = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4)
  out.writeUInt16BE(kind); out.writeUInt16BE(value.length, 2); value.copy(out, 4); return out
}
function packet(method, attributes, key) {
  let body = Buffer.concat(attributes.map(([k, v]) => attribute(k, v)))
  const header = Buffer.alloc(20); header.writeUInt16BE(method); header.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(header, 8)
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2)
  if (key) body = Buffer.concat([body, attribute(8, createHmac('sha1', key).update(Buffer.concat([header, body])).digest())])
  return Buffer.concat([header, body])
}
function parse(raw, key) {
  assert.equal(raw.readUInt32BE(4), 0x2112a442); assert.equal(raw.length, raw.readUInt16BE(2) + 20)
  const attributes = new Map(); let signed = false
  for (let at = 20; at < raw.length;) {
    const kind = raw.readUInt16BE(at), size = raw.readUInt16BE(at + 2), value = raw.subarray(at + 4, at + 4 + size)
    attributes.set(kind, value)
    if (kind === 8 && key) {
      const header = Buffer.from(raw.subarray(0, 20)); header.writeUInt16BE(at + 4, 2)
      assert.deepEqual(value, createHmac('sha1', key).update(Buffer.concat([header, raw.subarray(20, at)])).digest()); signed = true
    }
    at += 4 + Math.ceil(size / 4) * 4
  }
  return { type: raw.readUInt16BE(), attributes, signed }
}
export async function turnWire({ protocol, port, ca }) {
  const socket = protocol === 'udp' ? createSocket('udp4') : protocol === 'tls'
    ? tlsConnect({ host: '127.0.0.1', port, servername: 'node.example', ca, rejectUnauthorized: true }) : connect(port, '127.0.0.1')
  const queue = [], waiters = []; let buffer = Buffer.alloc(0), closed = false
  const deliver = frame => { const waiter = waiters.shift(); if (waiter) waiter(frame); else queue.push(frame) }
  socket.on('error', () => {})
  socket.once('close', () => { closed = true; while (waiters.length) waiters.shift()(undefined) })
  if (protocol === 'udp') socket.on('message', deliver)
  else {
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 20 && buffer.length >= 20 + buffer.readUInt16BE(2)) {
        const size = 20 + buffer.readUInt16BE(2); deliver(buffer.subarray(0, size)); buffer = buffer.subarray(size)
      }
    })
    await new Promise((resolve, reject) => { socket.once(protocol === 'tls' ? 'secureConnect' : 'connect', resolve); socket.once('error', reject) })
  }
  async function exchange(bytes) {
    if (protocol === 'udp') socket.send(bytes, port, '127.0.0.1'); else socket.write(bytes)
    let timer
    try { return await Promise.race([queue.length ? queue.shift() : new Promise(r => waiters.push(r)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TURN response timed out')), 2000) })]) }
    finally { clearTimeout(timer) }
  }
  let realm, nonce, login, key
  const client = {
    get closed() { return closed },
    close() { if (protocol === 'udp') { if (!closed) socket.close() } else socket.destroy() },
    async authenticate(credentials) {
      login = credentials
      const challenge = parse(await exchange(packet(3, [[25, Buffer.from([17, 0, 0, 0])]])))
      assert.equal(challenge.type, 0x0113)
      realm = challenge.attributes.get(20); nonce = challenge.attributes.get(21); assert.ok(realm && nonce)
      key = createHash('md5').update(`${login.username}:${realm.toString()}:${login.credential}`).digest()
      return client.request(3)
    },
    async request(method) {
      const attrs = [[6, Buffer.from(login.username)], [20, realm], [21, nonce], method === 3 ? [25, Buffer.from([17, 0, 0, 0])] : [13, Buffer.from([0, 0, 0, 60])]]
      const bytes = await exchange(packet(method, attrs, key)); assert.ok(bytes, 'TURN stream closed')
      const answer = parse(bytes, key)
      if (answer.type === (method | 0x0100)) assert.ok(answer.signed, 'successful TURN response needs integrity')
      return answer
    },
  }
  return client
}
