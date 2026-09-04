import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { LOCAL_TEST_RELAY } from './relays.js'
import { goToConversation } from './browser.js'

async function contextFor(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  })
  await context.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(/wss:\/\/.*/, ws => ws.close())
  return context
}

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

test('a lost acknowledgement retains the message and retries the same event in its original conversation', async ({ browser, baseURL }) => {
  const context = await contextFor(browser)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const sent: string[] = []
  let firstId: string | undefined
  let reject = true
  await context.routeWebSocket(LOCAL_TEST_RELAY, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) {
        // Control discovery also uses kind 1460. Only the main chat has
        // the room id as its d tag; arm the rejection after joining below.
        if (reject) firstId ??= frame[1].id
        if (frame[1].id === firstId) sent.push(frame[1].id)
      }
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (reject && frame[0] === 'OK' && frame[1] === firstId) {
        ws.send(JSON.stringify(['OK', frame[1], false, 'acknowledgement lost after delivery']))
      } else ws.send(raw)
    })
  })
  try {
    reject = false
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [LOCAL_TEST_RELAY]), 'Ada')
    reject = true
    await page.locator('#chatInput').fill('Please keep this message')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#outbox')).toContainText('Send not confirmed')
    await expect(page.locator('#outbox')).toContainText('Please keep this message')
    await expect(page.locator('#chatLog .msg')).toHaveCount(1)
    await goToConversation(page, 'Agents')
    await page.locator('#chatInput').fill('A separate draft')
    // Count the retry, then allow its acknowledgement through.
    reject = false
    // The first retry can still be observed through the same frame handler.
    await page.locator('#outbox').getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatInput')).toHaveValue('A separate draft')
    await expect(page.locator('#chatLog')).not.toContainText('Please keep this message')
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatLog .msg')).toHaveCount(1)
    expect(firstId).toBeTruthy()
    expect(sent).toEqual([firstId, firstId])
  } finally { await context.close() }
})

test('incoming chat preserves the reading position and offers a way to the latest messages', async ({ browser, baseURL }) => {
  const a = await contextFor(browser)
  const b = await contextFor(browser)
  try {
    const url = encodeJoinUrl(baseURL!, generateRoomSecret(), [LOCAL_TEST_RELAY])
    const reader = await a.newPage()
    const writer = await b.newPage()
    await join(reader, url, 'Reader')
    await join(writer, url, 'Writer')
    for (let i = 0; i < 12; i++) {
      await writer.locator('#chatInput').fill(`Message ${i}: ` + 'A longer message to fill this phone screen. '.repeat(6))
      await writer.locator('#chatInput').press('Enter')
      await expect(reader.locator('#chatLog .msg')).toHaveCount(i + 1)
    }
    const log = reader.locator('#chatLog')
    await log.evaluate(el => { el.scrollTop = 0 })
    await writer.locator('#chatInput').fill('A new arrival while you read')
    await writer.locator('#chatInput').press('Enter')
    await expect(reader.locator('#chatLog .msg')).toHaveCount(13)
    await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeLessThan(5)
    await expect(reader.locator('#newMessages')).toBeVisible()
    await reader.locator('#newMessages').click()
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(5)
    await expect(reader.locator('#newMessages')).toBeHidden()
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await a.close(); await b.close() }
})

test('public profiles require opt-in and the choice does not survive a new visit', async ({ browser, baseURL }) => {
  const context = await contextFor(browser)
  const queries: string[][] = []
  await context.routeWebSocket(LOCAL_TEST_RELAY, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'REQ') {
        for (const filter of frame.slice(2)) {
          if (filter.kinds?.includes(0) && filter.authors) queries.push(filter.authors)
        }
      }
      upstream.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [LOCAL_TEST_RELAY]), 'Private reader')
    await page.locator('#chatInput').fill('No public lookup needed')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('No public lookup needed')
    expect(queries).toHaveLength(0)
    await page.locator('#roomMenu').click()
    await page.locator('#lookupProfiles').check()
    await expect.poll(() => queries.length).toBeGreaterThan(0)
    await page.locator('#lookupProfiles').uncheck()
    const count = queries.length
    await page.reload()
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#roomMenu').click()
    await expect(page.locator('#lookupProfiles')).not.toBeChecked()
    expect(queries).toHaveLength(count)
  } finally { await context.close() }
})
