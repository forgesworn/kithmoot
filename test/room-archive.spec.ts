import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { TEST_RELAY_HTTP } from './relays.js'

// A room's history is as durable as the devices that saw it, not the relay
// that happened to keep it. On 27 September 2026 a two-person room showed
// 425 messages on one device and none on another, because only one relay
// still held the chat and no client kept a copy. Here the relay forgets the
// room outright: the device that was there still opens on its history, and
// puts it back, so a newcomer reads it from the relay again.

function testRelay(baseURL: string): string {
  const url = new URL('/__test-relay', baseURL)
  url.protocol = 'wss:'
  return url.href
}

async function contextFor(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
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

/** How many of the room's main chat events the relay holds; `forget`
 *  drops them all first. */
async function stored(roomId: string, forget = false): Promise<number> {
  const response = await fetch(`${TEST_RELAY_HTTP}/__stored?kind=1460&d=${roomId}`, { method: forget ? 'DELETE' : 'GET' })
  return (await response.json() as { count: number }).count
}

test('a room its relay forgot still opens on its history, and the device that kept it puts it back', async ({ browser, baseURL }) => {
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const url = encodeJoinUrl(baseURL!, secret, [testRelay(baseURL!)])
  const kept = await contextFor(browser, baseURL!)
  const newcomer = await contextFor(browser, baseURL!)
  try {
    const first = await kept.newPage()
    await join(first, url, 'Keeper of history')
    const said = ['The first thing said', 'The second thing said', 'The third thing said']
    for (const text of said) {
      await first.locator('#chatInput').fill(text)
      await first.locator('#chatInput').press('Enter')
    }
    await expect(first.locator('#chatLog .msg')).toHaveCount(said.length)
    await expect.poll(() => stored(roomId)).toBeGreaterThanOrEqual(said.length)
    const held = await stored(roomId)
    await first.close()

    // The relay forgets the room's chat, as a public relay does.
    expect(await stored(roomId, true)).toBe(0)

    // The same browser comes back: its history is on screen with no relay
    // holding any of it.
    const again = await kept.newPage()
    await join(again, url, 'Keeper of history')
    for (const text of said) await expect(again.locator('#chatLog')).toContainText(text)
    await expect(again.locator('#chatLog .msg')).toHaveCount(said.length)

    // And it hands the originals back to the relay.
    await expect.poll(() => stored(roomId), { timeout: 60_000 }).toBe(held)

    // So somebody who was never here reads them off the relay.
    const reader = await newcomer.newPage()
    await join(reader, url, 'Newcomer')
    for (const text of said) await expect(reader.locator('#chatLog')).toContainText(text)
  } finally {
    await kept.close()
    await newcomer.close()
  }
})
