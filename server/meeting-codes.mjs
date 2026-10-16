#!/usr/bin/env node
// Meeting code service for KithMoot (docs/meeting-codes.md, "Service").
//
// A host asks for a short code that stands in for a room's full invitation
// link; anyone who presents the code gets the link back. The code is short
// enough to read aloud, so it cannot carry the invitation's key. Without a
// password this service stores the full link and can therefore read it.
// With one (docs/meeting-codes.md, "Password") it stores only an envelope
// the host sealed under four password words it never sees, bound to the
// code and expiry. See the trust model there before deploying this.
//
//   POST   /codes          {link, expires} -> 201 {code, expires, deleteToken}
//   POST   /codes          {sealed: true, expires}
//                          -> 201 {code, expires, deleteToken, uploadToken}, pending
//   PUT    /codes/<code>   Authorization: Bearer <uploadToken>, {envelope}
//                          -> 204 | 403 | 404 | 409 | 410, once, within 10 minutes
//   GET    /codes/<code>   200 {link, expires} | 200 {envelope, expires}
//                          | 410 {state: "ended"} | 404 (unknown or pending)
//   DELETE /codes/<code>   Authorization: Bearer <deleteToken> -> 204 | 403 | 404
//   GET    /codes/health   200, loopback only: Caddy does not forward it
//
// Plain Node with no dependencies and no build step, the same shape as
// server/turn-credentials.mjs: `node server/meeting-codes.mjs` with
// MEETING_CODES_STORE set. Unlike that service it imports nothing from
// dist/, so there is no `npm run build:lib` step before starting it.
//
// What it keeps, and only this: one JSON file of records {code, link or
// envelope, expires, deleteTokenHash, state}, and for a pending code
// {uploadTokenHash, pendingUntil} instead of a link. No address, account, room name or user
// agent is written anywhere. Rate-limit counters live in memory, keyed by a
// salted hash of the client address whose salt is random per process and
// never written to disk. Logs carry the status and the route template
// (`GET /codes/:code`), never a code, link or token.

import { createServer } from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIPv6 } from 'node:net'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as nodeFs from 'node:fs'

// 127.0.0.1:8093 in the spec is already taken: deploy/Caddyfile.kithmoot
// binds Caddy's loopback Tor front onto Blossom to 127.0.0.1:8093. 8094 is
// the next free port on the box (8089 TURN credentials, 8092 Blossom, 8093
// that front, 4848 the drop tier).
const DEFAULT_PORT = 8094
const DEFAULT_HOST = '127.0.0.1' // behind Caddy on the same box, see deploy/Caddyfile.kithmoot

/** foregather `foregather-access/base32-en-v1/1`, in value order 0-31. Frozen. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 8

export const ALLOWED_ORIGINS = Object.freeze(['https://kithmoot.forgesworn.dev', 'https://kithmoot.app'])
const LINK_PREFIXES = ALLOWED_ORIGINS.map((origin) => `${origin}/j/`)

export const MAX_LIVE = 20_000
export const MAX_TOMBSTONES = 200_000
// Service-wide, on top of the per-address limits: at most this many codes
// created in any rolling 24 hours, whoever asks.
export const MAX_CREATED_PER_DAY = 2_000
export const MAX_BODY_BYTES = 8 * 1024
// An envelope's ciphertext is at most 6 KiB decoded, 8,192 base64url
// characters, so an upload needs a little more room than a create.
export const MAX_UPLOAD_BODY_BYTES = 10 * 1024
export const ENVELOPE_SALT_BYTES = 16
export const ENVELOPE_NONCE_BYTES = 12
// The smallest ciphertext is one byte and the 16-byte GCM tag.
export const ENVELOPE_MIN_CIPHERTEXT_BYTES = 17
export const ENVELOPE_MAX_CIPHERTEXT_BYTES = 6 * 1024
// A sealed code is pending until its envelope arrives, for at most this long.
export const PENDING_SECONDS = 10 * 60
export const MAX_LINK_LENGTH = 4096
export const MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60
export const TOMBSTONE_SECONDS = 30 * 24 * 60 * 60
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const GENERATE_ATTEMPTS = 32

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// docs/meeting-codes.md, "Abuse limits". Each is a fixed window: once a
// count is reached, the address (or, for the global ceiling, everyone) is
// answered 429 until that window ends.
export const LIMITS = Object.freeze({
  createPerMinute: 10,
  createPerDay: 100,
  lookupsPerMinute: 30,
  missesPerMinute: 10,
  missesPerHour: 50,
  globalMissesPerMinute: 200,
})

// ---- codes ---------------------------------------------------------------

/** A fresh canonical code: one CSPRNG byte per symbol, low five bits. */
export function generateCode(random = randomBytes) {
  const bytes = random(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] & 31]
  return code
}

