import { test, expect, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { newDeviceContext, open, openRoomDetails } from './browser.js'
import { agentRelaysFor } from './relays.js'

let keeper: RoomAgent
test.beforeEach(async ({ baseURL }) => {
  keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', ...agentRelaysFor(baseURL!) })
})
test.afterEach(() => { keeper?.leave() })

async function splitImage(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 200)
    ctx.fillStyle = '#0000ff'; ctx.fillRect(200, 0, 200, 200)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  return Buffer.from(encoded, 'base64')
}
async function enter(page: Page) {
  await open(page, keeper.url, 'Member')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}
async function choose(page: Page, png: Buffer, position: 'Home' | 'End') {
  await page.locator('.logoEditor input[type=file]').setInputFiles({ name: 'local-logo.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('.logoEditor [data-action=save]')).toBeEnabled()
  await page.getByLabel('Horizontal position', { exact: true }).focus()
  await page.keyboard.press(position)
}
async function pixel(page: Page): Promise<number[]> {
  return page.locator('#roomLogo img').evaluate(async (image: HTMLImageElement) => {
    await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  })
}

test('admitted members crop, share, recover, replace and remove an inline room logo', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    await enter(ada); await enter(bob)
    await openRoomDetails(ada)
    await ada.locator('#roomRenameInput').fill('Workshop'); await ada.locator('#roomRenameSave').click()
    await expect(bob.locator('#roomTitle')).toHaveText('Workshop')
    const png = await splitImage(ada)
    await ada.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await choose(ada, png, 'Home')
    await ada.locator('.logoEditor [data-action=save]').click()
    await expect(ada.locator('.logoEditor')).toHaveCount(0)
    const red = await ada.locator('#roomLogo img').getAttribute('src')
    expect(red).toMatch(/^data:image\/(webp|png);base64,/)
    await expect(bob.locator('#roomLogo img')).toHaveAttribute('src', red!)
    expect((await pixel(bob))[0]).toBeGreaterThan(220)
    expect((await pixel(bob))[2]).toBeLessThan(30)
    await expect(ada.locator('#roomTitle')).toHaveText('Workshop')

    await ada.locator('#roomSheetClose').click()
    await ada.setViewportSize({ width: 1440, height: 900 })
    await ada.locator('#workspaceBrandHome').click()
    const room = keeper.roomId
    const row = ada.locator(`#roomList .roomRow[data-room="${room}"]`)
    await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', red!)
    await row.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)
    await ada.reload()
    await expect(ada.locator('#join')).toBeVisible(); await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)

    await openRoomDetails(bob)
    await bob.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await choose(bob, png, 'End')
    await bob.locator('.logoEditor [data-action=cancel]').click()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)
    await ada.locator('#workspaceBrandHome').click()
    const activity = await row.locator('.roomTime').textContent()
    await bob.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await choose(bob, png, 'End')
    await bob.locator('.logoEditor [data-action=save]').click()
    await expect(bob.locator('.logoEditor')).toHaveCount(0)
    const blue = await bob.locator('#roomLogo img').getAttribute('src')
    expect(blue).not.toBe(red)
    await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', blue!)
    await expect(row.locator('.roomTime')).toHaveText(activity ?? '')
    await row.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', blue!)
    expect((await pixel(ada))[2]).toBeGreaterThan(220)
    await bob.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await bob.getByRole('button', { name: 'Remove room logo', exact: true }).click()
    await expect(bob.locator('.logoEditor')).toHaveCount(0)
    await expect(ada.locator('#roomLogo img')).toHaveCount(0)
    await expect(bob.locator('#roomLogo')).toHaveText('W')
    await ada.reload(); await expect(ada.locator('#join')).toBeVisible(); await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible()
    await expect(ada.locator('#roomLogo img')).toHaveCount(0)
  } finally { await a.close(); await b.close() }
})

test('cancelling while local image decoding completes releases its bitmap and shares nothing', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage(); await enter(page); await openRoomDetails(page)
    await page.getByRole('button', { name: 'Change room logo', exact: true }).click()
    const png = await splitImage(page)
    await page.evaluate(() => {
      const state = window as unknown as { logoRelease?: () => void; logoAllocated?: boolean; logoClosed?: number }
      const native = window.createImageBitmap.bind(window)
      window.createImageBitmap = (async (source: ImageBitmapSource) => {
        const bitmap = await native(source), close = bitmap.close.bind(bitmap)
        bitmap.close = () => { state.logoClosed = (state.logoClosed ?? 0) + 1; close() }
        await new Promise<void>(resolve => { state.logoRelease = resolve; state.logoAllocated = true })
        return bitmap
      }) as typeof createImageBitmap
    })
    await page.locator('.logoEditor input[type=file]').setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: png })
    await page.waitForFunction(() => (window as unknown as { logoAllocated?: boolean }).logoAllocated === true)
    await page.locator('.logoEditor [data-action=cancel]').click()
    await page.evaluate(() => (window as unknown as { logoRelease?: () => void }).logoRelease?.())
    await expect.poll(() => page.evaluate(() => (window as unknown as { logoClosed?: number }).logoClosed)).toBe(1)
    await expect(page.locator('.logoEditor')).toHaveCount(0)
    await expect(page.locator('#roomLogo img')).toHaveCount(0)
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.room-logo.v1.')))).toEqual([])
  } finally { await context.close() }
})

for (const scheme of ['light', 'dark'] as const) test(`the ${scheme} phone editor rejects hostile images and remains usable at 320 pixels`, async ({ browser, baseURL }, info) => {
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage(); await page.setViewportSize({ width: 320, height: 640 }); await page.emulateMedia({ colorScheme: scheme })
    await enter(page); await openRoomDetails(page)
    await page.getByRole('button', { name: 'Change room logo', exact: true }).click()
    const requests: string[] = []; page.on('request', request => requests.push(request.url()))
    const input = page.locator('.logoEditor input[type=file]')
    await input.setInputFiles({ name: 'spoofed.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.invalid/secret" /></svg>') })
    await expect(page.locator('.logoEditorStatus')).toContainText('valid PNG, JPG or still WebP')
    await expect(page.locator('.logoEditor [data-action=save]')).toBeDisabled()
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1)
    await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: oversized })
    await expect(page.locator('.logoEditorStatus')).toContainText('up to 8 MB')
    await choose(page, await splitImage(page), 'End')
    const save = page.locator('.logoEditor [data-action=save]')
    await save.scrollIntoViewIfNeeded()
    const bounds = await save.boundingBox()
    expect(bounds!.height).toBeGreaterThanOrEqual(44)
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
    expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await page.screenshot({ path: info.outputPath(`room-logo-phone-${scheme}.png`), fullPage: true })
    await save.click(); await expect(page.locator('.logoEditor')).toHaveCount(0)
    await expect(page.locator('#roomLogo img')).toBeVisible()
    expect(requests.some(url => url.includes('tracker.invalid'))).toBe(false)
    expect(requests.some(url => url.includes('local-logo.png'))).toBe(false)
  } finally { await context.close() }
})
