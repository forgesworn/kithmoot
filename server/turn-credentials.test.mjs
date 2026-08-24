import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createTurnServer, createRateLimiter, loadConfigFromEnv } from './turn-credentials.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'turn-credentials.mjs')

/** Starts a server on an ephemeral port and returns its base URL plus a
 *  teardown function. Every test that opens one registers the teardown
 *  with afterEach so a failing assertion never leaks a listening socket
 *  into the next test. */
const teardowns = []
afterEach(async () => {
  while (teardowns.length) {
    const close = teardowns.pop()
    await close()
  }
})

async function startServer(configOverrides = {}) {
  const config = {
    secret: 'test-secret',
    urls: ['turn:turn.example:3478'],
    ttlSeconds: 3600,
    allowedOrigins: ['https://kithmoot.example'],
    rateLimitBurst: 10,
    rateLimitRefillMs: 3000,
    ...configOverrides,
  }
  const server = createTurnServer(config)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  teardowns.push(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${port}`, config }
}

describe('loadConfigFromEnv', () => {
  it('refuses to start without TURN_SECRET', () => {
    expect(() => loadConfigFromEnv({ TURN_URLS: 'turn:x:3478' })).toThrow(/TURN_SECRET/)
  })

  it('refuses to start without TURN_URLS', () => {
    expect(() => loadConfigFromEnv({ TURN_SECRET: 'shh' })).toThrow(/TURN_URLS/)
  })

  it('applies defaults for ttl, port and rate limit knobs', () => {
    const config = loadConfigFromEnv({ TURN_SECRET: 'shh', TURN_URLS: 'turn:x:3478' })
    expect(config.ttlSeconds).toBe(3600)
    expect(config.port).toBe(8089)
    expect(config.host).toBe('127.0.0.1')
    expect(config.allowedOrigins).toEqual([])
  })

  it('parses a comma-separated TURN_URLS and ALLOWED_ORIGINS', () => {
    const config = loadConfigFromEnv({
      TURN_SECRET: 'shh',
      TURN_URLS: 'turn:a:3478, turns:a:5349',
      ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    })
    expect(config.urls).toEqual(['turn:a:3478', 'turns:a:5349'])
    expect(config.allowedOrigins).toEqual(['https://a.example', 'https://b.example'])
  })
})

describe('the process, run directly', () => {
  it('refuses to start with a clear message when TURN_SECRET is unset', () => {
    const env = { ...process.env, TURN_URLS: 'turn:x:3478' }
    delete env.TURN_SECRET
    const result = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/TURN_SECRET/)
  })
})

describe('GET /turn', () => {
  it('returns a well-formed credential whose username expiry is in the future', async () => {
    const { baseUrl } = await startServer({ ttlSeconds: 120 })
    const before = Math.floor(Date.now() / 1000)

    const res = await fetch(`${baseUrl}/turn`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.urls).toEqual(['turn:turn.example:3478'])
    expect(body.ttl).toBe(120)
    expect(typeof body.username).toBe('string')
    expect(typeof body.credential).toBe('string')

    const [expiryStr, name] = body.username.split(':')
    const expiry = Number(expiryStr)
    expect(name).toBe('kithmoot')
    expect(expiry).toBeGreaterThan(before)
    expect(expiry).toBeLessThanOrEqual(before + 120 + 1) // +1s test-runtime slack
  })

  it('mints a credential whose HMAC verifies against the configured secret', async () => {
    const { baseUrl } = await startServer({ secret: 'verify-me' })
    const res = await fetch(`${baseUrl}/turn`)
    const body = await res.json()

    const expected = createHmac('sha1', 'verify-me').update(body.username).digest('base64')
    expect(body.credential).toBe(expected)
  })

  it('never lets the fetch see the secret itself', async () => {
    const { baseUrl } = await startServer({ secret: 'super-secret-value' })
    const res = await fetch(`${baseUrl}/turn`)
    const text = await res.text()
    expect(text).not.toContain('super-secret-value')
  })
})

describe('GET /healthz', () => {
  it('returns 200', async () => {
    const { baseUrl } = await startServer()
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
  })
})

describe('CORS', () => {
  it('allows a listed origin and echoes it back', async () => {
    const { baseUrl } = await startServer({ allowedOrigins: ['https://kithmoot.example'] })
    const res = await fetch(`${baseUrl}/turn`, { headers: { origin: 'https://kithmoot.example' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kithmoot.example')
  })

  it('denies an unlisted origin', async () => {
    const { baseUrl } = await startServer({ allowedOrigins: ['https://kithmoot.example'] })
    const res = await fetch(`${baseUrl}/turn`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('denies every origin by default when ALLOWED_ORIGINS is unset', async () => {
    const { baseUrl } = await startServer({ allowedOrigins: [] })
    const res = await fetch(`${baseUrl}/turn`, { headers: { origin: 'https://anything.example' } })
    expect(res.status).toBe(403)
  })

  it('never sends a wildcard Access-Control-Allow-Origin', async () => {
    const { baseUrl } = await startServer({ allowedOrigins: ['https://kithmoot.example'] })
    const res = await fetch(`${baseUrl}/turn`, { headers: { origin: 'https://kithmoot.example' } })
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('proceeds without CORS headers for a same-origin/non-browser request with no Origin header', async () => {
    const { baseUrl } = await startServer({ allowedOrigins: ['https://kithmoot.example'] })
    const res = await fetch(`${baseUrl}/turn`)
    expect(res.status).toBe(200)
  })
})

describe('rate limiting', () => {
  it('allows a burst then rejects, and recovers as tokens refill', async () => {
    const { baseUrl } = await startServer({ rateLimitBurst: 3, rateLimitRefillMs: 50 })

    const first = await Promise.all([fetch(`${baseUrl}/turn`), fetch(`${baseUrl}/turn`), fetch(`${baseUrl}/turn`)])
    for (const res of first) expect(res.status).toBe(200)

    const limited = await fetch(`${baseUrl}/turn`)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 120))
    const recovered = await fetch(`${baseUrl}/turn`)
    expect(recovered.status).toBe(200)
  })
})

describe('createRateLimiter', () => {
  it('rejects the (capacity + 1)th request from the same key within the window', () => {
    const limiter = createRateLimiter({ capacity: 5, refillMs: 60_000 })
    const results = Array.from({ length: 6 }, () => limiter.allow('1.2.3.4'))
    expect(results).toEqual([true, true, true, true, true, false])
  })

  it('tracks buckets independently per key', () => {
    const limiter = createRateLimiter({ capacity: 1, refillMs: 60_000 })
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('b')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
  })

  it('prune() drops buckets older than maxAgeMs', async () => {
    const limiter = createRateLimiter({ capacity: 1, refillMs: 60_000 })
    limiter.allow('stale')
    expect(limiter.size()).toBe(1)
    // A bucket touched in the same millisecond as prune()'s own Date.now()
    // call is not, strictly, older than a 0ms cutoff - wait a tick so the
    // "older than" comparison is unambiguous under a loaded test runner.
    await new Promise((resolve) => setTimeout(resolve, 5))
    limiter.prune(0)
    expect(limiter.size()).toBe(0)
  })
})

describe('method and path handling', () => {
  it('404s an unknown path', async () => {
    const { baseUrl } = await startServer()
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  it('405s a POST to /turn', async () => {
    const { baseUrl } = await startServer()
    const res = await fetch(`${baseUrl}/turn`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