/** `ABCDEFGH` -> `ABC-DEF-GH`. */
export function formatCode(code) {
  return code.match(/.{1,3}/g).join('-')
}

/**
 * Canonicalises a code as foregather's parser does, at a fixed eight
 * symbols: ASCII only, surrounding ASCII whitespace trimmed, case folded to
 * upper, and hyphens allowed only between triples (final group 1-3). Anything
 * else - internal spaces, misplaced or repeated hyphens, I, L, O, U - is
 * refused, with no ambiguous-character substitution. Returns the canonical
 * eight symbols, or null.
 */
export function parseCode(value) {
  if (typeof value !== 'string' || value.length > 64) return null
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(value)) return null
  const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toUpperCase()
  if (trimmed.includes('-')) {
    const groups = trimmed.split('-')
    for (let i = 0; i < groups.length; i++) {
      const last = i === groups.length - 1
      if (groups[i].length === 0 || groups[i].length > 3 || (!last && groups[i].length !== 3)) return null
    }
  }
  const code = trimmed.replaceAll('-', '')
  if (code.length !== CODE_LENGTH) return null
  for (const c of code) if (!ALPHABET.includes(c)) return null
  return code
}

// ---- validation ----------------------------------------------------------

/**
 * A full invitation link on one of the two KithMoot origins: exactly
 * `<origin>/j/#<non-empty fragment>`, no query, credentials, port or other
 * path. Checked on the raw string as well as the parsed URL, so what is
 * stored is exactly what was validated (URL would percent-encode parts of a
 * fragment, and a parsed-and-reserialised link is not the one the host sent).
 */
export function validLink(link) {
  if (typeof link !== 'string' || link.length > MAX_LINK_LENGTH) return false
  if (!LINK_PREFIXES.some((prefix) => link.startsWith(`${prefix}#`))) return false
  // No whitespace or control characters anywhere: a link is copied, pasted
  // and handed to openLink, and none of those should meet a surprise.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(link)) return false
  let url
  try {
    url = new URL(link)
  } catch {
    return false
  }
  return (
    ALLOWED_ORIGINS.includes(url.origin) &&
    url.pathname === '/j/' &&
    url.search === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash.length > 1
  )
}

/**
 * Decodes strict base64url without padding: the alphabet only, and only the
 * one encoding of its bytes (Node's decoder ignores stray characters and
 * non-zero trailing bits; re-encoding catches both). Returns the byte
 * length, or -1.
 */
function base64urlLength(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return -1
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes.length : -1
}

/**
 * A sealed invitation as the host's client uploads it: exactly
 * {v: 1, salt, nonce, ciphertext}, base64url without padding, salt 16
 * bytes, nonce 12 and ciphertext 17 bytes to 6 KiB. The service cannot
 * open it and does not try.
 */
export function validEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false
  const keys = Object.keys(envelope).sort()
  if (keys.join(',') !== 'ciphertext,nonce,salt,v') return false
  if (envelope.v !== 1) return false
  if (base64urlLength(envelope.salt) !== ENVELOPE_SALT_BYTES) return false
  if (base64urlLength(envelope.nonce) !== ENVELOPE_NONCE_BYTES) return false
  const size = base64urlLength(envelope.ciphertext)
  return size >= ENVELOPE_MIN_CIPHERTEXT_BYTES && size <= ENVELOPE_MAX_CIPHERTEXT_BYTES
}

