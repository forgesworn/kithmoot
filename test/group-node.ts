import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import type { Event } from 'nostr-tools/pure'
import { parseGroupEvent, type GrantScope, type ParsedGrant } from '../src/group-grants.js'
import { verifyEventUncached } from '../src/verify.js'

/**
 * A group node as the web app meets it, small enough to read: the rules of
 * `wildbloomd` group mode (profile `group-grants/1`) that a client can observe,
 * and no more.
 *
 * - A read without a token is `401` whether or not the blob exists (6.2).
 *   `open` turns this into a node that serves any read, to prove the app
 *   refuses one.
 * - `POST /groups/v1/events` takes the keeper's grants, revocations and resets,
 *   judged by the same parser the keeper uses (`parseGroupEvent`) against the
 *   authority it was started with.
 * - `PUT /upload`, `GET`, `HEAD` and `DELETE` need one kind 24242 token each:
 *   `t`, `expiration`, `server`, `x`, signed by a device that holds an active
 *   grant for that verb here, not yet spent if it is a delete.
 * - Answers carry the CORS headers a browser needs to read them, and say why in
 *   `X-Reason`.
 *
 * It listens on loopback HTTP, and answers as `https://<host>`: the app and the
 * keeper both address it by its name, the page through Playwright's routing
 * (`routeGroupNode`) and the keeper through `fetch`.
 */

export interface GroupNodeHit { method: string; path: string; token: boolean; status: number; reason?: string }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, content-length, range, x-sha-256, x-content-length, x-content-type',
  // `date` is not in wildbloomd's list (`x-reason, content-range, content-length`), and a browser cannot read it cross-origin
  // unless it is exposed: without it a device cannot tell a wrong clock from a refusal. Exposed here so the app's handling can be driven.
  'access-control-expose-headers': 'x-reason, content-range, content-length, date',
}

interface Blob { bytes: Buffer; uploaders: Set<string> }

export class GroupNodeServer {
  readonly hits: GroupNodeHit[] = []
  readonly blobs = new Map<string, Blob>()
  readonly #grants = new Map<string, ParsedGrant>()
  readonly #revoked = new Set<string>()
  readonly #floor: { at: number } = { at: 0 }
  readonly #spent = new Set<string>()
  #server?: Server
  #port = 0
  /** Serve any read, as a node that is not in group mode does. */
  open = false
  /** Answer every request `503`, as a node that is down or overloaded does. */
  down = false
  /** This node's clock is this many seconds ahead of the world's, and its `Date` says so: tokens look expired to it and the device is told its clock is wrong. */
  skew = 0
  /** Do not take the keeper's events (a node the keeper has not reached yet). */
  refuseEvents = false

  /** Hold every `PUT /upload` this long before answering, so a screenshot can catch an upload in flight. */
  uploadDelayMs = 0

  /** `authority` is whoever signs this node's grants: set it once the keeper exists. */
  constructor(readonly host: string, public authority: string) {}

