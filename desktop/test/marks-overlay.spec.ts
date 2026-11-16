import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoom, joinWithMedia, INSTRUMENT, SYNTHETIC_MIC, SYNTHETIC_SCREEN } from '../../test/browser.js'
import { localAsset, HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relays = ['ws://127.0.0.1:17777']
process.env.E2E_RELAYS = relays.join(',')

// A display off the origin and at a size of its own, so an overlay that
// lands on the primary display, or on its work area, is caught.
const DISPLAY = { x: 200, y: 100, width: 1600, height: 900 }

// The synthetic presentation calls itself a shared tab; these say what the
// main process stands in for, as a real capture's own hint would.
const SURFACE = (surface: string) => {
  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getDisplayMedia = async options => {
    const stream = await original(options)
    const track = stream.getVideoTracks()[0]!
    const settings = track.getSettings.bind(track)
    track.getSettings = () => ({ ...settings(), displaySurface: surface }) as MediaTrackSettings
    return stream
  }
}

async function standIn(native: ElectronApplication, source: { id: string; display_id: string }) {
  // As in redaction.spec.ts: a synthetic presentation answers
  // getDisplayMedia, so stand in for the main process's choice of source.
  await native.evaluate(({ screen }, { display, source }) => {
    const real = screen.getPrimaryDisplay()
    const fake = { ...real, id: 4242, bounds: display, workArea: { ...display, y: display.y + 25, height: display.height - 25 }, size: { width: display.width, height: display.height } }
    screen.getAllDisplays = () => [fake]
    screen.getDisplayNearestPoint = () => fake
    screen.getDisplayMatching = () => fake
    const test = (globalThis as unknown as { kithmootTest: { redaction: { begin(): void; captured(source: unknown): void; __begin?: () => void } } }).kithmootTest
    const redaction = test.redaction
    redaction.__begin ??= redaction.begin.bind(redaction)
    redaction.begin = () => { redaction.__begin!(); redaction.captured(source) }
  }, { display: DISPLAY, source })
}

const overlayWindows = (native: ElectronApplication) => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
  .filter((window: Electron.BrowserWindow) => !window.isDestroyed() && window.webContents.getURL().includes('kithmoot-share-marks'))
  .map((window: Electron.BrowserWindow) => ({ bounds: window.getBounds(), visible: window.isVisible(), top: window.isAlwaysOnTop(), focusable: window.isFocusable(), protectedContent: window.isContentProtected?.() })))