function validExpires(expires, nowSeconds) {
  return Number.isSafeInteger(expires) && expires > nowSeconds && expires <= nowSeconds + MAX_LIFETIME_SECONDS
}

// ---- storage -------------------------------------------------------------

/**
 * One JSON file, replaced atomically: write `<path>.tmp` beside it, fsync,
 * rename over the store, fsync the directory so the rename itself is
 * durable. A crash at any point leaves either the old file or the new one,
 * never a torn one. The temp file sits in the same directory on purpose:
 * rename is only atomic within a filesystem, and under the unit's
 * ProtectSystem=strict and PrivateTmp the StateDirectory is the only
 * writable place anyway.
 *
 * Synchronous throughout. Every mutation rewrites the whole file, so two
 * interleaved async writes would race on the one temp file; sync calls are
 * serial by construction, and at this scale the cost is a short stall.
 *
 * `fs` is injectable so a test can fail a write between the temp file and
 * the rename and check what survives.
 */
export function createStore(path, { fs = nodeFs } = {}) {
  const tmpPath = `${path}.tmp`

  function load() {
    // A stale temp file is a write that never reached its rename: the store
    // it would have replaced is still the truth.
    try {
      fs.unlinkSync(tmpPath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    let text
    try {
      text = fs.readFileSync(path, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return new Map()
      throw err
    }
    // A store that exists but does not parse is refused, not treated as
    // empty: starting empty would forget tombstones and could reissue a
    // code value somebody still holds.
    // JSON.parse's message quotes the text around the fault, which here
    // could be somebody's invitation link; throw a message of our own.
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`${path} is not valid JSON - refusing to start rather than forget its codes`)
    }
    if (!data || data.version !== 1 || !Array.isArray(data.records)) {
      throw new Error(`${path} is not a meeting-codes store (expected {"version":1,"records":[...]})`)
    }
    const records = new Map()
    for (const r of data.records) records.set(r.code, r)
    return records
  }

  function save(records) {
    const body = JSON.stringify({ version: 1, records: [...records.values()] })
    const fd = fs.openSync(tmpPath, 'w', 0o600)
    try {
      fs.writeSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, path)
    const dirFd = fs.openSync(dirname(path), 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  }

  return { load, save, path }
}

// ---- rate limits ---------------------------------------------------------

/** Fixed-window counters keyed by an opaque string. */
function createWindows(now) {
  const windows = new Map() // `${name}:${key}` -> { start, count }

  function entry(name, key, size) {
    const id = `${name}:${key}`
    const t = now()
    let w = windows.get(id)
    if (!w || t >= w.start + size) {
      w = { start: t - (t % size), count: 0, size }
      windows.set(id, w)
    }
    return w
  }

  return {
    count(name, key, size) {
      return entry(name, key, size).count
    },
    add(name, key, size) {
      entry(name, key, size).count++
    },
    prune() {
      const t = now()
      for (const [id, w] of windows) if (t >= w.start + w.size) windows.delete(id)
    },
    size() {
      return windows.size
    },
  }
}

/**
 * The client address, as Caddy reports it. Caddy's reverse_proxy appends
 * the address of the connection it accepted to X-Forwarded-For (and, with no
 * trusted_proxies configured, discards whatever the client sent), so only
 * the last entry is trusted; anything before it is client-supplied. This
 * holds because the service listens on loopback and only Caddy reaches it,
 * and because /codes is served on kithmoot.forgesworn.dev, which is not
 * behind Cloudflare: the address Caddy sees is the visitor's own. Without
 * the header (a direct request in development) the socket address is used.
 *
 * IPv6 addresses are keyed by their /64: one subscriber is routinely given a
 * whole /64, and keying by /128 would hand a single guesser 2^64 budgets.
 */
export function clientAddress(req) {
  let address = req.socket.remoteAddress ?? 'unknown'
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string') {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) address = parts[parts.length - 1]
  }
  return addressKey(address)
}

export function addressKey(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1]
  if (!isIPv6(address)) return address
  const [head, tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = address.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

// ---- HTTP ----------------------------------------------------------------

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status, BASE_HEADERS)
    res.end()
    return
  }
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Reads at most `limit` bytes; resolves null once the body exceeds it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function bearerToken(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header)
  return match ? match[1] : null
}

