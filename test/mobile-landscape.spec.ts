import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { openCall } from './browser.js'

// B3 and M1: a phone turned sideways used to give the conversation 30% of
// the screen (117 of 390px) because the fixed chrome above it took the
// other 70%, and a docked call's own strip drew straight over the room bar
// rather than beside or under it. Both are measured here rather than left
// to a screenshot, because a pixel width is the only honest way to check
// "no more than a third" and "never overlap".

async function setup(browser: Browser, base: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 844, height: 390 } })
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const rooms = ['Book club', 'Design crit'].map(name => {
    const secret = generateRoomSecret()
    return { roomId: deriveRoom(secret).roomId, name, link: encodeRoomLink(base, { secret, name, relays: [relay.href], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
  })
  await context.addInitScript(rooms => {
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
  }, rooms)
  const page = await context.newPage()
  await page.goto(rooms[0].link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { context, page, rooms }
}

test('B3: a phone turned sideways keeps at least two thirds of the screen for the conversation', async ({ browser, baseURL }) => {
  const { context, page } = await setup(browser, baseURL!)
  try {
    const room = (await page.locator('#chatViewport').boundingBox())!
    expect(room.height).toBeGreaterThanOrEqual(250)
    const chrome = 390 - room.height
    expect(chrome / 390).toBeLessThanOrEqual(1 / 3)
  } finally { await context.close() }
})

test('M1: a docked call in landscape never draws over the room bar', async ({ browser, baseURL }, info) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone')
  const { context, page, rooms } = await setup(browser, baseURL!)
  const contexts: BrowserContext[] = [context]
  try {
    await context.grantPermissions(['microphone'], { origin: new URL(baseURL!).origin })
    await openCall(page)
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: `Switch to ${rooms[1].name}`, exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText(rooms[1].name)
    await expect(page.locator('#callDock')).toBeVisible()

    const dock = (await page.locator('#callDock').boundingBox())!
    const bar = (await page.locator('.roomBar').boundingBox())!
    const overlapX = Math.max(0, Math.min(dock.x + dock.width, bar.x + bar.width) - Math.max(dock.x, bar.x))
    const overlapY = Math.max(0, Math.min(dock.y + dock.height, bar.y + bar.height) - Math.max(dock.y, bar.y))
    await page.screenshot({ path: info.outputPath('docked-landscape.png') })
    expect(overlapX * overlapY, `dock ${JSON.stringify(dock)} vs bar ${JSON.stringify(bar)}`).toBe(0)
  } finally {
    for (const c of contexts) await c.close()
  }
})
