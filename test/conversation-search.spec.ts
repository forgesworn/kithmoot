import { test, expect, type Browser, type Page } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { goToConversation, openRoomDetails } from './browser.js'

async function setup(browser: Browser, baseURL: string) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const requests: string[] = []
  context.on('request', request => requests.push(request.url()))
  const link = encodeRoomLink(baseURL, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const writer = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  const page = await context.newPage()
  await page.goto(link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { page, writer, context, requests }
}

async function search(page: Page, query: string) {
  await openRoomDetails(page)
  await page.getByRole('button', { name: 'Search this conversation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Search this conversation' })).toBeVisible()
  await expect(page.locator('#messageSearchQuery')).toBeFocused()
  await page.locator('#messageSearchQuery').fill(query)
}

test('search finds literal text and people, jumps to context and preserves a draft and reading position', async ({ browser, baseURL }) => {
  const { page, writer, context } = await setup(browser, baseURL!)
  try {
    await writer.chat.send('Bring the blue toolbox <img src=x onerror=alert(1)> [.*]')
    // Wire timestamps have one-second resolution. Make this genuinely
    // older than the following messages, rather than relying on id order.
    await page.waitForTimeout(1100)
    for (let i = 0; i < 10; i++) await writer.chat.send(`Workshop note ${i}. ` + 'Give this message room on the screen. '.repeat(6))
    await expect(page.locator('#chatLog .msg')).toHaveCount(11)
    await page.locator('#chatInput').fill('Keep this draft here')
    const originalURL = page.url()
    await search(page, 'TOOLBOX')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await expect(page.locator('#messageSearchResults')).toContainText('<img src=x onerror=alert(1)>')
    await expect(page.locator('#messageSearchResults img')).toHaveCount(0)
    await page.locator('#messageSearchQuery').fill('[.*]')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchQuery').fill('Rowan')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(11)
    await page.locator('#messageSearchQuery').fill('toolbox')
    const selected = page.locator('#messageSearchResults button')
    await selected.focus()
    await selected.press('Enter')
    await expect(page.locator('#conversationSearch')).not.toBeVisible()
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft here')
    expect(page.url()).toBe(originalURL)
    const top = await page.locator('#chatLog').evaluate(el => el.scrollTop)
    await writer.chat.send('A new message while you read the old one')
    await expect(page.locator('#chatLog .msg')).toHaveCount(12)
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused({ timeout: 5000 })
    expect(Math.abs(await page.locator('#chatLog').evaluate(el => el.scrollTop) - top)).toBeLessThan(5)
    await expect(page.locator('#newMessages')).toBeVisible()
    await search(page, 'unfindable')
    await expect(page.locator('#messageSearchStatus')).toContainText('No matching messages')
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomMenu')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft here')
    expect(await page.locator('#messageSearchQuery').inputValue()).toBe('')
    await openRoomDetails(page)
    const agents = page.locator('#channelBar button[data-channel="agents"]')
    await agents.focus()
    await writer.chat.send('One more message while the conversation picker has focus')
    await expect(page.locator('#chatLog .msg')).toHaveCount(13)
    await expect(agents).toBeFocused()
    await page.locator('#roomSheetClose').click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await writer.leave(); await context.close() }
})

test('file discovery makes no download requests and search stays in its conversation as messages arrive', async ({ browser, baseURL }) => {
  const { page, writer, context, requests } = await setup(browser, baseURL!)
  try {
    await writer.chat.send('The plan for Saturday', { attachments: [{
      event: '01'.repeat(32), url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32),
      key: 'cd'.repeat(32), name: 'Workshop plans.pdf', size: 65608, type: 'application/pdf',
    }] })
    await expect(page.locator('#chatLog')).toContainText('Workshop plans.pdf')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchQuery').fill('')
    await page.getByLabel('Files only').check()
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await page.locator('#messageSearchClose').click()
    await goToConversation(page, 'Agents')
    await writer.channel('agents').send('An agent conversation about tools')
    await expect(page.locator('#chatLog')).toContainText('An agent conversation about tools')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(0)
    await expect(page.locator('#messageSearchScope')).toContainText('agents')
    await page.locator('#messageSearchQuery').fill('tools')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await writer.chat.send('tools in another conversation')
    await writer.channel('agents').send('More tools in this conversation')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(2)
    await expect(page.locator('#messageSearchQuery')).toBeFocused()
    await expect(page.locator('#messageSearchResults')).not.toContainText('tools in another conversation')
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await page.locator('#messageSearchClose').click()
    await goToConversation(page, 'Chat')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
  } finally { await writer.leave(); await context.close() }
})

test('searching while the microphone is on keeps the call live', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium provides the synthetic microphone')
  const { page, writer, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#callToggle').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'false')
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
    await writer.chat.send('Still in the call')
    await expect(page.locator('#chatLog')).toContainText('Still in the call')
    await search(page, 'call')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchClose').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
  } finally { await writer.leave(); await context.close() }
})
