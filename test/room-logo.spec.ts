import { test, expect, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { newDeviceContext, open, leaveToChats, openRoomInfoPage } from './browser.js'
import { agentRelaysFor } from './relays.js'
import { createLogoImage, logoFromCanvasEncoding, type LogoImage } from '../src/logo-image.js'
import { followRoomLogo } from '../src/room-logo.js'

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

async function solidLogo(page: Page, colour: string) {
  const png = Buffer.from(await page.evaluate(colour => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = colour; ctx.fillRect(0, 0, 128, 128)
    return canvas.toDataURL('image/png').split(',')[1]!
  }, colour), 'base64')
  return logoFromCanvasEncoding(png, 'image/png')
}

/** Valid container checksums, but an unsupported PNG pixel format. Some
 * browsers recover truncated WebP bitstreams, so use a deterministic failure. */
function brokenPixels(source: LogoImage) {
  const bytes = Buffer.from(source.data, 'base64')
  bytes[25] = 255
  let crc = 0xffffffff
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
  return createLogoImage(bytes, 'image/png')
}

for (const scheme of ['light', 'dark'] as const) test(`an unusable signed room logo falls back and recovers on a ${scheme} phone`, async ({ browser, baseURL }) => {
  test.setTimeout(60_000)
  const context = await newDeviceContext(browser, baseURL!), publisher = followRoomLogo(keeper.session)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 320, height: 640 }); await page.emulateMedia({ colorScheme: scheme })
    const externalImages: string[] = []
    page.on('request', request => {
      if (request.resourceType() === 'image' && /^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) externalImages.push(request.url())
    })
    await enter(page); await openRoomInfoPage(page, 'Name and picture')
    await page.locator('#roomRenameInput').fill('Workshop'); await page.locator('#roomRenameSave').click()
    await page.locator('#roomSheetClose').click()
    const replacement = await solidLogo(page, '#008000')
    await publisher.replace(replacement)
    await expect(page.locator('#roomLogo img')).toHaveAttribute('src', `data:image/png;base64,${replacement.data}`)
    expect((await pixel(page))[1]).toBeGreaterThan(100)
    const image = brokenPixels(replacement)
    await publisher.replace(image)
    expect(publisher.current()?.image?.sha256).toBe(image.sha256)
    await expect.poll(() => page.evaluate(hash => Object.keys(localStorage)
      .filter(key => key.startsWith('kithmoot.room-logo.v1.'))
      .some(key => localStorage.getItem(key)?.includes(hash)), image.sha256)).toBe(true)
    expect(await page.evaluate(async image => {
      const bytes = Uint8Array.from(atob(image.data), character => character.charCodeAt(0))
      let bitmap: ImageBitmap | undefined
      try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: image.mime }))
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        return !pixels.some((value, at) => at % 4 === 3 && value > 0)
      } catch { return true }
      finally { bitmap?.close() }
    }, image)).toBe(true)
    await expect(page.locator('#roomLogo img')).toHaveCount(0)
    await expect(page.locator('#roomLogo')).toHaveText('W')
    await expect(page.locator('#roomTitle')).toHaveText('Workshop')
    // The image sits beside the text: stacking it above the name consumes
    // chat space and clips call controls in shorter windows.
    const logoBox = await page.locator('#roomLogo').boundingBox()
    const textBox = await page.locator('.roomIdentityText').boundingBox()
    expect(logoBox).not.toBeNull(); expect(textBox).not.toBeNull()
    expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(textBox!.x)
    expect(Math.abs(logoBox!.y + logoBox!.height / 2 - textBox!.y - textBox!.height / 2)).toBeLessThan(2)
    await page.locator('#backToRooms:visible, #workspaceSwitch:visible').first().click()
    await leaveToChats(page)
    const row = page.locator(`#roomList .roomRow[data-room="${keeper.roomId}"]`)
    await expect(row).toBeVisible()
    await expect(row.locator('.roomAvatar img')).toHaveCount(0)
    await expect(row.locator('.roomAvatar')).toHaveText('W')
    await expect(row.getByRole('button', { name: 'Open Workshop', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await publisher.replace(replacement)
    await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', `data:image/png;base64,${replacement.data}`)
    expect(await row.locator('.roomAvatar img').evaluate(async (image: HTMLImageElement) => { await image.decode(); return image.naturalWidth })).toBe(128)
    await row.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(page.locator('#roomLogo img')).toHaveAttribute('src', `data:image/png;base64,${replacement.data}`)
    expect((await pixel(page))[1]).toBeGreaterThan(100)
    expect(externalImages).toEqual([])
  } finally { publisher.close(); await context.close() }
})

