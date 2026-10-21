import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { openNewRoomForm, openRoomDetails, openInvite, openRoomInfoPage } from './browser.js'

// Meeting codes (docs/meeting-codes.md) against a mocked /codes service:
// a code reaches the invitation door and never further, each refusal says
// what the spec says, and Get a meeting code is offered only to the
// creator of an Ask room or a room with an end, whose End room deletes it.

async function device(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://relay.ditto.pub']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by meeting code test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) })

/** Envelopes uploaded to the mocked service, shared between a host's and a
 *  guest's contexts as the real service's store would be. */
type Vault = Map<string, { envelope: unknown; expires: number }>

/** A code service answering lookups from a table, recording every request.
 *  A sealed allocation is pending until its PUT, then answers its envelope. */
async function codeService(context: BrowserContext, lookups: Record<string, { status: number; body?: unknown }>, vault: Vault = new Map()): Promise<Request[]> {
  const seen: Request[] = []
  const pending = new Map<string, number>()
  await context.route(/\/codes(\/[^/?#]*)?$/, async route => {
    const request = route.request()
    seen.push(request)
    const code = new URL(request.url()).pathname.split('/')[2]
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      if (body.sealed === true) {
        pending.set('K7M2Q9TX', body.expires)
        return route.fulfill(json(201, { code: 'K7M2Q9TX', expires: body.expires, deleteToken: 'delete-token-1', uploadToken: 'upload-token-1' }))
      }
      return route.fulfill(json(201, { code: 'K7M2Q9TX', expires: body.expires, deleteToken: 'delete-token-1' }))
    }
    if (request.method() === 'PUT') {
      const expires = code ? pending.get(code) : undefined
      if (expires === undefined) return route.fulfill(json(404, {}))
      if (request.headers().authorization !== 'Bearer upload-token-1') return route.fulfill(json(403, {}))
      pending.delete(code!)
      vault.set(code!, { envelope: request.postDataJSON().envelope, expires })
      return route.fulfill({ status: 204, body: '' })
    }
    if (request.method() === 'DELETE') return route.fulfill({ status: 204, body: '' })
    const sealed = code ? vault.get(code) : undefined
    if (sealed) return route.fulfill(json(200, sealed))
    const answer = (code && lookups[code]) || { status: 404, body: {} }
    return route.fulfill(json(answer.status, answer.body ?? {}))
  })
  return seen
}

async function joinWithCode(page: Page, code: string): Promise<void> {
  // The code sheet opens from the start page, or from the New menu once there are chats.
  if (!await page.locator('#joinCode').evaluate(el => (el as HTMLDialogElement).open)) {
    if (await page.locator('#homeJoinCode').isVisible()) await page.locator('#homeJoinCode').click()
    else { await page.locator('#newMenuButton').click(); await page.locator('#newMenuCode').click() }
  }
  await page.locator('#meetingCodeInput').fill(code)
  await page.locator('#meetingCodeInput').press('Enter')
}

test('Join with code opens the invitation door and does not join', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
    const link = encodeJoinUrl('https://kithmoot.forgesworn.dev/j/', generateRoomSecret(), [relay.href])
    const seen = await codeService(context, { K7M2Q9TX: { status: 200, body: { link, expires: Math.floor(Date.now() / 1000) + 3600 } } })
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    await joinWithCode(page, ' k7m-2q9-tx ')
    // The door, with the same fragment, on this app's own join page.
    await expect(page.locator('#join')).toBeVisible()
    expect(new URL(page.url()).hash).toBe(new URL(link).hash)
    expect(new URL(page.url()).search).toBe('')
    await expect(page.locator('#roomArea')).toBeHidden()
    await expect(page.locator('#joinMic')).not.toBeChecked()
    await expect(page.locator('#joinCamera')).not.toBeChecked()
    expect(seen.map(r => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual(['GET /codes/K7M2Q9TX'])

    // kithmoot.app/c/<code> arrives as ?c=<code>: the same path, to the same door.
    await page.goto(new URL('?c=K7M2Q9TX', baseURL!).href)
    await expect(page.locator('#join')).toBeVisible()
    expect(new URL(page.url()).hash).toBe(new URL(link).hash)
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { await context.close() }
})

test('each refusal says what happened, and a network failure offers Retry', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const seen = await codeService(context, {
      ENDED234: { status: 410, body: { state: 'ended' } },
      BZSY2345: { status: 429, body: {} },
    })
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    const error = page.locator('#joinCodeError')

    await joinWithCode(page, 'END-ED2-34')
    await expect(error).toHaveText('This meeting has ended')
    await joinWithCode(page, 'ABCDEFGH')
    await expect(error).toHaveText('We could not find that code. Check it and try again')
    await joinWithCode(page, 'BZSY2345')
    await expect(error).toHaveText('Too many tries. Wait a minute')
    await expect(page.locator('#joinCodeRetry')).toBeHidden()
    // A code that cannot be one is refused here, without asking anybody.
    const asked = seen.length
    await joinWithCode(page, 'ABCDEFGI')
    await expect(error).toHaveText('We could not find that code. Check it and try again')
    expect(seen.length).toBe(asked)

    await context.unroute(/\/codes(\/[^/?#]*)?$/)
    await context.route(/\/codes(\/[^/?#]*)?$/, route => route.abort('internetdisconnected'))
    await joinWithCode(page, 'ABCDEFGH')
    await expect(page.locator('#joinCodeRetry')).toBeVisible()
    await expect(page.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { await context.close() }
})

async function startRoom(page: Page, baseURL: string, setUp: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(baseURL)
  await openNewRoomForm(page)
  await setUp(page)
  await page.locator('#create').click()
  await expect(page.locator('#join')).toBeVisible()
  await page.locator('#displayName').fill('Host')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

test('Get a meeting code is offered to the creator of any room, and End room deletes it', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    // A group room that never ends gets a code too.
    const open = await device(browser, baseURL!); contexts.push(open)
    await codeService(open, {})
    const openPage = await open.newPage()
    await startRoom(openPage, baseURL!, async () => {})
    await openInvite(openPage)
    await expect(openPage.locator('#inviteDialog')).toBeVisible()
    await expect(openPage.locator('#copyShare')).toBeVisible()
    await expect(openPage.locator('#getMeetingCode')).toBeVisible()
    // Without a waiting room, a password is on by default.
    await expect(openPage.locator('#meetingCodePassword')).toHaveAttribute('data-on', 'true')

    // An Ask room is eligible, and stays so when the host lets anyone in.
    const ask = await device(browser, baseURL!); contexts.push(ask)
    await codeService(ask, {})
    const askPage = await ask.newPage()
    await startRoom(askPage, baseURL!, page => page.locator('#roomAsk').check())
    await openInvite(askPage)
    await expect(askPage.locator('#getMeetingCode')).toBeVisible()
    // Behind a waiting room, a password is off by default.
    await expect(askPage.locator('#meetingCodePassword')).toHaveAttribute('data-on', 'false')
    // A full service says so, and the full link stays the way in.
    await ask.route('**/codes', route => route.fulfill({ status: 503, body: '' }))
    await askPage.locator('#getMeetingCode').click()
    await expect(askPage.locator('#meetingCodeStatus')).toHaveText('Meeting codes are unavailable right now. Share the full link instead.')
    await expect(askPage.locator('#meetingCodeShown')).toBeHidden()
    await askPage.locator('#toggleKnock').click()
    await expect(askPage.locator('#toggleKnock')).toHaveAttribute('data-on', 'false')
    await expect(askPage.locator('#getMeetingCode')).toBeVisible()

    // A room with an end: the code is made for its full link, until its end.
    const dated = await device(browser, baseURL!); contexts.push(dated)
    const seen = await codeService(dated, {})
    const page = await dated.newPage()
    await startRoom(page, baseURL!, async page => {
      await page.locator('#roomEnds').selectOption('1')
      await page.locator('#roomWhenEnds').selectOption('keep')
    })
    const link = await page.locator('#shareUrl').inputValue()
    await openInvite(page)
    await expect(page.locator('#getMeetingCode')).toBeVisible()
    // This one without a password: the service is given the link itself.
    await page.locator('#meetingCodePassword').click()
    await expect(page.locator('#meetingCodePassword')).toHaveAttribute('data-on', 'false')
    await page.locator('#getMeetingCode').click()
    await expect(page.locator('#meetingCode')).toHaveText('K7M-2Q9-TX')
    await expect(page.locator('#meetingCodeWordsRow')).toBeHidden()
    await expect(page.locator('#meetingCodeLink')).toHaveValue('https://kithmoot.app/c/K7M2Q9TX')
    await expect(page.locator('#meetingCodeExpiry')).toContainText('This code works until')
    await expect(page.locator('#getMeetingCode')).toBeHidden()
    const post = seen.find(r => r.method() === 'POST')!
    const body = post.postDataJSON()
    expect(body.link).toBe(link)
    const now = Math.floor(Date.now() / 1000)
    expect(body.expires).toBeGreaterThan(now + 86_400 - 120)
    expect(body.expires).toBeLessThanOrEqual(now + 86_400)

    // Kept with the creator's records, never in the link.
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.meeting-code.v1.')).map(k => localStorage.getItem(k)))
    expect(stored).toHaveLength(1)
    expect(JSON.parse(stored[0]!)).toMatchObject({ code: 'K7M2Q9TX', deleteToken: 'delete-token-1' })
    expect(await page.locator('#shareUrl').inputValue()).toBe(link)
    expect(link).not.toContain('delete-token-1')

    await page.locator('#inviteClose').click()
    await openRoomDetails(page)
    await page.locator('#endRoom').click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#status')).toContainText('You ended this room for everyone')
    await expect.poll(() => seen.filter(r => r.method() === 'DELETE').length).toBe(1)
    const remove = seen.find(r => r.method() === 'DELETE')!
    expect(new URL(remove.url()).pathname).toBe('/codes/K7M2Q9TX')
    expect(await remove.headerValue('authorization')).toBe('Bearer delete-token-1')
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.meeting-code')).length)).toBe(0)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('New link deletes the old code', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const seen = await codeService(context, {})
    const page = await context.newPage()
    await startRoom(page, baseURL!, page => page.locator('#roomAsk').check())
    await openInvite(page)
    await page.locator('#getMeetingCode').click()
    await expect(page.locator('#meetingCode')).toHaveText('K7M-2Q9-TX')
    const first = await page.locator('#shareUrl').inputValue()
    await page.locator('#inviteClose').click()
    await openRoomInfoPage(page, 'Invite link')
    await page.locator('#rotateShare').click()
    await page.locator('#actionConfirm').click()
    await expect.poll(() => page.locator('#shareUrl').inputValue(), { timeout: 60_000 }).not.toBe(first)
    await expect.poll(() => seen.filter(r => r.method() === 'DELETE').length).toBe(1)
    expect(await seen.find(r => r.method() === 'DELETE')!.headerValue('authorization')).toBe('Bearer delete-token-1')
    // The old code is gone from this device. A replaced link no longer
    // holds the key the room follows, so End room is gone too, and with it
    // (the same check, docs/meeting-codes.md) a code for the new link.
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.meeting-code')).length)).toBe(0)
    await expect(page.locator('#meetingCodeRow')).toBeHidden()
    await expect(page.locator('#endRoom')).toBeHidden()
  } finally { await context.close() }
})

test('a code with a password: the link carries the words, the guest needs nothing but a tap', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const vault: Vault = new Map()
    const host = await device(browser, baseURL!); contexts.push(host)
    await host.addInitScript(() => {
      (window as unknown as { copied: string[] }).copied = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string[] }).copied.push(text) } } })
    })
    const seen = await codeService(host, {}, vault)
    const page = await host.newPage()
    await startRoom(page, baseURL!, async () => {})
    await openInvite(page)
    await expect(page.locator('#meetingCodePassword')).toHaveAttribute('data-on', 'true')
    // Nothing about sending the words apart is offered before there are words.
    await expect(page.locator('#meetingCodeSeparateRow')).toBeHidden()
    // The test app serves on localhost; a code's link must name a KithMoot
    // origin, so the link being sealed is given one, with the same fragment.
    const local = await page.locator('#shareUrl').inputValue()
    const link = 'https://kithmoot.forgesworn.dev/j/' + new URL(local).hash
    await page.locator('#shareUrl').evaluate((input, link) => { (input as HTMLInputElement).value = link }, link)
    await page.locator('#getMeetingCode').click()
    await expect(page.locator('#meetingCode')).toHaveText('K7M-2Q9-TX')
    await expect(page.locator('#meetingCodePasswordRow')).toBeHidden()

    // The default is one link, with the words inside its fragment.
    const words = (await page.locator('#meetingCodeAloudWords').textContent())!
    expect(words).toMatch(/^[a-z]+ [a-z]+ [a-z]+ [a-z]+$/)
    const joined = words.replaceAll(' ', '-')
    const oneLink = `https://kithmoot.app/c/K7M2Q9TX#${joined}`
    await expect(page.locator('#meetingCodeLink')).toHaveValue(oneLink)
    await expect(page.locator('#meetingCodeSeparateRow')).toBeVisible()
    await expect(page.locator('#meetingCodeSeparate')).toHaveText('Send the password separately')
    await expect(page.locator('#meetingCodeSeparate')).toHaveAttribute('data-on', 'false')
    // No password line beside the link: the words wait behind a disclosure
    // for the host who reads the bare code out.
    await expect(page.locator('#meetingCodeWordsRow')).toBeHidden()
    await expect(page.locator('#meetingCodeAloud')).toBeVisible()
    await expect(page.locator('#meetingCodeAloudWords')).toBeHidden()
    await page.locator('#meetingCodeAloud > summary').click()
    await expect(page.locator('#meetingCodeAloudWords')).toHaveText(words)

    // The service was asked for a pending code, then given only an envelope,
    // and nothing it was sent or asked for carries the words or the room key.
    const post = seen.find(r => r.method() === 'POST')!
    expect(Object.keys(post.postDataJSON()).sort()).toEqual(['expires', 'sealed'])
    expect(post.postDataJSON().sealed).toBe(true)
    const put = seen.find(r => r.method() === 'PUT')!
    expect(new URL(put.url()).pathname).toBe('/codes/K7M2Q9TX')
    expect(await put.headerValue('authorization')).toBe('Bearer upload-token-1')
    expect(Object.keys(put.postDataJSON().envelope).sort()).toEqual(['ciphertext', 'nonce', 'salt', 'v'])
    const secrets = [new URL(link).hash.slice(1, 20), joined]
    for (const r of seen) {
      const everything = r.url() + JSON.stringify(await r.allHeaders()) + (r.postData() ?? '')
      for (const secret of secrets) expect(everything).not.toContain(secret)
    }

    // Kept with the host's code record, so the sheet shows them again.
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.meeting-code.v1.')).map(k => localStorage.getItem(k)))
    expect(JSON.parse(stored[0]!)).toMatchObject({ code: 'K7M2Q9TX', words })
    await page.locator('#inviteClose').click()
    await openInvite(page)
    await expect(page.locator('#meetingCodeLink')).toHaveValue(oneLink)

    // Copy is that one link and nothing else: no code, no password line.
    await page.locator('#copyMeetingCode').click()
    await expect(page.locator('#meetingCodeStatus')).toContainText('joins in one tap')
    const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied)
    expect(copied.at(-1)).toBe(oneLink)

    // Send the password separately: today's behaviour. A bare link, the words
    // shown for sending on their own, and a Copy of two lines.
    await page.locator('#meetingCodeSeparate').click()
    await expect(page.locator('#meetingCodeSeparate')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#meetingCodeLink')).toHaveValue('https://kithmoot.app/c/K7M2Q9TX')
    await expect(page.locator('#meetingCodeWordsRow')).toBeVisible()
    await expect(page.locator('#meetingCodeWords')).toHaveText(words)
    await expect(page.locator('#meetingCodeAloud')).toBeHidden()
    await page.locator('#copyMeetingCode').click()
    await expect(page.locator('#meetingCodeStatus')).toContainText('Send the words separately')
    expect((await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).at(-1)!.split('\n'))
      .toEqual(['Meeting code K7M-2Q9-TX: https://kithmoot.app/c/K7M2Q9TX', `Password words: ${words}`])
    // The choice outlasts the sheet, so a host who sends words apart is not caught out by reopening it.
    await page.locator('#inviteClose').click()
    await openInvite(page)
    await expect(page.locator('#meetingCodeLink')).toHaveValue('https://kithmoot.app/c/K7M2Q9TX')
    await page.locator('#meetingCodeSeparate').click()
    await expect(page.locator('#meetingCodeLink')).toHaveValue(oneLink)

    // A guest follows the one link: kithmoot.app/c/<code>#<words> reaches the
    // join page as ?c=<code>#<words>. No prompt, one lookup, the door only.
    const guest = await device(browser, baseURL!); contexts.push(guest)
    const guestSeen = await codeService(guest, {}, vault)
    const requested: string[] = []
    guest.on('request', r => { requested.push(r.url()) })
    const door = await guest.newPage()
    await door.goto(new URL(`?c=K7M2Q9TX#${joined}`, baseURL!).href)
    await expect(door.locator('#join')).toBeVisible()
    await expect(door.locator('#joinCodePassword')).toBeHidden()
    await expect(door.locator('#joinCodeError')).toBeHidden()
    expect(new URL(door.url()).hash).toBe(new URL(link).hash)
    await expect(door.locator('#roomArea')).toBeHidden()
    await expect(door.locator('#joinMic')).not.toBeChecked()
    await expect(door.locator('#joinCamera')).not.toBeChecked()
    expect(guestSeen.map(r => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual(['GET /codes/K7M2Q9TX'])
    // The words went nowhere: not to a server, not into the address bar or
    // history, not into this device's storage.
    expect(door.url()).not.toContain(joined)
    // What a server is sent never includes the fragment, however a test tool reports it.
    for (const url of requested) expect(url.split('#')[0]).not.toContain(joined)
    for (const r of guestSeen) expect(r.url() + (r.postData() ?? '') + JSON.stringify(await r.allHeaders())).not.toContain(joined)
    const kept = await door.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    for (const word of words.split(' ')) expect(kept.toLowerCase()).not.toContain(` ${word} `)
    expect(kept.toLowerCase()).not.toContain(words)
    expect(kept.toLowerCase()).not.toContain(joined)
    // Words in the link that open nothing, a valid set from another meeting: the
    // prompt, exactly as for a code without them, and the address bar is clean.
    const wrongWords = words.split(' ').reverse().join(' ') === words ? 'ability zoo jasmine forget' : words.split(' ').reverse().join(' ')
    const other = await guest.newPage()
    await other.goto(new URL(`?c=K7M2Q9TX#${wrongWords.replaceAll(' ', '-')}`, baseURL!).href)
    await expect(other.locator('#joinCodePassword')).toBeVisible()
    await expect(other.locator('#meetingCodeWordsInput')).toBeFocused()
    await expect(other.locator('#join')).toBeHidden()
    expect(new URL(other.url()).hash).toBe('')
    expect(new URL(other.url()).search).toBe('?c=K7M2Q9TX')
    await other.locator('#meetingCodeWordsInput').fill(words)
    await other.locator('#meetingCodeWordsInput').press('Enter')
    await expect(other.locator('#join')).toBeVisible()
    expect(new URL(other.url()).hash).toBe(new URL(link).hash)

    // A fragment that is not four list words is dropped and the prompt shown,
    // never the incomplete-link failure; so is a missing one.
    for (const hash of ['#' + joined.split('-').slice(0, 3).join('-'), '#' + joined.toUpperCase(), '#' + joined + '.', '#nonsense']) {
      const bad = await guest.newPage()
      await bad.goto(new URL(`?c=K7M2Q9TX${hash}`, baseURL!).href)
      await expect(bad.locator('#joinCodePassword'), hash).toBeVisible()
      await expect(bad.locator('#join')).toBeHidden()
      expect(new URL(bad.url()).hash).toBe('')
      await bad.close()
    }
    const plain = await guest.newPage()
    await plain.goto(new URL('?c=K7M2Q9TX', baseURL!).href)
    await expect(plain.locator('#joinCodePassword')).toBeVisible()
    await expect(plain.locator('#join')).toBeHidden()
    await plain.close()

    // Typing the code in by hand still asks for the words, and a wrong set is
    // refused, a misspelt word is not corrected, and the right set (typed any
    // accepted way) reaches the door and no further.
    const typed = await device(browser, baseURL!); contexts.push(typed)
    const typedSeen = await codeService(typed, {}, vault)
    const hand = await typed.newPage()
    await hand.goto(baseURL!)
    await expect(hand.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    await joinWithCode(hand, 'k7m-2q9-tx')
    await expect(hand.locator('#joinCodePassword')).toBeVisible()
    await expect(hand.locator('label[for="meetingCodeWordsInput"]')).toHaveText('Enter the password words you were given')
    await expect(hand.locator('#meetingCodeWordsInput')).toBeFocused()
    await expect(hand.locator('#join')).toBeHidden()

    await hand.locator('#meetingCodeWordsInput').fill(wrongWords)
    await hand.locator('#meetingCodeWordsInput').press('Enter')
    await expect(hand.locator('#joinCodeError')).toHaveText('Those words do not match. Check them and try again.')
    await expect(hand.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    await expect(hand.locator('#join')).toBeHidden()
    await hand.locator('#meetingCodeWordsInput').fill(words.replace(/^./, c => c === 'q' ? 'z' : 'q'))
    await hand.locator('#meetingCodeWordsInput').press('Enter')
    await expect(hand.locator('#joinCodeError')).toHaveText('Those words do not match. Check them and try again.')

    await hand.locator('#meetingCodeWordsInput').fill(`  ${words.toUpperCase().replaceAll(' ', '-')} `)
    await hand.locator('#meetingCodeWordsInput').press('Enter')
    await expect(hand.locator('#join')).toBeVisible()
    expect(new URL(hand.url()).hash).toBe(new URL(link).hash)
    await expect(hand.locator('#roomArea')).toBeHidden()
    await expect(hand.locator('#joinMic')).not.toBeChecked()
    await expect(hand.locator('#joinCamera')).not.toBeChecked()
    // One lookup: the words were tried here, not at the service.
    expect(typedSeen.map(r => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual(['GET /codes/K7M2Q9TX'])
    const keptByHand = await hand.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    for (const word of words.split(' ')) expect(keptByHand.toLowerCase()).not.toContain(` ${word} `)
    expect(keptByHand.toLowerCase()).not.toContain(words)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