test('Marks drawn on a whole-screen share are shown over that screen, and go when the share does', async ({ browser }) => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-marks-'))
  const native = await electron.launch({
    executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [desktop, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_AREA_MODE: 'frame' },
  })
  const context = await browser.newContext({ permissions: ['camera', 'microphone', 'local-network-access'] })
  try {
    for (const isolated of [native.context(), context]) {
      await isolated.routeWebSocket(url => url.origin === relays[0], socket => { socket.connectToServer() })
    }
    await context.route('https://kithmoot.forgesworn.dev/**', async route => {
      const path = localAsset(route.request().url(), join(desktop, 'web'))
      if (!path) return route.fulfill({ status: 404, body: 'Not found' })
      const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
      await route.fulfill({ body: await readFile(path), contentType: types[extname(path)] ?? 'application/octet-stream' })
    })
    const mac = await native.firstWindow()
    const web = await context.newPage()
    for (const page of [mac, web]) {
      await page.addInitScript(INSTRUMENT)
      await page.addInitScript(SYNTHETIC_MIC)
      await page.addInitScript(SYNTHETIC_SCREEN)
      if (page === mac) await page.addInitScript(SURFACE, 'monitor')
      await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    }
    mac.on('console', message => { if (message.type() === 'error') console.log('MAC:', message.text()) })
    await standIn(native, { id: 'screen:4242:0', display_id: '4242' })
    const url = await createRoom(mac, HOME, relays, 'Desktop test')
    await joinWithMedia(mac, url, 'Desktop test')
    await joinWithMedia(web, url, 'Browser test')

    // Share the whole screen: a see-through window covers that display, all
    // of it rather than its work area, and never takes a click or the focus.
    const opened = native.waitForEvent('window')
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    const overlay = await opened
    await expect.poll(async () => (await overlayWindows(native))).toEqual([{ bounds: DISPLAY, visible: true, top: true, focusable: false, protectedContent: true }])
    const canvas = overlay.locator('canvas.shareMarksOverlay')
    await expect(canvas).toHaveCount(1)
    await expect(overlay.locator('body')).toHaveCSS('pointer-events', 'none')

    // The far end draws: the stroke lands on the overlay, over the real screen.
    const expand = web.getByRole('button', { name: 'Expand screen share from Desktop test' })
    await expect(expand).toBeVisible({ timeout: 60_000 }); await expand.click()
    const dialog = web.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => dialog.locator('.shareStage video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click()
    const painted = () => canvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext('2d')!
      const { data } = context.getImageData(0, 0, element.width, element.height)
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) opaque++
      return { width: element.width, height: element.height, opaque }
    })
    await expect.poll(async () => {
      const rect = (await dialog.locator('.shareStage').boundingBox())!
      await web.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .35)
      await web.mouse.down()
      await web.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .65, { steps: 12 })
      await web.mouse.up()
      return (await painted()).opaque
    }, { message: 'the far end\'s stroke is painted over the shared screen', timeout: 30_000 }).toBeGreaterThan(0)
    // The canvas is the display, so a stroke's place on it is its place on the screen.
    const size = await painted()
    expect({ width: size.width, height: size.height }).toEqual({ width: DISPLAY.width, height: DISPLAY.height })
    // Marks fade, and the overlay empties with them.
    await expect.poll(async () => (await painted()).opaque, { timeout: 15_000 }).toBe(0)

    // Stopping the share takes the overlay away.
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    await expect.poll(async () => (await overlayWindows(native)).length).toBe(0)

    // Sharing again brings it back, and leaving the call takes it away.
    await mac.locator('#toggleScreen').click()
    await expect.poll(async () => (await overlayWindows(native)).length).toBe(1)
    await mac.locator('#leaveCall').click()
    await expect.poll(async () => (await overlayWindows(native)).length).toBe(0)
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {})
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test('A window sharer sees drawings over the selected window and can draw back', async ({ browser }) => {
  test.setTimeout(150_000)
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-marks-window-'))
  const native = await electron.launch({
    executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [desktop, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_AREA_MODE: 'frame' },
  })
  const context = await browser.newContext({ permissions: ['camera', 'microphone', 'local-network-access'] })
  try {
    for (const isolated of [native.context(), context]) await isolated.routeWebSocket(url => url.origin === relays[0], socket => { socket.connectToServer() })
    await context.route('https://kithmoot.forgesworn.dev/**', async route => {
      const path = localAsset(route.request().url(), join(desktop, 'web'))
      if (!path) return route.fulfill({ status: 404 })
      const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
      await route.fulfill({ body: await readFile(path), contentType: types[extname(path)] ?? 'application/octet-stream' })
    })
    const mac = await native.firstWindow(), web = await context.newPage()
    mac.on('console', message => { if (message.type() === 'error') console.log('MAC:', message.text()) })
    mac.on('pageerror', error => console.log('MAC PAGE:', error.message))
    for (const page of [mac, web]) {
      await page.addInitScript(INSTRUMENT)
      await page.addInitScript(SYNTHETIC_MIC)
      await page.addInitScript(SYNTHETIC_SCREEN)
      await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    }
    // The track has no usable native id (the macOS picker case). The main
    // process's recorded choice, rather than a synthetic track id, identifies it.
    await mac.addInitScript(SURFACE, 'window')
    const chosen = await native.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({ x: 300, y: 220, width: 800, height: 450, frame: false, backgroundColor: '#375d75', webPreferences: { sandbox: true } })
      await target.loadURL('about:blank')
      return { id: target.getMediaSourceId(), display_id: '', bounds: target.getBounds() }
    })
    await standIn(native, chosen)
    const url = await createRoom(mac, HOME, relays, 'Desktop test')
    await joinWithMedia(mac, url, 'Desktop test')
    await joinWithMedia(web, url, 'Browser test')
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    const drawnOver = () => native.windows().find(page => page.url().includes('kithmoot-share-marks'))
    const drawTools = () => native.windows().find(page => page.url().includes('kithmoot-share-mark-tools'))
    await expect.poll(() => Boolean(drawnOver()), { message: 'a canvas covers the actual shared window' }).toBe(true)
    await expect.poll(async () => (await overlayWindows(native))[0]?.bounds).toEqual(chosen.bounds)
    const overlay = drawnOver()!, tools = drawTools()!
    const canvas = overlay.locator('canvas.shareMarksOverlay')
    await web.getByRole('button', { name: 'Expand screen share from Desktop test' }).click()
    const viewer = web.getByRole('dialog', { name: 'Screen-share viewer' })
    await expect.poll(() => viewer.locator('.shareStage video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    const stroke = async (page: typeof web, host: typeof viewer) => {
      const rect = (await host.locator('.shareStage').boundingBox())!
      await page.mouse.move(rect.x + rect.width * .25, rect.y + rect.height * .35)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .65, { steps: 12 })
      await page.mouse.up()
    }
    await viewer.getByRole('button', { name: 'Draw', exact: true }).click()
    await expect.poll(async () => {
      await stroke(web, viewer)
      return canvas.getAttribute('data-legend')
    }).toContain('Browser test')
    await tools.getByRole('button', { name: 'Draw', exact: true }).click()
    await expect.poll(async () => {
      const rect = (await canvas.boundingBox())!
      await overlay.mouse.move(rect.width * .25, rect.height * .35)
      await overlay.mouse.down()
      await overlay.mouse.move(rect.width * .7, rect.height * .65, { steps: 12 })
      await overlay.mouse.up()
      return viewer.locator('canvas.shareAnnotations').getAttribute('data-authors')
    }).toContain('Desktop test')
    await tools.getByRole('button', { name: 'Use window', exact: true }).click()
    // Real native geometry follows the actual window, including hiding while
    // minimised. It never points at a guessed display or at another window.
    const moved = await native.evaluate(({ BrowserWindow }, id) => {
      const target = BrowserWindow.getAllWindows().find(w => w.getMediaSourceId() === id)!
      target.setBounds({ x: 400, y: 280, width: 640, height: 360 })
      return target.getBounds()
    }, chosen.id)
    await expect.poll(async () => (await overlayWindows(native))[0]?.bounds).toEqual(moved)
    await native.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(w => w.getMediaSourceId() === id)!.minimize(), chosen.id)
    await expect.poll(async () => (await overlayWindows(native))[0]?.visible).toBe(false)
    await native.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(w => w.getMediaSourceId() === id)!.restore(), chosen.id)
    await expect.poll(async () => (await overlayWindows(native))[0]?.visible).toBe(true)
    await tools.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    await expect.poll(() => Boolean(drawnOver()) || Boolean(drawTools())).toBe(false)
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {})
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
