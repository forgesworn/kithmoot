import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'

function testRelay(baseURL: string): string {
  const url = new URL('/__test-relay', baseURL)
  url.protocol = 'wss:'
  return url.href
}

async function contextFor(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  })
  await context.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== testRelay(baseURL), ws => ws.close())
  return context
}

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

test('Send shows the newest queued message inside the window while acknowledgements are delayed', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const events = new Set<string>()
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) events.add(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if ((frame[0] === 'OK' && events.has(frame[1])) || (frame[0] === 'EVENT' && events.has(frame[2]?.id))) return
      ws.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1200, height: 800 })
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Sender')
    for (let i = 0; i < 8; i++) {
      const text = `Queued message ${i}. ` + 'A longer message waiting for a slow relay. '.repeat(4)
      await page.locator('#chatInput').fill(text)
      await page.locator('#chatInput').press('Enter')
      await expect(page.locator('#chatInput')).toHaveValue('')
      const row = page.locator('#outbox .pendingMsg').last()
      await expect(row).toContainText(text)
      await expect(row).toContainText('Sending')
      // Playwright visibility alone accepts elements clipped by a scrollbox.
      // The status must actually be painted where the person can see it.
      await expect.poll(() => row.locator('.pendingStatus').evaluate(el => {
        const rect = el.getBoundingClientRect()
        const root = document.getElementById('outbox')!.getBoundingClientRect()
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        return y > root.top && y < root.bottom && y > 0 && y < innerHeight && el.contains(document.elementFromPoint(x, y))
      })).toBe(true)
    }
    expect(events.size).toBe(8)
    await page.locator('#chatInput').press('Enter')
    expect(events.size).toBe(8)
    await expect(page.locator('#outbox .pendingMsg')).toHaveCount(8)
  } finally { await context.close() }
})

test('an accepted message stays in the conversation when the relay does not echo it', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const events = new Set<string>()
  const echoes: Array<() => void> = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) events.add(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && events.has(frame[2]?.id)) { echoes.push(() => ws.send(raw)); return }
      ws.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1200, height: 800 })
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Sender')
    await page.locator('#chatInput').fill('Keep my accepted message visible')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatInput')).toHaveValue('')
    await expect(page.locator('#chatLog .msg', { hasText: 'Keep my accepted message visible' })).toHaveCount(1, { timeout: 8000 })
    await expect(page.locator('#outbox')).toBeHidden()
    expect(events.size).toBe(1)
    for (const echo of echoes) echo()
    await expect(page.locator('#chatLog .msg', { hasText: 'Keep my accepted message visible' })).toHaveCount(1)
  } finally { await context.close() }
})
