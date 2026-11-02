import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServer as tcpServer, type Server as NetServer } from 'node:net'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'
import { createNodeFront } from './front.js'

let directory: string, cert: Buffer, key: Buffer
let front: ReturnType<typeof createNodeFront>, frontPort: number
const servers: (NetServer | HttpServer)[] = [], sockets: TLSSocket[] = []
const received: { backend: string; path: string; body: Buffer; headers: Record<string, unknown> }[] = []
let websocketServer: WebSocketServer
const listen = async (server: NetServer | HttpServer): Promise<number> => {
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('test listener'); return address.port
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'kithmoot-front-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=node.example',
    '-addext', 'subjectAltName=DNS:node.example,DNS:turn.node.example', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  cert = readFileSync(join(directory, 'cert')); key = readFileSync(join(directory, 'key'))
  const backend = async (name: string) => listen(httpServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.once('end', () => {
      received.push({ backend: name, path: req.url!, body: Buffer.concat(chunks), headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'must-not-leave-backend=1', 'access-control-allow-origin': 'https://app.example' })
      res.end(JSON.stringify({ backend: name }))
    })
  }))
  const deskPort = await backend('desk'), spryPort = await backend('spry')
  const relay = httpServer(); websocketServer = new WebSocketServer({ server: relay, path: '/events' })
  websocketServer.on('connection', ws => ws.on('message', data => ws.send(data)))
  const shelterPort = await listen(relay)
  const turnPort = await listen(tcpServer(socket => socket.pipe(socket)))
  front = createNodeFront({ host: 'node.example', relayIp: '127.0.0.1', deskPort, spryPort, shelterPort }, { cert, key }, { turnPort })
  await new Promise<void>(r => front.server.listen(0, '127.0.0.1', r)); const address = front.server.address()
  if (!address || typeof address === 'string') throw Error('front listener'); frontPort = address.port
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await front?.close()
  websocketServer?.clients.forEach(ws => ws.terminate()); websocketServer?.close()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(r => server.close(() => r()))))
  received.length = 0; if (directory) rmSync(directory, { force: true, recursive: true })
})
function request(path: string, options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: frontPort, servername: 'node.example', ca: cert, path,
      method: options.method ?? 'GET', headers: { host: 'node.example', ...options.headers }, agent: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }))
    })
    req.once('error', reject); req.end(options.body)
  })
}
it('keeps exact signed HTTP bodies and public audience while hiding proxy-only registrar paths and cookies', async () => {
  const body = Buffer.from('{"grant":"public-test-token"}')
  const answer = await request('/v1/credentials', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: 'Nostr public-test-proof', 'x-forwarded-for': 'forged-client' } })
  expect(answer.status).toBe(200); expect(answer.body).toBe('{"backend":"spry"}')
  expect(answer.headers['set-cookie']).toBeUndefined(); expect(answer.headers['cache-control']).toBe('no-store')
  expect(received[0]).toMatchObject({ backend: 'spry', path: '/v1/credentials', body, headers: { host: 'node.example', authorization: 'Nostr public-test-proof' } })
  expect(received[0].headers['x-forwarded-for']).not.toContain('forged-client')
  await request('/node/v1/claim', { method: 'POST', body: Buffer.from('{}'), headers: { 'content-type': 'application/json' } })
  expect(received[1].backend).toBe('desk')
  expect((await request('/node/v1/status', { method: 'POST', body: Buffer.from('{}'), headers: { 'content-type': 'application/json' } })).status).toBe(200)
  expect(received[2].backend).toBe('desk')
  for (const path of ['/v1/pairings', '/v1/grants/devices', '/node/v1/status?extra=1', 'https://other.example/node/v1/info']) expect((await request(path)).status).toBe(404)
  expect((await request('/node/v1/info', { headers: { cookie: 'tracking=1' } })).status).toBe(421)
  expect((await request('/node/v1/info', { headers: { host: 'other.example' } })).status).toBe(421)
  expect(received).toHaveLength(3)
})
it('carries binary TURN over trusted TLS on the TURN hostname, including TURN ALPN', async () => {
  for (const alpn of [undefined, ['stun.turn']]) {
    const socket = tlsConnect({ host: '127.0.0.1', port: frontPort, servername: 'turn.node.example', ca: cert, ALPNProtocols: alpn }); sockets.push(socket)
    await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
    expect(socket.authorized).toBe(true); if (alpn) expect(socket.alpnProtocol).toBe('stun.turn')
    const payload = Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42, 0xff, 0, 0x80])
    const data = new Promise<Buffer>((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject) })
    socket.write(payload); expect(await data).toEqual(payload); socket.destroy()
  }
  expect(received).toHaveLength(0)
})
it('upgrades only the room WebSocket door and transports opaque frames', async () => {
  const options = { servername: 'node.example', ca: cert, headers: { host: 'node.example' } }
  const ws = new WebSocket(`wss://127.0.0.1:${frontPort}/events`, options)
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const echoed = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString())))
    ws.send('["REQ","public-test",{"kinds":[1059]}]'); expect(await echoed).toBe('["REQ","public-test",{"kinds":[1059]}]')
  } finally { ws.terminate() }
  const bad = new WebSocket(`wss://127.0.0.1:${frontPort}/v1/pairings`, options)
  await new Promise<void>(resolve => { bad.once('error', () => resolve()); bad.once('open', () => { bad.terminate(); throw Error('Private route upgraded') }) })
})
it('refuses unknown SNI and safely keeps the current certificate when reload is invalid', async () => {
  const socket = tlsConnect({ host: '127.0.0.1', port: frontPort, servername: 'other.example', ca: cert }); sockets.push(socket)
  await expect(new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })).rejects.toThrow()
  expect(() => front.reload({ cert: 'invalid', key })).toThrow()
  expect((await request('/node/v1/info')).status).toBe(200)
  expect(() => createNodeFront({ host: 'NODE.example', relayIp: '127.0.0.1', deskPort: 1, spryPort: 2, shelterPort: 3 }, { cert, key })).toThrow()
})
