/** Opt-in host-gated profile proof in the task-owned offline Linux container.
 * This exercises the production supervisor/backends and generated host TLS
 * listeners. It does not qualify Archy's app gate, FIPS, UI or public networking. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, chownSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer as tlsServer } from 'node:tls'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createNodeFront } from '../src/node/kithmoot-node/front.js'
import { probeNodeUdp, probeNodeStream } from '../src/node/kithmoot-node/doctor.js'
assert.equal(process.env.E2E_NODE_INSTALLED_FIXTURE, 'disposable-offline-host-profile')
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
assert.equal(existsSync('/fixture/disposable-host-profile'), true)
const base = '/opt/kithmoot-node/current', directory = '/var/lib/kithmoot-node', children = [], servers = [], sockets = new Set()
const certificate = readFileSync('/fixture/host-tls/cert.pem'), key = readFileSync('/fixture/host-tls/key.pem')
const configuration = { v: 1, host: 'node.example', hosting: 'archy', relayIp: '1.2.3.4', aggregateBytesPerSecond: 1000000,
  maxBytes: 16777216, minFreeBytes: 16777216, maxRooms: 8, origins: ['https://kithmoot.app'],
  spryBinary: base + '/bin/spry-node', shelterBinary: base + '/bin/bothyd', deskPort: 3746, spryPort: 3744, shelterPort: 3745,
  tlsGate: true, turnPorts: { udpTcp: 34790, tls: 53499 }, relayPortFirst: 49192 }
const declared = { KITHMOOT_NODE_SERVICE_KEY: Buffer.from(generateSecretKey()).toString('hex'),
  KITHMOOT_NODE_TURN_SECRET: randomBytes(32).toString('hex'), KITHMOOT_NODE_STATE_SALT: randomBytes(32).toString('hex') }
const appEnvironment = { ...declared }
function child(program, args, uid, env) {
  const value = spawn(program, args, { uid, gid: uid, env, stdio: 'ignore', detached: true }); children.push(value)
  value.on('error', () => {}); return value
}
function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket }
async function wait(check, name) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { try { if (await check()) return } catch {}; await delay(100) }
  throw Error('Host profile fixture timed out: ' + name)
}
function command(program, args, options, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const value = spawn(program, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      try { process.kill(-value.pid, 'SIGKILL') } catch {}
      reject(Error('Fixture client timed out: ' + program + ' ' + args[0] + '\n' + stderr.slice(-2048)))
    }, timeout)
    value.stdout.on('data', data => { stdout += data; if (stdout.length > 65536) value.kill('SIGKILL') })
    value.stderr.on('data', data => { stderr += data; if (stderr.length > 65536) value.kill('SIGKILL') })
    value.once('error', error => { clearTimeout(timer); reject(error) })
    value.once('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}
async function gate(port, target) {
  const server = tlsServer({ cert: certificate, key, minVersion: 'TLSv1.2', handshakeTimeout: 5000, ALPNProtocols: ['stun.turn'] }, socket => {
    track(socket)
    if (socket.servername !== 'node.example') { socket.destroy(); return }
    const peer = track(connect(target, '1.2.3.4'))
    socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy()); socket.pipe(peer); peer.pipe(socket)
  })
  server.on('tlsClientError', (_, socket) => socket.destroy()); server.maxConnections = 64
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '1.2.3.4', resolve) })
  servers.push(server)
}
let front
try {
  mkdirSync(directory, { mode: 0o700 }); chownSync(directory, 1000, 1000)
  mkdirSync('/fixture/legacy-state', { mode: 0o700 }); chownSync('/fixture/legacy-state', 1001, 1001)
  writeFileSync('/fixture/app.json', JSON.stringify(configuration), { mode: 0o644 })
  const privateKeyProbe = spawnSync(process.execPath, ['-e', "try{require('node:fs').readFileSync('/fixture/host-tls/key.pem');process.stdout.write('readable')}catch(e){if(e.code==='EACCES')process.stdout.write('denied');else process.exit(1)}"], { uid: 1000, gid: 1000, encoding: 'utf8' })
  assert.equal(privateKeyProbe.status, 0); assert.equal(privateKeyProbe.stdout, 'denied')
  const prepared = spawnSync(base + '/kithmoot-node', ['init', '--state', directory, '--configuration', '/fixture/app.json'], { uid: 1000, gid: 1000, env: appEnvironment, encoding: 'utf8' })
  assert.equal(prepared.status, 0, 'manifest-declared initialization failed')
  child(base + '/kithmoot-node', ['run', '--state', directory], 1000, appEnvironment)
  // An independent standard-profile Spry occupies the old ports. This is a
  // listener-coexistence fixture, not a FIPS/private-mesh qualification.
  const legacyKey = getPublicKey(generateSecretKey())
  child(base + '/bin/spry-node', [], 1001, { SPRY_PUBLIC_URL: 'https://legacy.example', SPRY_OWNER_KEYS: legacyKey, SPRY_PAIRING_KEY: legacyKey,
    SPRY_TURN_SECRET: randomBytes(32).toString('hex'), SPRY_ROOM_SEAL: 'required', SPRY_PUBLIC: 'false', SPRY_RELAY_IP: '1.2.3.4',
    SPRY_HTTP_BIND: '127.0.0.1', SPRY_HTTP_PORT: '3748', SPRY_STATE_FILE: '/fixture/legacy-state/spry.json', SPRY_TLS_GATE: 'true' })
  await gate(5349, 3478); await gate(53499, 34790)
  front = createNodeFront({ host: configuration.host, relayIp: configuration.relayIp, deskPort: configuration.deskPort,
    spryPort: configuration.spryPort, shelterPort: configuration.shelterPort, turnPorts: configuration.turnPorts, relayPortFirst: configuration.relayPortFirst }, { cert: certificate, key })
  await new Promise((resolve, reject) => { front.server.once('error', reject); front.server.listen(443, '1.2.3.4', resolve) })
  await wait(async () => (await (await fetch('http://127.0.0.1:3746/node/v1/status')).json()).ready, 'production supervisor ready')
  await wait(() => probeNodeUdp('1.2.3.4', 3478), 'independent old UDP port')
  assert.equal(await probeNodeStream('1.2.3.4', 3478), true)
  assert.equal(await probeNodeStream('1.2.3.4', 5349, 'node.example'), true)
  const doctor = await command(base + '/kithmoot-node', ['doctor', '--state', directory], { uid: 1000, gid: 1000,
    env: { NODE_EXTRA_CA_CERTS: '/fixture/client-ca.pem' } })
  assert.equal(doctor.status, 0, 'host-gated doctor failed: ' + doctor.stdout)
  assert.equal(JSON.parse(doctor.stdout).localReady, true)
  const journey = await command(process.execPath, ['/fixture/journey.mjs'], { env: { E2E_NODE_INSTALLED_FIXTURE: 'disposable-offline-host-profile', NODE_EXTRA_CA_CERTS: '/fixture/client-ca.pem' } }, 120000)
  assert.equal(journey.status, 0, journey.stderr)
  const receipt = JSON.parse(journey.stdout.trim())
  assert.equal(receipt.result, 'passed'); assert.deepEqual(receipt.authenticatedTurn, ['udp34790', 'tcp34790', 'tls53499', 'tls443'])
  assert.equal(await probeNodeUdp('1.2.3.4', 3478), true)
  assert.equal(await probeNodeStream('1.2.3.4', 5349, 'node.example'), true)
  console.log(JSON.stringify({ schema: 'kithmoot-node-host-profile/1', result: 'passed', isolatedLinux: true,
    applicationUid: 1000, hostCertificateKeyDeniedToApplication: true, manifestDeclaredSecrets: true,
    hostManagedTls: true, separatePorts: configuration.turnPorts, independentOldListenersPreserved: true,
    localDoctorChecks: JSON.parse(doctor.stdout).checks.length, journey: receipt,
    actualArchyHostIntegration: false, publicNetwork: false, physicalGrapheneOS: false }))
} finally {
  await front?.close().catch(() => {})
  for (const socket of sockets) socket.destroy()
  for (const server of servers) await new Promise(resolve => server.close(resolve))
  for (const value of children) { try { process.kill(-value.pid, 'SIGTERM') } catch {} }
  await delay(1000)
  for (const value of children) { try { process.kill(-value.pid, 'SIGKILL') } catch {} }
}
