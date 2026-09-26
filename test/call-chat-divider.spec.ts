import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open } from './browser.js'

/**
 * The divider between the call and the chat, on a wide screen.
 *
 * The owner's words: "on the desktop apps in particular we should be able
 * to let the user drag the divider to have more chat or more video." This
 * drives it with a mouse and with the keyboard, in the layout call-focus.ts
 * draws once a call has pictures in it, and checks the chat's width moves,
 * stays inside the floors either side owns, and survives a reload.
 *
 * Runs in both Chromium projects: the ordinary build and the installed
 * window share the same divider - see call-focus.ts.
 *
 * Screenshots go to CALL_CHAT_DIVIDER_SHOTS when it is set.
 */

test.use({ actionTimeout: 30_000 })

const SHOTS = process.env.CALL_CHAT_DIVIDER_SHOTS ?? resolve('test-results/call-chat-divider')

async function shot(page: Page, name: string): Promise<void> {
  const size = page.viewportSize()!
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${size.width}x${size.height}-${name}.png` })
}

async function joinCall(browser: Browser, baseURL: string, url: string, name: string, contexts: BrowserContext[]): Promise<Page> {
  const context = await newDeviceContext(browser, baseURL)
  contexts.push(context)
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#callToggle')).toHaveText('Join call', { timeout: 60_000 })
  await page.locator('#callToggle').click()
  await expect(page.locator('#deviceControls')).toBeVisible()
  await page.locator('#toggleCamera').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  return page
}

/** The chat's own width, whichever way it is showing: the drawer in the
 *  installed window, or the loose composer beside the stage otherwise. */
async function chatWidth(page: Page): Promise<number> {
  const box = (await page.locator('#chatForm').boundingBox())!
  return box.width
}

async function dragDivider(page: Page, dx: number): Promise<void> {
  const divider = page.locator('#callChatDivider')
  const box = (await divider.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 12 })
  await page.mouse.up()
  // The rAF-throttled apply has a frame to settle in.
  await page.waitForTimeout(150)
}

test('the divider drags, keys, clamps and is remembered', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const context = await newDeviceContext(browser, baseURL!)
    contexts.push(context)
    const ada = await context.newPage()
    await ada.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinCall(browser, baseURL!, url, 'Bob', contexts)
    await expect(ada.locator('html')).toHaveAttribute('data-call-first', '', { timeout: 60_000 })
    await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')

    const divider = ada.locator('#callChatDivider')
    await expect(divider).toBeVisible()
    await expect(divider).toHaveAttribute('role', 'separator')
    await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
    await expect(divider).toHaveAttribute('aria-label', 'Resize chat')
    await expect(divider).toHaveAttribute('tabindex', '0')
    const cursor = await divider.evaluate(el => getComputedStyle(el).cursor)
    expect(cursor).toBe('col-resize')
    await shot(ada, 'default')

    // Dragging left - towards the stage - hands the chat more room.
    const before = await chatWidth(ada)
    await dragDivider(ada, -200)
    const wide = await chatWidth(ada)
    expect(wide, 'dragging towards the stage should widen the chat').toBeGreaterThan(before + 100)
    await shot(ada, 'dragged-wide')

    // Dragging the other way narrows it, but clamps at its own floor -
    // CHAT_MIN_WIDTH_PX - rather than collapsing it.
    await dragDivider(ada, 900)
    const narrow = await chatWidth(ada)
    expect(narrow, 'dragging towards the chat should narrow it').toBeLessThan(wide)
    expect(narrow, 'the chat should never go below its floor').toBeGreaterThanOrEqual(320)
    await shot(ada, 'dragged-narrow')

    // The call pane keeps a floor too: it never disappears under a chat
    // dragged the other way as far as it will go.
    await dragDivider(ada, -900)
    const stageWidth = (await ada.locator('#callStage').boundingBox())!.width
    expect(stageWidth, 'the call pane should keep a floor of its own').toBeGreaterThanOrEqual(230)

    // Home first, to a known floor - then a few small steps land somewhere
    // in the middle, well clear of either end, where a plain step and a
    // bigger Shift step are both free to make a real difference.
    await divider.focus()
    await ada.keyboard.press('Home')
    await expect.poll(() => chatWidth(ada)).toBeLessThanOrEqual(365)
    for (let i = 0; i < 4; i++) await ada.keyboard.press('ArrowLeft')
    const mid = await chatWidth(ada)
    await ada.keyboard.press('ArrowRight')
    await expect.poll(() => chatWidth(ada)).toBeLessThan(mid)
    const afterRight = await chatWidth(ada)
    await ada.keyboard.press('ArrowLeft')
    await expect.poll(() => chatWidth(ada)).toBeGreaterThan(afterRight)
    const afterLeft = await chatWidth(ada)
    await ada.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => chatWidth(ada)).toBeGreaterThan(afterLeft + 20)

    // End goes to the other limit.
    await ada.keyboard.press('End')
    await expect.poll(() => chatWidth(ada)).toBeGreaterThan(500)

    // A visible focus ring.
    const outline = await divider.evaluate(el => getComputedStyle(el).outlineStyle)
    expect(outline, 'a focused divider should show its focus ring').not.toBe('none')

    // Persists as a fraction, across a reload and a rejoin.
    await ada.keyboard.press('ArrowLeft')
    await ada.keyboard.press('ArrowLeft')
    const beforeReload = await chatWidth(ada)
    const storedFraction = await ada.evaluate(() => localStorage.getItem('kithmoot.call-chat-divider'))
    expect(storedFraction).not.toBeNull()

    await ada.reload()
    await ada.locator('#displayName').fill('Ada')
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(ada.locator('#callToggle')).toHaveText('Join call', { timeout: 60_000 })
    await ada.locator('#callToggle').click()
    await ada.locator('#toggleCamera').click()
    await expect(ada.locator('html')).toHaveAttribute('data-call-first', '', { timeout: 60_000 })
    await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')
    const afterReload = await chatWidth(ada)
    expect(Math.abs(afterReload - beforeReload), 'the split should survive a reload at the same size').toBeLessThan(8)

    // Enter, or a double-click, resets it.
    await divider.focus()
    await ada.keyboard.press('Enter')
    await expect.poll(async () => ada.evaluate(() => localStorage.getItem('kithmoot.call-chat-divider'))).toBeNull()
    const afterReset = await chatWidth(ada)
    expect(Math.abs(afterReset - beforeReload), 'Enter should move the split back to the default').toBeGreaterThan(20)
    await dragDivider(ada, -150)
    await divider.dblclick()
    await expect.poll(async () => ada.evaluate(() => localStorage.getItem('kithmoot.call-chat-divider'))).toBeNull()
    await shot(ada, 'reset')
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('the divider, by eye, at a laptop and a tablet window, light and dark', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const context = await newDeviceContext(browser, baseURL!)
    contexts.push(context)
    const ada = await context.newPage()
    await ada.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinCall(browser, baseURL!, url, 'Bob', contexts)
    await expect(ada.locator('html')).toHaveAttribute('data-call-first', '', { timeout: 60_000 })
    await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')
    const divider = ada.locator('#callChatDivider')

    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await ada.setViewportSize(size)
      await ada.waitForTimeout(150)
      // Below 1280px the chat panel starts shut on a device that has never
      // said otherwise (see chatPanelOpen in call-focus-model.ts) - open it
      // by hand so the divider, which only shows beside an open chat, is
      // there to shoot.
      if (await ada.locator('#callChatToggle').getAttribute('aria-expanded') === 'false') {
        await ada.locator('#callChatToggle').click()
      }
      await expect(ada.locator('#callChatDivider')).toBeVisible()
      for (const scheme of ['light', 'dark'] as const) {
        await ada.emulateMedia({ colorScheme: scheme })
        await divider.dblclick()
        await shot(ada, `${scheme}-default`)
        await dragDivider(ada, -200)
        await shot(ada, `${scheme}-wide`)
        await dragDivider(ada, 900)
        await shot(ada, `${scheme}-narrow`)
      }
    }
  } finally {
    for (const context of contexts) await context.close()
  }
})
