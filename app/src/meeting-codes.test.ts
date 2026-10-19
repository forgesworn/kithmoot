import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { memoryDeviceStore } from './device-store.js'
import {
  MEETING_CODE_WRONG_WORDS, PASSWORD_WORDS, WrongPasswordError, generatePasswordWords, issueSealedMeetingCode, openInvitation,
  parsePasswordFragment, parsePasswordWords, passwordAdditionalData, passwordFragment, readCodeArrival, sealInvitation, validSealedInvitation,
  type MeetingCodeClient, type SealedInvitation,
} from './meeting-codes.js'
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

  it('carries the password words in the fragment, and nowhere else, when given them', () => {
    expect(meetingCodeLink('abc-def-gh', 'Ability  ZOO jasmine forget')).toBe('https://kithmoot.app/c/ABCDEFGH#ability-zoo-jasmine-forget')
    const link = new URL(meetingCodeLink('ABCDEFGH', 'ability zoo jasmine forget'))
    expect(link.search).toBe('')
    expect(link.pathname).toBe('/c/ABCDEFGH')
    expect(() => meetingCodeLink('ABCDEFGH', 'not words')).toThrow()
    expect(() => meetingCodeLink('ABCDEFGH', '')).toThrow()
  })
})

describe('eligibility and expiry', () => {
  const now = 1_800_000_000
  it('offers a code to any room that has not ended', () => {
    expect(meetingCodeEligible({ now })).toBe(true)
    expect(meetingCodeEligible({ endsAt: now + 60, now })).toBe(true)
    expect(meetingCodeEligible({ endsAt: now, now })).toBe(false)
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

describe('password words', () => {
  it('pins the frozen foregather en-v1 list: 2,048 words and its SHA-256', () => {
    const text = readFileSync(new URL('./meeting-code-words-en-v1.txt', import.meta.url), 'utf8')
    expect(createHash('sha256').update(text).digest('hex')).toBe('0334930ebdfbc76e81ec914515d7567ca85738a6bf3069249d97df951d44661c')
    expect(PASSWORD_WORDS.length).toBe(2048)
    expect(PASSWORD_WORDS.join('\n')).toBe(text)
    expect(new Set(PASSWORD_WORDS).size).toBe(2048)
    for (const word of PASSWORD_WORDS) expect(word).toMatch(/^[a-z]+$/)
    expect(PASSWORD_WORDS[0]).toBe('ability')
    expect(PASSWORD_WORDS[2047]).toBe('zoo')
  })

  it('takes the low 11 bits of each 16-bit value, so every index is reachable and none favoured', () => {
    const pick = (values: number[]) => generatePasswordWords(array => { array.set(values); return array })
    expect(pick([0, 2047, 2048, 0xffff])).toBe(['ability', 'zoo', 'ability', 'zoo'].join(' '))
    // Exactly 32 of the 65,536 values land on each index: masking, not modulo.
    const hits = new Array(2048).fill(0)
    for (let v = 0; v < 65536; v++) hits[v & 0x7ff]++
    expect(new Set(hits)).toEqual(new Set([32]))
    for (let i = 0; i < 2048; i += 97) expect(pick([i, i + 2048, i + 4096, i + 63488]).split(' ')).toEqual(Array(4).fill(PASSWORD_WORDS[i]))
  })

  it('generates four list words from the platform CSPRNG', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const words = generatePasswordWords()
      expect(parsePasswordWords(words)).toBe(words)
      expect(words.split(' ')).toHaveLength(4)
      for (const word of words.split(' ')) seen.add(word)
    }
    expect(seen.size).toBeGreaterThan(300)
  })

  it.each([
    ['ability zoo jasmine forget', 'ability zoo jasmine forget'],
    ['ABILITY Zoo jasmine FORGET', 'ability zoo jasmine forget'],
    ['  ability zoo jasmine forget\n', 'ability zoo jasmine forget'],
    ['ability-zoo-jasmine-forget', 'ability zoo jasmine forget'],
    ['ability, zoo, jasmine, forget', 'ability zoo jasmine forget'],
    ['ability\t\tzoo   jasmine\nforget', 'ability zoo jasmine forget'],
    ['ability - zoo , jasmine,forget', 'ability zoo jasmine forget'],
    ['ability zoo jasmine', undefined], // three
    ['ability zoo jasmine forget zoo', undefined], // five
    ['ability zoo jasmine forgot', undefined], // not in the list: no near match
    ['abilty zoo jasmine forget', undefined], // a typo is not corrected
    ['ability zoo jasmine forget.', undefined],
    ['ability_zoo_jasmine_forget', undefined],
    ['abilityzoo jasmine forget', undefined],
    ['ability zoo jasmine forgét', undefined],
    ['ability zoo jasmine ｆorget', undefined],
    ['', undefined],
    ['   ', undefined],
  ])('parses %j as %j', (typed, expected) => {
    expect(parsePasswordWords(typed)).toBe(expected)
  })
})

describe('password words in a link fragment', () => {
  const WORDS = 'ability zoo jasmine forget'

  it('joins the canonical words with hyphens, lowercase, without a leading #', () => {
    expect(passwordFragment(WORDS)).toBe('ability-zoo-jasmine-forget')
    expect(passwordFragment('  ABILITY, Zoo - jasmine forget\n')).toBe('ability-zoo-jasmine-forget')
    expect(() => passwordFragment('ability zoo jasmine')).toThrow()
    expect(() => passwordFragment('ability zoo jasmine forgot')).toThrow()
    expect(() => passwordFragment('')).toThrow()
  })

  it('round-trips the canonical words exactly, whether or not the # is kept', () => {
    expect(parsePasswordFragment('#ability-zoo-jasmine-forget')).toBe(WORDS)
    expect(parsePasswordFragment('ability-zoo-jasmine-forget')).toBe(WORDS)
    // Every word in the list, in every position, survives the round trip.
    for (let i = 0; i < PASSWORD_WORDS.length; i++) {
      const words = [PASSWORD_WORDS[i], PASSWORD_WORDS[(i * 7 + 1) % 2048], PASSWORD_WORDS[(i * 31 + 5) % 2048], PASSWORD_WORDS[2047 - i]].join(' ')
      expect(parsePasswordFragment('#' + passwordFragment(words))).toBe(words)
      expect(passwordFragment(words)).not.toMatch(/[^a-z-]/)
    }
    for (let n = 0; n < 50; n++) {
      const words = generatePasswordWords()
      expect(parsePasswordFragment(new URL('https://kithmoot.app/c/ABCDEFGH#' + passwordFragment(words)).hash)).toBe(words)
    }
  })

  it.each([
    ['', 'empty'],
    ['#', 'a bare #'],
    ['#ability-zoo-jasmine', 'three words'],
    ['#ability-zoo-jasmine-forget-zoo', 'five words'],
    ['#ability-zoo-jasmine-forgot', 'a word outside the list'],
    ['#abilty-zoo-jasmine-forget', 'a misspelt word, which is never corrected'],
    ['#ABILITY-ZOO-JASMINE-FORGET', 'upper case'],
    ['#Ability-zoo-jasmine-forget', 'mixed case'],
    ['#ability zoo jasmine forget', 'spaces'],
    ['#ability%20zoo%20jasmine%20forget', 'percent-encoded spaces'],
    ['#ability%2Dzoo%2Djasmine%2Dforget', 'percent-encoded hyphens'],
    ['#ability+zoo+jasmine+forget', 'plus signs'],
    ['#ability,zoo,jasmine,forget', 'commas'],
    ['#ability_zoo_jasmine_forget', 'underscores'],
    ['#ability--zoo-jasmine-forget', 'a doubled hyphen'],
    ['#-ability-zoo-jasmine-forget', 'a leading hyphen'],
    ['#ability-zoo-jasmine-forget-', 'a trailing hyphen'],
    ['#ability-zoo-jasmine-forget.', 'trailing punctuation'],
    ['#ability-zoo-jasmine-forget\n', 'a trailing newline'],
    ['#ability-zoo-jasmine-forget&x=1', 'a trailing parameter'],
    ['##ability-zoo-jasmine-forget', 'a doubled #'],
    ['#abilityzoojasmineforget', 'no separators'],
    ['#ability-zoo-jasmine-forgét', 'a non-ASCII letter'],
    ['#ability-zoo-jasmine-ｆorget', 'a full-width letter'],
    ['#' + 'a'.repeat(100), 'a very long run'],
    ['#eyJ2IjozfQ', 'an invitation fragment'],
  ])('refuses %j (%s)', (hash) => {
    expect(parsePasswordFragment(hash)).toBeUndefined()
  })

  it('opens a sealed invitation with the words read back from the fragment', async () => {
    const LINK = 'https://kithmoot.forgesworn.dev/j/#r=room&k=secret'
    const words = generatePasswordWords()
    const envelope = await sealInvitation({ link: LINK, words, code: 'K7M2Q9TX', expires: 1_900_000_000 })
    const read = parsePasswordFragment(new URL(meetingCodeLink('K7M2Q9TX', words)).hash)
    expect(read).toBe(words)
    expect(await openInvitation({ envelope, words: read!, code: 'K7M2Q9TX', expires: 1_900_000_000 })).toBe(LINK)
  })
})

describe('reading the words from the join page address', () => {
  const never = () => { throw new Error('should not be asked') }
  const room = (href: string) => new URL(href).hash.startsWith('#eyJ')

  it('takes valid words from a code arrival and leaves the address without them', () => {
    expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/?c=K7M2Q9TX#ability-zoo-jasmine-forget', never))
      .toEqual({ words: 'ability zoo jasmine forget', cleaned: '/j/?c=K7M2Q9TX' })
    expect(readCodeArrival('http://localhost:4173/?c=K7M2Q9TX&x=1#ability-zoo-jasmine-forget', never))
      .toEqual({ words: 'ability zoo jasmine forget', cleaned: '/?c=K7M2Q9TX&x=1' })
  })

  it('does nothing without a code or without a fragment', () => {
    expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/#ability-zoo-jasmine-forget', never)).toBeUndefined()
    expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/?c=K7M2Q9TX', never)).toBeUndefined()
    expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/?c=K7M2Q9TX#', never)).toBeUndefined()
    expect(readCodeArrival('not a url', never)).toBeUndefined()
  })

  it('leaves a room link alone, as it was opened before words existed', () => {
    expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/?c=K7M2Q9TX#eyJ2IjozfQeyJ2IjozfQ', room)).toBeUndefined()
  })

  it('drops a fragment that is neither words nor a room link, so the person is asked for the words', () => {
    for (const hash of ['#ability-zoo-jasmine', '#ability-zoo-jasmine-forget.', '#ABILITY-ZOO-JASMINE-FORGET', '#x']) {
      expect(readCodeArrival('https://kithmoot.forgesworn.dev/j/?c=K7M2Q9TX' + hash, room), hash).toEqual({ cleaned: '/j/?c=K7M2Q9TX' })
    }
  })
})

describe('password envelope', () => {
  const WORDS = 'ability zoo jasmine forget'
  const LINK = 'https://kithmoot.forgesworn.dev/j/#r=room&k=secret'
  const CODE = 'K7M2Q9TX'
  const EXPIRES = 1792000000

  it('binds the canonical code and the expiry', () => {
    expect(passwordAdditionalData('k7m-2q9-tx', EXPIRES)).toBe('kithmoot-meeting-code/v1:K7M2Q9TX:1792000000')
    expect(() => passwordAdditionalData('ABCDEFGI', EXPIRES)).toThrow()
  })

  it('opens what it sealed, with the words typed any accepted way, and fails every alteration', async () => {
    const envelope = await sealInvitation({ link: LINK, words: WORDS, code: CODE, expires: EXPIRES })
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'nonce', 'salt', 'v'])
    expect(validSealedInvitation(envelope)).toBe(true)
    expect(JSON.stringify(envelope)).not.toContain('secret')
    expect(await openInvitation({ envelope, words: 'ABILITY-zoo, jasmine  forget ', code: 'k7m-2q9-tx', expires: EXPIRES })).toBe(LINK)

    const fails = async (args: Partial<{ envelope: SealedInvitation; words: string; code: string; expires: number }>) => {
      const error = await openInvitation({ envelope, words: WORDS, code: CODE, expires: EXPIRES, ...args }).catch(e => e)
      expect(error).toBeInstanceOf(WrongPasswordError)
      expect(error.message).toBe(MEETING_CODE_WRONG_WORDS)
    }
    await fails({ words: 'ability zoo jasmine zoo' }) // wrong words
    await fails({ words: 'ability zoo jasmine' }) // not a password at all
    await fails({ code: 'K7M2Q9TY' }) // another code
    await fails({ expires: EXPIRES + 1 }) // another expiry
    const flip = (text: string) => (text[0] === 'A' ? 'B' : 'A') + text.slice(1)
    await fails({ envelope: { ...envelope, ciphertext: flip(envelope.ciphertext) } })
    await fails({ envelope: { ...envelope, nonce: flip(envelope.nonce) } })
    await fails({ envelope: { ...envelope, salt: flip(envelope.salt) } })
  }, 30_000)

  it('uses a fresh salt and nonce each time', async () => {
    const a = await sealInvitation({ link: LINK, words: WORDS, code: CODE, expires: EXPIRES })
    const b = await sealInvitation({ link: LINK, words: WORDS, code: CODE, expires: EXPIRES })
    expect(a.salt).not.toBe(b.salt)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  }, 20_000)

  it('refuses envelopes outside the service bounds', () => {
    const ok = { v: 1, salt: 'AAECAwQFBgcICQoLDA0ODw', nonce: 'oKGio6Slpqeoqaqr', ciphertext: 'A'.repeat(23) }
    expect(validSealedInvitation(ok)).toBe(true)
    for (const bad of [
      { ...ok, v: 2 }, { ...ok, extra: 1 }, { ...ok, salt: `${ok.salt}==` }, { ...ok, salt: ok.salt.slice(0, -1) + 'x' },
      { ...ok, nonce: 'oKGio6Slpqeo' }, { ...ok, ciphertext: 'A'.repeat(21) }, { ...ok, ciphertext: 'A'.repeat(8195) }, { ...ok, ciphertext: 'AA+A'.repeat(6) }, null, [],
    ]) expect(validSealedInvitation(bad), JSON.stringify(bad)).toBe(false)
  })

  it('allocates, seals for the allocated code, uploads, and deletes the pending code if the upload fails', async () => {
    const calls: string[] = []
    let uploaded: SealedInvitation | undefined
    const client = (failUpload: boolean): MeetingCodeClient => ({
      create: async () => { throw new Error('not used') },
      allocate: async expires => { calls.push(`allocate ${expires}`); return { code: CODE, expires, deleteToken: 'del', uploadToken: 'up' } },
      upload: async (code, token, envelope) => {
        calls.push(`upload ${code} ${token}`)
        if (failUpload) throw new Error('refused')
        uploaded = envelope
      },
      resolve: async () => { throw new Error('not used') },
      remove: async (code, token) => { calls.push(`remove ${code} ${token}`); return true },
    })
    const issued = await issueSealedMeetingCode(client(false), LINK, EXPIRES, 'Ability Zoo Jasmine Forget')
    expect(issued).toEqual({ code: CODE, expires: EXPIRES, deleteToken: 'del', words: WORDS })
    expect(await openInvitation({ envelope: uploaded!, words: WORDS, code: CODE, expires: EXPIRES })).toBe(LINK)
    expect(calls).toEqual([`allocate ${EXPIRES}`, `upload ${CODE} up`])

    calls.length = 0
    await expect(issueSealedMeetingCode(client(true), LINK, EXPIRES, WORDS)).rejects.toThrow('refused')
    expect(calls).toEqual([`allocate ${EXPIRES}`, `upload ${CODE} up`, `remove ${CODE} del`])
  }, 30_000)

  it('speaks the sealed contract: POST {sealed, expires}, PUT the envelope, GET it back', async () => {
    const envelope: SealedInvitation = { v: 1, salt: 'AAECAwQFBgcICQoLDA0ODw', nonce: 'oKGio6Slpqeoqaqr', ciphertext: 'A'.repeat(23) }
    const calls: { url: string; init: RequestInit }[] = []
    const answers = [
      new Response(JSON.stringify({ code: 'ABCDEFGH', expires: 99, deleteToken: 'del', uploadToken: 'up' }), { status: 201 }),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ envelope, expires: 99 }), { status: 200 }),
      new Response(JSON.stringify({ code: 'ABCDEFGH', expires: 99, deleteToken: 'del' }), { status: 201 }),
      new Response(null, { status: 409 }),
      new Response(JSON.stringify({ envelope: { ...envelope, v: 2 }, expires: 99 }), { status: 200 }),
    ]
    const client = meetingCodeClient({ fetch: async (url, init) => { calls.push({ url, init: init! }); return answers.shift()! } })
    expect(await client.allocate(99)).toEqual({ code: 'ABCDEFGH', expires: 99, deleteToken: 'del', uploadToken: 'up' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sealed: true, expires: 99 })
    await client.upload('ABCDEFGH', 'up', envelope)
    expect(calls[1]!.url).toBe('/codes/ABCDEFGH')
    expect(calls[1]!.init.method).toBe('PUT')
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer up')
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ envelope })
    expect(await client.resolve('ABCDEFGH')).toEqual({ envelope, expires: 99 })
    // No upload token: not an allocation this app understands.
    expect(await client.allocate(99).catch(e => e)).toBeInstanceOf(MeetingCodeError)
    expect(await client.upload('ABCDEFGH', 'up', envelope).catch(e => e)).toBeInstanceOf(MeetingCodeError)
    expect(await client.resolve('ABCDEFGH').catch(e => e)).toBeInstanceOf(MeetingCodeNetworkError)
  })

  it('keeps the words with the host record, and not on the delete queue', () => {
    const store = memoryDeviceStore()
    const now = 1000
    storeMeetingCode(store, 'inv1', { code: CODE, expires: now + 60, deleteToken: 'del', roomId: 'room1', words: WORDS })
    expect(loadMeetingCode(store, 'inv1', now)?.words).toBe(WORDS)
    store.set('kithmoot.meeting-code.v1.inv2', JSON.stringify({ code: CODE, expires: now + 60, deleteToken: 'del', roomId: 'room1', words: 'not words' }))
    expect(loadMeetingCode(store, 'inv2', now)).toBeUndefined()
    retireMeetingCodes(store, { invitationId: 'inv1' }, now)
    expect(store.get(MEETING_CODE_RETIRE_KEY)).not.toContain('ability')
    expect(pendingRetirements(store, now).map(r => r.code)).toEqual([CODE])
  })
})
