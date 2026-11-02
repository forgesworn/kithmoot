import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { createServer as tcpServer, connect } from 'node:net'
import { createServer as httpsServer } from 'node:https'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NodeLedger } from '../src/node/kithmoot-node/ledger.js'
import { SpryBackend, ShelterBackend } from '../src/node/kithmoot-node/backends.js'
import { NodeSupervisor } from '../src/node/kithmoot-node/supervisor.js'
import { nodeHttp, preparePairing } from '../src/node/kithmoot-node/http.js'

async function freePort() {
  const server = tcpServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port')
  await new Promise<void>(r => server.close(() => r())); return address.port
}
/** Real supervisor, Spry and Shelter. Only the browser's production host
 * routing is replaced; signatures keep their production HTTPS/WSS audiences. */
export async function nodeBrowserFixture(appOrigin: string) {
  const spry = process.env.E2E_NODE_SPRY_BINARY, shelter = process.env.E2E_NODE_SHELTER_BINARY
  if (!spry || !shelter) throw Error('Set E2E_NODE_SPRY_BINARY and E2E_NODE_SHELTER_BINARY to checked local executables')
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-browser-')), children: ChildProcess[] = []
  const sockets = new Set<Duplex>(), key = generateSecretKey(), serviceKey = getPublicKey(key), origin = 'https://node.example'
  let ledger: NodeLedger | undefined, supervisor: NodeSupervisor | undefined, http: ReturnType<typeof nodeHttp> | undefined
  let bridge: ReturnType<typeof httpsServer> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined
  const close = async () => {
    clearInterval(heartbeat)
    for (const socket of sockets) socket.destroy()
    await supervisor?.stop().catch(() => {})
    await Promise.all([http && new Promise<void>(r => { http!.close(() => r()); http!.closeAllConnections() }), bridge && new Promise<void>(r => { bridge!.close(() => r()); bridge!.closeAllConnections() })])
    for (const child of children) if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>(r => { const timer = setTimeout(() => { child.kill('SIGKILL'); r() }, 3000); child.once('exit', () => { clearTimeout(timer); r() }) })
    }
    ledger?.close(); rmSync(directory, { recursive: true, force: true }); key.fill(0)
  }
  try {
    const [spryPort, relayPort] = await Promise.all(Array.from({ length: 2 }, freePort))
    // The signed node profile fixes the advertised TURN ports. This serial
    // fixture owns those real listeners; it never rewrites a credential.
    const turnPort = 3478, tlsPort = 5349
    const cert = join(directory, 'cert.pem'), tlsKey = join(directory, 'key.pem'), control = join(directory, 'relay.sock'), turnSecret = randomBytes(32).toString('hex')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', tlsKey, '-out', cert], { stdio: 'ignore' })
    const start = (binary: string, args: string[], env: Record<string, string> = {}) => { const child = spawn(binary, args, { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }); children.push(child) }
    start(spry, [], { SPRY_PUBLIC_URL: origin, SPRY_OWNER_KEYS: serviceKey, SPRY_PAIRING_KEY: serviceKey, SPRY_TURN_SECRET: turnSecret,
      SPRY_ROOM_SEAL: 'required', SPRY_LOCAL_TEST: 'true', SPRY_RELAY_IP: '127.0.0.1', SPRY_HTTP_PORT: String(spryPort), SPRY_TURN_PORT: String(turnPort),
      SPRY_TLS_PORT: String(tlsPort), SPRY_RELAY_PORTS: '49400:49431', SPRY_TLS_CERT_FILE: cert, SPRY_TLS_KEY_FILE: tlsKey, SPRY_TLS_443: 'true',
      SPRY_STATE_FILE: join(directory, 'spry.json'), SPRY_AGGREGATE_BYTES_PER_SECOND: '1000000', SPRY_ALLOWED_ORIGINS: appOrigin })
    start(shelter, ['room-relay', '--data', join(directory, 'rooms'), '--control', control, '--listen', `127.0.0.1:${relayPort}`, '--url', 'wss://node.example/events', '--max-bytes', '8388608', '--min-free-bytes', '0'])
    const calls = new SpryBackend({ local: `http://127.0.0.1:${spryPort}`, origin, key, turnSecret }), relay = new ShelterBackend(control)
    const deadline = Date.now() + 15000
    for (;;) {
      try { if ((await calls.status()).ready && (await relay.status()).rooms === 0) break } catch { /* startup */ }
      if (Date.now() > deadline) throw Error('Node fixture children did not become ready')
      await new Promise(r => setTimeout(r, 40))
    }
    ledger = new NodeLedger(join(directory, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: randomBytes(32).toString('hex') })
    supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', key)
    http = nodeHttp(supervisor, { origin, origins: [appOrigin], serviceKey }); await new Promise<void>(r => http!.listen(0, '127.0.0.1', r))
    const address = http.address(); if (!address || typeof address === 'string') throw Error('http listener')
    const desk = `http://127.0.0.1:${address.port}`
    bridge = httpsServer({ cert: readFileSync(cert), key: readFileSync(tlsKey) })
    bridge.on('upgrade', (request, socket, head) => {
      const upstream = connect(relayPort, '127.0.0.1'); sockets.add(socket); sockets.add(upstream)
      socket.once('close', () => { sockets.delete(socket); upstream.destroy() }); upstream.once('close', () => { sockets.delete(upstream); socket.destroy() })
      upstream.once('connect', () => {
        upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
    })
    await new Promise<void>(r => bridge!.listen(0, '127.0.0.1', r))
    const tls = bridge.address(); if (!tls || typeof tls === 'string') throw Error('tls listener')
    heartbeat = setInterval(() => { void supervisor!.tick().catch(() => {}) }, 1000)
    return { desk, calls: `http://127.0.0.1:${spryPort}`, websocket: `wss://localhost:${tls.port}/events`, supervisor, ledger, relay, close,
      pairing() { const pair = preparePairing(supervisor!); return '#kithmoot-node=' + Buffer.from(JSON.stringify({ v: 1, node: origin, code: pair.code, expiresAt: pair.expiresAt })).toString('base64url') } }
  } catch (error) { await close(); throw error }
}
