import { test, expect, type Browser, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'

// Somebody on a phone during a live call could not read the chat. These are
// the measurements that were wrong, taken the way that person met them: a
// 360 by 800 phone, a busy conversation, and a call on in the room.

const LONG = 'I have put the draft plan in the shared folder and the risk assessment beside it. Could somebody check the access notes for wheelchair users before we print it? The ramp by the shed is steeper than it looks.'

async function phone(browser: Browser, baseURL: string) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 360, height: 800 }, hasTouch: true })
  if (browser.browserType().name() === 'chromium') await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL, { secret: generateRoomSecret(), name: 'Community garden', relays: [relay.href], iceUrls: [] })
  return { context, link }
}

/** WCAG contrast of an element's text against the first opaque background
 *  behind it, from computed styles. */
function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
    const luminance = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    let behind: Element | null = el
    let background = 'rgb(0, 0, 0)'
    while (behind) {
      const [, , , alpha = 1] = rgb(getComputedStyle(behind).backgroundColor)
      if (alpha > 0) { background = getComputedStyle(behind).backgroundColor; break }
      behind = behind.parentElement
    }
    const a = luminance(rgb(getComputedStyle(el).color)), b = luminance(rgb(background))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

const px = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))

test('a phone reads the conversation: size, width, contrast and no sideways scroll', async ({ browser, baseURL }) => {
  const { context, link } = await phone(browser, baseURL!)
  const relays = ['ws://127.0.0.1:7777']
  const page = await context.newPage()
  await page.goto(link)
  await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  const rowan = await RoomAgent.join({ link, relays, name: 'Rowan', agent: false })
  const clerk = await RoomAgent.join({ link, relays, name: 'Clerk' })
  try {
    await rowan.chat.send(LONG)
    await rowan.chat.send('npub1u8lnhlw5usp3t9vmpz60ejpyt649z33hu82wc2hpv6m5xdqmuxhs46turz is the garden account')
    await expect(page.locator('#chatLog .msg')).toHaveCount(2)
    await expect(page.locator('#roomWho')).toContainText('1 agent')
    await clerk.chat.send('Noted: the access check is with whoever picks it up.')
    await expect(page.locator('#chatLog .msg.fromAgent')).toHaveCount(1)
    await page.locator('#chatInput').fill('I will bring the keys and a flask.')
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .msg.mine')).toHaveCount(1)

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(await px(page, '#chatLog .bubble .text')).toBeGreaterThanOrEqual(16)
      for (const secondary of ['#chatLog .msg .sender', '#chatLog .msg .when', '#chatLog .msg .chip']) {
        expect(await px(page, secondary), secondary).toBeGreaterThanOrEqual(14)
      }
      for (const [selector, floor] of [
        ['#chatLog .msg.theirs:not(.fromAgent) .bubble .text', 4.5],
        ['#chatLog .msg.mine .bubble .text', 4.5],
        ['#chatLog .msg.fromAgent .bubble .text', 4.5],
        ['#chatLog .msg .sender', 4.5],
        ['#chatLog .msg .sender .name', 4.5],
        ['#chatLog .msg .when', 4.5],
        ['#chatLog .msg .chip', 4.5],
      ] as const) {
        expect(await contrast(page, selector), `${selector} in ${colorScheme}`).toBeGreaterThanOrEqual(floor)
      }
      const log = page.locator('#chatLog')
      expect(await log.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // The bubble uses the width of the phone rather than sharing it with a
      // column kept for two buttons.
      const logWidth = await log.evaluate(el => el.clientWidth)
      const bubble = await page.locator('#chatLog .msg').filter({ hasText: 'risk assessment' }).locator('.bubble').boundingBox()
      expect(bubble!.width / logWidth).toBeGreaterThanOrEqual(0.75)
      // Every message keeps both of its buttons, at thumb size.
      for (const control of await page.locator('#chatLog .messageControls button').all()) {
        const box = (await control.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(43.5); expect(box.height).toBeGreaterThanOrEqual(43.5)
      }
      const scan = await new AxeBuilder({ page }).include('#chatLog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
      expect(scan.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    }

    // Huge text, chosen in Room details and kept on this device.
    await page.locator('#roomMenu').click()
    await page.locator('#roomSheet').getByRole('radio', { name: 'Huge' }).check()
    await page.locator('#roomSheetClose').click()
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(24)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('#chatLog').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    const huge = await page.locator('#chatLog .msg').filter({ hasText: 'risk assessment' }).locator('.bubble').boundingBox()
    expect(huge!.width / await page.locator('#chatLog').evaluate(el => el.clientWidth)).toBeGreaterThanOrEqual(0.75)
    await page.reload()
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(24)
    await page.evaluate(() => localStorage.removeItem('kithmoot.textSize'))
  } finally { rowan.leave(); clerk.leave(); await context.close() }
})

test('a call on a phone leaves the conversation on the screen, upright and on its side', async ({ browser, baseURL }) => {
  test.skip(browser.browserType().name() !== 'chromium', 'Chromium provides the synthetic camera')
  const { context, link } = await phone(browser, baseURL!)
  const writer = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage()
    await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    for (let i = 0; i < 8; i++) await writer.chat.send(`Message ${i}: ${LONG}`)
    await expect(page.locator('#chatLog .msg')).toHaveCount(8)
    await page.locator('#callToggle').click()
    await expect(page.locator('#deviceControls')).toBeVisible()
    await page.locator('#toggleCamera').click()
    await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#room video').first()).toBeVisible()
    for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport)
      // Upright, the whole room fits the screen. On its side a 390px-tall
      // screen cannot hold the bar, the tools and a readable conversation at
      // once: the bar scrolls away and the conversation keeps a screenful,
      // with the call held in its own column beside it.
      const landscape = viewport.width > viewport.height
      await page.evaluate(end => window.scrollTo(0, end ? document.documentElement.scrollHeight : 0), landscape)
      const log = (await page.locator('#chatLog').boundingBox())!
      const form = (await page.locator('#chatForm').boundingBox())!
      const label = `${viewport.width}x${viewport.height}`
      expect(log.y, `conversation starts on screen at ${label}`).toBeGreaterThanOrEqual(0)
      expect(log.y + log.height, `conversation ends on screen at ${label}`).toBeLessThanOrEqual(viewport.height)
      expect(log.height, `conversation height at ${label}`).toBeGreaterThanOrEqual(viewport.height * (landscape ? 0.5 : 0.25))
      expect(form.y + form.height, `the box to reply in at ${label}`).toBeLessThanOrEqual(viewport.height)
      await expect(page.locator('#toggleCamera')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (!landscape) expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), `no page scroll at ${label}`).toBe(true)
    }
    await page.locator('#leaveCall').click()
  } finally { writer.leave(); await context.close() }
})