function tokenMatches(presented, storedHashHex) {
  if (!presented) return false
  const expected = Buffer.from(storedHashHex, 'hex')
  const actual = sha256(presented)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Loads configuration from the environment. MEETING_CODES_STORE has no
 * default: a silent default path would be somewhere the unit cannot write
 * under ProtectSystem=strict, or somewhere a second instance shares.
 */
export function loadConfigFromEnv(env = process.env) {
  const storePath = env.MEETING_CODES_STORE
  if (!storePath) {
    throw new Error(
      'MEETING_CODES_STORE is not set - refusing to start. Set it to the ' +
        'JSON file the codes live in, inside a directory only this service ' +
        'can write (deploy/meeting-codes.service sets ' +
        '/var/lib/kithmoot-codes/codes.json, under its StateDirectory).',
    )
  }
  if (!storePath.startsWith('/')) {
    throw new Error(`MEETING_CODES_STORE must be an absolute path, got "${storePath}".`)
  }
  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}".`)
  }
  const host = env.HOST || DEFAULT_HOST
  return { storePath, port, host }
}

/**
 * Builds the service. Does not listen; main() or a test decides where.
 *
 * config: storePath (required); now() in milliseconds (default Date.now);
 * log(line) (default stderr); maxLive (20,000), maxTombstones (200,000) and
 * maxCreatedPerDay (2,000); fs and random for
 * tests. Every expiry, sweep and rate window reads now(), so a test can move
 * time without sleeping.
 */
