import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as fs from 'node:fs'
import {
  ALPHABET,
  LIMITS,
  MAX_RECORDS,
  TOMBSTONE_SECONDS,
  addressKey,
  createMeetingCodesServer,
  formatCode,
  generateCode,
  loadConfigFromEnv,
  parseCode,
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
      headers: { 'x-forwarded-for': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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

  it('defaults to loopback on 8094', () => {
    expect(loadConfigFromEnv({ MEETING_CODES_STORE: '/x/codes.json' })).toEqual({
      storePath: '/x/codes.json',
      host: '127.0.0.1',
      port: 8094,
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
    expect((await request('PUT', '/codes/ABCDEFGH')).status).toBe(405)
    expect((await request('GET', '/elsewhere')).status).toBe(404)
    expect((await request('GET', '/codes/ABC/DEF')).status).toBe(404)
    expect((await request('GET', '/codes/ABCDEFGI')).status).toBe(400)
  })
})

describe('abuse limits', () => {
  it('limits creation to 10 a minute and 100 a day per address', async () => {
    const now = clock()
    const { create } = await startServer({ now, maxRecords: 1000 })
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

  it('bounds the store at 20,000 records by default', () => {
    expect(MAX_RECORDS).toBe(20_000)
  })

  it('refuses creation when full, counting tombstones, and evicts nothing', async () => {
    const now = clock()
    const { create, request, server } = await startServer({ now, maxRecords: 3 })
    const made = []
    for (let i = 0; i < 3; i++) made.push(await (await create()).json())
    await request('DELETE', `/codes/${made[0].code}`, { headers: { authorization: `Bearer ${made[0].deleteToken}` } })
    const full = await create()
    expect(full.status).toBe(503)
    expect(await full.json()).toEqual({ error: 'store full' })
    expect(server.records.size).toBe(3)
    expect((await request('GET', `/codes/${made[1].code}`)).status).toBe(200)
    expect((await request('GET', `/codes/${made[0].code}`)).status).toBe(410)

    // Room appears only when a tombstone ages out.
    now.advance((3600 + TOMBSTONE_SECONDS + 1) * 1000)
    server.sweep()
    expect((await create()).status).toBe(201)
  })
})

describe('HTTP surface', () => {
  it('answers health', async () => {
    const { request } = await startServer()
    const res = await request('GET', '/codes/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
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
