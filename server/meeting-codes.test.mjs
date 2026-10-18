import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as fs from 'node:fs'
import {
  ALPHABET,
  ENVELOPE_MAX_CIPHERTEXT_BYTES,
  LIMITS,
  MAX_CREATED_PER_DAY,
  PENDING_SECONDS,
  MAX_LIVE,
  MAX_TOMBSTONES,
  TOMBSTONE_SECONDS,
  addressKey,
  createMeetingCodesServer,
  formatCode,
  generateCode,
  loadConfigFromEnv,
  parseCode,
  validEnvelope,
  validLink,
} from './meeting-codes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'meeting-codes.mjs')

const LINK = 'https://kithmoot.forgesworn.dev/j/#r=room-secret-fragment&k=0123456789abcdef'
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)
const T0S = Math.floor(T0 / 1000)

const teardowns = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()()
})

function tempStore() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'meeting-codes-'))
  teardowns.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'codes.json')
}

/** A clock the test moves by hand. */
function clock(start = T0) {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
  }
  return now
}

async function startServer(overrides = {}) {
  const lines = []
  const config = {
    storePath: overrides.storePath ?? tempStore(),
    now: overrides.now ?? clock(),
    log: (line) => lines.push(line),
    ...overrides,
  }
  const server = createMeetingCodesServer(config)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  teardowns.push(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${port}`
  const request = (method, path, { body, headers = {}, ip = '203.0.113.1' } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(ip === null ? {} : { 'x-forwarded-for': ip }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  const create = (body = { link: LINK, expires: Math.floor(config.now() / 1000) + 3600 }, opts = {}) =>
    request('POST', '/codes', { body, ...opts })
  return { server, config, lines, request, create }
}

/** A code that is not in the store: flip the last symbol of a real one. */
function otherCode(code) {
  const last = ALPHABET.indexOf(code[7])
  return code.slice(0, 7) + ALPHABET[(last + 1) % 32]
}

function unusedCode(i) {
  // Distinct codes beginning with I-free filler; none was issued.
  return `ZZZZ${ALPHABET[i % 32]}${ALPHABET[Math.floor(i / 32) % 32]}ZZ`
}

describe('code format', () => {
  it('uses the frozen foregather base32-en-v1 alphabet', () => {
    expect(ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(new Set(ALPHABET).size).toBe(32)
    for (const c of 'ILOU') expect(ALPHABET).not.toContain(c)
  })

  it('takes one byte per symbol and its low five bits', () => {
    const bytes = Buffer.from([0x00, 0x1f, 0x20, 0x3f, 0xe1, 0xff, 0x0a, 0x8a])
    expect(generateCode(() => bytes)).toBe('0Z0Z1ZAA')
  })

  it('generates eight symbols from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode()
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    }
  })

  it('displays in triples', () => {
    expect(formatCode('ABCDEFGH')).toBe('ABC-DEF-GH')
  })

  it.each([
    ['ABCDEFGH', 'ABCDEFGH'],
    ['abcdefgh', 'ABCDEFGH'],
    ['ABC-DEF-GH', 'ABCDEFGH'],
    ['abc-def-gh', 'ABCDEFGH'],
    [' ABCDEFGH ', 'ABCDEFGH'],
    ['\tabc-def-gh\n', 'ABCDEFGH'],
    ['ABC-DEFGH', null], // a group of five
    ['AB-CDEFGH', null], // a non-final group of two
    ['ABC-DEF-GH-', null], // trailing hyphen
    ['-ABC-DEF-GH', null], // leading hyphen
    ['ABC--DEF-GH', null], // repeated hyphen
    ['ABC DEF GH', null], // internal spaces
    ['ABCDEFGI', null], // I
    ['ABCDEFGL', null], // L
    ['ABCDEFGO', null], // O, no substitution for 0
    ['ABCDEFGU', null], // U
    ['ABCDEFG', null], // seven
    ['ABCDEFGHJ', null], // nine
    ['ABC‐DEF‐GH', null], // a Unicode hyphen
    ['ＡBCDEFGH', null], // fullwidth
    ['', null],
  ])('parses %j as %j', (input, expected) => {
    expect(parseCode(input)).toBe(expected)
  })
})

describe('link validation', () => {
  it.each([
    [LINK, true],
    ['https://kithmoot.app/j/#x', true],
    ['https://kithmoot.forgesworn.dev/j/#', false], // empty fragment
    ['https://kithmoot.forgesworn.dev/j/', false],
    ['https://kithmoot.forgesworn.dev/j/?a=1#x', false],
    ['https://kithmoot.forgesworn.dev/j#x', false],
    ['https://kithmoot.forgesworn.dev/j/x#x', false],
    ['https://kithmoot.forgesworn.dev/#x', false],
    ['https://user:pw@kithmoot.forgesworn.dev/j/#x', false],
    ['https://kithmoot.forgesworn.dev:444/j/#x', false],
    ['http://kithmoot.forgesworn.dev/j/#x', false],
    ['https://evil.example/j/#x', false],
    ['https://kithmoot.app.evil.example/j/#x', false],
    ['https://kithmoot.app/j/#a b', false],
    [`https://kithmoot.app/j/#${'a'.repeat(4096)}`, false],
    [42, false],
  ])('%j -> %j', (link, ok) => {
    expect(validLink(link)).toBe(ok)
  })
})

