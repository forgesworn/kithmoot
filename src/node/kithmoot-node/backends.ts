import { createHmac, createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { NodeRefusal, type DeviceAccess, type NodeRoom } from './ledger.js'

export interface NodeOffer { v: 1; endpoint: string; token: string; expiresAt: number }
export interface SpryState { offer: NodeOffer; revision: number; devices: Record<string, number> }
export interface CallBackend {
  status(): Promise<{ ready: boolean; leaseActive: boolean }>
  offer(room: string): Promise<NodeOffer>
  register(token: string, revision: number, add: string[], remove: string[], expiration?: number): Promise<void>
  remove(token: string): Promise<void>
  lease(): Promise<void>
}
export interface RelayBackend {
  sync(rooms: NodeRoom[], devices: DeviceAccess[]): Promise<void>
  publish(room: string, events: Event[]): Promise<void>
  purge(room: string): Promise<number>
  status(): Promise<{ rooms: number; devices: number; usedBytes: number; leaseActive: boolean }>
}
export class SpryBackend implements CallBackend {
  readonly #pairing: string
  readonly #key: Uint8Array
  readonly #origin: string
  readonly #local: string
  readonly #fetch: typeof fetch
  constructor(options: { local: string; origin: string; key: Uint8Array; turnSecret: string; fetch?: typeof fetch }) {
    const local = new URL(options.local), origin = new URL(options.origin)
    if (local.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(local.hostname) || local.username || local.password || local.pathname !== '/' || local.search || local.hash) throw Error('Spry needs an explicit loopback control URL')
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Spry needs an explicit HTTPS audience')
    this.#local = local.origin; this.#origin = origin.origin; this.#key = options.key; this.#fetch = options.fetch ?? fetch
    this.#pairing = createHmac('sha256', options.turnSecret).update(`spry-supervised-pairing-v1:${getPublicKey(options.key)}`).digest('base64url')
  }
  async #request(path: string, value?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = value ? JSON.stringify(value) : undefined
    const headers: Record<string, string> = {}
    if (body !== undefined) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
        ['u', this.#origin + path], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', randomBytes(32).toString('base64url')],
      ] }, this.#key)
      headers.Authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
      headers['Content-Type'] = 'application/json'
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000)
    try {
      const response = await this.#fetch(this.#local + path, { method: body === undefined ? 'GET' : 'POST', headers, body,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal })
      if (!response.ok) throw new NodeRefusal(503, `spry-http-${response.status}`)
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new NodeRefusal(503, 'spry-invalid-answer')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw Error('oversize'); chunks.push(value) } }
      finally { await reader.cancel().catch(() => {}) }
      const answer: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new NodeRefusal(503, 'spry-invalid-answer')
      return answer as Record<string, unknown>
    } catch (error) { if (error instanceof NodeRefusal) throw error; throw new NodeRefusal(503, 'spry-unavailable') }
    finally { clearTimeout(timer); controller.abort() }
  }
  async status(): Promise<{ ready: boolean; leaseActive: boolean }> {
    const value = await this.#request('/v1/status')
    if (typeof value.ready !== 'boolean' || typeof value.leaseActive !== 'boolean') throw new NodeRefusal(503, 'spry-node-profile-required')
    return { ready: value.ready, leaseActive: value.leaseActive }
  }
  async offer(room: string): Promise<NodeOffer> {
    const value = await this.#request('/v1/grants', { pairing: this.#pairing, scope: room })
    if (value.v !== 1 || value.endpoint !== this.#origin || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() / 1000) throw new NodeRefusal(503, 'spry-invalid-offer')
    return value as unknown as NodeOffer
  }
  async register(token: string, revision: number, add: string[], remove: string[], expiration?: number): Promise<void> {
    await this.#request('/v1/grants/devices', { v: 1, pairing: this.#pairing, grant: token, revision, add, remove, seal: true,
      ...(expiration === undefined ? {} : { expiration }) })
  }
  async remove(token: string): Promise<void> { await this.#request('/v1/grants/remove', { pairing: this.#pairing, grant: token }) }
  async lease(): Promise<void> { await this.#request('/v1/node/lease', { v: 1, pairing: this.#pairing }) }
}

export class ShelterBackend implements RelayBackend {
  constructor(readonly socket: string) {}
  #request(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const client = connect(this.socket), chunks: Buffer[] = []; let bytes = 0, settled = false
      const finish = (error?: Error, value?: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); client.destroy(); if (error) reject(error); else resolve(value!) }
      const timer = setTimeout(() => finish(new NodeRefusal(503, 'shelter-timeout')), 5000)
      client.on('connect', () => client.end(JSON.stringify({ v: 1, ...value })))
      client.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) finish(new NodeRefusal(503, 'shelter-invalid-answer')); else chunks.push(chunk) })
      client.on('error', () => finish(new NodeRefusal(503, 'shelter-unavailable')))
      client.on('end', () => {
        try {
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { v?: number; ok?: boolean; result?: Record<string, unknown> }
          if (answer.v !== 1 || answer.ok !== true || !answer.result || typeof answer.result !== 'object') return finish(new NodeRefusal(503, 'shelter-refused'))
          finish(undefined, answer.result)
        } catch { finish(new NodeRefusal(503, 'shelter-invalid-answer')) }
      })
    })
  }
  async sync(rooms: NodeRoom[], devices: DeviceAccess[]): Promise<void> {
    await this.#request({ op: 'sync', rooms: rooms.map(r => ({ room: r.room, inviter: r.inviter, ends: r.ends ?? null })),
      grants: devices.filter(d => d.read || d.write).map(d => ({ room: d.room, device: d.device, expires: d.expires, read: d.read, write: d.write })) })
  }
  async publish(room: string, events: Event[]): Promise<void> {
    const result = await this.#request({ op: 'publish', room, events })
    const accepted = result.accepted
    if (!Array.isArray(accepted) || events.some(event => !accepted.includes(event.id))) throw new NodeRefusal(503, 'shelter-publish-pending')
  }
  async purge(room: string): Promise<number> {
    const value = await this.#request({ op: 'purge', room })
    if (typeof value.eventsDeleted !== 'number' || !Number.isSafeInteger(value.eventsDeleted) || value.eventsDeleted < 0) throw new NodeRefusal(503, 'shelter-invalid-answer')
    return value.eventsDeleted
  }
  async status(): Promise<{ rooms: number; devices: number; usedBytes: number; leaseActive: boolean }> {
    const value = await this.#request({ op: 'status' })
    if (typeof value.leaseActive !== 'boolean' || [value.rooms, value.devices, value.usedBytes].some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) throw new NodeRefusal(503, 'shelter-invalid-answer')
    return value as unknown as { rooms: number; devices: number; usedBytes: number; leaseActive: boolean }
  }
}
