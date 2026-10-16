import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import {
  MEETING_CODE_ALPHABET, MEETING_CODE_MAX_SECONDS, MEETING_CODES_UNAVAILABLE, MEETING_CODE_PREFIX, MEETING_CODE_RETIRE_KEY, MEETING_ENDED, MEETING_CODE_TOO_MANY, MEETING_CODE_UNKNOWN,
  MeetingCodeError, MeetingCodeNetworkError, displayMeetingCode, drainRetirements, loadMeetingCode, meetingCodeClient, meetingCodeEligible,
  meetingCodeExpiry, meetingCodeLink, parseMeetingCode, pendingRetirements, retireMeetingCodes, returnedJoinFragment, storeMeetingCode,
} from './meeting-codes.js'

describe('meeting code format', () => {
  it('uses the frozen foregather base32-en-v1 alphabet', () => {
    expect(MEETING_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(new Set(MEETING_CODE_ALPHABET).size).toBe(32)
  })

  it('accepts case, surrounding whitespace, no separators or hyphens between triples', () => {
    for (const value of ['ABCDEFGH', 'abcdefgh', 'ABC-DEF-GH', 'abc-def-gh', '  ABC-DEF-GH\n', '\tabcdefgh ', 'aBc-DeF-gH']) {
      expect(parseMeetingCode(value), value).toBe('ABCDEFGH')
    }
    expect(parseMeetingCode('012-345-67')).toBe('01234567')
    expect(parseMeetingCode('XYZ-WVT-SR')).toBe('XYZWVTSR')
  })

  it('rejects ambiguous letters, internal spaces, misplaced hyphens and other lengths', () => {
    for (const value of [
      '', 'ABCDEFGI', 'ABCDEFGL', 'ABCDEFGO', 'ABCDEFGU', 'abcdefgi', 'ABC DEF GH', 'ABC-DEF GH',
      'AB-CDEF-GH', 'ABC-DEF-G-H', 'ABCDEF-GH', 'ABC-DEFGH', '-ABC-DEF-GH', 'ABC-DEF-GH-', 'ABC--DEF-GH',
      'ABCDEFG', 'ABCDEFGHJ', 'ABC-DEF-G', 'ABC-DEF-GHJ', 'ABC–DEF–GH', 'ＡBCDEFGH', 'ABC_DEF_GH', 'x'.repeat(65),
    ]) {
      expect(parseMeetingCode(value), value).toBeUndefined()
    }
  })

  it('displays in triples and links in canonical form', () => {
    expect(displayMeetingCode('abcdefgh')).toBe('ABC-DEF-GH')
    expect(meetingCodeLink('ABC-DEF-GH')).toBe('https://kithmoot.app/c/ABCDEFGH')
    expect(() => displayMeetingCode('ABCDEFGI')).toThrow()
  })
})

describe('eligibility and expiry', () => {
  const now = 1_800_000_000
  it('offers a code to an Ask room or a room with an end, and to nothing else', () => {
    expect(meetingCodeEligible({ ask: true, now })).toBe(true)
    expect(meetingCodeEligible({ ask: false, endsAt: now + 60, now })).toBe(true)
    expect(meetingCodeEligible({ ask: true, endsAt: now + 60, now })).toBe(true)
    expect(meetingCodeEligible({ ask: false, now })).toBe(false)
    expect(meetingCodeEligible({ ask: false, endsAt: now, now })).toBe(false)
  })
  it('never outlives the room, and asks for a minute less than a week at most', () => {
    expect(meetingCodeExpiry(undefined, now)).toBe(now + MEETING_CODE_MAX_SECONDS - 60)
    expect(meetingCodeExpiry(now + 3600, now)).toBe(now + 3600)
    expect(meetingCodeExpiry(now + 7 * 86400, now)).toBe(now + 7 * 86400 - 60)
    expect(meetingCodeExpiry(now + 30 * 86400, now)).toBe(now + 7 * 86400 - 60)
  })
})

describe('returned links', () => {
  it('accepts only a KithMoot join link and gives its fragment', () => {
    expect(returnedJoinFragment('https://kithmoot.forgesworn.dev/j/#abc')).toBe('#abc')
    expect(returnedJoinFragment('https://kithmoot.app/j/#abc')).toBe('#abc')
    for (const link of ['https://kithmoot.forgesworn.dev/j/', 'https://evil.example/j/#abc', 'http://kithmoot.app/j/#abc', 'https://kithmoot.app/j/?x=1#abc',
      'https://u@kithmoot.app/j/#abc', 'https://kithmoot.app/x/#abc', 'javascript:alert(1)#abc', 'not a link']) {
      expect(returnedJoinFragment(link), link).toBeUndefined()
    }
  })
})

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return answer(url, init) }
  return { calls, fetch }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('meeting code client', () => {
  it('creates with the full link and expiry', async () => {
    const { calls, fetch } = fakeFetch(() => json(201, { code: 'ABCDEFGH', expires: 99, deleteToken: 'tok' }))
    const client = meetingCodeClient({ base: 'https://codes.test/codes/', fetch })
    expect(await client.create('https://kithmoot.forgesworn.dev/j/#x', 99)).toEqual({ code: 'ABCDEFGH', expires: 99, deleteToken: 'tok' })
    expect(calls[0]!.url).toBe('https://codes.test/codes')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ link: 'https://kithmoot.forgesworn.dev/j/#x', expires: 99 })
  })

  it('says codes are unavailable when the service is full', async () => {
    const error = await meetingCodeClient({ fetch: async () => json(503, {}) }).create('https://kithmoot.forgesworn.dev/j/#x', 99).catch(e => e)
    expect(error).toBeInstanceOf(MeetingCodeError)
    expect(error.message).toBe('Meeting codes are unavailable right now. Share the full link instead.')
    expect(MEETING_CODES_UNAVAILABLE).toBe(error.message)
  })

  it('maps each lookup answer to its message', async () => {
    const cases: [number, string][] = [[410, MEETING_ENDED], [404, MEETING_CODE_UNKNOWN], [429, MEETING_CODE_TOO_MANY]]
    for (const [status, message] of cases) {
      const client = meetingCodeClient({ fetch: async () => json(status, {}) })
      const error = await client.resolve('ABC-DEF-GH').catch(e => e)
      expect(error).toBeInstanceOf(MeetingCodeError)
      expect(error.message).toBe(message)
    }
    expect(MEETING_ENDED).toBe('This meeting has ended')
    expect(MEETING_CODE_UNKNOWN).toBe('We could not find that code. Check it and try again')
    expect(MEETING_CODE_TOO_MANY).toBe('Too many tries. Wait a minute')
  })

  it('looks up the canonical form and returns the link', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { link: 'https://kithmoot.forgesworn.dev/j/#x', expires: 5 }))
    const client = meetingCodeClient({ fetch })
    expect(await client.resolve(' abc-def-gh ')).toEqual({ link: 'https://kithmoot.forgesworn.dev/j/#x', expires: 5 })
    expect(calls[0]!.url).toBe('/codes/ABCDEFGH')
  })

  it('refuses a malformed code without asking the service', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, {}))
    const error = await meetingCodeClient({ fetch }).resolve('ABCDEFGI').catch(e => e)
    expect(error.message).toBe(MEETING_CODE_UNKNOWN)
    expect(calls).toHaveLength(0)
  })

  it('reports no answer as a network failure', async () => {
    const client = meetingCodeClient({ fetch: async () => { throw new TypeError('offline') } })
    expect(await client.resolve('ABCDEFGH').catch(e => e)).toBeInstanceOf(MeetingCodeNetworkError)
  })

  it('deletes with the bearer token', async () => {
    const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }))
    expect(await meetingCodeClient({ fetch }).remove('ABCDEFGH', 'tok')).toBe(true)
    expect(calls[0]!.url).toBe('/codes/ABCDEFGH')
    expect(calls[0]!.init.method).toBe('DELETE')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(await meetingCodeClient({ fetch: async () => new Response(null, { status: 403 }) }).remove('ABCDEFGH', 'bad')).toBe(false)
  })
})

