/** Private, generated loopback fixtures. Build the library and both backend
 * executables first. No dependency is downloaded and no public socket opens. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { NodeLedger } from '../dist/src/node/kithmoot-node/ledger.js'
import { NodeSupervisor } from '../dist/src/node/kithmoot-node/supervisor.js'
import { nodeHttp, preparePairing } from '../dist/src/node/kithmoot-node/http.js'
import { SpryBackend, ShelterBackend } from '../dist/src/node/kithmoot-node/backends.js'
import { buildGrant, buildRevocation, buildReset, parseGroupEvent } from '../dist/src/group-grants.js'
import { turnWire } from './node-turn-wire.mjs'

const spry = process.env.E2E_NODE_SPRY_BINARY, shelter = process.env.E2E_NODE_SHELTER_BINARY
if (!spry || !shelter) throw Error('Set E2E_NODE_SPRY_BINARY and E2E_NODE_SHELTER_BINARY to the locally built executables')
const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-backends-')), children = [], sockets = [], turnClients = []
let ledger, http, supervisor
const port = async () => {
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r))
  const port = listener.address().port; await new Promise(r => listener.close(r)); return port
}
const until = async (check, label) => {
  const end = Date.now() + 12000
  while (true) { try { if (await check()) return } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(30) }
}
const start = (binary, args, env = {}) => { const child = spawn(resolve(binary), args, { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }); children.push(child); return child }
const origin = 'https://node.example', hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function signed(base, path, value, key) {
  const body = JSON.stringify(value)
  const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
    ['u', origin + path], ['method', 'POST'], ['payload', hash(body)], ['nonce', randomBytes(32).toString('base64url')],
  ] }, key)
  return fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}` }, signal: AbortSignal.timeout(5000) })
}
async function wsLogin(base, room, key) {
  const socket = new WebSocket(base + '/events'); sockets.push(socket)
  const queue = [], waiters = []
  socket.on('message', data => { const value = JSON.parse(String(data)); const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value) })
  const next = async () => queue.length ? queue.shift() : Promise.race([new Promise(r => waiters.push(r)), delay(4000).then(() => { throw Error('No WebSocket frame') })])
  const challenge = await next(); assert.equal(challenge[0], 'AUTH')
  const proof = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
    ['relay', 'wss://node.example/events'], ['challenge', challenge[1]], ['room', room], ['mode', 'room'],
  ] }, key)
  socket.send(JSON.stringify(['AUTH', proof])); const ack = await next(); assert.equal(ack[0], 'OK'); assert.equal(ack[2], true)
  return { socket, next, queue }
}
try {
  const [spryPort, relayPort, turnPort, tlsPort] = await Promise.all(Array.from({ length: 4 }, port))
  const key = generateSecretKey(), serviceKey = getPublicKey(key), turnSecret = randomBytes(32).toString('hex')
  const cert = join(directory, 'cert.pem'), tlsKey = join(directory, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=node.example', '-addext', 'subjectAltName=DNS:node.example,DNS:turn.node.example,IP:127.0.0.1', '-keyout', tlsKey, '-out', cert], { stdio: 'ignore' })
  start(spry, [], { SPRY_PUBLIC_URL: origin, SPRY_OWNER_KEYS: serviceKey, SPRY_PAIRING_KEY: serviceKey, SPRY_TURN_SECRET: turnSecret,
    SPRY_ROOM_SEAL: 'required', SPRY_LOCAL_TEST: 'true', SPRY_RELAY_IP: '127.0.0.1', SPRY_HTTP_PORT: String(spryPort),
    SPRY_TURN_PORT: String(turnPort), SPRY_TLS_PORT: String(tlsPort), SPRY_RELAY_PORTS: '49320:49351',
    SPRY_TLS_CERT_FILE: cert, SPRY_TLS_KEY_FILE: tlsKey, SPRY_TLS_443: 'true', SPRY_STATE_FILE: join(directory, 'spry.json'),
    SPRY_AGGREGATE_BYTES_PER_SECOND: '1000000' })
  const socket = join(directory, 'relay.sock')
  start(shelter, ['room-relay', '--data', join(directory, 'rooms'), '--control', socket, '--listen', `127.0.0.1:${relayPort}`,
    '--url', 'wss://node.example/events', '--max-bytes', '8388608', '--min-free-bytes', '0'])
  const calls = new SpryBackend({ local: `http://127.0.0.1:${spryPort}`, origin, key, turnSecret }), relay = new ShelterBackend(socket)
  await until(async () => (await calls.status()).ready && (await relay.status()).rooms === 0, 'backend readiness')
  ledger = new NodeLedger(join(directory, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: randomBytes(32).toString('hex') })
  supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', key)
  http = nodeHttp(supervisor, { origin, origins: [], serviceKey }); await new Promise(r => http.listen(0, '127.0.0.1', r))
  const desk = `http://127.0.0.1:${http.address().port}`, owner = generateSecretKey(), authority = generateSecretKey(), device = generateSecretKey(), otherDevice = generateSecretKey()
  assert.equal((await signed(desk, '/node/v1/claim', { code: preparePairing(supervisor).code }, owner)).status, 200)
  const rooms = ['01'.repeat(32), '02'.repeat(32)]
  for (const room of rooms) assert.equal((await signed(desk, '/node/v1/enrol', { room, authority: getPublicKey(authority), inviter: getPublicKey(authority) }, owner)).status, 200)
  const now = Math.floor(Date.now() / 1000)
  const grants = rooms.map((room, i) => buildGrant({ authoritySk: authority, roomId: room, device: getPublicKey(i ? otherDevice : device), server: 'node.example',
    scopes: ['turn', 'relay-read', 'relay-write'], createdAt: now, expiration: now + 120, grantId: String(i + 1).padStart(32, '0') }))
  for (const grant of grants) {
    const response = await signed(desk, '/groups/v1/events', grant, authority)
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
  }
  const access = await (await signed(desk, '/node/v1/access', { room: rooms[0], grant: grants[0].tags.find(t => t[0] === 'grant')[1] }, device)).json()
  assert.equal(access.state, 'active')
  const credentials = await signed(`http://127.0.0.1:${spryPort}`, '/v1/credentials', { grant: access.offer.token }, device)
  assert.equal(credentials.status, 200)
  const login = await credentials.json()
  assert.equal(login.urls.length, 4); assert.ok(login.expiresAt <= now + 120); assert.ok(login.expiresAt > now)
  const transports = await Promise.all(['udp', 'tcp', 'tls'].map(async protocol => {
    const client = await turnWire({ protocol, port: protocol === 'tls' ? tlsPort : turnPort, ca: readFileSync(cert) }); turnClients.push(client)
    assert.equal((await client.authenticate(login)).type, 0x0103); return client
  }))
  const otherAccess = await (await signed(desk, '/node/v1/access', { room: rooms[1], grant: grants[1].tags.find(t => t[0] === 'grant')[1] }, otherDevice)).json()
  const otherLogin = await (await signed(`http://127.0.0.1:${spryPort}`, '/v1/credentials', { grant: otherAccess.offer.token }, otherDevice)).json()
  const otherTurn = await turnWire({ protocol: 'udp', port: turnPort }); turnClients.push(otherTurn)
  assert.equal((await otherTurn.authenticate(otherLogin)).type, 0x0103)
  const a = await wsLogin(`ws://127.0.0.1:${relayPort}`, rooms[0], device), b = await wsLogin(`ws://127.0.0.1:${relayPort}`, rooms[1], otherDevice)
  a.socket.send(JSON.stringify(['REQ', 'a', { kinds: [1] }])); assert.equal((await a.next())[0], 'EOSE')
  const event = finalizeEvent({ kind: 1, created_at: now, content: 'encrypted fixture', tags: [['expiration', String(now + 120)]] }, generateSecretKey())
  a.socket.send(JSON.stringify(['EVENT', event]))
  const frames = [await a.next(), await a.next()]; assert.ok(frames.some(f => f[0] === 'OK' && f[2])); assert.ok(frames.some(f => f[0] === 'EVENT' && f[2].id === event.id))
  b.socket.send(JSON.stringify(['REQ', 'b', { kinds: [1] }])); assert.equal((await b.next())[0], 'EOSE')
  const parsed = parseGroupEvent(grants[0]); assert.equal(parsed.ok, true)
  assert.equal((await signed(desk, '/groups/v1/events', buildRevocation(parsed.parsed, authority, now + 1), authority)).status, 200)
  const revokedAt = performance.now()
  await until(() => transports[1].closed && transports[2].closed, 'revoked TCP/TLS allocations closed')
  const revocationMs = Math.ceil(performance.now() - revokedAt); assert.ok(revocationMs <= 1000, 'TURN revocation must close streams within one second of acknowledgement')
  for (const method of [3, 4]) assert.equal((await transports[0].request(method)).type, method | 0x0110)
  for (const protocol of ['tcp', 'tls']) {
    const retry = await turnWire({ protocol, port: protocol === 'tls' ? tlsPort : turnPort, ca: readFileSync(cert) }); turnClients.push(retry)
    assert.equal((await retry.authenticate(login)).type, 0x0113)
  }
  assert.equal((await otherTurn.request(4)).type, 0x0104)
  await until(() => a.socket.readyState === WebSocket.CLOSED, 'revoked WebSocket closure')
  assert.equal((await signed(`http://127.0.0.1:${spryPort}`, '/v1/credentials', { grant: access.offer.token }, device)).status, 403)
  assert.equal((await relay.status()).rooms, 2)
  const operation = randomBytes(16).toString('hex'), at = Math.floor(Date.now() / 1000)
  b.socket.send(JSON.stringify(['REQ', 'closing', { kinds: [1461, 1462] }])); assert.equal((await b.next())[0], 'EOSE')
  const close = { operation, room: rooms[1], deadline: at + 2, reset: buildReset({ authoritySk: authority, roomId: rooms[1], server: 'node.example', createdAt: at }),
    closure: finalizeEvent({ kind: 27543, created_at: at, content: '', tags: [['t', 'closed'], ['d', rooms[1]], ['server', 'node.example'], ['operation', operation], ['expiration', String(at + 30 * 86400)]] }, authority),
    events: [1461, 1462].map(kind => finalizeEvent({ kind, created_at: at, content: 'sealed closing fixture', tags: [['expiration', String(at + 120)]] }, authority)) }
  const started = await signed(desk, '/node/v1/close', close, authority); assert.equal(started.status, 200)
  assert.equal((await started.json()).phase, 'draining')
  assert.equal((await b.next())[0], 'EVENT'); assert.equal((await b.next())[0], 'EVENT')
  await delay(2100); await supervisor.tick()
  assert.equal(supervisor.operation(operation).phase, 'done'); assert.equal(ledger.room(rooms[1]), undefined)
  const receipt = supervisor.operation(operation).result.receipt
  assert.ok(verifyEvent(receipt)); assert.equal(receipt.pubkey, serviceKey); assert.equal(receipt.kind, 27544)
  assert.equal(JSON.parse(receipt.content).operation, operation)
  assert.equal((await relay.status()).rooms, 1)
  assert.equal(JSON.stringify(supervisor.operation(operation)).includes(rooms[1]), false)
  assert.equal((await (await signed(desk, '/node/v1/close', close, authority)).json()).phase, 'done')
  console.log(JSON.stringify({ schema: 'kithmoot-node-backends/1', result: 'passed', loopbackOnly: true,
    binaryHashes: { spry: hash(readFileSync(spry)), shelter: hash(readFileSync(shelter)) },
    checks: ['owner pairing', 'authority grants', 'both child acknowledgements', 'four TURN URLs', 'signed expiry clamp', 'room partition isolation',
      'rotating event author', 'removed WebSocket closure', 'removed credential refusal', 'UDP/TCP/TLS allocations', 'cached UDP Allocate/Refresh refused', 'cached TCP/TLS Allocate refused',
      'active TCP/TLS removal under one second', 'other room TURN refresh survives', 'signed closing event delivery', 'scoped purge', 'durable close retry'],
    revocationAcknowledgementToClosedStreamsMs: revocationMs,
    internetNode: false, physicalGrapheneOS: false, tls443PublicRoute: false }))
} finally {
  for (const client of turnClients) client.close()
  for (const socket of sockets) socket.terminate()
  if (supervisor) await supervisor.stop()
  if (http) await new Promise(r => { http.close(r); http.closeAllConnections() })
  if (ledger) ledger.close()
  for (const child of children) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)) }
  }
  rmSync(directory, { recursive: true, force: true })
}
