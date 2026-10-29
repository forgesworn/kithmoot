import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'

// The one tick: whether the relays kept a message this device sent. A relay's
// OK is not enough, so a message shows a clock until a relay that took it has
// returned it (or been seen to keep chat), then one tick; a relay that took it
// and returned nothing leaves it "Not kept", with Retry. Nothing here says
// anyone else has it: two ticks need delivery receipts, a later change.

const FORGETFUL = 'wss://forgetful.example/'
const KEEPING = 'wss://keeping.example/'

/** A relay that says OK to everything and answers a request for an event by id from what it was given, but only while `remember()` says so: with it false, a relay that accepts chat and returns none of it. */
async function mockRelay(context: BrowserContext, url: string, remember: () => boolean) {
  const stored = new Map<string, { id: string; kind: number }>()
  const seen = { writes: 0 }
  await context.routeWebSocket(url, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      if (frame[0] === 'EVENT') {
        const event = frame[1] as { id: string; kind: number }
        if (event.kind === 1460) seen.writes++
        stored.set(event.id, event)
        ws.send(JSON.stringify(['OK', event.id, true, '']))
      }
      if (frame[0] === 'REQ') {
        const subscription = frame[1] as string
        if (remember()) for (const filter of frame.slice(2) as { ids?: string[] }[]) for (const id of filter.ids ?? []) {
          const event = stored.get(id)
          if (event) ws.send(JSON.stringify(['EVENT', subscription, event]))
        }
        ws.send(JSON.stringify(['EOSE', subscription]))
      }
    })
  })
  return seen
}

function testRelay(baseURL: string): string {
  const url = new URL('/__test-relay', baseURL)
  url.protocol = 'wss:'
  return url.href
}

async function contextFor(browser: Browser, baseURL: string, extra: string[] = []): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
  const allowed = new Set([testRelay(baseURL), ...extra])
  await context.routeWebSocket(url => url.protocol === 'wss:' && !allowed.has(url.href), ws => ws.close())
  return context
}

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

async function reopen(page: Page): Promise<void> {
  await page.reload()
  const joinButton = page.locator('#join'), room = page.locator('#roomArea')
  await expect.poll(async () => await joinButton.isVisible() || await room.isVisible()).toBe(true)
  if (await joinButton.isVisible()) await joinButton.click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator('#chatInput').fill(text)
  await page.locator('#chatInput').press('Enter')
}

const own = (page: Page, text: string) => page.locator('#chatLog .msg.mine', { hasText: text })
const tick = (page: Page, text: string) => own(page, text).locator('.deliveryTick')

test('a message turns to two ticks once the other person\'s device confirms it, and never says read', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!), other = await contextFor(browser, baseURL!)
  try {
    const link = encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!)])
    const ada = await context.newPage(), bo = await other.newPage()
    await join(ada, link, 'Ada'); await join(bo, link, 'Bo')
    await send(ada, 'Did it arrive?')
    await expect(bo.locator('#chatLog .msg.theirs', { hasText: 'Did it arrive?' })).toBeVisible()
    await expect(tick(ada, 'Did it arrive?')).toHaveAttribute('data-state', 'delivered', { timeout: 30_000 })
    await expect(tick(ada, 'Did it arrive?').locator('button')).toHaveAttribute('aria-label', 'Delivered to Bo')
    await expect(ada.locator('#chatLog .deliveryTick[data-state="delivered"]')).toHaveCount(1)
    await expect(ada.locator('#chatLog')).not.toContainText(/\bRead\b|\bSeen\b/)
    // Bo's own screen shows no tick on Ada's message.
    await expect(bo.locator('#chatLog .msg.theirs .deliveryTick')).toHaveCount(0)
  } finally { await context.close(); await other.close() }
})

test('a message shows a clock, then one tick once a relay has returned it, and only its own messages have one', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!), other = await contextFor(browser, baseURL!)
  try {
    const link = encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!)])
    const ada = await context.newPage(), bo = await other.newPage()
    await join(ada, link, 'Ada'); await join(bo, link, 'Bo')
    // One tick only here: Bo confirms nothing, so the second tick never supersedes it.
    await bo.evaluate(() => localStorage.setItem('kithmoot.delivery-receipts.v1', 'off'))
    await send(ada, 'Is this kept?')
    await expect(own(ada, 'Is this kept?')).toBeVisible()
    // A relay said OK a moment ago; nobody has yet been asked whether it kept it.
    await expect(tick(ada, 'Is this kept?')).toHaveAttribute('aria-label', 'Sending')
    await expect(tick(ada, 'Is this kept?')).toHaveAttribute('data-state', 'checking')
    await expect(tick(ada, 'Is this kept?')).toHaveAttribute('data-state', 'sent', { timeout: 20_000 })
    await expect(tick(ada, 'Is this kept?')).toHaveAttribute('aria-label', 'Sent')
    await expect(tick(ada, 'Is this kept?')).toHaveAttribute('title', 'Sent. Not yet confirmed on anyone else’s device.')
    // Not a reaction's, an edit's, or anybody else's.
    await send(bo, 'Not mine to tick')
    await expect(ada.locator('#chatLog .msg.theirs', { hasText: 'Not mine to tick' })).toBeVisible()
    await expect(ada.locator('#chatLog .msg.theirs .deliveryTick')).toHaveCount(0)
    await expect(ada.locator('#chatLog .deliveryTick')).toHaveCount(1)
    // The next message is not held back by a second round of checking.
    await send(ada, 'And this one')
    await expect(tick(ada, 'And this one')).toHaveAttribute('data-state', 'sent', { timeout: 15_000 })
  } finally { await context.close(); await other.close() }
})