describe('host records', () => {
  const now = 1_800_000_000
  const record = { code: 'ABCDEFGH', expires: now + 60, deleteToken: 'tok', roomId: 'room1' }

  it('keeps the code and token per invitation, and forgets it once expired', () => {
    const store = memoryDeviceStore()
    storeMeetingCode(store, 'inv1', record)
    expect(loadMeetingCode(store, 'inv1', now)).toEqual(record)
    expect(loadMeetingCode(store, 'inv1', now + 60)).toBeUndefined()
    expect(store.get(MEETING_CODE_PREFIX + 'inv1')).toBeNull()
  })

  it('queues a retired code and drains the queue, keeping failures for later', async () => {
    const store = memoryDeviceStore()
    storeMeetingCode(store, 'inv1', record)
    storeMeetingCode(store, 'inv2', { ...record, code: 'JKMNPQRS', roomId: 'room2' })
    expect(retireMeetingCodes(store, { roomId: 'room1' }, now)).toHaveLength(1)
    expect(loadMeetingCode(store, 'inv1', now)).toBeUndefined()
    expect(loadMeetingCode(store, 'inv2', now)).toBeDefined()
    expect(pendingRetirements(store, now).map(r => r.code)).toEqual(['ABCDEFGH'])

    let up = false
    const client = meetingCodeClient({ fetch: async () => { if (!up) throw new TypeError('offline'); return new Response(null, { status: 204 }) } })
    await drainRetirements(store, client, now)
    expect(pendingRetirements(store, now).map(r => r.code)).toEqual(['ABCDEFGH'])
    up = true
    await drainRetirements(store, client, now)
    expect(store.get(MEETING_CODE_RETIRE_KEY)).toBeNull()
  })

  it('needs no delete for a code that has already expired', () => {
    const store = memoryDeviceStore()
    storeMeetingCode(store, 'inv1', record)
    expect(retireMeetingCodes(store, { invitationId: 'inv1' }, now + 61)).toEqual([])
    expect(store.get(MEETING_CODE_RETIRE_KEY)).toBeNull()
  })
})