test('late logo decoding releases its bitmap and displays the current replacement only once', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!), publisher = followRoomLogo(keeper.session)
  try {
    const page = await context.newPage(); await enter(page)
    const green = await solidLogo(page, '#008000'), blue = await solidLogo(page, '#0000ff')
    await page.evaluate(() => {
      const state = window as unknown as { releaseFirstLogo?: () => void; closedFirstLogo: number }
      state.closedFirstLogo = 0
      const native = window.createImageBitmap.bind(window); let held = false
      window.createImageBitmap = (async (source: ImageBitmapSource) => {
        const pause = source instanceof Blob && !held
        if (pause) held = true
        const bitmap = await native(source)
        if (pause) {
          const close = bitmap.close.bind(bitmap)
          bitmap.close = () => { ++state.closedFirstLogo; close() }
          await new Promise<void>(resolve => { state.releaseFirstLogo = resolve })
        }
        return bitmap
      }) as typeof createImageBitmap
    })
    await publisher.replace(green)
    await page.waitForFunction(() => !!(window as unknown as { releaseFirstLogo?: () => void }).releaseFirstLogo)
    await expect(page.locator('#roomLogo img')).toHaveCount(0)
    await publisher.replace(blue)
    await expect(page.locator('#roomLogo img')).toHaveAttribute('src', `data:image/png;base64,${blue.data}`)
    await publisher.replace(green)
    await expect.poll(() => page.evaluate(hash => Object.keys(localStorage)
      .filter(key => key.startsWith('kithmoot.room-logo.v1.'))
      .some(key => localStorage.getItem(key)?.includes(hash)), green.sha256)).toBe(true)
    await expect(page.locator('#roomLogo img')).toHaveCount(0)
    await page.evaluate(() => (window as unknown as { releaseFirstLogo?: () => void }).releaseFirstLogo?.())
    await expect.poll(() => page.evaluate(() => (window as unknown as { closedFirstLogo: number }).closedFirstLogo)).toBe(1)
    await expect(page.locator('#roomLogo img')).toHaveAttribute('src', `data:image/png;base64,${green.data}`)
    await expect(page.locator('#roomLogo img')).toHaveCount(1)
    expect((await pixel(page))[1]).toBeGreaterThan(100)
  } finally { publisher.close(); await context.close() }
})

test('admitted members crop, share, recover, replace and remove an inline room logo', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    await enter(ada); await enter(bob)
    await openRoomInfoPage(ada, 'Name and picture')
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
    await leaveToChats(ada)
    const room = keeper.roomId
    const row = ada.locator(`#roomList .roomRow[data-room="${room}"]`)
    await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', red!)
    await row.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)
    await ada.reload()
    // A room this device has joined opens by itself.
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)

    await openRoomInfoPage(bob, 'Name and picture')
    await bob.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await choose(bob, png, 'End')
    await bob.locator('.logoEditor [data-action=cancel]').click()
    await expect(ada.locator('#roomLogo img')).toHaveAttribute('src', red!)
    await leaveToChats(ada)
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
    await ada.reload()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(ada.locator('#roomLogo img')).toHaveCount(0)
  } finally { await a.close(); await b.close() }
})

test('cancelling while local image decoding completes releases its bitmap and shares nothing', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage(); await enter(page); await openRoomInfoPage(page, 'Name and picture')
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
    await enter(page); await openRoomInfoPage(page, 'Name and picture')
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
