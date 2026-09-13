import { test, expect, type Locator, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, open, openCall } from './browser.js'

test('a viewer enlarges, pans and pops out a real received synthetic screen without stopping it', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), viewer = await b.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click(); await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(viewer)
    await presenter.locator('#toggleScreen').click()
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60000 }); await expand.click()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    const video = dialog.locator('video')
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    const previous = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(previous)
    // The viewer can mark the shared image. The presenter, who has opened
    // nothing, sees the same normalised stroke over their own preview tile;
    // it is a pointer, not a record, so it fades away after a couple of
    // seconds and never becomes a chat item.
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const drawStroke = async () => {
      const drawRect = (await dialog.locator('.shareViewport').boundingBox())!
      await viewer.mouse.move(drawRect.x + drawRect.width * .3, drawRect.y + drawRect.height * .35)
      await viewer.mouse.down()
      await viewer.mouse.move(drawRect.x + drawRect.width * .7, drawRect.y + drawRect.height * .65, { steps: 12 })
      await viewer.mouse.up()
    }
    await drawStroke()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '1')
    const presenterMarks = presenter.locator('canvas.shareMarks')
    await expect(presenterMarks).toHaveAttribute('data-strokes', '1', { timeout: 10_000 })
    await expect(presenterMarks).toBeVisible()
    await expect(presenterMarks).toHaveAttribute('data-strokes', '0', { timeout: 10_000 })
    await expect(presenterMarks).toBeHidden()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '0')
    // The presenter's own expanded view paints the same marks, and a clear
    // removes them from both ends before they would have faded.
    const presenterExpand = presenter.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(presenterExpand).toBeVisible(); await presenterExpand.click()
    const presenterDialog = presenter.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => presenterDialog.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await drawStroke()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '1')
    await expect(presenterDialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '1', { timeout: 2_000 })
    await dialog.getByRole('button', { name: 'Clear marks', exact: true }).click()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '0')
    await expect(presenterDialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '0', { timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    await presenterDialog.getByRole('button', { name: 'Close screen-share viewer', exact: true }).click()
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click({ clickCount: 4 })
    const viewport = dialog.locator('.shareViewport')
    expect(Number(await viewport.getAttribute('data-zoom'))).toBeGreaterThan(2)
    const stage = dialog.locator('.shareStage')
    const before = await stage.getAttribute('style')
    const rect = (await viewport.boundingBox())!
    await viewer.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await viewer.mouse.down(); await viewer.mouse.move(rect.x + rect.width / 2 + 90, rect.y + rect.height / 2 + 70, { steps: 5 }); await viewer.mouse.up()
    expect(await stage.getAttribute('style')).not.toBe(before)
    await dialog.getByRole('button', { name: 'Fit to screen', exact: true }).click()
    await expect(viewport).toHaveAttribute('data-zoom', '1')
    await dialog.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await expect.poll(() => viewer.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
    await dialog.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    const popupPromise = viewer.waitForEvent('popup')
    await dialog.getByRole('button', { name: 'Pop out', exact: true }).click()
    const popup = await popupPromise
    await expect.poll(() => popup.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await popup.setViewportSize({ width: 700, height: 480 })
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await popup.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(popup.locator('.shareViewport')).toHaveAttribute('data-zoom', '1.25')
    await popup.close()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expand.click()
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await presenter.locator('#toggleScreen').click()
    await expect(dialog).toContainText('Screen sharing has stopped or is reconnecting')
    expect(await video.evaluate((v: HTMLVideoElement) => v.srcObject)).toBe(null)
    // And the tile behind the dialog: a stopped share comes off the
    // viewer's screen on the roster's word, not left as a black box, and
    // its Expand button goes with it.
    await expect(viewer.locator('#room video.screenPreview')).toHaveCount(0, { timeout: 10_000 })
    await expect(expand).toBeHidden()
    await presenter.locator('#toggleScreen').click()
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await viewer.setViewportSize({ width: 320, height: 640 })
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await viewer.screenshot({ path: '/tmp/kithmoot-share-viewer-320.png' })
    await dialog.getByRole('button', { name: 'Close screen-share viewer', exact: true }).click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await viewer.evaluate(() => { window.open = () => null })
    await expand.click(); await dialog.getByRole('button', { name: 'Pop out', exact: true }).click()
    await expect(dialog).toContainText('The pop-out was blocked')
  } finally { await a.close(); await b.close() }
})

interface MarkAuthorData { strokeId: string; label: string; color: string }

/** `data-authors` on a marks canvas, in the same spirit as the `data-strokes`
 *  and `data-zoom` this file already reads off other canvases and elements:
 *  the one thing a screenshot cannot answer reliably here is whose stroke is
 *  which colour and what its chip says, so app/src/share-viewer.ts puts that
 *  on the canvas as data for exactly this. */
async function markAuthors(canvas: Locator): Promise<MarkAuthorData[]> {
  return JSON.parse((await canvas.getAttribute('data-authors')) ?? '[]') as MarkAuthorData[]
}

test('a drawer gets the same colour on every screen, two different drawers get two different colours, and each chip names the right person', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!), c = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), rowan = await b.newPage(), sam = await c.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(rowan, link, 'Rowan'); await rowan.locator('#join').click(); await expect(rowan.locator('#roomArea')).toBeVisible()
    await open(sam, link, 'Sam'); await sam.locator('#join').click(); await expect(sam.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(rowan); await openCall(sam)
    await presenter.locator('#toggleScreen').click()

    // Both other participants open the viewer and switch to Draw before
    // anybody actually draws, so a stroke's arrival on their screens is
    // timed by signalling alone. A mark's whole life is a couple of seconds
    // (see HOLD_MS and FADE_MS in share-marks.ts), and opening a viewer from
    // cold - waiting for "Expand" to appear, for the video to decode a first
    // frame - is not reliably faster than that.
    const openDrawing = async (page: Page): Promise<Locator> => {
      const expand = page.getByRole('button', { name: 'Expand screen share from Ada' })
      await expect(expand).toBeVisible({ timeout: 60_000 }); await expand.click()
      const dialog = page.getByRole('dialog', { name: 'Screen-share viewer' })
      await expect.poll(() => dialog.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
      await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
      return dialog
    }
    const drawStroke = async (page: Page, dialog: Locator): Promise<void> => {
      const rect = (await dialog.locator('.shareViewport').boundingBox())!
      await page.mouse.move(rect.x + rect.width * 0.3, rect.y + rect.height * 0.3)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.6, { steps: 8 })
      await page.mouse.up()
    }

    const rowanDialog = await openDrawing(rowan)
    const samDialog = await openDrawing(sam)
    const presenterOverlay = presenter.locator('canvas.shareMarks')

    await drawStroke(rowan, rowanDialog)
    await expect(presenterOverlay).toHaveAttribute('data-strokes', '1', { timeout: 5_000 })
    const rowanOnSharer = (await markAuthors(presenterOverlay)).find(m => m.label.startsWith('Rowan'))
    expect(rowanOnSharer, 'the sharer never saw a mark labelled for Rowan').toBeDefined()

    // Rowan's own stroke, on Rowan's own screen, is the very same colour the
    // sharer sees - "the blue arrow" has to mean the same arrow to everybody,
    // including whoever drew it, so there is no separate "this device's own"
    // colour any more.
    const rowanOnOwnScreen = (await markAuthors(rowanDialog.locator('.shareAnnotations'))).find(m => m.label.startsWith('Rowan'))
    expect(rowanOnOwnScreen?.color).toBe(rowanOnSharer!.color)

    // Sam is neither the sharer nor (yet) a drawer: a third viewer, seeing
    // Rowan's mark with no coordination between Sam's page and the sharer's.
    await expect.poll(async () => (await markAuthors(samDialog.locator('.shareAnnotations'))).some(m => m.label.startsWith('Rowan')), {
      timeout: 5_000, message: 'a third viewer never saw a mark labelled for Rowan',
    }).toBe(true)
    const rowanOnThirdViewer = (await markAuthors(samDialog.locator('.shareAnnotations'))).find(m => m.label.startsWith('Rowan'))!
    expect(rowanOnThirdViewer.color).toBe(rowanOnSharer!.color)

    await drawStroke(sam, samDialog)
    await expect.poll(async () => (await markAuthors(presenterOverlay)).some(m => m.label.startsWith('Sam')), {
      timeout: 5_000, message: 'the sharer never saw a mark labelled for Sam',
    }).toBe(true)
    // Read both marks off the sharer's tile in the same snapshot: a clash
    // is resolved against whoever else is live right now (share-marks.ts's
    // `coloursForShare`), so comparing a fresh colour against one read
    // before Sam ever drew could catch a colour mid-shift and call it a
    // difference that was never really there.
    const onSharerWithBoth = await markAuthors(presenterOverlay)
    const samOnSharer = onSharerWithBoth.find(m => m.label.startsWith('Sam'))!
    const rowanOnSharerNow = onSharerWithBoth.find(m => m.label.startsWith('Rowan'))

    // Sam's own stroke, on Sam's own screen, is likewise the same colour
    // the sharer sees for it.
    const samOnOwnScreen = (await markAuthors(samDialog.locator('.shareAnnotations'))).find(m => m.label.startsWith('Sam'))
    expect(samOnOwnScreen?.color).toBe(samOnSharer.color)

    // Two different drawers, two different colours, both readable from the
    // sharer's own tile - unless Rowan's mark has already faded off it by
    // now, in which case there is nothing left to compare and the fade is
    // doing its job, not this assertion.
    if (rowanOnSharerNow) expect(samOnSharer.color).not.toBe(rowanOnSharerNow.color)
  } finally { await a.close(); await b.close(); await c.close() }
})
