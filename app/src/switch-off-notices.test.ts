import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MEETING_CODES_GONE, MeetingCodeError, MeetingCodeNetworkError, meetingCodeClient, issueSealedMeetingCode } from './meeting-codes.js'
import { RELAY_MISSING_NOTICE, fetchTurnCredential, hasRelay, resolveIceServers } from './ice-resolve.js'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const LINK = 'https://kithmoot.forgesworn.dev/j/#x'

describe('meeting codes when the service is gone', () => {
  it('uses neutral wording and shows no going note', () => {
    expect(MEETING_CODES_GONE).toBe('Meeting codes are unavailable right now. Share the room link instead.')
    expect(html).not.toContain('Meeting codes are going')
  })
  for (const status of [404, 405, 410]) {
    it(`fails cleanly when creating answers ${status}`, async () => {
      const client = meetingCodeClient({ base: '/codes', fetch: async () => reply(status) })
      for (const make of [() => client.create(LINK, 99), () => client.allocate(99), () => issueSealedMeetingCode(client, LINK, 99)]) {
        const error = await make().catch(e => e)
        expect(error).toBeInstanceOf(MeetingCodeError)
        expect(error.message).toBe(MEETING_CODES_GONE)
        expect(error.status).toBe(status)
      }
    })
  }
  it('fails cleanly when the network is down', async () => {
    const client = meetingCodeClient({ base: '/codes', fetch: async () => { throw new TypeError('Failed to fetch') } })
    expect(await client.create(LINK, 99).catch(e => e)).toBeInstanceOf(MeetingCodeNetworkError)
  })
  it('does not hang when the service never answers', async () => {
    const client = meetingCodeClient({ base: '/codes', fetch: () => new Promise<Response>(() => {}), timeoutMs: 30 })
    const started = Date.now()
    expect(await client.create(LINK, 99).catch(e => e)).toBeInstanceOf(MeetingCodeNetworkError)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('still resolves an existing code while the service exists', async () => {
    const client = meetingCodeClient({ base: '/codes', fetch: async () => reply(200, { link: LINK, expires: 5 }) })
    expect(await client.resolve('ABC-DEF-GH')).toEqual({ link: LINK, expires: 5 })
  })
})

describe('calls without a relay', () => {
  const location = { protocol: 'https:', hostname: 'kithmoot.forgesworn.dev' }
  const stunOnly = (servers: RTCIceServer[]) => expect(hasRelay(servers)).toBe(false)
  const mint = (fetch: (input: string, init?: RequestInit) => Promise<Response>) => resolveIceServers([], { endpoint: '/turn', location, fetch, timeoutMs: 40 })

  it('names the notice and puts its element in the call screen', () => {
    expect(RELAY_MISSING_NOTICE).toBe('No call relay is set up on this device, so this call may not connect on some networks. Set one up in Settings › Calls.')
    expect(html).toContain('id="relayMissingNote"')
  })
  for (const status of [404, 410, 500]) {
    it(`returns STUN promptly when the mint answers ${status}`, async () => {
      const servers = await mint(async () => reply(status))
      stunOnly(servers)
      expect(servers.length).toBeGreaterThan(0)
    })
  }
  it('returns STUN when the network fails', async () => {
    stunOnly(await mint(async () => { throw new TypeError('Failed to fetch') }))
  })
  it('returns STUN when the mint never answers, even if fetch ignores abort', async () => {
    const started = Date.now()
    stunOnly(await mint(() => new Promise<Response>(() => {})))
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('returns STUN when there is no endpoint, and never calls fetch', async () => {
    let called = false
    const servers = await resolveIceServers([], { endpoint: undefined, location, fetch: async () => { called = true; return reply(200) } })
    expect(called).toBe(false)
    stunOnly(servers)
  })
  it('still uses a working mint', async () => {
    const servers = await mint(async () => reply(200, { urls: ['turn:kithmoot.forgesworn.dev:3478'], username: 'u', credential: 'c', ttl: 3600 }))
    expect(hasRelay(servers)).toBe(true)
  })
  it('treats malformed JSON as no credential', async () => {
    expect(await fetchTurnCredential('/turn', { fetch: async () => new Response('<html>', { status: 200 }) })).toBeUndefined()
  })
  it('leaves a room that names its own servers alone', async () => {
    expect(await resolveIceServers(['turn:t.example:3478'], { endpoint: '/turn', location, fetch: async () => { throw new Error('no') } })).toEqual([{ urls: 'turn:t.example:3478' }])
  })
})
