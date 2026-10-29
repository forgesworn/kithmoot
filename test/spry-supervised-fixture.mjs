#!/usr/bin/env node
/**
 * A member's built-in call relay, for test/spry-standard-offer.spec.ts: the
 * real `spry-node supervised` (spry-turn docs/supervised-mode.md), reached
 * only through the encrypted `spry:` control channel on the offline test
 * relay (test/ws-relay.mjs).
 *
 * Clients accept only `wss://` control relays on dotted names, so the test
 * relay is put behind one: `wss://control.example:<port>/`, a TLS terminator
 * on 127.0.0.1 with a throwaway certificate authority. The browser resolves
 * the name to loopback (`--host-resolver-rules`); the node reaches it through
 * a SOCKS5 proxy here that answers for that one name only, and trusts the
 * throwaway authority (`SPRY_CONTROL_CA_FILE`). Nothing leaves loopback.
 *
 * The node runs `SPRY_LOCAL_TEST=true` so it may bind and advertise
 * 127.0.0.1, which the client admits only in a build made with
 * `VITE_E2E_SPRY_LOOPBACK_TURN=true`. Its pairing key is the public half of
 * the generated `E2E_SPRY_PAIRING_SECRET` the spec gives the host's browser,
 * as a desktop app would hold its own node's pairing.
 *
 * No token, credential, secret or guest address is printed, stored or
 * returned; `/fixture/pairing` returns only the public endpoint and pairing
 * id the node prints for its supervisor.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

const CONTROL_HOST = 'control.example'
const CONTROL_PORT = Number(process.env.E2E_SPRY_CONTROL_PORT ?? 7796)
const FIXTURE_PORT = Number(process.env.E2E_SPRY_FIXTURE_PORT ?? 7797)
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 7777)
const binary = process.env.E2E_SPRY_NODE_BINARY ?? ''
if (!isAbsolute(binary) || !existsSync(binary)) {
  throw new Error('Set E2E_SPRY_NODE_BINARY to the absolute path of a spry-node with supervised mode (see scripts/build-spry-node-fixture.sh)')
}
const secret = process.env.E2E_SPRY_PAIRING_SECRET ?? ''
if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Set E2E_SPRY_PAIRING_SECRET (playwright.spry-standard-offer.config.ts does)')
const pairingKey = getPublicKey(hexToBytes(secret))

const root = mkdtempSync(join(tmpdir(), 'kithmoot-spry-supervised-'))
let child
let ready
let controlRelays = 0
let stopping = false
const servers = []

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

/** A throwaway authority and a leaf for the control name, as rustls wants:
 *  the leaf is not a CA and names the host in its subjectAltName. */
function certificates() {
  const file = name => join(root, name)
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '1', '-subj', '/CN=KithMoot test control CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('leaf.key'), '-out', file('leaf.csr'), '-subj', `/CN=${CONTROL_HOST}`])
  writeFileSync(file('leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${CONTROL_HOST}\n`)
  run(['x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('leaf.pem'), '-days', '1', '-extfile', file('leaf.ext')])
  for (const name of ['ca.key', 'leaf.key']) chmodSync(file(name), 0o600)
  return { ca: file('ca.pem'), key: readFileSync(file('leaf.key')), cert: readFileSync(file('leaf.pem')) }
}

/** `wss://control.example:<port>/` in front of the offline relay. */
function controlTerminator({ key, cert }) {
  const server = createTlsServer({ key, cert }, socket => {
    const upstream = netConnect(RELAY_PORT, '127.0.0.1')
    socket.pipe(upstream).pipe(socket)
    const end = () => { socket.destroy(); upstream.destroy() }
    socket.on('error', end); upstream.on('error', end); socket.on('close', end); upstream.on('close', end)
  })
  server.on('tlsClientError', () => {})
  servers.push(server)
  return new Promise(resolve => server.listen(CONTROL_PORT, '127.0.0.1', resolve))
}

/** SOCKS5, no authentication, CONNECT to the control name and port only. */
async function socksProxy() {
  const port = await freePort()
  const server = createNetServer(socket => {
    let stage = 0, buffer = Buffer.alloc(0)
    socket.on('error', () => socket.destroy())
    socket.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 600) { socket.destroy(); return }
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]).includes(0)) { socket.destroy(); return }
        buffer = buffer.subarray(2 + buffer[1]); stage = 1
        socket.write(Buffer.from([5, 0]))
      }
      if (stage === 1) {
        if (buffer.length < 5 || buffer.length < 7 + buffer[4]) return
        const length = buffer[4]
        const host = buffer.subarray(5, 5 + length).toString('latin1'), port = buffer.readUInt16BE(5 + length)
        const rest = buffer.subarray(7 + length)
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3 || host !== CONTROL_HOST || port !== CONTROL_PORT) {
          socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return
        }
        stage = 2
        socket.removeListener('data', onData)
        const upstream = netConnect(CONTROL_PORT, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (rest.length) upstream.write(rest)
          socket.pipe(upstream).pipe(socket)
        })
        upstream.on('error', () => { socket.destroy(); upstream.destroy() })
        socket.on('close', () => upstream.destroy())
      }
    })
  })
  servers.push(server)
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return port
}