describe('configuration', () => {
  it('refuses to start without MEETING_CODES_STORE', () => {
    expect(() => loadConfigFromEnv({})).toThrow(/MEETING_CODES_STORE is not set/)
  })

  it('refuses a relative store path', () => {
    expect(() => loadConfigFromEnv({ MEETING_CODES_STORE: 'codes.json' })).toThrow(/absolute/)
  })

  it('defaults to loopback on 8114', () => {
    expect(loadConfigFromEnv({ MEETING_CODES_STORE: '/x/codes.json' })).toEqual({
      storePath: '/x/codes.json',
      host: '127.0.0.1',
      port: 8114,
    })
  })

  it('refuses with a clear message when run directly without a store', () => {
    const env = { ...process.env }
    delete env.MEETING_CODES_STORE
    const result = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/MEETING_CODES_STORE is not set - refusing to start/)
  })
})

describe('lifecycle', () => {
  it('creates, resolves and deletes a code', async () => {
    const { create, request } = await startServer()
    const expires = T0S + 3600
    const res = await create({ link: LINK, expires })
    expect(res.status).toBe(201)
    const { code, expires: e, deleteToken } = await res.json()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(e).toBe(expires)
    expect(deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const got = await request('GET', `/codes/${code}`)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ link: LINK, expires })

    // Displayed and lower-case forms resolve too.
    expect((await request('GET', `/codes/${formatCode(code).toLowerCase()}`)).status).toBe(200)

    expect((await request('DELETE', `/codes/${code}`)).status).toBe(403)
    const wrong = await request('DELETE', `/codes/${code}`, { headers: { authorization: `Bearer ${'A'.repeat(43)}` } })
    expect(wrong.status).toBe(403)
    expect((await request('GET', `/codes/${code}`)).status).toBe(200)

    const auth = { authorization: `Bearer ${deleteToken}` }
    expect((await request('DELETE', `/codes/${code}`, { headers: auth })).status).toBe(204)
    const ended = await request('GET', `/codes/${code}`)
    expect(ended.status).toBe(410)
    expect(await ended.json()).toEqual({ state: 'ended' })
    // Already ended: 204 for the token holder, 403 for anyone else.
    expect((await request('DELETE', `/codes/${code}`, { headers: auth })).status).toBe(204)
    expect((await request('DELETE', `/codes/${code}`)).status).toBe(403)

    expect((await request('DELETE', `/codes/${otherCode(code)}`, { headers: auth })).status).toBe(404)
    expect((await request('GET', `/codes/${otherCode(code)}`)).status).toBe(404)
  })

  it('stores the delete token only as its SHA-256, and no tombstone keeps the link', async () => {
    const { create, request, config } = await startServer()
    const { code, deleteToken } = await (await create()).json()
    const stored = fs.readFileSync(config.storePath, 'utf8')
    expect(stored).not.toContain(deleteToken)
    const record = JSON.parse(stored).records[0]
    expect(Object.keys(record).sort()).toEqual(['code', 'deleteTokenHash', 'expires', 'link', 'state'])
    expect(record.deleteTokenHash).toBe(createHash('sha256').update(deleteToken).digest('hex'))

    await request('DELETE', `/codes/${code}`, { headers: { authorization: `Bearer ${deleteToken}` } })
    const after = fs.readFileSync(config.storePath, 'utf8')
    expect(after).not.toContain(LINK)
    expect(JSON.parse(after).records[0].state).toBe('ended')
  })

  it('answers 410 the moment a code expires, tombstones it on sweep and forgets it 30 days later', async () => {
    const now = clock()
    const { server, create, request, config } = await startServer({ now })
    const { code } = await (await create({ link: LINK, expires: T0S + 60 })).json()

    now.advance(59_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(200)
    now.advance(1_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(410)

    server.sweep()
    const tomb = JSON.parse(fs.readFileSync(config.storePath, 'utf8')).records[0]
    expect(tomb.state).toBe('ended')
    expect(tomb.link).toBeUndefined()

    now.advance(TOMBSTONE_SECONDS * 1000)
    server.sweep()
    expect((await request('GET', `/codes/${code}`)).status).toBe(410)
    now.advance(1_000)
    server.sweep()
    expect((await request('GET', `/codes/${code}`)).status).toBe(404)
    expect(JSON.parse(fs.readFileSync(config.storePath, 'utf8')).records).toEqual([])
  })

  it('sweeps at start, from what is on disk', async () => {
    const storePath = tempStore()
    const now = clock()
    const first = await startServer({ storePath, now })
    const { code } = await (await first.create({ link: LINK, expires: T0S + 60 })).json()
    await new Promise((resolve) => first.server.close(resolve))

    now.advance((60 + TOMBSTONE_SECONDS + 1) * 1000)
    const second = await startServer({ storePath, now })
    expect(second.server.records.size).toBe(0)
    expect((await second.request('GET', `/codes/${code}`)).status).toBe(404)
  })

  it('never reissues a code value it still holds, live or tombstoned', async () => {
    const fixed = Buffer.from([10, 11, 12, 13, 14, 15, 16, 17])
    let calls = 0
    const random = (n) => (calls++ < 3 ? fixed : Buffer.from([1, 2, 3, 4, 5, 6, 7, calls % 32]).subarray(0, n))
    const { create, request } = await startServer({ random })
    const first = await (await create()).json()
    expect(first.code).toBe('ABCDEFGH')
    await request('DELETE', `/codes/${first.code}`, { headers: { authorization: `Bearer ${first.deleteToken}` } })
    const second = await (await create()).json()
    expect(second.code).not.toBe('ABCDEFGH')
    expect(calls).toBeGreaterThan(2)
  })

  it('answers 503 when it cannot find a free code', async () => {
    const fixed = Buffer.from([10, 11, 12, 13, 14, 15, 16, 17])
    const { create } = await startServer({ random: () => fixed })
    expect((await create()).status).toBe(201)
    expect((await create()).status).toBe(503)
  })
})

describe('validation on create', () => {
  it.each([
    ['not JSON', '{link:', 400],
    ['an array', '[]', 400],
    ['a missing expires', { link: LINK }, 400],
    ['an extra field', { link: LINK, expires: T0S + 60, room: 'x' }, 400],
    ['a bad link', { link: 'https://evil.example/j/#x', expires: T0S + 60 }, 400],
    ['expires now', { link: LINK, expires: T0S }, 400],
    ['expires in the past', { link: LINK, expires: T0S - 1 }, 400],
    ['expires past 7 days', { link: LINK, expires: T0S + 7 * 86400 + 1 }, 400],
    ['a fractional expires', { link: LINK, expires: T0S + 60.5 }, 400],
    ['a string expires', { link: LINK, expires: String(T0S + 60) }, 400],
    ['an unsafe integer expires', { link: LINK, expires: 2 ** 53 }, 400],
  ])('refuses %s', async (_name, body, status) => {
    const { create } = await startServer()
    expect((await create(body)).status).toBe(status)
  })

  it('accepts exactly 7 days', async () => {
    const { create } = await startServer()
    expect((await create({ link: LINK, expires: T0S + 7 * 86400 })).status).toBe(201)
  })

  it('refuses a body over 8 KiB', async () => {
    const { create } = await startServer()
    const body = JSON.stringify({ link: LINK, expires: T0S + 60, pad: 'x'.repeat(8192) })
    expect((await create(body)).status).toBe(413)
  })

  it('refuses other methods and paths', async () => {
    const { request } = await startServer()
    expect((await request('GET', '/codes')).status).toBe(405)
    expect((await request('PATCH', '/codes/ABCDEFGH')).status).toBe(405)
    expect((await request('PUT', '/codes')).status).toBe(405)
    expect((await request('GET', '/elsewhere')).status).toBe(404)
    expect((await request('GET', '/codes/ABC/DEF')).status).toBe(404)
    expect((await request('GET', '/codes/ABCDEFGI')).status).toBe(400)
  })
})

const b64 = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64url')
const ENVELOPE = { v: 1, salt: b64(16, 1), nonce: b64(12, 2), ciphertext: b64(64, 3) }

describe('sealed codes', () => {
  async function allocate(s, expires = T0S + 3600, opts = {}) {
    const res = await s.create({ sealed: true, expires }, opts)
    expect(res.status).toBe(201)
    return res.json()
  }
  const put = (s, code, token, body = { envelope: ENVELOPE }, opts = {}) =>
    s.request('PUT', `/codes/${code}`, { body, headers: token === null ? {} : { authorization: `Bearer ${token}` }, ...opts })

  it('allocates pending, takes the envelope once, then answers it', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    expect(Object.keys(issued).sort()).toEqual(['code', 'deleteToken', 'expires', 'uploadToken'])
    expect(issued.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.uploadToken).not.toBe(issued.deleteToken)
    expect(issued.expires).toBe(T0S + 3600)

    // Pending: indistinguishable from a code never issued.
    const pending = await s.request('GET', `/codes/${issued.code}`)
    expect(pending.status).toBe(404)
    expect(await pending.json()).toEqual({ error: 'not found' })

    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(204)
    const got = await s.request('GET', `/codes/${issued.code}`)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ envelope: ENVELOPE, expires: T0S + 3600 })

    // Once only, whoever asks.
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(409)
    expect((await put(s, issued.code, 'A'.repeat(43))).status).toBe(409)
    expect(await (await s.request('GET', `/codes/${issued.code}`)).json()).toEqual({ envelope: ENVELOPE, expires: T0S + 3600 })

    // Deleted like any other code; the envelope goes with it.
    const auth = { authorization: `Bearer ${issued.deleteToken}` }
    expect((await s.request('DELETE', `/codes/${issued.code}`, { headers: auth })).status).toBe(204)
    expect((await s.request('GET', `/codes/${issued.code}`)).status).toBe(410)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(410)
    const tomb = JSON.parse(fs.readFileSync(s.config.storePath, 'utf8')).records[0]
    expect(Object.keys(tomb).sort()).toEqual(['code', 'deleteTokenHash', 'expires', 'state'])
  })

  it('stores both tokens only as SHA-256, and only the listed fields', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    let stored = fs.readFileSync(s.config.storePath, 'utf8')
    expect(stored).not.toContain(issued.uploadToken)
    expect(stored).not.toContain(issued.deleteToken)
    let record = JSON.parse(stored).records[0]
    expect(Object.keys(record).sort()).toEqual(['code', 'deleteTokenHash', 'expires', 'pendingUntil', 'state', 'uploadTokenHash'])
    expect(record.state).toBe('pending')
    expect(record.pendingUntil).toBe(T0S + PENDING_SECONDS)
    expect(record.uploadTokenHash).toBe(createHash('sha256').update(issued.uploadToken).digest('hex'))

    await put(s, issued.code, issued.uploadToken)
    stored = fs.readFileSync(s.config.storePath, 'utf8')
    record = JSON.parse(stored).records[0]
    expect(Object.keys(record).sort()).toEqual(['code', 'deleteTokenHash', 'envelope', 'expires', 'state'])
    expect(record.envelope).toEqual(ENVELOPE)
    expect(record.state).toBe('live')
  })

  it('discards a pending code not uploaded within 10 minutes', async () => {
    const now = clock()
    const s = await startServer({ now })
    const late = await allocate(s)
    const onTime = await allocate(s)
    now.advance(PENDING_SECONDS * 1000 - 1000)
    expect((await put(s, onTime.code, onTime.uploadToken)).status).toBe(204)
    now.advance(1000)
    // Lapsed: 404 at once, before any sweep, for upload, lookup and delete.
    expect((await put(s, late.code, late.uploadToken)).status).toBe(404)
    expect((await s.request('GET', `/codes/${late.code}`)).status).toBe(404)
    expect((await s.request('DELETE', `/codes/${late.code}`, { headers: { authorization: `Bearer ${late.deleteToken}` } })).status).toBe(404)
    s.server.sweep()
    expect(s.server.records.has(late.code)).toBe(false)
    expect((await s.request('GET', `/codes/${onTime.code}`)).status).toBe(200)
  })

  it('discards a pending code whose expiry comes before its upload window ends', async () => {
    const now = clock()
    const s = await startServer({ now })
    const issued = await allocate(s, T0S + 60)
    now.advance(60_000)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(404)
  })

  it('refuses a missing or wrong upload token, and the delete token', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    expect((await put(s, issued.code, null)).status).toBe(403)
    expect((await put(s, issued.code, 'A'.repeat(43))).status).toBe(403)
    expect((await put(s, issued.code, issued.deleteToken)).status).toBe(403)
    expect((await put(s, otherCode(issued.code), issued.uploadToken)).status).toBe(404)
    // Still pending, and still takes the right token.
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(204)
  })

  it('ends a pending code on DELETE, so its value is not reissued', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    expect((await s.request('DELETE', `/codes/${issued.code}`)).status).toBe(403)
    expect((await s.request('DELETE', `/codes/${issued.code}`, { headers: { authorization: `Bearer ${issued.deleteToken}` } })).status).toBe(204)
    expect((await s.request('GET', `/codes/${issued.code}`)).status).toBe(410)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(410)
  })

  it.each([
    ['sealed false', { sealed: false, expires: T0S + 60 }],
    ['sealed "true"', { sealed: 'true', expires: T0S + 60 }],
    ['sealed with a link', { sealed: true, link: LINK, expires: T0S + 60 }],
    ['sealed without expires', { sealed: true }],
    ['sealed with an extra field', { sealed: true, expires: T0S + 60, x: 1 }],
    ['sealed past 7 days', { sealed: true, expires: T0S + 7 * 86400 + 1 }],
  ])('refuses to allocate with %s', async (_name, body) => {
    const s = await startServer()
    expect((await s.create(body)).status).toBe(400)
  })

  const tooLong = b64(ENVELOPE_MAX_CIPHERTEXT_BYTES + 1)
  it.each([
    ['not JSON', '{envelope:'],
    ['an array', '[]'],
    ['no envelope', {}],
    ['an extra top-level field', { envelope: ENVELOPE, link: LINK }],
    ['a link instead', { link: LINK }],
    ['v 2', { envelope: { ...ENVELOPE, v: 2 } }],
    ['v "1"', { envelope: { ...ENVELOPE, v: '1' } }],
    ['an extra envelope field', { envelope: { ...ENVELOPE, aad: 'x' } }],
    ['a missing nonce', { envelope: { v: 1, salt: ENVELOPE.salt, ciphertext: ENVELOPE.ciphertext } }],
    ['a 15-byte salt', { envelope: { ...ENVELOPE, salt: b64(15) } }],
    ['a 17-byte salt', { envelope: { ...ENVELOPE, salt: b64(17) } }],
    ['an 11-byte nonce', { envelope: { ...ENVELOPE, nonce: b64(11) } }],
    ['a 13-byte nonce', { envelope: { ...ENVELOPE, nonce: b64(13) } }],
    ['a 16-byte ciphertext', { envelope: { ...ENVELOPE, ciphertext: b64(16) } }],
    ['a ciphertext over 6 KiB', { envelope: { ...ENVELOPE, ciphertext: tooLong } }],
    ['padding', { envelope: { ...ENVELOPE, salt: `${ENVELOPE.salt}==` } }],
    ['standard base64', { envelope: { ...ENVELOPE, salt: Buffer.alloc(16, 0xfb).toString('base64') } }],
    ['non-zero trailing bits', { envelope: { ...ENVELOPE, salt: `${ENVELOPE.salt.slice(0, -1)}B` } }],
    ['whitespace', { envelope: { ...ENVELOPE, ciphertext: `${ENVELOPE.ciphertext.slice(0, 8)} ${ENVELOPE.ciphertext.slice(8)}` } }],
    ['a number', { envelope: { ...ENVELOPE, nonce: 12 } }],
  ])('refuses an upload with %s, and stays pending', async (_name, body) => {
    const s = await startServer()
    const issued = await allocate(s)
    expect((await put(s, issued.code, issued.uploadToken, body)).status).toBe(400)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(204)
  })

  it('accepts a 17-byte and a 6 KiB ciphertext, and refuses a body over 10 KiB', async () => {
    expect(validEnvelope({ ...ENVELOPE, ciphertext: b64(17) })).toBe(true)
    expect(validEnvelope({ ...ENVELOPE, ciphertext: b64(ENVELOPE_MAX_CIPHERTEXT_BYTES) })).toBe(true)
    expect(validEnvelope({ ...ENVELOPE, ciphertext: b64(ENVELOPE_MAX_CIPHERTEXT_BYTES + 1) })).toBe(false)
    const s = await startServer()
    const issued = await allocate(s)
    const big = { envelope: { ...ENVELOPE, ciphertext: b64(ENVELOPE_MAX_CIPHERTEXT_BYTES) } }
    expect(JSON.stringify(big).length).toBeGreaterThan(8 * 1024)
    expect((await put(s, issued.code, issued.uploadToken, big)).status).toBe(204)
    const other = await allocate(s)
    const huge = JSON.stringify({ envelope: ENVELOPE, pad: 'x'.repeat(10 * 1024) })
    expect((await put(s, other.code, other.uploadToken, huge)).status).toBe(413)
  })

  it('counts a pending lookup and an unknown upload as misses', async () => {
    const s = await startServer()
    const plain = await (await s.create()).json()
    const issued = await allocate(s)
    for (let i = 0; i < LIMITS.missesPerMinute / 2; i++) {
      expect((await s.request('GET', `/codes/${issued.code}`)).status).toBe(404)
      expect((await put(s, unusedCode(i), issued.uploadToken)).status).toBe(404)
    }
    expect((await s.request('GET', `/codes/${plain.code}`)).status).toBe(429)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(429)
  })

  it('spends the lookup budget on uploads', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    for (let i = 0; i < LIMITS.lookupsPerMinute; i++) expect((await put(s, issued.code, 'A'.repeat(43))).status).toBe(403)
    expect((await put(s, issued.code, issued.uploadToken)).status).toBe(429)
  })

  it('counts a pending code against the live bound and the creation limits', async () => {
    const s = await startServer({ maxLive: 1 })
    await allocate(s)
    const full = await s.create({ sealed: true, expires: T0S + 3600 })
    expect(full.status).toBe(503)
    expect((await s.create()).status).toBe(503)
  })

  it('discards a lapsed pending code at start, from what is on disk', async () => {
    const storePath = tempStore()
    const now = clock()
    const first = await startServer({ storePath, now })
    const issued = await allocate(first)
    await new Promise((resolve) => first.server.close(resolve))
    now.advance(PENDING_SECONDS * 1000)
    const second = await startServer({ storePath, now })
    expect(second.server.records.size).toBe(0)
    expect((await put(second, issued.code, issued.uploadToken)).status).toBe(404)
  })

  it('logs status and route only, never a token or an envelope', async () => {
    const s = await startServer()
    const issued = await allocate(s)
    await put(s, issued.code, issued.uploadToken)
    await s.request('GET', `/codes/${issued.code}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const line of s.lines) {
      expect(line).toMatch(/^meeting-codes: \d{3} (GET|POST|PUT) \/codes(\/:code)?$/)
      for (const secret of [issued.code, issued.uploadToken, issued.deleteToken, ENVELOPE.ciphertext, ENVELOPE.salt]) expect(line).not.toContain(secret)
    }
  })
})

describe('abuse limits', () => {
  it('limits creation to 10 a minute and 100 a day per address', async () => {
    const now = clock()
    const { create } = await startServer({ now })
    const mk = () => create({ link: LINK, expires: Math.floor(now() / 1000) + 3600 })
    for (let i = 0; i < LIMITS.createPerMinute; i++) expect((await mk()).status).toBe(201)
    expect((await mk()).status).toBe(429)
    expect((await create(undefined, { ip: '203.0.113.2' })).status).toBe(201)
    let made = LIMITS.createPerMinute
    while (made < LIMITS.createPerDay) {
      now.advance(60_000)
      for (let i = 0; i < LIMITS.createPerMinute && made < LIMITS.createPerDay; i++, made++) {
        expect((await mk()).status).toBe(201)
      }
    }
    now.advance(60_000)
    expect((await mk()).status).toBe(429)
  })

  it('limits lookups to 30 a minute per address', async () => {
    const now = clock()
    const { create, request } = await startServer({ now })
    const { code } = await (await create()).json()
    for (let i = 0; i < LIMITS.lookupsPerMinute; i++) expect((await request('GET', `/codes/${code}`)).status).toBe(200)
    expect((await request('GET', `/codes/${code}`)).status).toBe(429)
    expect((await request('GET', `/codes/${code}`, { ip: '198.51.100.9' })).status).toBe(200)
    now.advance(60_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(200)
  })

  it('answers 429 to every lookup from an address after 10 misses in a minute, until the minute passes', async () => {
    const now = clock()
    const { create, request } = await startServer({ now })
    const { code } = await (await create()).json()
    for (let i = 0; i < LIMITS.missesPerMinute; i++) {
      expect((await request('GET', `/codes/${unusedCode(i)}`)).status).toBe(404)
    }
    expect((await request('GET', `/codes/${code}`)).status).toBe(429)
    expect((await request('GET', `/codes/${code}`, { ip: '198.51.100.9' })).status).toBe(200)
    now.advance(60_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(200)
  })

  it('answers 429 after 50 misses in an hour', async () => {
    const now = clock()
    const { create, request } = await startServer({ now })
    const { code } = await (await create({ link: LINK, expires: T0S + 7200 })).json()
    for (let i = 0; i < LIMITS.missesPerHour; i++) {
      if (i > 0 && i % LIMITS.missesPerMinute === 0) now.advance(60_000)
      expect((await request('GET', `/codes/${unusedCode(i)}`)).status).toBe(404)
    }
    now.advance(60_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(429)
    now.advance(60 * 60_000)
    expect((await request('GET', `/codes/${code}`)).status).toBe(200)
  })

  it('counts a DELETE of an unknown code as a miss', async () => {
    const { create, request } = await startServer()
    const { code } = await (await create()).json()
    for (let i = 0; i < LIMITS.missesPerMinute; i++) {
      expect((await request('DELETE', `/codes/${unusedCode(i)}`)).status).toBe(404)
    }
    expect((await request('GET', `/codes/${code}`)).status).toBe(429)
    expect((await request('DELETE', `/codes/${code}`)).status).toBe(429)
  })

  it('does not count a 410 as a miss', async () => {
    const { create, request } = await startServer()
    const { code, deleteToken } = await (await create()).json()
    await request('DELETE', `/codes/${code}`, { headers: { authorization: `Bearer ${deleteToken}` } })
    for (let i = 0; i < LIMITS.missesPerMinute + 5; i++) expect((await request('GET', `/codes/${code}`)).status).toBe(410)
  })

  it('stops every lookup once 200 misses a minute arrive from many addresses', async () => {
    const now = clock()
    const { create, request } = await startServer({ now })
    const { code } = await (await create()).json()
    const perAddress = LIMITS.missesPerMinute
    for (let i = 0; i < LIMITS.globalMissesPerMinute; i++) {
      const ip = `192.0.2.${Math.floor(i / perAddress)}`
      expect((await request('GET', `/codes/${unusedCode(i)}`, { ip })).status).toBe(404)
    }
    // An address that has missed nothing, asking for a code that exists.
    expect((await request('GET', `/codes/${code}`, { ip: '198.51.100.77' })).status).toBe(429)
    now.advance(60_000)
    expect((await request('GET', `/codes/${code}`, { ip: '198.51.100.77' })).status).toBe(200)
  })

  it('trusts only the last X-Forwarded-For hop', async () => {
    const { create, request } = await startServer()
    const { code } = await (await create()).json()
    for (let i = 0; i < LIMITS.missesPerMinute; i++) {
      // A client prepending its own forged entry on every request.
      const ip = `10.0.0.${i}, 203.0.113.1`
      expect((await request('GET', `/codes/${unusedCode(i)}`, { ip })).status).toBe(404)
    }
    expect((await request('GET', `/codes/${code}`, { ip: '10.9.9.9, 203.0.113.1' })).status).toBe(429)
  })

  it('keys IPv6 by /64', async () => {
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'))
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'))
    expect(addressKey('::ffff:192.0.2.1')).toBe('192.0.2.1')
    const { create, request } = await startServer()
    const { code } = await (await create()).json()
    for (let i = 0; i < LIMITS.missesPerMinute; i++) {
      expect((await request('GET', `/codes/${unusedCode(i)}`, { ip: `2001:db8:1:2::${i + 1}` })).status).toBe(404)
    }
    expect((await request('GET', `/codes/${code}`, { ip: '2001:db8:1:2:ffff::9' })).status).toBe(429)
  })
})

describe('storage', () => {
  it('survives a crash between writing the temp file and the rename', async () => {
    const storePath = tempStore()
    let crash = false
    const crashingFs = {
      ...fs,
      renameSync(from, to) {
        if (crash) throw Object.assign(new Error('simulated crash'), { code: 'ESIMULATED' })
        return fs.renameSync(from, to)
      },
    }
    const first = await startServer({ storePath, fs: crashingFs })
    const kept = await (await first.create()).json()
    const before = fs.readFileSync(storePath, 'utf8')

    crash = true
    const failed = await first.create()
    expect(failed.status).toBe(500)
    // The new record reached the temp file and nowhere else.
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(true)
    expect(fs.readFileSync(storePath, 'utf8')).toBe(before)
    expect(first.server.records.size).toBe(1)
    await new Promise((resolve) => first.server.close(resolve))

    // A restart loads the last complete store and discards the torn write.
    const second = await startServer({ storePath })
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(false)
    expect([...second.server.records.keys()]).toEqual([kept.code])
    expect((await second.request('GET', `/codes/${kept.code}`)).status).toBe(200)
  })

  it('ignores a garbage temp file left beside a good store, and one with no store', async () => {
    const storePath = tempStore()
    const first = await startServer({ storePath })
    const { code } = await (await first.create()).json()
    await new Promise((resolve) => first.server.close(resolve))
    fs.writeFileSync(`${storePath}.tmp`, '{"version":1,"records":[{"code":"tor')
    const second = await startServer({ storePath })
    expect((await second.request('GET', `/codes/${code}`)).status).toBe(200)

    const lonely = tempStore()
    fs.writeFileSync(`${lonely}.tmp`, 'garbage')
    const third = await startServer({ storePath: lonely })
    expect(third.server.records.size).toBe(0)
  })

  it('refuses to start on a corrupt store rather than forget its codes, without quoting it', () => {
    const storePath = tempStore()
    fs.writeFileSync(storePath, `{"version":1,"records":[{"code":"ABCDEFGH","link":"${LINK}"`)
    let message = ''
    try {
      createMeetingCodesServer({ storePath, log: () => {} })
    } catch (err) {
      message = err.message
    }
    expect(message).toMatch(/not valid JSON - refusing to start/)
    expect(message).not.toContain(LINK)
    expect(message).not.toContain('ABCDEFGH')
  })

  it('bounds the store at 20,000 live codes, 200,000 tombstones and 2,000 creations a day by default', () => {
    expect(MAX_LIVE).toBe(20_000)
    expect(MAX_TOMBSTONES).toBe(200_000)
    expect(MAX_CREATED_PER_DAY).toBe(2_000)
  })

  it('refuses creation when the live store is full, and evicts nothing', async () => {
    const now = clock()
    const { create, request, server } = await startServer({ now, maxLive: 3 })
    const made = []
    for (let i = 0; i < 3; i++) made.push(await (await create()).json())
    const full = await create()
    expect(full.status).toBe(503)
    expect(await full.json()).toEqual({ error: 'store full' })
    expect(server.records.size).toBe(3)
    for (const { code } of made) expect((await request('GET', `/codes/${code}`)).status).toBe(200)

    // Ending a code frees a live slot; its tombstone counts separately.
    await request('DELETE', `/codes/${made[0].code}`, { headers: { authorization: `Bearer ${made[0].deleteToken}` } })
    expect((await create()).status).toBe(201)
    expect((await request('GET', `/codes/${made[0].code}`)).status).toBe(410)
  })

  it('refuses creation when the tombstone store is full, until tombstones age out', async () => {
    const now = clock()
    const { create, request, server } = await startServer({ now, maxTombstones: 2 })
    const end = ({ code, deleteToken }) =>
      request('DELETE', `/codes/${code}`, { headers: { authorization: `Bearer ${deleteToken}` } })
    const a = await (await create()).json()
    const b = await (await create()).json()
    await end(a)
    const c = await (await create()).json() // one tombstone: still room
    expect(c.code).toBeDefined()
    await end(b)
    const full = await create()
    expect(full.status).toBe(503)
    expect(await full.json()).toEqual({ error: 'store full' })

    expect((await request('GET', `/codes/${c.code}`)).status).toBe(200)

    now.advance((3600 + TOMBSTONE_SECONDS + 1) * 1000)
    server.sweep()
    expect((await create()).status).toBe(201)
  })

  it('caps creation service-wide at 2,000 a rolling day, answering 503', async () => {
    const now = clock()
    const { create } = await startServer({ now, maxCreatedPerDay: 5 })
    const mk = (i) => create({ link: LINK, expires: Math.floor(now() / 1000) + 3600 }, { ip: `192.0.2.${i}` })
    for (let i = 0; i < 3; i++) expect((await mk(i)).status).toBe(201)
    now.advance(12 * 3600_000)
    for (let i = 3; i < 5; i++) expect((await mk(i)).status).toBe(201)
    const capped = await mk(9)
    expect(capped.status).toBe(503)
    expect(await capped.json()).toEqual({ error: 'daily creation limit reached' })
    // Rolling: the first three leave the window 24 hours after they were made.
    now.advance(12 * 3600_000 - 1)
    expect((await mk(10)).status).toBe(503)
    now.advance(1)
    for (let i = 11; i < 14; i++) expect((await mk(i)).status).toBe(201)
    expect((await mk(14)).status).toBe(503)
  })

  it('does not count a refused creation against the daily cap', async () => {
    const { create } = await startServer({ maxCreatedPerDay: 1 })
    expect((await create({ link: 'https://evil.example/j/#x', expires: T0S + 60 })).status).toBe(400)
    expect((await create()).status).toBe(201)
  })
})

describe('HTTP surface', () => {
  it('answers health on loopback only', async () => {
    const { request } = await startServer()
    const res = await request('GET', '/codes/health', { ip: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Anything that came through a proxy is answered as if the path did not exist.
    expect((await request('GET', '/codes/health')).status).toBe(404)
  })

  it('sends Cache-Control: no-store on every answer', async () => {
    const { create, request } = await startServer()
    const created = await create()
    const { code } = await created.clone().json()
    for (const res of [
      created,
      await request('GET', `/codes/${code}`),
      await request('GET', `/codes/${otherCode(code)}`),
      await request('GET', '/codes/nonsense'),
      await request('DELETE', `/codes/${code}`),
      await request('OPTIONS', '/codes', { headers: { origin: 'https://kithmoot.app' } }),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('allows only the two KithMoot origins', async () => {
    const { create, request } = await startServer()
    for (const origin of ['https://kithmoot.forgesworn.dev', 'https://kithmoot.app']) {
      const res = await create(undefined, { headers: { origin } })
      expect(res.status).toBe(201)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    }
    for (const origin of ['https://evil.example', 'http://kithmoot.app', 'https://kithmoot.app.evil.example', 'null']) {
      const res = await request('GET', '/codes/ABCDEFGH', { headers: { origin } })
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('answers a preflight for POST with JSON and DELETE with a bearer token', async () => {
    const { request } = await startServer()
    const origin = 'https://kithmoot.forgesworn.dev'
    const post = await request('OPTIONS', '/codes', { headers: { origin } })
    expect(post.status).toBe(204)
    expect(post.headers.get('access-control-allow-methods')).toContain('POST')
    expect(post.headers.get('access-control-allow-headers')).toMatch(/Content-Type/)
    const del = await request('OPTIONS', '/codes/ABCDEFGH', { headers: { origin } })
    expect(del.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(del.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(del.headers.get('access-control-allow-headers')).toMatch(/Authorization/)
  })

  it('logs status and route only, never a code, link or token', async () => {
    const { create, request, lines } = await startServer()
    const { code, deleteToken } = await (await create()).json()
    await request('GET', `/codes/${code}`)
    await request('GET', `/codes/${formatCode(code).toLowerCase()}`)
    await request('GET', `/codes/${otherCode(code)}`)
    await request('GET', '/codes/%E0%A4%A')
    await request('DELETE', `/codes/${code}`, { headers: { authorization: `Bearer ${deleteToken}` } })
    await request('POST', '/codes', { body: { link: `${LINK}x`, expires: 'soon' } })
    // Wait for the last 'finish' events to be logged.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(lines.length).toBeGreaterThanOrEqual(7)
    const fragment = LINK.split('#')[1]
    for (const line of lines) {
      expect(line).toMatch(/^meeting-codes: \d{3} (GET|POST|DELETE) \/codes(\/:code)?$/)
      for (const secret of [code, otherCode(code), formatCode(code), code.toLowerCase(), LINK, fragment, deleteToken]) {
        expect(line.toLowerCase()).not.toContain(secret.toLowerCase())
      }
    }
  })
})
