import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTurnCredential, hasRelay, liveIceServers, resolveIceServers } from './ice-resolve.js'
import { relayOnlyIceConfiguration } from './relay-only.js'
import { withDeviceStun } from './call-stun.js'

const profile = { urls: ['turns:relay.example:443?transport=tcp'], username: 'temporary-device', credential: 'temporary-password', ttl: 3600 }
const response = (body: unknown = profile) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
afterEach(() => vi.restoreAllMocks())

describe('independent issuer boundary', () => {
  it('sends no cookies, authorisation, referrer, body or room information and refuses redirects', async () => {
    const send = vi.fn(async () => response())
    expect(await fetchTurnCredential('https://issuer.example/turn', { fetch: send })).toEqual({
      urls: profile.urls, username: profile.username, credential: profile.credential,
    })
    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://issuer.example/turn')
    expect(init).toEqual({ signal: expect.any(AbortSignal), credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' })
  })
  for (const endpoint of ['http://issuer.example/turn', '//issuer.example/turn',
    'https://root:secret@issuer.example/turn', 'https://issuer.example/turn?apiKey=secret',
    '/turn#room-key', '/turn?room=secret', '/\\issuer.example/turn', '/turn\n', 'relative/turn', 'x'.repeat(2049)]) {
    it(`refuses an unsafe endpoint before contacting it (${JSON.stringify(endpoint.slice(0, 70))})`, async () => {
      const send = vi.fn(async () => response())
      expect(await fetchTurnCredential(endpoint, { fetch: send })).toBeUndefined()
      expect(send).not.toHaveBeenCalled()
    })
  }
  for (const patch of [{ ttl: undefined }, { ttl: 3599 }, { ttl: 86401 }, { ttl: '3600' }, { ttl: 3600.5 },
    { secret: 'root-key' }, { apiKey: 'account-key' }, { expiresAt: 9999999999 },
    { username: ['not-a-string'] }, { credential: {} }, { urls: ['stun:relay.example:3478'] },
    { urls: ['https://relay.example/'] }, { urls: ['turn:user:password@relay.example:3478'] }]) {
    it(`refuses malformed, master-key or unsupported lease fields (${JSON.stringify(patch)})`, async () => {
      expect(await fetchTurnCredential('/turn', { fetch: async () => response({ ...profile, ...patch }) })).toBeUndefined()
    })
  }
  it('bounds streamed bytes without trusting Content-Length and cancels the reader', async () => {
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16385)) },
      cancel() { canceled = true },
    })
    expect(await fetchTurnCredential('/turn', { fetch: async () => new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': '1' },
    }) })).toBeUndefined()
    expect(canceled).toBe(true)
  })
  it('bounds a stalled response body and cancels it', async () => {
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
    const started = Date.now()
    expect(await fetchTurnCredential('/turn', { fetch: async () => new Response(stream, {
      headers: { 'content-type': 'application/json' },
    }), timeoutMs: 20 })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(canceled).toBe(true)
  })
  it('bounds fetches which ignore abort and never reads their late body', async () => {
    let finish!: (response: Response) => void
    const result = fetchTurnCredential('/turn', { fetch: () => new Promise(resolve => { finish = resolve }), timeoutMs: 20 })
    expect(await result).toBeUndefined()
    const late = response()
    const read = vi.spyOn(late.body!, 'getReader')
    finish(late)
    await Promise.resolve(); await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
  })
  it('does not hand expired credentials to a new relay-only peer after refresh fails', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const options = { endpoint: '/turn', location: { protocol: 'https:', hostname: 'caller.example' } }
    const servers = withDeviceStun(await resolveIceServers([], { ...options, fetch: async () => response() }), ['stun:chosen.example:3478'])
    expect(hasRelay(servers)).toBe(true)
    now += 40 * 60 * 1000
    const failedRefresh = await resolveIceServers([], { ...options, fetch: async () => new Response('', { status: 503 }) })
    expect(() => relayOnlyIceConfiguration(failedRefresh)).toThrow()
    expect(() => relayOnlyIceConfiguration(liveIceServers(servers))).not.toThrow()
    now = 100 + 3600 * 1000
    expect(hasRelay(servers)).toBe(false)
    expect(() => relayOnlyIceConfiguration(liveIceServers(servers))).toThrow()
    expect(liveIceServers(servers).every(server => ![server.urls].flat().some(url => url.startsWith('turn')))).toBe(true)
  })
  it('starts the lease before the request, so network time is not added to validity', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const relay = await fetchTurnCredential('/turn', { fetch: async () => { now = 3000; return response() } })
    expect(relay).toBeDefined()
    now = 3600 * 1000
    expect(liveIceServers([relay!])).toEqual([])
  })
})
