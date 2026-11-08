import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { createServer as tcpServer, connect } from 'node:net'
import { createServer as httpsServer } from 'node:https'
import { request as httpRequest, createServer as httpServer } from 'node:http'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
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
export async function nodeBrowserFixture(appOrigin: string, options: { chatOnly?: boolean; relayIp?: string; turnPorts?: { udpTcp: number; tls: number };
  onRequest?: (value: { method: string; path: string; origin?: string }) => void } = {}) {
  const spry = process.env.E2E_NODE_SPRY_BINARY, shelter = process.env.E2E_NODE_SHELTER_BINARY
  if (!shelter || !options.chatOnly && !spry) throw Error('Set checked native fixture executables; chat-only qualification needs Shelter and supplies no real TURN service')
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-browser-')), children: ChildProcess[] = []
  const sockets = new Set<Duplex>(), key = generateSecretKey(), serviceKey = getPublicKey(key), origin = 'https://node.example'
  let ledger: NodeLedger | undefined, supervisor: NodeSupervisor | undefined, http: ReturnType<typeof nodeHttp> | undefined
  let credentials: ReturnType<typeof httpServer> | undefined
  let bridge: ReturnType<typeof httpsServer> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined
  const close = async () => {
    clearInterval(heartbeat)
    for (const socket of sockets) socket.destroy()
    await supervisor?.stop().catch(() => {})
    await Promise.all([credentials && new Promise<void>(r => { credentials!.close(() => r()); credentials!.closeAllConnections() }), http && new Promise<void>(r => { http!.close(() => r()); http!.closeAllConnections() }), bridge && new Promise<void>(r => { bridge!.close(() => r()); bridge!.closeAllConnections() })])
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
    const turnPorts = options.turnPorts ?? { udpTcp: 3478, tls: 5349 }
    const turnPort = turnPorts.udpTcp, tlsPort = turnPorts.tls
    const cert = join(directory, 'cert.pem'), tlsKey = join(directory, 'key.pem'), control = join(directory, 'relay.sock'), turnSecret = randomBytes(32).toString('hex')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:node.example,DNS:turn.node.example,IP:127.0.0.1', '-keyout', tlsKey, '-out', cert], { stdio: 'ignore' })
    const startupErrors: string[] = []
    const start = (binary: string, args: string[], env: Record<string, string> = {}) => {
      const index = children.length
      startupErrors[index] = ''
      const child = spawn(binary, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr?.on('data', chunk => { startupErrors[index] = (startupErrors[index] + String(chunk)).slice(-2048) })
      children.push(child)
    }
    if (!options.chatOnly) start(spry!, [], { SPRY_PUBLIC_URL: origin, SPRY_OWNER_KEYS: serviceKey, SPRY_PAIRING_KEY: serviceKey, SPRY_TURN_SECRET: turnSecret,
      SPRY_ROOM_SEAL: 'required', SPRY_LOCAL_TEST: 'true', SPRY_RELAY_IP: options.relayIp ?? '127.0.0.1', SPRY_HTTP_PORT: String(spryPort), SPRY_TURN_PORT: String(turnPort),
      SPRY_TLS_PORT: String(tlsPort), SPRY_RELAY_PORTS: '49400:49431', SPRY_TLS_CERT_FILE: cert, SPRY_TLS_KEY_FILE: tlsKey, SPRY_TLS_443: 'true',
      SPRY_STATE_FILE: join(directory, 'spry.json'), SPRY_AGGREGATE_BYTES_PER_SECOND: '1000000', SPRY_ALLOWED_ORIGINS: appOrigin })
    start(shelter, ['room-relay', '--data', join(directory, 'rooms'), '--control', control, '--listen', `127.0.0.1:${relayPort}`, '--url', 'wss://node.example/events', '--max-bytes', '8388608', '--min-free-bytes', '0'])
    // Explicit chat-only runs exercise real signed admission and the native
    // relay. Their synthetic credential issuer cannot qualify media or TURN.
    const tokens = new Map<string, string>()
    const calls = options.chatOnly ? {
      status: async () => ({ ready: true, leaseActive: true }),
      offer: async (room: string) => {
        const token = createHash('sha256').update(room).digest('base64url'); tokens.set(token, room)
        return { v: 1 as const, endpoint: origin, token, expiresAt: Math.floor(Date.now() / 1000) + 86400 }
      }, register: async () => {}, remove: async () => {}, lease: async () => {},
    } : new SpryBackend({ local: `http://127.0.0.1:${spryPort}`, origin, key, turnSecret })
    const relay = new ShelterBackend(control)
    const deadline = Date.now() + 15000
    for (;;) {
      try { if ((await calls.status()).ready && (await relay.status()).rooms === 0) break } catch { /* startup */ }
      if (children.some(child => child.exitCode !== null) || Date.now() > deadline) {
        const safe = startupErrors.join('\n').replaceAll(turnSecret, '[fixture secret]').replaceAll(Buffer.from(key).toString('hex'), '[fixture key]')
        throw Error(`Node fixture children did not become ready: ${safe}`)
      }
      await new Promise(r => setTimeout(r, 40))
    }
    ledger = new NodeLedger(join(directory, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: randomBytes(32).toString('hex') })
    supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', key)
    http = nodeHttp(supervisor, { origin, origins: [appOrigin], serviceKey, turnPorts }); await new Promise<void>(r => http!.listen(0, '127.0.0.1', r))
    const address = http.address(); if (!address || typeof address === 'string') throw Error('http listener')
    const desk = `http://127.0.0.1:${address.port}`
    if (options.chatOnly) {
      credentials = httpServer(async (request, response) => {
        try {
          const chunks: Buffer[] = []; let bytes = 0
          for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw Error('fixture request'); chunks.push(chunk) }
          const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
          const proof = JSON.parse(Buffer.from(String(request.headers.authorization).slice(6), 'base64').toString('utf8'))
          if (request.url !== '/v1/credentials' || !verifyEvent(proof) || proof.kind !== 27235 || !proof.tags.some((tag: string[]) => tag[0] === 'payload' && tag[1] === createHash('sha256').update(raw).digest('hex'))) throw Error('fixture proof')
          const room = tokens.get(body.grant), grant = ledger!.active().find(g => g.roomId === room && g.device === proof.pubkey)
          if (!grant) throw Error('fixture grant')
          const now = Math.floor(Date.now() / 1000), expiresAt = Math.min(now + 300, grant.expiration, ledger!.room(grant.roomId)?.ends ?? Infinity)
          response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': appOrigin })
          response.end(JSON.stringify({ urls: [`turn:node.example:${turnPort}?transport=udp`], username: `${expiresAt}:${'01'.repeat(12)}`, credential: 'A'.repeat(27) + '=', issuedAt: now, expiresAt, accessExpiresAt: grant.expiration }))
        } catch { response.writeHead(403, { 'content-type': 'application/json' }); response.end('{}') }
      })
      await new Promise<void>(r => credentials!.listen(spryPort, '127.0.0.1', r))
    }

    bridge = httpsServer({ cert: readFileSync(cert), key: readFileSync(tlsKey) })
    bridge.on('request', (request, response) => {
      options.onRequest?.({ method: request.method ?? '', path: request.url ?? '', origin: request.headers.origin })
      const target = request.url === '/v1/credentials' ? `http://127.0.0.1:${spryPort}` : desk
      const upstream = httpRequest(target + request.url, { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.on('error', () => upstream.destroy()); request.pipe(upstream)
    })
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
    return { chatOnly: !!options.chatOnly, desk, calls: `http://127.0.0.1:${spryPort}`, websocket: `wss://localhost:${tls.port}/events`, supervisor, ledger, relay, close,
      native: { origin, port: tls.port, certificate: readFileSync(cert, 'utf8') },
      pairing() { const pair = preparePairing(supervisor!); return '#kithmoot-node=' + Buffer.from(JSON.stringify({ v: 1, node: origin, code: pair.code, expiresAt: pair.expiresAt })).toString('base64url') } }
  } catch (error) { await close(); throw error }
}
