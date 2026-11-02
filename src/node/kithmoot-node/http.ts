import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { NodeRefusal, type NodeRoom } from './ledger.js'
import { NodeSupervisor, type CloseRequest } from './supervisor.js'

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new NodeRefusal(400, 'invalid-request')
}
/** Only the local CLI creates a code; the daemon never prints pairing secrets. */
export function preparePairing(supervisor: NodeSupervisor): { code: string; expiresAt: number } {
  if (supervisor.ledger.meta('owner')) throw new NodeRefusal(409, 'node-already-paired')
  const code = randomBytes(32).toString('base64url'), expiresAt = supervisor.now() + 360
  supervisor.ledger.setMeta('pairing', JSON.stringify({ digest: digest(code), expiresAt }))
  return { code, expiresAt }
}
export function nodeHttp(supervisor: NodeSupervisor, options: { origin: string; origins: string[]; serviceKey: string }): Server {
  const audience = new URL(options.origin)
  if (audience.protocol !== 'https:' || audience.origin !== options.origin || audience.hostname !== supervisor.host) throw Error('Invalid node HTTPS audience')
  for (const origin of options.origins) { const url = new URL(origin); if (url.origin !== origin || url.protocol !== 'https:') throw Error('Invalid browser origin') }
  const origins = new Set(options.origins), rates = new Map<string, { start: number; count: number }>()
  let requests = 0
  const authenticate = (request: IncomingMessage, path: string, body: Buffer): string => {
    const authorization = request.headers.authorization
    if (!authorization || authorization.length > 12000 || !/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(authorization)) throw new NodeRefusal(401, 'authentication-required')
    let event: Event
    try { event = JSON.parse(Buffer.from(authorization.slice(6), 'base64').toString('utf8')) as Event } catch { throw new NodeRefusal(401, 'invalid-authentication') }
    const now = supervisor.now()
    if (!event || Object.keys(event).length !== 7 || event.kind !== 27235 || event.content !== '' || !Number.isSafeInteger(event.created_at)
      || event.created_at < now - 60 || event.created_at > now + 30 || !Array.isArray(event.tags) || event.tags.length !== 4
      || event.tags.some(t => !Array.isArray(t) || t.length !== 2 || t.some(v => typeof v !== 'string')) || !verifyEvent(event)) throw new NodeRefusal(401, 'invalid-authentication')
    const tags = new Map(event.tags.map(t => [t[0], t[1]]))
    if (tags.size !== 4 || tags.get('u') !== options.origin + path || tags.get('method') !== 'POST'
      || tags.get('payload') !== digest(body) || !/^[A-Za-z0-9_-]{43}$/.test(tags.get('nonce') ?? '')) throw new NodeRefusal(401, 'invalid-authentication')
    supervisor.ledger.consumeNonce(digest(event.pubkey + ':' + tags.get('nonce')), now + 120)
    return event.pubkey
  }
  const dispatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const origin = request.headers.origin
    if (origin) {
      if (!origins.has(origin)) throw new NodeRefusal(403, 'origin-refused')
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST')
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      response.writeHead(204); response.end(); return
    }
    const path = request.url ?? ''
    const reply = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.method === 'GET' && path === '/node/v1/info') return reply({ v: 1, profile: 'kithmoot-node/1', origin: options.origin,
      serviceKey: options.serviceKey, relay: `wss://${audience.host}/events`, files: 'off', calls: 'relay-only' })
    if (request.method === 'GET' && path === '/node/v1/status') return reply(supervisor.status())
    if (request.method !== 'POST' || !['/node/v1/claim', '/node/v1/enrol', '/groups/v1/events', '/node/v1/access', '/node/v1/close', '/node/v1/operation'].includes(path)) throw new NodeRefusal(404, 'not-found')
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) throw new NodeRefusal(415, 'json-required')
    const limit = path === '/groups/v1/events' ? 16384 : path === '/node/v1/close' ? 1024 * 1024 : 65536
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new NodeRefusal(413, 'request-too-large'); chunks.push(Buffer.from(chunk)) }
    const body = Buffer.concat(chunks), actor = authenticate(request, path, body)
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch { throw new NodeRefusal(400, 'invalid-json') }
    const owner = (): void => { if (supervisor.ledger.meta('owner') !== actor) throw new NodeRefusal(403, 'owner-required') }
    switch (path) {
      case '/node/v1/claim': {
        object(value, ['code'])
        if (supervisor.ledger.meta('owner')) throw new NodeRefusal(409, 'node-already-paired')
        const pairing = supervisor.ledger.meta('pairing')
        const state = pairing ? JSON.parse(pairing) as { digest: string; expiresAt: number } : undefined
        if (typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code) || !state || state.expiresAt <= supervisor.now()
          || !timingSafeEqual(Buffer.from(state.digest, 'hex'), Buffer.from(digest(value.code), 'hex'))) throw new NodeRefusal(403, 'pairing-expired')
        supervisor.ledger.claimOwner(actor); supervisor.ledger.setMeta('pairing', '')
        return reply({ paired: true })
      }
      case '/node/v1/enrol': {
        owner(); object(value, ['room', 'authority', 'inviter', 'ends'])
        await supervisor.enrol(value as unknown as NodeRoom); return reply({ enrolled: true })
      }
      case '/groups/v1/events': {
        if (!value || typeof value !== 'object' || (value as Event).pubkey !== actor) throw new NodeRefusal(403, 'room-authority-required')
        return reply(await supervisor.apply(value))
      }
      case '/node/v1/access': {
        object(value, ['room', 'grant'])
        if (typeof value.room !== 'string' || !/^[0-9a-f]{64}$/.test(value.room) || typeof value.grant !== 'string' || !/^[0-9a-f]{32}$/.test(value.grant)) throw new NodeRefusal(400, 'invalid-request')
        const closed = supervisor.ledger.closedProof(value.room)
        if (closed) return reply({ state: 'closed', ...closed })
        const revoked = supervisor.ledger.revocation(value.room, actor, value.grant)
        if (revoked) return reply({ state: 'removed', event: revoked })
        const reset = supervisor.ledger.reset(value.room)
        const grant = supervisor.ledger.active().find(g => g.roomId === value.room && g.device === actor && g.grantId === value.grant)
        if (!grant) {
          if (reset) return reply({ state: 'reset', event: reset })
          throw new NodeRefusal(403, 'access-required')
        }
        return reply({ state: 'active', event: grant.event, ...(grant.scopes.includes('turn') ? { offer: await supervisor.offer(value.room, actor) } : {}) })
      }
      case '/node/v1/close': {
        object(value, ['operation', 'room', 'deadline', 'reset', 'closure', 'events'])
        return reply(await supervisor.close(actor, value as unknown as CloseRequest))
      }
      case '/node/v1/operation': {
        owner(); object(value, ['operation'])
        if (typeof value.operation !== 'string' || !/^[0-9a-f]{32}$/.test(value.operation)) throw new NodeRefusal(400, 'invalid-operation')
        return reply(supervisor.operation(value.operation))
      }
    }
  }
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 }, (request, response) => {
    const peer = request.socket.remoteAddress ?? 'unknown'
    // This server binds only loopback. The TLS proxy must append the actual IP.
    const forwarded = request.headers['x-forwarded-for']
    const source = (typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined) ?? peer
    const now = supervisor.now()
    for (const [key, entry] of rates) if (entry.start + 60 <= now) rates.delete(key)
    const rate = rates.get(source) ?? { start: now, count: 0 }
    const refused = requests >= 32 || rate.count >= 120 || rates.size >= 2048 && !rates.has(source)
    rate.count++; if (!refused) rates.set(source, rate)
    const fail = (error: unknown): void => {
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(error instanceof NodeRefusal ? error.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ error: error instanceof NodeRefusal ? error.code : 'node-unavailable' }))
    }
    if (refused) { fail(new NodeRefusal(429, 'request-limit')); request.resume(); return }
    requests++
    void dispatch(request, response).catch(fail).finally(() => { requests-- })
  })
  server.maxConnections = 128; server.maxHeadersCount = 40; server.keepAliveTimeout = 5000
  return server
}
