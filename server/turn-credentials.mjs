#!/usr/bin/env node
// TURN credential minting service for KithMoot's default TURN server.
//
// `deploy/coturn/turnserver.conf` is configured for coturn's REST-style
// time-limited credentials (`use-auth-secret`), and `src/turn.ts` implements
// the HMAC-SHA1 scheme those credentials need - but nothing served that to
// a browser (see `deploy/README.md`, "What's out of scope here"). This is
// that missing piece: a small, dependency-light HTTP service that hands a
// browser a fresh, short-lived {urls, username, credential, ttl} on
// request, ready to drop into an RTCPeerConnection's iceServers.
//
// This file is Node-only server code - it never ships to the browser (unlike
// src/), so unlike src/ it is fine for it to use Buffer or other Node
// builtins where that is genuinely simpler. It deliberately stays plain
// JavaScript with no build step of its own, so a checkout can run it with
// nothing but `node server/turn-credentials.mjs` (after `npm run build:lib`,
// see below, and with TURN_SECRET set).
//
// SECURITY NOTE, read before deploying this: GET /turn is, as shipped,
// unauthenticated - anyone who can reach this URL can mint a working TURN
// credential and relay real media traffic through the coturn server at this
// operator's bandwidth cost. CORS (below) stops a browser script running on
// another site from reading the response, and the rate limiter (below)
// slows down casual, single-source abuse - neither is a substitute for
// actually gating access. See deploy/README.md for the honest options.

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
// Imported from the built library, not src/turn.ts directly - this file has
// no TypeScript build step of its own, and re-deriving the HMAC here would
// be exactly the "reimplement it a second time" mistake mintTurnCredential
// exists to avoid. Run `npm run build:lib` (tsc) before starting this
// service; that produces dist/src/turn.js from src/turn.ts. dist/ is
// gitignored, so this is a deploy-time step, not a one-off - do it after
// every pull, or wire it into whatever restarts this service.
import { mintTurnCredential } from '../dist/src/turn.js'

const DEFAULT_PORT = 8089
const DEFAULT_HOST = '127.0.0.1' // sits behind Caddy on the same box - see deploy/Caddyfile.kithmoot
const DEFAULT_TTL_SECONDS = 3600
const DEFAULT_RATE_LIMIT_BURST = 10
const DEFAULT_RATE_LIMIT_REFILL_MS = 3000 // one token every 3s once the burst is spent -> ~20/min sustained

/**
 * Reads and validates configuration from the environment. Throws with a
 * clear, specific message on anything that would make the service unsafe or
 * useless to start - most importantly, an unset TURN_SECRET. There is no
 * fallback secret: a default here would either mint credentials no real
 * coturn accepts, or - worse - become a secret every deployment of this
 * file quietly shares.
 */
export function loadConfigFromEnv(env = process.env) {
  const secret = env.TURN_SECRET
  if (!secret) {
    throw new Error(
      'TURN_SECRET is not set - refusing to start. Generate one with ' +
        '`openssl rand -hex 32`, put the same value in static-auth-secret ' +
        'in deploy/coturn/turnserver.conf, and set TURN_SECRET in this ' +
        "service's EnvironmentFile (see deploy/turn-credentials.service " +
        'and deploy/README.md). There is no default secret on purpose.',
    )
  }

  const urls = splitCsv(env.TURN_URLS)
  if (urls.length === 0) {
    throw new Error(
      'TURN_URLS is not set - at least one turn: (or turns:) URL is ' +
        'required, comma-separated for more than one, e.g. ' +
        '"turn:turn.kithmoot.example:3478,turns:turn.kithmoot.example:5349".',
    )
  }

  const ttlSeconds = env.TURN_TTL_SECONDS ? Number(env.TURN_TTL_SECONDS) : DEFAULT_TTL_SECONDS
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`TURN_TTL_SECONDS must be a positive number of seconds, got "${env.TURN_TTL_SECONDS}".`)
  }

  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}".`)
  }

  const host = env.HOST || DEFAULT_HOST
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS)

  const rateLimitBurst = env.RATE_LIMIT_BURST ? Number(env.RATE_LIMIT_BURST) : DEFAULT_RATE_LIMIT_BURST
  const rateLimitRefillMs = env.RATE_LIMIT_REFILL_MS
    ? Number(env.RATE_LIMIT_REFILL_MS)
    : DEFAULT_RATE_LIMIT_REFILL_MS

  return { secret, urls, ttlSeconds, port, host, allowedOrigins, rateLimitBurst, rateLimitRefillMs }
}

