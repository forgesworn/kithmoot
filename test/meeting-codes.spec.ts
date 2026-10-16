import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { openNewRoomForm, openRoomDetails } from './browser.js'

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
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
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

/** A code service answering lookups from a table, recording every request. */
async function codeService(context: BrowserContext, lookups: Record<string, { status: number; body?: unknown }>): Promise<Request[]> {
  const seen: Request[] = []
  await context.route(/\/codes(\/[^/?#]*)?$/, async route => {
    const request = route.request()
    seen.push(request)
    const code = new URL(request.url()).pathname.split('/')[2]
    if (request.method() === 'POST') return route.fulfill(json(201, { code: 'K7M2Q9TX', expires: request.postDataJSON().expires, deleteToken: 'delete-token-1' }))
    if (request.method() === 'DELETE') return route.fulfill({ status: 204, body: '' })
    const answer = (code && lookups[code]) || { status: 404, body: {} }
    return route.fulfill(json(answer.status, answer.body ?? {}))
  })
  return seen
}

async function joinWithCode(page: Page, code: string): Promise<void> {
  const details = page.locator('#joinCode')
  if (!await details.evaluate(el => (el as HTMLDetailsElement).open)) await page.locator('#joinCode > summary').click()
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
    await expect(page.locator('#home')).toBeVisible()
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
    await expect(page.locator('#home')).toBeVisible()
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
    await expect(page.locator('#home')).toBeVisible()
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
    await openPage.locator('#invitePeople').click()
    await expect(openPage.locator('#inviteDialog')).toBeVisible()
    await expect(openPage.locator('#copyShare')).toBeVisible()
    await expect(openPage.locator('#getMeetingCode')).toBeVisible()

    // An Ask room is eligible, and stays so when the host lets anyone in.
    const ask = await device(browser, baseURL!); contexts.push(ask)
    await codeService(ask, {})
    const askPage = await ask.newPage()
    await startRoom(askPage, baseURL!, page => page.locator('#roomAsk').check())
    await askPage.locator('#invitePeople').click()
    await expect(askPage.locator('#getMeetingCode')).toBeVisible()
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
    await page.locator('#invitePeople').click()
    await expect(page.locator('#getMeetingCode')).toBeVisible()
    await page.locator('#getMeetingCode').click()
    await expect(page.locator('#meetingCode')).toHaveText('K7M-2Q9-TX')
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
    await page.locator('#invitePeople').click()
    await page.locator('#getMeetingCode').click()
    await expect(page.locator('#meetingCode')).toHaveText('K7M-2Q9-TX')
    const first = await page.locator('#shareUrl').inputValue()
    await page.locator('#inviteClose').click()
    await openRoomDetails(page)
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
