import { test, expect, type Browser, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { TEST_RELAY_WS } from './browser.js'

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

/** Text in the call strips that its own box or any scrolling box around it
 *  cuts off: the text's laid-out rectangle, not the element's, so a label
 *  cut by an ellipsis counts too. A tile wholly outside a sideways strip is
 *  off screen rather than cut, and is skipped. */
function clippedCallText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stage = document.getElementById('callStage')!
    const found: string[] = []
    const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim()
      const owner = node.parentElement
      if (!text || !owner || !owner.checkVisibility({ visibilityProperty: true, opacityProperty: false })) continue
      const range = document.createRange(); range.selectNodeContents(node)
      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
      if (!rects.length) continue
      let offscreen = false
      for (let box: Element | null = owner; box && !offscreen; box = box === stage ? null : box.parentElement) {
        const style = getComputedStyle(box)
        if (style.clipPath !== 'none') { offscreen = true; break }
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
        const edge = box.getBoundingClientRect()
        for (const r of rects) {
          if (r.right <= edge.left || r.left >= edge.right) { offscreen = true; break }
          if (r.top < edge.top - 1 || r.bottom > edge.bottom + 1 || r.left < edge.left - 1 || r.right > edge.right + 1) {
            found.push(`"${text}" cut by ${box.id || box.className || box.tagName}`)
            offscreen = true
            break
          }
        }
      }
    }
    return found
  })
}

const px = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))

test('a phone reads the conversation: size, width, contrast and no sideways scroll', async ({ browser, baseURL }) => {
  const { context, link } = await phone(browser, baseURL!)
  const relays = [TEST_RELAY_WS]
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

test('M9: the composer is a combobox while the mention list is open, with no aria-allowed-attr violation', async ({ browser, baseURL }) => {
  const { context, link } = await phone(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(link)
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('@')
    await expect(page.locator('#mentions')).toBeVisible()
    await expect(page.locator('#chatInput')).toHaveAttribute('role', 'combobox')
    await expect(page.locator('#chatInput')).toHaveAttribute('aria-expanded', 'true')
    const scan = await new AxeBuilder({ page }).include('#chatInput').include('#mentions').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(scan.violations.map(v => v.id)).toEqual([])
  } finally { await context.close() }
})

test('phone Call and Chat each use the screen, with settings in a sheet', async ({ browser, baseURL }, info) => {
  test.skip(browser.browserType().name() !== 'chromium', 'Chromium provides the synthetic camera')
  const { context, link } = await phone(browser, baseURL!)
  const { context: other } = await phone(browser, baseURL!)
  try {
    const page = await context.newPage(); const remote = await other.newPage()
    for (const [p, name] of [[page, 'Ada'], [remote, 'Rowan']] as const) {
      await p.goto(link); await p.locator('#displayName').fill(name); await p.locator('#join').click()
      // The Call tab only opens the call view (B1); starting the call is
      // still the one explicit tap on the strip's own action.
      await p.locator('#mobileCall').click(); await p.locator('#callStripAction').click(); await p.locator('#toggleCamera').click()
    }
    await expect(page.locator('#room video')).toHaveCount(2)
    await expect.poll(() => remote.locator('#room video').evaluateAll(v => v.every(e => (e as HTMLVideoElement).videoWidth > 0))).toBe(true)
    for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport)
      await page.locator('#mobileCall').click()
      await expect(page.locator('#room video')).toHaveCount(2)
      await expect.poll(() => page.locator('#room video').evaluateAll(videos => videos.every(video => !(video as HTMLVideoElement).paused && (video as HTMLVideoElement).videoWidth > 0))).toBe(true)
      await expect(page.locator('#chatForm')).toBeHidden()
      const stage = (await page.locator('#whoIsHere').boundingBox())!
      expect(stage.height).toBeGreaterThan(viewport.height * .45)
      for (const name of ['Microphone', 'Camera', 'Screen share', 'Leave call']) {
        await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath(`call-${viewport.width}.png`) })
      await page.locator('#mobileChat').click()
      await expect(page.locator('#callStage')).toBeHidden()
      await expect(page.locator('#chatForm')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`chat-${viewport.width}.png`) })
      const log = (await page.locator('#chatLog').boundingBox())!
      expect(log.height).toBeGreaterThan(viewport.height * .45)
      await page.locator('#chatInput').fill('The call stays on while I write this.')
      await page.locator('#chatForm button[type=submit]').click()
      await remote.locator('#mobileChat').click()
      await expect(remote.locator('#chatLog')).toContainText('The call stays on while I write this.')
      await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
      await page.screenshot({ path: info.outputPath(`chat-${viewport.width}.png`) })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#mobileCall').click()
    const before = await page.locator('#whoIsHere').boundingBox()
    await page.locator('#callExtras > summary').click()
    await expect(page.locator('#mobileCallSettings')).toBeVisible()
    await expect(page.locator('#callMore > summary')).toBeVisible()
    await page.locator('#mobileCallSettingsClose').click()
    expect(await page.locator('#whoIsHere').boundingBox()).toEqual(before)
    // M13: Leave used to be plain on a phone and red only in the desktop
    // build. Every width gets the same danger fill now.
    await expect.poll(() => page.locator('#leaveCall').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await page.locator('#leaveCall').click()
    await expect(page.locator('#chatForm')).toBeVisible()
  } finally { await context.close(); await other.close() }
})