export function createMeetingCodesServer(config) {
  const now = config.now ?? Date.now
  const log = config.log ?? ((line) => process.stderr.write(`${line}\n`))
  const maxLive = config.maxLive ?? MAX_LIVE
  const maxTombstones = config.maxTombstones ?? MAX_TOMBSTONES
  const maxCreatedPerDay = config.maxCreatedPerDay ?? MAX_CREATED_PER_DAY
  // Creation times in the last 24 hours, oldest first. In memory only, so a
  // restart forgets it; at most maxCreatedPerDay entries.
  const created = []
  const random = config.random ?? randomBytes
  const store = createStore(config.storePath, { fs: config.fs ?? nodeFs })
  const records = store.load()
  const windows = createWindows(now)
  // Random per process, never written anywhere: a counter key cannot be
  // turned back into an address, and a restart forgets every key.
  const salt = randomBytes(32)

  const nowSeconds = () => Math.floor(now() / 1000)

  /** Persists `next` and only then adopts it, so a failed write changes nothing. */
  function adopt(next) {
    store.save(next)
    records.clear()
    for (const [k, v] of next) records.set(k, v)
  }

  function commit(change) {
    const next = new Map(records)
    change(next)
    adopt(next)
  }

  /**
   * Ends every live code past its expiry (dropping the link: an ended code
   * resolves to nothing, so there is no reason to keep the invitation),
   * discards every pending code whose envelope did not arrive in time, and
   * removes every record 30 days past its expiry, whatever its state.
   * Runs at start and on a timer.
   */
  function sweep() {
    const t = nowSeconds()
    let changed = false
    const next = new Map(records)
    for (const [code, r] of next) {
      if (pendingLapsed(r, t)) {
        next.delete(code)
        changed = true
      } else if (t > r.expires + TOMBSTONE_SECONDS) {
        next.delete(code)
        changed = true
      } else if (r.state === 'live' && t >= r.expires) {
        next.set(code, tombstone(r))
        changed = true
      }
    }
    if (changed) adopt(next)
    windows.prune()
  }

  function tombstone(r) {
    return { code: r.code, expires: r.expires, deleteTokenHash: r.deleteTokenHash, state: 'ended' }
  }

  function isLive(r, t) {
    return r.state === 'live' && t < r.expires
  }

  /**
   * A pending code whose envelope never arrived. It was never shown to
   * anyone (the client shows a sealed code only after its upload), so it is
   * discarded outright rather than kept as a tombstone, and answers 404
   * from the moment it lapses, before any sweep.
   */
  function pendingLapsed(r, t) {
    return r.state === 'pending' && (t >= r.pendingUntil || t >= r.expires)
  }

  /** The record for a code, unless it is absent or a lapsed pending code. */
  function present(code) {
    const r = records.get(code)
    return r && !pendingLapsed(r, nowSeconds()) ? r : undefined
  }

  function addrKey(req) {
    return createHmac('sha256', salt).update(clientAddress(req)).digest('base64url')
  }

  // The miss budget guards guessing: per address, and process-wide so a
  // guesser spread over many addresses is capped too.
  function missBlocked(key) {
    return (
      windows.count('global-miss', '*', MINUTE) >= LIMITS.globalMissesPerMinute ||
      windows.count('miss-m', key, MINUTE) >= LIMITS.missesPerMinute ||
      windows.count('miss-h', key, HOUR) >= LIMITS.missesPerHour
    )
  }

  function recordMiss(key) {
    windows.add('global-miss', '*', MINUTE)
    windows.add('miss-m', key, MINUTE)
    windows.add('miss-h', key, HOUR)
  }

  /** Shared by GET, PUT and DELETE: each answers differently for a code that exists. */
  function lookupGate(key) {
    if (missBlocked(key)) return false
    if (windows.count('lookup', key, MINUTE) >= LIMITS.lookupsPerMinute) return false
    windows.add('lookup', key, MINUTE)
    return true
  }

  async function create(req, res, key) {
    if (
      windows.count('create-m', key, MINUTE) >= LIMITS.createPerMinute ||
      windows.count('create-d', key, DAY) >= LIMITS.createPerDay
    ) {
      return send(res, 429, { error: 'too many requests' })
    }
    windows.add('create-m', key, MINUTE)
    windows.add('create-d', key, DAY)

    const raw = await readBody(req, MAX_BODY_BYTES)
    if (raw === null) return send(res, 413, { error: 'body too large' })
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return send(res, 400, { error: 'body must be JSON' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return send(res, 400, { error: 'body must be a JSON object' })
    }
    const keys = Object.keys(body)
    const sealed = keys.includes('sealed')
    if (keys.length !== 2 || !keys.includes('expires') || !(sealed || keys.includes('link'))) {
      return send(res, 400, { error: 'body must be exactly {link, expires} or {sealed: true, expires}' })
    }
    if (sealed ? body.sealed !== true : !validLink(body.link)) {
      return send(res, 400, { error: sealed ? 'sealed must be true' : 'invalid link' })
    }
    const t = nowSeconds()
    if (!validExpires(body.expires, t)) return send(res, 400, { error: 'invalid expires' })

    // Each bound refuses rather than evict a live code or forget a tombstone
    // early. A live code past its expiry still counts as live until the
    // sweep turns it into a tombstone, and a pending code counts as live.
    let live = 0
    for (const r of records.values()) if (r.state !== 'ended') live++
    if (live >= maxLive || records.size - live >= maxTombstones) {
      return send(res, 503, { error: 'store full' })
    }
    // 503, not 429: the cap is the service's, not this caller's, and a
    // client shows 429 as "wait a minute", which would not be true.
    const dayAgo = now() - DAY
    while (created.length > 0 && created[0] <= dayAgo) created.shift()
    if (created.length >= maxCreatedPerDay) return send(res, 503, { error: 'daily creation limit reached' })

    let code = null
    for (let i = 0; i < GENERATE_ATTEMPTS && code === null; i++) {
      const candidate = generateCode(random)
      if (!records.has(candidate)) code = candidate
    }
    if (code === null) return send(res, 503, { error: 'could not allocate a code' })

    const deleteToken = randomBytes(32).toString('base64url')
    const deleteTokenHash = sha256(deleteToken).toString('hex')
    if (sealed) {
      // The envelope's additional data names the code, so the host must
      // know the code before sealing: allocate now, upload once later.
      const uploadToken = randomBytes(32).toString('base64url')
      const record = {
        code,
        expires: body.expires,
        deleteTokenHash,
        uploadTokenHash: sha256(uploadToken).toString('hex'),
        pendingUntil: t + PENDING_SECONDS,
        state: 'pending',
      }
      commit((m) => m.set(code, record))
      created.push(now())
      return send(res, 201, { code, expires: record.expires, deleteToken, uploadToken })
    }
    const record = { code, link: body.link, expires: body.expires, deleteTokenHash, state: 'live' }
    commit((m) => m.set(code, record))
    created.push(now())
    send(res, 201, { code, expires: record.expires, deleteToken })
  }

  /**
   * Stores a pending code's envelope, once. Spends the lookup and miss
   * budgets as DELETE does: 404 against 403 or 409 would otherwise tell a
   * guesser for free which codes exist.
   */
  async function upload(req, res, key, rawCode) {
    if (!lookupGate(key)) return send(res, 429, { error: 'too many requests' })
    const code = parseCode(rawCode)
    if (code === null) return send(res, 400, { error: 'invalid code' })
    const r = present(code)
    if (!r) {
      recordMiss(key)
      return send(res, 404, { error: 'not found' })
    }
    if (r.state === 'ended') return send(res, 410, { state: 'ended' })
    if (r.state !== 'pending') return send(res, 409, { error: 'already uploaded' })
    if (!tokenMatches(bearerToken(req), r.uploadTokenHash)) return send(res, 403, { error: 'forbidden' })

    const raw = await readBody(req, MAX_UPLOAD_BODY_BYTES)
    if (raw === null) return send(res, 413, { error: 'body too large' })
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return send(res, 400, { error: 'body must be JSON' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'envelope') {
      return send(res, 400, { error: 'body must be exactly {envelope}' })
    }
    if (!validEnvelope(body.envelope)) return send(res, 400, { error: 'invalid envelope' })
    // The body was read asynchronously: the record may have changed, been
    // deleted or lapsed meanwhile, and only the pending one is replaced.
    const current = present(code)
    if (current !== r) {
      if (!current) return send(res, 404, { error: 'not found' })
      return send(res, current.state === 'ended' ? 410 : 409, current.state === 'ended' ? { state: 'ended' } : { error: 'already uploaded' })
    }
    const { v, salt, nonce, ciphertext } = body.envelope
    const record = {
      code,
      envelope: { v, salt, nonce, ciphertext },
      expires: r.expires,
      deleteTokenHash: r.deleteTokenHash,
      state: 'live',
    }
    commit((m) => m.set(code, record))
    send(res, 204)
  }

  function lookup(req, res, key, rawCode) {
    if (!lookupGate(key)) return send(res, 429, { error: 'too many requests' })
    const code = parseCode(rawCode)
    if (code === null) return send(res, 400, { error: 'invalid code' })
    const r = present(code)
    // A pending code has nothing to give yet and answers as unknown, miss
    // and all, so a lookup cannot tell it from a code never issued.
    if (!r || r.state === 'pending') {
      recordMiss(key)
      return send(res, 404, { error: 'not found' })
    }
    if (!isLive(r, nowSeconds())) return send(res, 410, { state: 'ended' })
    if (r.envelope) return send(res, 200, { envelope: r.envelope, expires: r.expires })
    send(res, 200, { link: r.link, expires: r.expires })
  }

  function remove(req, res, key, rawCode) {
    // 404 against 403 tells a guesser whether a code exists, so DELETE
    // spends the same lookup and miss budgets as GET.
    if (!lookupGate(key)) return send(res, 429, { error: 'too many requests' })
    const code = parseCode(rawCode)
    if (code === null) return send(res, 400, { error: 'invalid code' })
    const r = present(code)
    if (!r) {
      recordMiss(key)
      return send(res, 404, { error: 'not found' })
    }
    // The token is checked before the state, so a tombstone answers 204
    // only to the holder of its token. A pending code ends like a live one,
    // so its value is not reissued while the host may still hold it.
    if (!tokenMatches(bearerToken(req), r.deleteTokenHash)) return send(res, 403, { error: 'forbidden' })
    if (r.state !== 'ended') commit((m) => m.set(code, tombstone(r)))
    send(res, 204)
  }

  /**
   * CORS for the two KithMoot origins only. A request with no Origin is not
   * a cross-origin browser request and proceeds without CORS headers; one
   * with any other Origin is refused outright, as in turn-credentials.
   */
  function applyCors(req, res) {
    const origin = req.headers.origin
    if (!origin) return true
    if (!ALLOWED_ORIGINS.includes(origin)) return false
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
    return true
  }

  async function handle(req, res) {
    const path = (req.url ?? '').split('?')[0]
    let route
    let codeSegment = null
    if (path === '/codes' || path === '/codes/') route = '/codes'
    else if (path === '/codes/health') route = '/codes/health'
    else if (/^\/codes\/[^/]+$/.test(path)) {
      route = '/codes/:code'
      codeSegment = path.slice('/codes/'.length)
    } else route = 'other'
    res.locals = { route: `${req.method} ${route}` }

    if (route === 'other') return send(res, 404, { error: 'not found' })
    // Health is for `curl http://127.0.0.1:8094/codes/health` on the box.
    // Caddy does not forward it (deploy/Caddyfile.kithmoot); should that
    // ever change, anything carrying X-Forwarded-For came through a proxy
    // and is answered as if the path did not exist.
    if (route === '/codes/health' && req.headers['x-forwarded-for'] !== undefined) {
      return send(res, 404, { error: 'not found' })
    }
    if (!applyCors(req, res)) return send(res, 403, { error: 'origin not allowed' })

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...BASE_HEADERS,
        'access-control-allow-methods': route === '/codes' ? 'POST, OPTIONS' : 'GET, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-max-age': '600',
      })
      return res.end()
    }

    if (route === '/codes/health') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      return send(res, 200, { ok: true })
    }

    const key = addrKey(req)
    if (route === '/codes') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      return create(req, res, key)
    }
    let decoded
    try {
      decoded = decodeURIComponent(codeSegment)
    } catch {
      decoded = null
    }
    if (req.method === 'GET') return lookup(req, res, key, decoded)
    if (req.method === 'PUT') return upload(req, res, key, decoded)
    if (req.method === 'DELETE') return remove(req, res, key, decoded)
    send(res, 405, { error: 'method not allowed' })
  }

  sweep()
  const sweepTimer = setInterval(() => {
    try {
      sweep()
    } catch (err) {
      log(`meeting-codes: sweep failed (${err?.code ?? err?.name ?? 'error'})`)
    }
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref()

  const server = createServer((req, res) => {
    res.on('finish', () => log(`meeting-codes: ${res.statusCode} ${res.locals?.route ?? 'unknown'}`))
    handle(req, res).catch((err) => {
      // Never the error message: Node puts its input in some of them, and
      // the input here is a code, a link or a token.
      log(`meeting-codes: request failed (${err?.code ?? err?.name ?? 'error'})`)
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  server.on('close', () => clearInterval(sweepTimer))
  server.sweep = sweep
  server.records = records
  return server
}

function isMainModule() {
  const entry = process.argv[1]
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href
}

function main() {
  let config
  let server
  try {
    config = loadConfigFromEnv(process.env)
    server = createMeetingCodesServer(config)
  } catch (err) {
    console.error(`meeting-codes: ${err.message}`)
    process.exitCode = 1
    return
  }
  server.on('error', (err) => {
    console.error(`meeting-codes: server error - ${err.code ?? err.message}`)
    process.exitCode = 1
  })
  server.listen(config.port, config.host, () => {
    console.error(`meeting-codes: listening on ${config.host}:${config.port}, ${server.records.size} record(s)`)
  })
}

if (isMainModule()) main()
