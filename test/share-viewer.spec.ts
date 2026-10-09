import { test, expect, type Locator, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, open, openCall } from './browser.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { testRelaysFor } from './relays.js'

/** Wait for presence so the viewer joins this call instead of starting another. */
async function openExistingCall(page: Page): Promise<void> {
  await expect(page.locator('#callStripAction')).toHaveText('Join call')
  await openCall(page)
}

test('independent share popouts keep their call owner, camera and annotations while another room is read', async ({ browser, baseURL }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => newDeviceContext(browser, baseURL!)))
  const secret = generateRoomSecret()
  const side = { roomId: deriveRoom(secret).roomId, name: 'Side room', link: encodeRoomLink(baseURL!, { secret, name: 'Side room', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
  await contexts[2]!.addInitScript(room => localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room)), side)
  try {
    const [ada, bo, viewer] = await Promise.all(contexts.map(context => context.newPage()))
    const link = await createRoom(ada!, baseURL!)
    for (const [page, name] of [[ada!, 'Ada'], [bo!, 'Bo'], [viewer!, 'Rowan']] as const) {
      await open(page, link, name); await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()
      if (name === 'Ada') await openCall(page)
      else await openExistingCall(page)
    }
    for (const presenter of [ada!, bo!]) {
      await presenter.locator('#toggleCamera').click()
      await presenter.locator('#toggleScreen').click()
    }
    const popOut = async (name: string) => {
      await viewer!.getByRole('button', { name: `Expand screen share from ${name}` }).click()
      const dialog = viewer!.getByRole('dialog', { name: 'Screen-share viewer' })
      const next = viewer!.waitForEvent('popup')
      await dialog.getByRole('button', { name: 'Pop out', exact: true }).click()
      const popup = await next
      await expect(popup.locator('.shareViewerBar h2')).toContainText(name)
      await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
      await expect.poll(() => popup.locator('.shareOwnerCamera video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
      expect(await popup.locator('video').evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).muted))).toBe(true)
      await expect(popup.locator('audio')).toHaveCount(0)
      return popup
    }
    const first = await popOut('Ada'), second = await popOut('Bo')
    const originalExpand = await viewer!.getByRole('button', { name: 'Expand screen share from Ada', exact: true }).elementHandle()
    await first.screenshot({ path: '/tmp/kithmoot-call-origin-popout.png' })
    const firstOwner = await first.locator('main.shareViewer').getAttribute('data-share-owner')
    const secondOwner = await second.locator('main.shareViewer').getAttribute('data-share-owner')
    expect(firstOwner).not.toBe(secondOwner)
    const origin = await first.locator('main.shareViewer').getAttribute('data-origin-room')
    expect(origin).toBe(await second.locator('main.shareViewer').getAttribute('data-origin-room'))
    expect(origin).not.toBe(side.roomId)
    const tracks = await first.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks().map(track => track.id))

    await viewer!.keyboard.press('Control+k')
    await viewer!.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Side room', exact: true }).click()
    await expect(viewer!.locator('#roomTitle')).toHaveText('Side room')
    await expect(viewer!.locator('#callDock')).toBeVisible()
    for (const popup of [first, second]) {
      expect(popup.isClosed()).toBe(false)
      await expect(popup.locator('main.shareViewer')).toHaveAttribute('data-origin-room', origin!)
      await expect(popup.locator('.shareViewerBar h2')).not.toContainText('Side room')
      const before = await popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.currentTime)
      await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(before)
    }
    expect(await first.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks().map(track => track.id))).toEqual(tracks)
    await first.getByRole('button', { name: 'Draw', exact: true }).click()
    const picture = (await first.locator('.shareStage').boundingBox())!
    await first.mouse.move(picture.x + picture.width * .25, picture.y + picture.height * .3)
    await first.mouse.down(); await first.mouse.move(picture.x + picture.width * .6, picture.y + picture.height * .6, { steps: 10 }); await first.mouse.up()
    const marks = ada!.locator('#room .participant[data-self="true"] canvas.shareMarks')
    await expect(marks).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/, { timeout: 10_000 })
    await expect(marks).toHaveAttribute('data-legend', /Rowan/)

    await ada!.locator('#toggleCamera').click()
    await expect(first.locator('.shareCameraFallback')).toHaveText('Camera off')
    await expect(first.locator('.shareOwnerCamera video')).toBeHidden()
    await ada!.locator('#toggleCamera').click()
    await expect.poll(() => first.locator('.shareOwnerCamera video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
    expect(await viewer!.getByRole('button', { name: 'Expand screen share from Ada', exact: true }).evaluate((button, original) => button === original, originalExpand)).toBe(true)
    await first.getByRole('button', { name: 'Hide camera', exact: true }).click()
    await expect(first.locator('.shareOwnerCamera')).toBeHidden()
    await first.getByRole('button', { name: 'Show camera', exact: true }).click()
    await expect(first.locator('.shareOwnerCamera')).toBeVisible()

    await second.close()
    expect(first.isClosed()).toBe(false)
    await expect(bo!.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await viewer!.locator('#callDockBack').click()
    expect(await first.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks().map(track => track.id))).toEqual(tracks)
    const returning = await popOut('Bo')
    await bo!.locator('#leaveCall').click()
    await expect(returning.locator('.shareViewerNotice')).toHaveText('The sharer has left the call.')
    expect(await returning.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBe(null)
    await returning.close()
    await viewer!.keyboard.press('Control+k')
    await viewer!.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Side room', exact: true }).click()
    await ada!.locator('#toggleScreen').click()
    await expect(first.locator('.shareViewerNotice')).toHaveText('Screen sharing has ended.')
    expect(await first.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBe(null)
    await viewer!.locator('#callDockLeave').click()
    await expect.poll(() => first.isClosed()).toBe(true)
    await expect(viewer!.locator('#roomTitle')).toHaveText('Side room')
  } finally { await Promise.allSettled(contexts.map(context => context.close())) }
})

test('a phone share viewer keeps the camera inside its picture area and controls reachable', async ({ browser, baseURL }) => {
  const presenterContext = await newDeviceContext(browser, baseURL!)
  const phoneContext = await newDeviceContext(browser, baseURL!, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    const presenter = await presenterContext.newPage(), phone = await phoneContext.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await openCall(presenter)
    await open(phone, link, 'Rowan'); await phone.locator('#join').click()
    await openExistingCall(phone)
    await presenter.locator('#toggleCamera').click(); await presenter.locator('#toggleScreen').click()
    await phone.getByRole('button', { name: 'Expand screen share from Ada' }).click()
    const dialog = phone.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('.shareOwnerCamera video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
    const viewport = (await dialog.locator('.shareViewport').boundingBox())!
    const camera = (await dialog.locator('.shareOwnerCamera').boundingBox())!
    expect(camera.x).toBeGreaterThanOrEqual(viewport.x)
    expect(camera.y).toBeGreaterThanOrEqual(viewport.y)
    expect(camera.x + camera.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1)
    expect(camera.y + camera.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1)
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(dialog.locator('.shareOwnerName')).toHaveText('Ada')
    await expect(dialog.locator('.shareViewerBar h2')).toContainText('Untitled room')
    for (const label of ['Hide camera', 'Close screen-share viewer']) {
      const button = dialog.getByRole('button', { name: label, exact: true })
      const bounds = (await button.boundingBox())!
      expect(bounds.height).toBeGreaterThanOrEqual(44)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
    }
    await dialog.screenshot({ path: '/tmp/kithmoot-call-origin-phone.png' })
    await dialog.getByRole('button', { name: 'Hide camera', exact: true }).click()
    await expect(dialog.locator('.shareOwnerCamera')).toBeHidden()
    await dialog.getByRole('button', { name: 'Show camera', exact: true }).click()
    await expect(dialog.locator('.shareOwnerCamera')).toBeVisible()
    await dialog.getByRole('button', { name: 'Close screen-share viewer', exact: true }).click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
  } finally { await Promise.allSettled([presenterContext.close(), phoneContext.close()]) }
})

test('a viewer enlarges, pans and pops out a real received synthetic screen without stopping it', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), viewer = await b.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click(); await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openExistingCall(viewer)
    await presenter.locator('#toggleScreen').click()
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60000 }); await expand.click()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    const video = dialog.locator('.shareStage > video')
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
      // Model iOS WebKit losing element-level pointer capture: the stroke
      // ends elsewhere in the window. The completed line must still publish
      // to the sharer rather than remaining only under the viewer's finger.
      await dialog.locator('.shareViewport').evaluate((viewport) => {
        if (viewport.hasPointerCapture(1)) viewport.releasePointerCapture(1)
      })
      await viewer.mouse.move(4, 4)
      await viewer.mouse.up()
    }
    await drawStroke()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/)
    const presenterMarks = presenter.locator('canvas.shareMarks')
    await expect(presenterMarks).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/, { timeout: 10_000 })
    await expect(presenterMarks).toBeVisible()
    const legend = JSON.parse((await presenterMarks.getAttribute('data-legend')) ?? '[]')
    expect(legend).toHaveLength(1)
    expect(legend[0].label).toContain('Rowan')
    expect(legend[0].color).toMatch(/^#[0-9a-f]{6}$/i)
    await dialog.screenshot({ path: '/tmp/kithmoot-share-legend.png' })
    await expect(presenterMarks).toHaveAttribute('data-strokes', '0', { timeout: 10_000 })
    await expect(presenterMarks).toBeHidden()
    await expect(presenterMarks).toHaveAttribute('data-legend', '[]')
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-legend', '[]')
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', '0')
    // The presenter's own expanded view paints the same marks, and a clear
    // removes them from both ends before they would have faded.
    const presenterExpand = presenter.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(presenterExpand).toBeVisible(); await presenterExpand.click()
    const presenterDialog = presenter.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => presenterDialog.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await drawStroke()
    await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/)
    await expect(presenterDialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/, { timeout: 2_000 })
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
    await expect.poll(() => popup.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await popup.setViewportSize({ width: 700, height: 480 })
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await popup.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(popup.locator('.shareViewport')).toHaveAttribute('data-zoom', '1.25')
    await popup.close()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expand.click()
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await presenter.locator('#toggleScreen').click()
    await expect(dialog).toContainText('Screen sharing has ended')
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
    await openCall(presenter); await openExistingCall(viewer)
    await presenter.locator('#toggleScreen').click()
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60000 }); await expand.click()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)

    // The presenter's own tile, pushed out of view the way it actually is
    // while presenting: looking at the shared window, not at this page.
    await presenter.evaluate(() => {
      const spacer = document.createElement('div')
      spacer.style.height = '3000px'
      // A call puts the page in a column the height of the window, which
      // would squash a spacer that is allowed to shrink.
      spacer.style.flex = 'none'
      document.body.prepend(spacer)
    })
    const myPreview = presenter.locator('video.screenPreview')
    // Settled, not merely at first paint: the stage lays out a frame later.
    await presenter.waitForTimeout(1500)
    await expect(myPreview).not.toBeInViewport()

    const notice = presenter.locator('#sharerMarksNotice')
    await expect(notice).toBeHidden()

    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const drawStroke = async () => {
      const drawRect = (await dialog.locator('.shareViewport').boundingBox())!
      await viewer.mouse.move(drawRect.x + drawRect.width * .3, drawRect.y + drawRect.height * .35)
      await viewer.mouse.down()
      await viewer.mouse.move(drawRect.x + drawRect.width * .7, drawRect.y + drawRect.height * .65, { steps: 12 })
      // Other devices must see ink while the pointer is still held down.
      await expect(presenter.locator('canvas.shareMarks').first()).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/)
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
    await openCall(presenter); await openExistingCall(viewer)
    await presenter.locator('#toggleScreen').click()

    await presenter.locator('#callExtras').evaluate((fold) => { (fold as HTMLDetailsElement).open = true })
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
    await expect.poll(() => dialog.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const drawRect = (await dialog.locator('.shareViewport').boundingBox())!
    await viewer.mouse.move(drawRect.x + drawRect.width * .3, drawRect.y + drawRect.height * .35)
    await viewer.mouse.down()
    await viewer.mouse.move(drawRect.x + drawRect.width * .7, drawRect.y + drawRect.height * .65, { steps: 12 })
    await viewer.mouse.up()
    await expect.poll(() => presenter.evaluate(() => {
      const win = (window as unknown as { __pipStub: { wins: { document: Document }[] } }).__pipStub.wins.at(-1)!
      return win.document.querySelector('canvas.shareMarks')?.getAttribute('data-strokes')
    })).toMatch(/^[1-9][0-9]*$/)

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
    await openCall(presenter); await openExistingCall(rowan); await openExistingCall(sam)
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
      await expect.poll(() => dialog.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
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
    await expect(presenterOverlay).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/, { timeout: 5_000 })
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

test.describe('drawing on a screen share with a finger', () => {
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }

  /** A presenter on a desktop browser and a viewer on a phone-shaped touch
   *  context, with the viewer's expanded share viewer open and Draw on. */
  async function touchViewer(browser: Parameters<typeof newDeviceContext>[0], baseURL: string) {
    const a = await newDeviceContext(browser, baseURL), b = await newDeviceContext(browser, baseURL, phone)
    const presenter = await a.newPage(), viewer = await b.newPage()
    const link = await createRoom(presenter, baseURL)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click(); await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click(); await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openExistingCall(viewer)
    await presenter.locator('#toggleScreen').click()
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60_000 }); await expand.tap()
    const dialog = viewer.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('.shareStage > video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    const cdp = await b.newCDPSession(viewer)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })) })
    return { a, b, presenter, viewer, dialog, touch }
  }

  test('a one-finger drag draws once Draw is on, says so while it is off, and reaches the sharer', async ({ browser, baseURL }) => {
    const { a, b, presenter, dialog, touch } = await touchViewer(browser, baseURL!)
    try {
      // Off, the touch hint points at the button rather than leaving a drag to do nothing.
      await expect(dialog.locator('.shareViewerNotice')).toContainText('Tap Draw to draw on the screen')
      await dialog.getByRole('button', { name: 'Draw', exact: true }).tap()
      await expect(dialog.locator('.shareViewport')).toHaveClass(/drawing/)
      const stage = (await dialog.locator('.shareStage').boundingBox())!
      const x0 = stage.x + stage.width * .2, y0 = stage.y + stage.height * .3
      await touch('touchStart', [{ x: x0, y: y0, id: 0 }])
      for (let i = 1; i <= 20; i++) {
        await touch('touchMove', [{ x: x0 + i * 8, y: y0 + i * 3, id: 0 }])
        await viewerPause(15)
      }
      await expect(dialog.locator('.shareAnnotations')).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/)
      await touch('touchEnd', [])
      await expect(presenter.locator('canvas.shareMarks')).toHaveAttribute('data-strokes', /^[1-9][0-9]*$/, { timeout: 10_000 })
    } finally { await a.close(); await b.close() }
  })

  test('a touch that starts in the letterbox does not begin a stroke', async ({ browser, baseURL }) => {
    const { a, b, presenter, dialog, touch } = await touchViewer(browser, baseURL!)
    try {
      await dialog.getByRole('button', { name: 'Draw', exact: true }).tap()
      const stage = (await dialog.locator('.shareStage').boundingBox())!
      const viewport = (await dialog.locator('.shareViewport').boundingBox())!
      // Portrait: a wide picture is a band, so there is black above it.
      expect(stage.y - viewport.y).toBeGreaterThan(40)
      const x0 = stage.x + stage.width * .2, y0 = viewport.y + 10
      await touch('touchStart', [{ x: x0, y: y0, id: 0 }])
      // Dragging down onto the picture must not pick the stroke up part-way.
      for (let i = 1; i <= 20; i++) {
        await touch('touchMove', [{ x: x0 + i * 8, y: y0 + i * ((stage.y - y0 + stage.height / 2) / 20), id: 0 }])
        await viewerPause(15)
      }
      await touch('touchEnd', [])
      // Read once, not polled: marks fade after a couple of seconds, so a
      // retrying assertion would pass on the fade rather than on the fix.
      await viewerPause(500)
      expect(await dialog.locator('.shareAnnotations').getAttribute('data-strokes')).toBe('0')
      expect(await presenter.locator('canvas.shareMarks').getAttribute('data-strokes')).toBe('0')
    } finally { await a.close(); await b.close() }
  })

  test('a second finger does not restart the stroke the first is drawing', async ({ browser, baseURL }) => {
    const { a, b, dialog, touch } = await touchViewer(browser, baseURL!)
    try {
      await dialog.getByRole('button', { name: 'Draw', exact: true }).tap()
      const stage = (await dialog.locator('.shareStage').boundingBox())!
      const marks = dialog.locator('.shareAnnotations')
      const count = async () => Number(await marks.getAttribute('data-strokes'))
      const first = { x: stage.x + stage.width * .2, y: stage.y + stage.height * .3 }
      const second = { x: stage.x + stage.width * .8, y: stage.y + stage.height * .7 }
      await touch('touchStart', [{ ...first, id: 0 }])
      await touch('touchMove', [{ x: first.x + 30, y: first.y + 10, id: 0 }])
      await expect.poll(count).toBeGreaterThan(0)
      await viewerPause(200)
      const before = await count()
      // The first finger rests; only the second moves. Had it taken over the
      // stroke, its movement would publish new marks.
      await touch('touchStart', [{ x: first.x + 30, y: first.y + 10, id: 0 }, { ...second, id: 1 }])
      for (let i = 1; i <= 15; i++) {
        await touch('touchMove', [{ x: first.x + 30, y: first.y + 10, id: 0 }, { x: second.x - i * 6, y: second.y - i * 4, id: 1 }])
        await viewerPause(30)
      }
      expect(await count()).toBeLessThanOrEqual(before)
      await touch('touchEnd', [{ x: first.x + 30, y: first.y + 10, id: 0 }])
      await touch('touchEnd', [])
    } finally { await a.close(); await b.close() }
  })
})

const viewerPause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