async function startNode(ca, socks) {
  const ports = []
  while (ports.length < 5) { const port = await freePort(); if (!ports.includes(port)) ports.push(port) }
  const [listen, ...allocations] = ports
  const args = ['supervised', '--exit-on-stdin-close', '--pairing-key', pairingKey, '--state-file', join(root, 'state.json'),
    '--control-relay', `wss://${CONTROL_HOST}:${CONTROL_PORT}/`, '--bind', '127.0.0.1', '--public-ip', '127.0.0.1',
    '--listen-port', String(listen), '--public-udp-port', String(listen), '--public-tcp-port', String(listen),
    ...allocations.flatMap(port => ['--relay-port-map', `${port}:${port}`])]
  child = spawn(binary, args, {
    env: { PATH: process.env.PATH, SPRY_TURN_SECRET: randomBytes(32).toString('hex'), SPRY_ROOM_SEAL: 'required', SPRY_LOCAL_TEST: 'true',
      SPRY_SOCKS_PROXY: `127.0.0.1:${socks}`, SPRY_CONTROL_CA_FILE: ca },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let refusal = ''
  child.stderr.on('data', chunk => { refusal = (refusal + chunk).slice(-400) })
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += chunk
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1)
      try {
        const event = JSON.parse(line)
        if (event.v !== 1) continue
        if (event.event === 'ready') ready = { endpoint: event.endpoint, id: event.pairing, urls: event.urls }
        if (event.event === 'control') controlRelays = event.relays
      } catch { /* not a supervisor line */ }
    }
  })
  child.on('exit', code => {
    if (!stopping) process.stderr.write(`spry-node supervised exited (${code}): ${refusal.trim()}\n`)
    child = undefined
  })
  for (let attempt = 0; attempt < 400 && !(ready && controlRelays > 0); attempt++) {
    if (!child) throw new Error('spry-node exited before it was ready')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!ready || controlRelays === 0) throw new Error('spry-node did not connect to its control relay')
}

function reply(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function shutdown() {
  if (stopping) return
  stopping = true
  // Closing stdin ends the node and frees every port it held.
  try { child?.stdin.end() } catch { /* already gone */ }
  await new Promise(resolve => { if (!child) resolve(); else { const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve() }, 4000); child.once('exit', () => { clearTimeout(timer); resolve() }) } })
  for (const server of servers) try { server.close() } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  const { ca, key, cert } = certificates()
  await controlTerminator({ key, cert })
  const socks = await socksProxy()
  await startNode(ca, socks)
  const api = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    if (req.method !== 'GET') return reply(res, { error: 'Not found' }, 404)
    if (url.pathname === '/') return reply(res, { ready: !!ready && controlRelays > 0 && !!child })
    if (url.pathname === '/fixture/pairing') return reply(res, { endpoint: ready.endpoint, id: ready.id })
    if (url.pathname === '/fixture/stats') {
      return reply(res, { nodeRunning: !!child, controlRelays, urls: ready.urls, nodeBinarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') })
    }
    return reply(res, { error: 'Not found' }, 404)
  })
  servers.push(api)
  api.listen(FIXTURE_PORT, '127.0.0.1')
} catch (error) {
  process.stderr.write(`spry-supervised fixture failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
  stopping = true
  try { child?.stdin.end() } catch { /* already gone */ }
  for (const server of servers) try { server.close() } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