test('the tick is the same after a reload', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!)]), 'Ada')
    await send(page, 'Still kept after a reload')
    await expect(tick(page, 'Still kept after a reload')).toHaveAttribute('data-state', 'sent', { timeout: 20_000 })
    await reopen(page)
    await expect(own(page, 'Still kept after a reload')).toBeVisible()
    await expect(tick(page, 'Still kept after a reload')).toHaveAttribute('data-state', 'sent')
    await expect(tick(page, 'Still kept after a reload')).toHaveAttribute('aria-label', 'Sent')
  } finally { await context.close() }
})

test('a message no relay has taken stays pending, with no tick, and gets one when it goes', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const live = new Set<{ close: () => void }>()
  let blocked = false
  await context.routeWebSocket(relay, ws => {
    if (blocked) { ws.close(); return }
    live.add(ws)
    const upstream = ws.connectToServer()
    ws.onMessage(raw => upstream.send(raw))
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [relay]), 'Ada')
    blocked = true
    for (const ws of live) ws.close()
    live.clear()
    await send(page, 'Written with nothing reachable')
    const row = page.locator('#outbox .pendingMsg')
    await expect(row).toContainText('Pending: will send when you are connected.')
    await expect(page.locator('#chatLog .deliveryTick')).toHaveCount(0)
    blocked = false
    await expect(page.locator('#outbox')).toBeHidden({ timeout: 60_000 })
    await expect(tick(page, 'Written with nothing reachable')).toHaveAttribute('data-state', /checking|sent/)
    await expect(tick(page, 'Written with nothing reachable')).toHaveAttribute('data-state', 'sent', { timeout: 30_000 })
  } finally { await context.close() }
})

test('a relay that accepts a message and does not return it leaves it Not kept, and Retry recovers once it does', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!, [FORGETFUL])
  let remember = false
  const relay = await mockRelay(context, FORGETFUL, () => remember)
  try {
    const page = await context.newPage()
    // Some WebKit builds cannot store events in the room archive (a DataCloneError on main too), and then a reload
    // loses the message row itself; the reload below is only meaningful where the archive works.
    let archiveWorks = true
    page.on('console', message => { if (message.text().includes('room archive could not keep events')) archiveWorks = false })
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [FORGETFUL]), 'Ada')
    await send(page, 'Is this kept anywhere?')
    await expect(own(page, 'Is this kept anywhere?')).toBeVisible()
    const retry = page.getByRole('button', { name: 'Not kept. Retry' })
    await expect(retry).toBeVisible({ timeout: 20_000 })
    await expect(retry).toContainText('Retry')
    await expect(retry).toHaveAttribute('title', 'Not kept: a relay accepted it but did not keep it.')
    await expect(page.locator('#chatLog .deliveryTick[data-state="sent"]')).toHaveCount(0)
    // The same state, and the same way out, after a reload.
    if (archiveWorks) {
      await reopen(page)
      await expect(retry).toBeVisible({ timeout: 20_000 })
    }
    const before = relay.writes
    remember = true
    await retry.click()
    // The same signed event is offered again, and the tick waits to hear.
    await expect(tick(page, 'Is this kept anywhere?')).toHaveAttribute('data-state', /checking|sent/)
    await expect(tick(page, 'Is this kept anywhere?')).toHaveAttribute('data-state', 'sent', { timeout: 30_000 })
    expect(relay.writes).toBeGreaterThan(before)
    await expect(page.getByRole('button', { name: 'Not kept. Retry' })).toHaveCount(0)
  } finally { await context.close() }
})

test('one relay that keeps chat is enough, beside one that does not', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!, [FORGETFUL, KEEPING])
  await mockRelay(context, FORGETFUL, () => false)
  await mockRelay(context, KEEPING, () => true)
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, generateRoomSecret(), [FORGETFUL, KEEPING]), 'Ada')
    await send(page, 'One good relay')
    await expect(tick(page, 'One good relay')).toHaveAttribute('data-state', 'sent', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Not kept. Retry' })).toHaveCount(0)
  } finally { await context.close() }
})
