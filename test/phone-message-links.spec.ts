import { test, expect, type Browser } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'

/**
 * On a phone a link in a message could not be tapped or copied, and holding
 * the bubble to select text opened the reaction picker instead of a native
 * selection handle. This is the fix, at the size it was found: a 360 by 800
 * phone with touch. See `app/src/linkify.ts` for the URL splitter and its
 * own unit tests.
 */

const MESSAGE_TEXT = 'See https://example.com/docs. Not a link: javascript:alert(1)'

async function phone(browser: Browser, baseURL: string) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 360, height: 800 }, hasTouch: true })
  if (browser.browserType().name() === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin })
  }
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL, { secret: generateRoomSecret(), name: 'Phone links', relays: [relay.href], iceUrls: [] })
  return { context, link }
}

test('a link in a message is tappable, safe and wraps; the rest of the text can be copied; holding the link does not open reactions', async ({ browser, baseURL }) => {
  const { context, link } = await phone(browser, baseURL!)
  const writer = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage()
    await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await writer.chat.send(MESSAGE_TEXT)
    const row = page.locator('#chatLog .msg').filter({ hasText: 'Not a link' })
    await expect(row).toBeVisible()

    // Exactly one link, for the http(s) URL only, trailing full stop kept
    // out of the href, visible text is the URL itself.
    const anchors = row.locator('.bubble .text a')
    await expect(anchors).toHaveCount(1)
    const anchor = anchors.first()
    await expect(anchor).toHaveAttribute('href', 'https://example.com/docs')
    await expect(anchor).toHaveText('https://example.com/docs')
    await expect(anchor).toHaveAttribute('target', '_blank')
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(row.locator('.bubble .text')).toContainText('docs. Not a link: javascript:alert(1)')
    // A javascript: string never becomes a link.
    expect(await row.locator('.bubble .text a').count()).toBe(1)

    // A long URL wraps inside the bubble instead of overflowing the phone.
    await writer.chat.send(`Long: https://example.com/${'a'.repeat(300)}`)
    const longRow = page.locator('#chatLog .msg').filter({ hasText: 'Long:' })
    await expect(longRow).toBeVisible()
    expect(await longRow.locator('.bubble').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    // Keyboard: the link is reachable by Tab and shows a visible focus ring.
    await anchor.focus()
    await expect(anchor).toBeFocused()

    if (browser.browserType().name() === 'chromium') {
      // "Copy text" on the actions menu puts the exact message text, links
      // and all, on the clipboard.
      await row.locator('.messageMore').click()
      const panel = page.locator('#messageActionPanel')
      const copyButton = panel.getByRole('button', { name: 'Copy text', exact: true })
      await expect(copyButton).toBeVisible()
      await copyButton.click()
      await expect(page.locator('#status')).toContainText('copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MESSAGE_TEXT)
      await expect(panel).not.toBeVisible()
    }

    // Holding the link itself does not trigger the bubble's reaction hold:
    // reaction-hold.ts already steps aside for any press starting on an
    // `a`, so the 450ms timer never even starts.
    // The narrow phone bubble wraps this URL onto two lines, so the point to
    // press comes from the anchor's first line fragment, not the union
    // bounding box `boundingBox()` would give across both lines - a wrapped
    // inline element's box can have a gap in it that belongs to its parent.
    const { x: cx, y: cy } = await anchor.evaluate((el) => {
      const rect = el.getClientRects()[0]!
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.waitForTimeout(600)
    await expect(page.locator('#messageActionPanel')).not.toBeVisible()
    await page.mouse.up()
  } finally { writer.leave(); await context.close() }
})
