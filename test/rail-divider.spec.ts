import { test, expect, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, open } from './browser.js'

/**
 * The drag line on the rooms rail, in the installed window.
 *
 * The owner's words: "you added the numbers of unread on the desktop, but
 * now it's too squashed - we need a drag line like we have between video
 * and chat." This drives the rail's divider with a mouse and the keyboard
 * and checks the rail widens, clamps, is remembered, and resets.
 */

test.use({ actionTimeout: 30_000 })

const railWidth = async (page: Page): Promise<number> => (await page.locator('#workspaceNav').boundingBox())!.width

async function drag(page: Page, dx: number): Promise<void> {
  const box = (await page.locator('#railDivider').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}

test('the rooms rail drags, keys, clamps, is remembered and resets', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(180_000)
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(page, baseURL!)
    await open(page, url, 'Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'open')

    const divider = page.locator('#railDivider')
    await expect(divider).toBeVisible()
    await expect(divider).toHaveAttribute('role', 'separator')
    await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
    expect(await divider.evaluate(el => getComputedStyle(el).cursor)).toBe('col-resize')
    const initial = await railWidth(page)
    expect(initial).toBeGreaterThan(200)
    expect(initial).toBeLessThan(216)

    // Dragging right widens the rail, and the room beside it gives way.
    const roomBefore = (await page.locator('#roomArea').boundingBox())!.width
    await drag(page, 150)
    const wide = await railWidth(page)
    expect(wide).toBeGreaterThan(initial + 130)
    expect((await page.locator('#roomArea').boundingBox())!.width).toBeLessThan(roomBefore - 130)

    // It clamps both ways rather than swallowing the room or vanishing.
    await drag(page, 2000)
    expect(await railWidth(page)).toBeLessThanOrEqual(Math.min(512, 1440 * 0.4) + 1)
    await drag(page, -2000)
    expect(await railWidth(page)).toBeGreaterThanOrEqual(175)

    // The keyboard, from the floor.
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => railWidth(page)).toBeGreaterThan(190)
    await page.keyboard.press('Shift+ArrowRight')
    const keyed = await railWidth(page)
    expect(keyed).toBeGreaterThan(250)
    await expect(divider).toHaveAttribute('aria-valuenow', String(Math.round(keyed)))

    // Remembered on this device.
    await page.reload()
    await page.locator('#join').click().catch(() => {})
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect.poll(() => railWidth(page)).toBeGreaterThan(keyed - 2)

    // A double-click puts it back.
    await divider.dblclick()
    await expect.poll(() => railWidth(page)).toBeLessThan(216)

    // Collapsed, there is nothing to drag.
    await page.locator('#projectsRailToggle').click()
    await expect(divider).toBeHidden()
  } finally {
    await context.close()
  }
})