function splitCsv(raw) {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * A simple in-memory per-IP token bucket.
 *
 * This resets to full capacity every time the process restarts, and each
 * instance keeps its own counters - so behind more than one instance (a
 * load balancer, a crash-restart loop) an attacker's real effective rate is
 * capacity x instances, not the configured burst. Treat this as a speed
 * bump against casual, single-source abuse, not a control anything
 * important depends on. See deploy/README.md for what an actual control
 * looks like.
 */
export function createRateLimiter({ capacity = DEFAULT_RATE_LIMIT_BURST, refillMs = DEFAULT_RATE_LIMIT_REFILL_MS } = {}) {
  const buckets = new Map() // ip -> { tokens, last }

  return {
    allow(ip) {
      const now = Date.now()
      const bucket = buckets.get(ip) ?? { tokens: capacity, last: now }
      const elapsed = now - bucket.last
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed / refillMs)
      bucket.last = now
      if (bucket.tokens < 1) {
        buckets.set(ip, bucket)
        return false
      }
      bucket.tokens -= 1
      buckets.set(ip, bucket)
      return true
    },
    size() {
      return buckets.size
    },
    // Best-effort memory bound for the per-IP map - see createTurnServer,
    // which calls this on a timer. Not required for correctness, only so a
    // long-running process doesn't accumulate one entry per IP forever.
    prune(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs
      for (const [ip, bucket] of buckets) {
        if (bucket.last < cutoff) buckets.delete(ip)
      }
    },
  }
}

// Caddy (see deploy/Caddyfile.kithmoot) is the only thing that talks to
// this service - it binds to 127.0.0.1 by default - so the last hop in
// X-Forwarded-For is the one Caddy itself appended, and is trustworthy in a
// way an attacker-supplied leading entry is not. Falls back to the raw
// socket address if the header is absent (e.g. a direct request in dev).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

/**
 * Applies CORS to a response. Returns true if the request may proceed.
 *
 * A request with no Origin header is not a cross-origin browser request
 * (a same-origin fetch, curl, or another server) - nothing to allow or
 * deny, so it proceeds without CORS headers. A request carrying an Origin
 * that is not in allowedOrigins is refused outright (403), not merely sent
 * back without an Access-Control-Allow-Origin header - the latter is what
 * CORS technically requires (it only ever governs whether a *browser*
 * lets its own script read the response), but this is the one place that
 * distinction should not be relied on: a disallowed Origin is the one
 * signal available that a browser page other than this app's own is
 * trying to use it, and there is no reason to do the work of minting a
 * credential for that. A caller that omits Origin entirely bypasses this
 * regardless (see the CORS honesty note in deploy/README.md) - this is a
 * real limit of CORS, not a bug here.
 */
function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin
  if (!origin) return true
  if (!allowedOrigins.includes(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  return true
}

function handleRequest(req, res, config, rateLimiter) {
  const url = new URL(req.url, 'http://internal')

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  if (url.pathname !== '/turn') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  if (!applyCors(req, res, config.allowedOrigins)) {
    sendJson(res, 403, { error: 'origin not allowed' })
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, HEAD, OPTIONS' })
    res.end()
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, OPTIONS' })
    return
  }

  if (!rateLimiter.allow(clientIp(req))) {
    sendJson(res, 429, { error: 'rate limit exceeded' }, { 'retry-after': '1' })
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const { username, credential } = mintTurnCredential(config.secret, config.ttlSeconds, now)
  const body = { urls: config.urls, username, credential, ttl: config.ttlSeconds }

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Builds an http.Server for the given config. Does not call listen() -
 * callers (main() below, or a test) decide when and where it binds.
 */
export function createTurnServer(config) {
  const rateLimiter =
    config.rateLimiter ?? createRateLimiter({ capacity: config.rateLimitBurst, refillMs: config.rateLimitRefillMs })

  // unref'd so a bare prune timer never keeps the process (or a test) alive
  // on its own.
  const pruneTimer = setInterval(() => rateLimiter.prune(10 * 60 * 1000), 5 * 60 * 1000)
  pruneTimer.unref()

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res, config, rateLimiter)
    } catch (err) {
      console.error('turn-credentials: unhandled request error -', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  })
  server.on('close', () => clearInterval(pruneTimer))
  return server
}

function isMainModule() {
  const entry = process.argv[1]
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href
}

function main() {
  let config
  try {
    config = loadConfigFromEnv(process.env)
  } catch (err) {
    console.error(`turn-credentials: ${err.message}`)
    process.exitCode = 1
    return
  }

  const server = createTurnServer(config)
  server.on('error', (err) => {
    console.error(`turn-credentials: server error - ${err.message}`)
    process.exitCode = 1
  })
  server.listen(config.port, config.host, () => {
    console.error(
      `turn-credentials: listening on ${config.host}:${config.port} - ` +
        `${config.urls.length} ICE URL(s), ttl ${config.ttlSeconds}s, ` +
        `${config.allowedOrigins.length} allowed origin(s)`,
    )
  })
}

if (isMainModule()) main()