  get origin(): string { return `https://${this.host}` }
  get port(): number { return this.#port }

  static async start(host: string, authority = ''): Promise<GroupNodeServer> {
    const node = new GroupNodeServer(host, authority)
    node.#server = createServer((req, res) => { void node.#serve(req, res) })
    await new Promise<void>((resolve) => node.#server!.listen(0, '127.0.0.1', resolve))
    node.#port = (node.#server!.address() as AddressInfo).port
    return node
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server) await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  }

  /** The keeper's HTTP client: `https://<host>/...` is this server. */
  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== this.origin) throw new TypeError('fetch failed')
    return fetch(`http://127.0.0.1:${this.#port}${url.pathname}${url.search}`, init)
  }) as typeof fetch

  /** Active grants a device holds here, for the test to look at. */
  grantsOf(device: string): ParsedGrant[] {
    return [...this.#grants.values()].filter((g) => g.device === device && !this.#revoked.has(g.grantId))
  }

  hitsTo(method: string): GroupNodeHit[] { return this.hits.filter((h) => h.method === method) }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const path = (req.url ?? '/').split('?')[0]!
    const method = req.method ?? 'GET'
    const auth = req.headers.authorization
    const [status, headers, payload, reason] = this.#answer(method, path, auth, req.headers, body)
    if (method === 'PUT' && this.uploadDelayMs) await new Promise((resolve) => setTimeout(resolve, this.uploadDelayMs))
    this.hits.push({ method, path, token: auth !== undefined, status, ...(reason ? { reason } : {}) })
    res.writeHead(status, { ...CORS, date: new Date((Date.now() / 1000 + this.skew) * 1000).toUTCString(), ...(reason ? { 'x-reason': reason } : {}), ...headers })
    res.end(method === 'HEAD' ? undefined : payload)
  }

  #answer(method: string, path: string, auth: string | undefined, headers: IncomingMessage['headers'], body: Buffer): [number, Record<string, string>, Buffer | string | undefined, string?] {
    const now = Math.floor(Date.now() / 1000) + this.skew
    if (method === 'OPTIONS') return [204, {}, undefined]
    if (this.down) return [503, {}, undefined, 'busy']
    if (method === 'POST' && path === '/groups/v1/events') return this.#takeEvent(body, now)
    const hash = /^\/([0-9a-f]{64})$/.exec(path)?.[1]
    if (method === 'PUT' && path === '/upload') return this.#upload(auth, headers, body, now)
    if (!hash) return [404, {}, undefined, 'not-found']
    if ((method === 'GET' || method === 'HEAD') && !auth) {
      if (!this.open) return [401, {}, undefined, 'missing']
      const held = this.blobs.get(hash)
      return held ? [200, { 'content-length': String(held.bytes.length) }, held.bytes] : [404, {}, undefined]
    }
    const verb = method === 'DELETE' ? 'delete' : 'get'
    const token = this.#token(auth, verb, hash, now)
    if (typeof token === 'string') return [token === 'not-granted' || token === 'scope' ? 403 : 401, {}, undefined, token]
    if (method === 'DELETE') {
      if (this.#spent.has(token.id)) return [409, {}, undefined, 'spent']
      this.#spent.add(token.id)
      const held = this.blobs.get(hash)
      if (!held?.uploaders.has(token.pubkey)) return [404, {}, undefined]
      this.blobs.delete(hash)
      return [204, {}, undefined]
    }
    const held = this.blobs.get(hash)
    if (!held) return [404, {}, undefined]
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(headers.range ?? ''))
    if (range && method === 'GET') {
      const part = held.bytes.subarray(Number(range[1]), Number(range[2]) + 1)
      return [206, { 'content-range': `bytes ${range[1]}-${range[2]}/${held.bytes.length}`, 'content-length': String(part.length) }, part]
    }
    return [200, { 'content-length': String(held.bytes.length), 'content-type': 'application/octet-stream' }, held.bytes]
  }

  #takeEvent(body: Buffer, now: number): [number, Record<string, string>, string | undefined, string?] {
    if (this.refuseEvents) return [503, {}, undefined, 'busy']
    let event: unknown
    try { event = JSON.parse(body.toString('utf8')) } catch { return [400, {}, undefined, 'malformed'] }
    const verdict = parseGroupEvent(event, { now, keepers: [this.authority], servers: [this.host] })
    if (!verdict.ok) return [verdict.status, {}, undefined, verdict.reason]
    const p = verdict.parsed
    if (p.type === 'reset') {
      if (p.createdAt <= this.#floor.at) return [409, {}, undefined, 'stale']
      this.#floor.at = p.createdAt
      for (const g of this.#grants.values()) if (g.createdAt <= p.createdAt) this.#revoked.add(g.grantId)
      return [201, {}, JSON.stringify({ state: 'accepted' })]
    }
    if (p.status === 'revoked') { this.#revoked.add(p.grantId); return [201, {}, JSON.stringify({ state: 'revoked' })] }
    if (p.createdAt <= this.#floor.at) return [409, {}, undefined, 'stale']
    const held = this.#grants.get(p.grantId)
    if (held && held.event.id === p.event.id) return [200, {}, JSON.stringify({ state: 'unchanged' })]
    this.#grants.set(p.grantId, p)
    return [201, {}, JSON.stringify({ state: 'active' })]
  }

  /** The token's problem, or the verified event. */
  #token(auth: string | undefined, verb: GrantScope, hash: string, now: number): Event | string {
    if (!auth?.startsWith('Nostr ')) return 'missing'
    let token: Event
    try { token = JSON.parse(Buffer.from(auth.slice(6), 'base64').toString('utf8')) as Event } catch { return 'malformed' }
    const tag = (name: string): string | undefined => token.tags?.find((t) => t[0] === name)?.[1]
    if (token.kind !== 24242 || !verifyEventUncached(token)) return 'signature'
    if (tag('t') !== verb || tag('x') !== hash || tag('server') !== this.host) return 'malformed'
    const expiration = Number(tag('expiration'))
    if (!Number.isFinite(expiration) || expiration <= now) return 'expired'
    if (token.created_at > now + 5) return 'future'
    // A delete may be kept for a week (604,801 s); any other token is short.
    if (expiration - token.created_at > (verb === 'delete' ? 604_801 : 600)) return 'lifetime'
    const scope = verb === 'upload' ? 'upload' : verb
    const held = [...this.#grants.values()].some((g) => g.device === token.pubkey && !this.#revoked.has(g.grantId) && g.expiration > now && g.scopes.includes(scope))
    // A removed device keeps its delete permission for a week but cannot read.
    const kept = verb === 'delete' && [...this.#grants.values()].some((g) => g.device === token.pubkey && g.scopes.includes('delete') && g.expiration + 7 * 86_400 > now)
    return held || kept ? token : 'not-granted'
  }

  #upload(auth: string | undefined, headers: IncomingMessage['headers'], body: Buffer, now: number): [number, Record<string, string>, string | undefined, string?] {
    const hash = createHash('sha256').update(body).digest('hex')
    if (headers['x-sha-256'] !== hash) return [400, {}, undefined, 'hash-mismatch']
    const token = this.#token(auth, 'upload', hash, now)
    if (typeof token === 'string') return [token === 'not-granted' ? 403 : 401, {}, undefined, token]
    const held = this.blobs.get(hash) ?? { bytes: body, uploaders: new Set<string>() }
    held.uploaders.add(token.pubkey)
    this.blobs.set(hash, held)
    return [201, { 'content-type': 'application/json' }, JSON.stringify({ url: `${this.origin}/${hash}`, sha256: hash, size: body.length, type: 'application/octet-stream', uploaded: now })]
  }
}

/**
 * The page's requests to a node's name are answered by the node: Playwright
 * forwards each, body and headers intact, to the local server, which answers as
 * the node would. Anything else addressed to that origin cannot happen.
 */
export async function routeGroupNode(context: BrowserContext, node: GroupNodeServer): Promise<void> {
  await context.route((url) => url.origin === node.origin, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    try {
      const response = await route.fetch({ url: `http://127.0.0.1:${node.port}${url.pathname}${url.search}`, headers: { ...request.headers(), origin: 'https://localhost' } })
      await route.fulfill({ response })
    } catch {
      // The page gave up on the request (an upload it stopped), or the context closed: the node's answer has nowhere to go.
      await route.abort().catch(() => {})
    }
  })
}
