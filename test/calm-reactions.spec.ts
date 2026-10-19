import { test, expect, type Browser, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { agentRelaysFor } from './relays.js'

/**
 * Reacting to the newest message while at the bottom of the conversation
 * (#458): the whole reaction chip stays inside the log and "Jump to latest"
 * does not appear, at phone and desktop widths.
 */

async function device(browser: Browser, baseURL: string, touch: boolean) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 },
    hasTouch: touch, isMobile: touch,
  })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

async function joinNewRoom(page: Page, keeper: RoomAgent, name: string) {
  await page.goto(keeper.url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
}

for (const [label, width, height, touch] of [['phone', 390, 844, true], ['desktop', 1440, 900, false]] as const) {
  test(`reacting to the newest message keeps it, and its reaction, in view (${label})`, async ({ browser, baseURL }) => {
    const context = await device(browser, baseURL!, touch)
    let sentAt = Math.floor(Date.now() / 1000) - 600
    const keeper = await RoomAgent.create({ base: baseURL!, roomName: 'Reaction room', name: 'Rowan', agent: false, ...agentRelaysFor(baseURL!), now: () => sentAt })
    try {
      for (let i = 0; i < 14; i++) { sentAt += 20; await keeper.chat.send(`Note ${i}. ` + 'Enough history to fill the conversation. '.repeat(3)) }
      const page = await context.newPage()
      await page.setViewportSize({ width, height })
      await joinNewRoom(page, keeper, 'Ada')
      const log = page.locator('#chatLog')
      await expect(log.locator('.msg')).toHaveCount(14)
      const gap = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
      await expect.poll(gap).toBeLessThan(5)

      const last = log.locator('.msg').last()
      // The actions button is on every device; on a fine pointer it shows on hover.
      await last.getByRole('button', { name: 'Actions for message from Rowan', exact: true }).click()
      await page.locator('#messageActionPanel').getByRole('button', { name: 'Add 👍 reaction', exact: true }).click()
      const chip = last.getByRole('button', { name: /^Remove 👍 reaction/ })
      await expect(chip).toBeVisible()

      // The conversation stays at its end, so the chip is not under the edge.
      await expect.poll(gap).toBeLessThan(5)
      const inside = async () => {
        const [box, edge] = [await chip.boundingBox(), await log.boundingBox()]
        return !!box && !!edge && box.y >= edge.y - 0.5 && box.y + box.height <= edge.y + edge.height + 0.5
      }
      await expect.poll(inside).toBe(true)
      await expect(page.locator('#newMessages')).toBeHidden()
    } finally { await keeper.leave(); await context.close() }
  })
}
