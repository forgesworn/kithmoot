import { test, expect } from '@playwright/test'
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

test('the sharer is told when somebody draws on their screen, and the notice brings the preview back into view', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), viewer = await b.newPage()
    // This browser's own Document Picture-in-Picture support, if any, is
    // covered by the stubbed test below. Forcing it off here keeps this
    // test about the notice - the fallback every other browser gets -
    // regardless of which Chromium Playwright happens to bundle.
    await presenter.addInitScript(() => { Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }) })
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click(); await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(viewer)
    await presenter.locator('#toggleScreen').click()
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60000 }); await expand.click()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)

    // The presenter's own tile, pushed out of view the way it actually is
    // while presenting: looking at the shared window, not at this page.
    await presenter.evaluate(() => {
      const spacer = document.createElement('div')
      spacer.style.height = '3000px'
      document.body.prepend(spacer)
    })
    const myPreview = presenter.locator('video.screenPreview')
    await expect(myPreview).not.toBeInViewport()

    const notice = presenter.locator('#sharerMarksNotice')
    await expect(notice).toBeHidden()

    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const drawStroke = async () => {
      const drawRect = (await dialog.locator('.shareViewport').boundingBox())!
      await viewer.mouse.move(drawRect.x + drawRect.width * .3, drawRect.y + drawRect.height * .35)
      await viewer.mouse.down()
      await viewer.mouse.move(drawRect.x + drawRect.width * .7, drawRect.y + drawRect.height * .65, { steps: 12 })
      await viewer.mouse.up()
    }
    await drawStroke()

    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(notice).toHaveAttribute('role', 'status')
    await expect(presenter.locator('#sharerMarksNoticeText')).toContainText('Rowan')
    await expect(presenter.locator('#sharerMarksNoticeText')).toContainText('is drawing on your screen')
    // No floating window on this browser: only the one button.
    await expect(presenter.locator('#sharerMarksNoticeFloat')).toBeHidden()

    // Its button brings the preview back into view and dismisses the notice.
    await presenter.locator('#sharerMarksNoticeShow').click()
    await expect(notice).toBeHidden()
    await expect(myPreview).toBeInViewport()

    // A second stroke from the same drawer, straight away, is inside the
    // rate limit and is not announced again.
    await drawStroke()
    await presenter.waitForTimeout(500)
    await expect(notice).toBeHidden()
  } finally { await a.close(); await b.close() }
})

test('a floating preview window carries the same marks overlay, exercised with a stubbed Document Picture-in-Picture window', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), viewer = await b.newPage()
    // A stand-in for the platform's own Document Picture-in-Picture API: a
    // fresh, detached document from `document.implementation`, exactly as
    // real support hands back, but with no real second window behind it -
    // which is the part headless Chromium in CI cannot be relied on for.
    // Real support (Chromium desktop only) is not exercised by this suite.
    await presenter.addInitScript(() => {
      const state: { wins: { document: Document; closed: boolean }[] } = { wins: [] }
      ;(window as unknown as { __pipStub: unknown }).__pipStub = state
      // A plain assignment does not stick: this browser already exposes the
      // real API as a non-writable property, so overriding it needs the same
      // `Object.defineProperty` trick the unsupported-browser test above uses
      // to turn it off.
      Object.defineProperty(window, 'documentPictureInPicture', {
        configurable: true,
        value: {
          window: null,
          requestWindow: async () => {
            const doc = document.implementation.createHTMLDocument('pip')
            const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
            const win = {
              document: doc,
              closed: false,
              addEventListener(type: string, fn: (...a: unknown[]) => void) {
                const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list)
              },
              removeEventListener(type: string, fn: (...a: unknown[]) => void) {
                const list = listeners.get(type); if (!list) return
                const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1)
              },
              close() {
                if (win.closed) return
                win.closed = true
                for (const fn of listeners.get('pagehide') ?? []) fn()
              },
            }
            state.wins.push(win)
            return win
          },
        },
      })
    })
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click(); await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(viewer)
    await presenter.locator('#toggleScreen').click()

    const floatingToggle = presenter.locator('#toggleFloatingMarks')
    await expect(floatingToggle).toBeVisible({ timeout: 10_000 })
    await floatingToggle.click()
    await expect.poll(() => presenter.evaluate(() => (window as unknown as { __pipStub: { wins: unknown[] } }).__pipStub.wins.length)).toBe(1)
    await expect(floatingToggle).toHaveAttribute('data-on', 'true')

    // The floating document gets its own video, playing the same track.
    await expect.poll(() => presenter.evaluate(() => {
      const win = (window as unknown as { __pipStub: { wins: { document: Document }[] } }).__pipStub.wins.at(-1)!
      return win.document.querySelector('video') !== null
    })).toBe(true)

    // A remote stroke paints the overlay inside the floating document too.
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60000 }); await expand.click()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const drawRect = (await dialog.locator('.shareViewport').boundingBox())!
    await viewer.mouse.move(drawRect.x + drawRect.width * .3, drawRect.y + drawRect.height * .35)
    await viewer.mouse.down()
    await viewer.mouse.move(drawRect.x + drawRect.width * .7, drawRect.y + drawRect.height * .65, { steps: 12 })
    await viewer.mouse.up()
    await expect.poll(() => presenter.evaluate(() => {
      const win = (window as unknown as { __pipStub: { wins: { document: Document }[] } }).__pipStub.wins.at(-1)!
      return win.document.querySelector('canvas.shareMarks')?.getAttribute('data-strokes')
    })).toBe('1')

    // With the floating window open, the ordinary notice does not also fire.
    await expect(presenter.locator('#sharerMarksNotice')).toBeHidden()

    // Stopping the share closes the floating window and cleans up its video.
    await presenter.locator('#toggleScreen').click()
    await expect.poll(() => presenter.evaluate(() =>
      (window as unknown as { __pipStub: { wins: { closed: boolean }[] } }).__pipStub.wins.at(-1)!.closed)).toBe(true)
    await expect.poll(() => presenter.evaluate(() => {
      const win = (window as unknown as { __pipStub: { wins: { document: Document }[] } }).__pipStub.wins.at(-1)!
      return (win.document.querySelector('video') as HTMLVideoElement | null)?.srcObject ?? null
    })).toBe(null)
  } finally { await a.close(); await b.close() }
})
