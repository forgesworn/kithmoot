import { createServer as tlsServer, createSecureContext, type SecureContextOptions, type TLSSocket } from 'node:tls'
import { createServer as httpServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { connect, isIPv4, type Socket } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { isHostName } from '../../group-grants.js'

export interface NodeFrontRoutes { host: string; relayIp: string; deskPort: number; spryPort: number; shelterPort: number }
type Certificate = Pick<SecureContextOptions, 'cert' | 'key'>
const methods = new Map<string, readonly string[]>([
  ['/node/v1/info', ['GET', 'OPTIONS']], ['/node/v1/status', ['GET', 'POST', 'OPTIONS']],
  ...['/node/v1/claim', '/node/v1/enrol', '/groups/v1/events', '/node/v1/access', '/node/v1/close', '/node/v1/operation', '/v1/credentials'].map(path => [path, ['POST', 'OPTIONS']] as const),
])
const requestHeaders = ['authorization', 'content-type', 'origin', 'access-control-request-method', 'access-control-request-headers']
const responseHeaders = ['content-type', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'vary', 'retry-after']

/** One TLS listener, using Node's TLS parser rather than parsing ClientHello.
 * The TURN hostname terminates TLS and carries opaque TURN to the local Spry
 * TCP listener. HTTPS/WSS can reach only the explicit room-profile routes.
 * No service identities, TURN secrets, room keys or request logs live here. */
export function createNodeFront(routes: NodeFrontRoutes, certificate: Certificate, fixture: { turnPort?: number } = {}) {
  const { host } = routes
  if (!isHostName(host) || host !== host.toLowerCase() || !host.includes('.') || host.endsWith('.local') || !isIPv4(routes.relayIp)
    || ![routes.deskPort, routes.spryPort, routes.shelterPort, fixture.turnPort ?? 3478].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) throw Error('Invalid node front routes')
  const turnHost = `turn.${host}`
  const validate = (value: Certificate) => {
    if (typeof value.cert !== 'string' && !Buffer.isBuffer(value.cert)) throw Error('Invalid node certificate')
    const leaf = new X509Certificate(value.cert)
    if (!leaf.checkHost(host) || !leaf.checkHost(turnHost) || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw Error('Node certificate must cover both hostnames and be current')
    return createSecureContext({ ...value, minVersion: 'TLSv1.2' })
  }
  let context = validate(certificate), closing = false, requests = 0
  const sockets = new Set<Socket>()
  const track = <T extends Socket>(socket: T): T => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket
  }
  const headers = (request: IncomingMessage, upgrade = false): OutgoingHttpHeaders => {
    const result: OutgoingHttpHeaders = { host, 'x-forwarded-for': request.socket.remoteAddress ?? 'unknown' }
    for (const key of requestHeaders) if (request.headers[key] !== undefined) result[key] = request.headers[key]
    if (upgrade) {
      result.connection = 'Upgrade'; result.upgrade = 'websocket'
      for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) if (request.headers[key] !== undefined) result[key] = request.headers[key]
    }
    return result
  }
  const permitted = (request: IncomingMessage): boolean => {
    const socket = request.socket as TLSSocket
    return !closing && socket.servername === host && [host, `${host}:443`].includes(request.headers.host ?? '')
      && !request.headers.cookie && !request.headers['content-encoding'] && !request.headers['proxy-authorization']
  }
  const http = httpServer({ maxHeaderSize: 16384, headersTimeout: 5000, requestTimeout: 15000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store'); response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('x-content-type-options', 'nosniff')
    const fail = (status: number): void => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) response.writeHead(status, { connection: 'close' }); response.end(); request.resume() }
    const path = request.url ?? ''
    if (!permitted(request)) return fail(421)
    if (!methods.get(path)?.includes(request.method ?? '')) return fail(404)
    if (requests >= 16) return fail(503)
    requests++
    try {
      const limit = path === '/node/v1/close' ? 1048576 : path === '/groups/v1/events' ? 16384 : 65536
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) { fail(413); return }; chunks.push(Buffer.from(chunk)) }
      const body = Buffer.concat(chunks), forwarded = headers(request)
      forwarded['content-length'] = body.length
      await new Promise<void>(resolve => {
        let finished = false
        const done = () => { if (!finished) { finished = true; resolve() } }
        const upstream = httpRequest({ host: '127.0.0.1', port: path === '/v1/credentials' ? routes.spryPort : routes.deskPort,
          path, method: request.method, headers: forwarded, agent: false, timeout: 10000, maxHeaderSize: 16384 }, reply => {
          const pieces: Buffer[] = []; let size = 0
          reply.on('data', chunk => { size += chunk.length; if (size > 65536) { upstream.destroy(); fail(502); done() } else pieces.push(Buffer.from(chunk)) })
          reply.once('error', () => { fail(502); done() })
          reply.once('end', () => {
            if (finished) return
            for (const key of responseHeaders) if (reply.headers[key] !== undefined) response.setHeader(key, reply.headers[key]!)
            response.writeHead(reply.statusCode ?? 502); response.end(Buffer.concat(pieces)); done()
          })
        })
        upstream.once('timeout', () => upstream.destroy()); upstream.once('error', () => { fail(502); done() })
        response.once('close', () => { upstream.destroy(); done() }); upstream.end(body)
      })
    } catch { fail(400) } finally { requests-- }
  })
  http.keepAliveTimeout = 5000; http.maxRequestsPerSocket = 100
  http.on('clientError', (_, socket) => socket.destroy())
  http.on('upgrade', (request, rawSocket, head) => {
    const socket = rawSocket as Socket
    if (!permitted(request) || request.method !== 'GET' || request.url !== '/events' || request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return }
    const upstream = httpRequest({ host: '127.0.0.1', port: routes.shelterPort, path: '/events', method: 'GET', headers: headers(request, true), timeout: 5000, maxHeaderSize: 16384 })
    upstream.once('upgrade', (response, peer, first) => {
      track(peer)
      let reply = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      for (const key of ['sec-websocket-accept', 'sec-websocket-protocol']) if (typeof response.headers[key] === 'string') reply += `${key}: ${response.headers[key]}\r\n`
      socket.write(reply + '\r\n'); if (first.length) socket.write(first); if (head.length) peer.write(head)
      peer.setTimeout(120000, () => peer.destroy()); socket.setTimeout(120000, () => socket.destroy())
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy()); peer.pipe(socket); socket.pipe(peer)
    })
    upstream.once('response', response => { response.resume(); socket.destroy() })
    upstream.once('timeout', () => upstream.destroy()); upstream.once('error', () => socket.destroy()); socket.once('close', () => upstream.destroy()); upstream.end()
  })
  const server = tlsServer({ ...certificate, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1', 'stun.turn'], handshakeTimeout: 5000,
    SNICallback(name, callback) { callback(name === host || name === turnHost ? null : Error('Unknown node hostname'), context) },
  }, socket => {
    if (closing || ![host, turnHost].includes(socket.servername || '')) { socket.destroy(); return }
    socket.setTimeout(120000, () => socket.destroy())
    if (socket.servername === host) { http.emit('connection', socket); return }
    const peer = track(connect(fixture.turnPort ?? 3478, routes.relayIp))
    peer.setTimeout(120000, () => peer.destroy()); socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy())
    peer.pipe(socket); socket.pipe(peer)
  })
  server.maxConnections = 256
  server.on('connection', socket => { track(socket); if (closing) socket.destroy() })
  server.on('tlsClientError', (_, socket) => socket.destroy())
  return {
    server,
    reload(value: Certificate) { const next = validate(value); server.setSecureContext({ ...value, minVersion: 'TLSv1.2' }); context = next },
    async close() { if (closing) return; closing = true; for (const socket of sockets) socket.destroy(); http.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
