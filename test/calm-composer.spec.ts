import { test, expect, type Browser, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { agentRelaysFor } from './relays.js'

/**
 * The composer row (#459): add a file, the field and send share one
 * rendered height and one vertical centre, at phone, tablet and desktop
 * widths and at each text size.
 */

async function device(browser: Browser, baseURL: string, touch: boolean, size?: 'large' | 'huge') {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 },
    hasTouch: touch, isMobile: touch,
  })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  if (size) await context.addInitScript(value => localStorage.setItem('kithmoot.textSize', value), size)
  return context
}

async function joinNewRoom(page: Page, keeper: RoomAgent, name: string) {
  await page.goto(keeper.url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
}

for (const size of [undefined, 'large', 'huge'] as const) {
  test(`the composer row shares one height and one centre line at ${size ?? 'standard'} text size`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const keeper = await RoomAgent.create({ base: baseURL!, roomName: 'Composer room', name: 'Rowan', agent: false, ...agentRelaysFor(baseURL!) })
    const contexts = []
    try {
      await keeper.chat.send('Hello from the keeper.')
      for (const [label, width, height, touch] of [['phone', 390, 844, true], ['tablet', 820, 1180, true], ['desktop', 1440, 900, false]] as const) {
        const context = await device(browser, baseURL!, touch, size)
        contexts.push(context)
        const page = await context.newPage()
        await page.setViewportSize({ width, height })
        await joinNewRoom(page, keeper, 'Ada')
        const form = page.locator('#chatForm')
        await expect(form).toBeVisible()
        const boxes = async () => {
          const out: Record<string, { y: number; h: number }> = {}
          for (const [name, selector] of [['plus', '#attachToggle'], ['field', '.composerField'], ['emoji', '#emojiToggle'], ['send', 'button[type=submit]']] as const) {
            await expect(form.locator(selector), `${name} is shown`).toBeVisible()
            const box = await form.locator(selector).boundingBox()
            expect(box, `${name} is on screen`).not.toBeNull()
            out[name] = { y: box!.y + box!.height / 2, h: box!.height }
          }
          return out
        }
        const b = await boxes()
        const note = `${label}, ${size ?? 'standard'}: ${JSON.stringify(b)}`
        // One vertical centre for everything in the row.
        for (const name of ['field', 'emoji', 'send']) expect(Math.abs(b[name]!.y - b.plus!.y), `${name} centre, ${note}`).toBeLessThanOrEqual(1)
        // One height for the three buttons; the field is at least as tall.
        for (const name of ['emoji', 'send']) expect(Math.abs(b[name]!.h - b.plus!.h), `${name} height, ${note}`).toBeLessThanOrEqual(1)
        expect(b.plus!.h, `button height, ${note}`).toBeGreaterThanOrEqual(touch ? 44 : 36)
        expect(b.field!.h, `field height, ${note}`).toBeGreaterThanOrEqual(b.plus!.h - 1)
        // Nothing wider than the screen.
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `overflow, ${note}`).toBeLessThanOrEqual(0)
      }
    } finally { await keeper.leave(); for (const context of contexts) await context.close() }
  })
}
