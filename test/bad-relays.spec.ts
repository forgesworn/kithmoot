import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'

// The public relay failures seen in September 2026, each beside the local
// test relay that behaves: a relay that accepts the socket and never
// answers, one that says OK to chat and keeps none of it, and one that
// refuses every connection. The room has to stay usable through each, and
// relay settings has to say what was seen and nothing more.

const HUNG = 'wss://hung.example/'
const FORGETFUL = 'wss://forgetful.example/'
// Nothing listens on the discard port: a real refused connection, not a
// routed socket that opens first.
const REFUSING = 'wss://127.0.0.1:9/'

function testRelay(baseURL: string): string {
  const url = new URL('/__test-relay', baseURL)
  url.protocol = 'wss:'
  return url.href
}

async function contextFor(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
  const allowed = new Set([testRelay(baseURL), HUNG, FORGETFUL, REFUSING])
  await context.routeWebSocket(url => url.protocol === 'wss:' && !allowed.has(url.href), ws => ws.close())
  // Accepts the socket, then never sends a frame.
  await context.routeWebSocket(HUNG, () => {})
  // Says OK to every event and answers every request with nothing.
  await context.routeWebSocket(FORGETFUL, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      if (frame[0] === 'EVENT') ws.send(JSON.stringify(['OK', (frame[1] as { id: string }).id, true, '']))
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
    })
  })
  await context.addInitScript(() => {
    const dials: Record<string, number> = {}
    const Base = window.WebSocket
    ;(window as typeof window & { relayDials: Record<string, number> }).relayDials = dials
    window.WebSocket = class extends Base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        dials[String(url)] = (dials[String(url)] ?? 0) + 1
      }
    }
  })
  return context
}

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator('#chatInput').fill(text)
  await page.locator('#chatInput').press('Enter')
}

async function relayRow(page: Page, url: string) {
  await page.locator('#roomMenu').click()
  await page.locator('#roomRelaySettings').click()
  return page.locator('#relayList .relayRow').filter({ hasText: url }).locator('.relayHealth')
}

test('a relay that never answers neither holds a message back nor keeps history from a joiner', async ({ browser, baseURL }) => {
  const secret = generateRoomSecret()
  const link = encodeJoinUrl(baseURL!, secret, [testRelay(baseURL!), HUNG])
  const first = await contextFor(browser, baseURL!)
  const second = await contextFor(browser, baseURL!)
  try {
    const ada = await first.newPage()
    await join(ada, link, 'Ada')
    await send(ada, 'Sent past a hung relay')
    await expect(ada.locator('#chatLog')).toContainText('Sent past a hung relay')
    // Counted as sent on the good relay's OK, not after the hung one's
    // 20-second retry budget.
    await expect(ada.locator('#outbox')).toBeHidden({ timeout: 5_000 })
    const bo = await second.newPage()
    await join(bo, link, 'Bo')
    await expect(bo.locator('#chatLog')).toContainText('Sent past a hung relay', { timeout: 15_000 })
    await send(bo, 'And back again')
    await expect(ada.locator('#chatLog')).toContainText('And back again')
  } finally { await first.close(); await second.close() }
})

test('relay settings names a relay that accepts chat and keeps none of it, and only that one', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!), FORGETFUL]), 'Ada')
    await send(page, 'Is this kept?')
    await expect(page.locator('#outbox')).toBeHidden()
    const forgetful = await relayRow(page, FORGETFUL)
    await expect(forgetful).toContainText('Does not keep chat', { timeout: 20_000 })
    await expect(page.locator('#relayList .relayRow').filter({ hasText: testRelay(baseURL!) }).locator('.relayHealth')).not.toContainText('Does not keep chat')
  } finally { await context.close() }
})

test('a relay that refuses every connection is dialled with backoff, and the room carries on', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!), REFUSING]), 'Ada')
    const dials = () => page.evaluate(url => (window as typeof window & { relayDials: Record<string, number> }).relayDials[url] ?? 0, REFUSING)
    const before = await dials()
    await send(page, 'Still here')
    await expect(page.locator('#outbox')).toBeHidden({ timeout: 5_000 })
    await page.waitForTimeout(40_000)
    await send(page, 'Still here later')
    await expect(page.locator('#outbox')).toBeHidden({ timeout: 5_000 })
    // Each publish, its retries and the readers they rebind used to dial on
    // their own schedules, most of a dial a second between them.
    expect(await dials() - before).toBeLessThanOrEqual(12)
    const refusing = await relayRow(page, REFUSING)
    await expect(refusing).toContainText('Connection failed')
    await expect(refusing).not.toContainText('Connected')
  } finally { await context.close() }
})
