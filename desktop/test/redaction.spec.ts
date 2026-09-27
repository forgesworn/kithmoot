import { _electron as electron, test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoom, joinWithMedia, INSTRUMENT, SYNTHETIC_MIC, SYNTHETIC_SCREEN } from '../../test/browser.js'
import { localAsset, HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relays = ['ws://127.0.0.1:17777']
process.env.E2E_RELAYS = relays.join(',')

// The synthetic presentation is 1600x900, so the test stands in a display of
// exactly that size in DIP: one frame pixel to every DIP.
const DISPLAY = { x: 0, y: 0, width: 1600, height: 900 }
const BOX = { x: 400, y: 300, width: 400, height: 200 }

/** Pixels of this device's own published screen track, read off the RTP sender. */
function published(page: Page, points: [number, number][]) {
  return page.evaluate(async points => {
    const senders = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap(pc => pc.getSenders())
    const tracks = new Set(senders.map(sender => sender.track).filter((track): track is MediaStreamTrack => track?.kind === 'video' && track.readyState === 'live'))
    for (const track of tracks) {
      const video = document.createElement('video')
      video.muted = true; video.srcObject = new MediaStream([track])
      await video.play()
      for (let i = 0; i < 100 && !video.videoWidth; i++) await new Promise(resolve => setTimeout(resolve, 20))
      // The camera is 4:3; the share is the wide one.
      if (!video.videoWidth || video.videoWidth / video.videoHeight < 1.5) { video.srcObject = null; continue }
      await new Promise(resolve => setTimeout(resolve, 120))
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(video, 0, 0)
      video.srcObject = null
      return { width: canvas.width, height: canvas.height, pixels: points.map(([x, y]) => [...context.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data.slice(0, 3)]) }
    }
    return null
  }, points)
}

/** Pixels of the share as the far end decoded it. */
function received(page: Page, points: [number, number][]) {
  return page.evaluate(points => {
    const video = [...document.querySelectorAll('video')].find(item => item.videoWidth && item.videoWidth / item.videoHeight > 1.5)
    if (!video) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(video, 0, 0)
    return points.map(([x, y]) => [...context.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data.slice(0, 3)])
  }, points)
}

const black = (pixel: number[]) => Math.max(...pixel) < 30
// Points inside the box, and outside it (the background and the green edge),
// as fractions of the whole screen.
const grid = (rect: typeof BOX, into: typeof DISPLAY) => {
  const points: [number, number][] = []
  for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) for (const fy of [0.03, 0.5, 0.97]) {
    points.push([(rect.x - into.x + fx * rect.width) / into.width, (rect.y - into.y + fy * rect.height) / into.height])
  }
  return points
}
const inside = grid(BOX, DISPLAY)
const outside: [number, number][] = [[1550 / 1600, 0.5], [60 / 1600, 850 / 900], [1550 / 1600, 0.1]]

async function standIn(native: ElectronApplication, source: { id: string; display_id: string }) {
  // Tests never capture the machine's desktop: a synthetic presentation
  // answers getDisplayMedia in the page, so the main process never chooses
  // a source. Stand in for that choice, and for a display the presentation's size.
  await native.evaluate(({ screen }, { display, source }) => {
    const real = screen.getPrimaryDisplay()
    const fake = { ...real, id: 4242, bounds: display, workArea: display, size: { width: display.width, height: display.height } }
    screen.getAllDisplays = () => [fake]
    screen.getDisplayNearestPoint = () => fake
    screen.getDisplayMatching = () => fake
    const test = (globalThis as unknown as { kithmootTest: { redaction: { begin(): void; captured(source: unknown): void; __begin?: () => void } } }).kithmootTest
    const redaction = test.redaction
    redaction.__begin ??= redaction.begin.bind(redaction)
    redaction.begin = () => { redaction.__begin!(); redaction.captured(source) }
  }, { display: DISPLAY, source })
}

const boxWindow = (native: ElectronApplication) => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('kithmoot-redaction-box')).map(window => ({ bounds: window.getBounds(), top: window.isAlwaysOnTop(), protectedContent: window.isContentProtected?.() })))

test('Redaction boxes: the boxed part of a screen or area share is black in the published picture', async ({ browser }) => {
  test.setTimeout(240_000)
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-redaction-'))
  const native = await electron.launch({
    executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [desktop, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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
      await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    }
    mac.on('console', message => { if (message.type() === 'error') console.log('MAC:', message.text()) })
    await standIn(native, { id: 'screen:4242:0', display_id: '4242' })
    const url = await createRoom(mac, HOME, relays)
    await joinWithMedia(mac, url, 'Desktop test')
    await joinWithMedia(web, url, 'Browser test')

    // A box is added from the share controls, before any share.
    await expect(mac.locator('#toggleRedaction')).toBeHidden()
    const opened = native.waitForEvent('window')
    await mac.locator('#addRedaction').click()
    const box = await opened
    await expect(box.getByText('Hidden from share')).toBeVisible()
    await expect(mac.locator('#toggleRedaction')).toBeVisible()
    await expect(mac.locator('#toggleRedaction')).toHaveAttribute('aria-pressed', 'true')
    const [placed] = await boxWindow(native)
    expect(placed!.top).toBe(true)
    // Placed in the middle of the cursor's display.
    expect(placed!.bounds).toEqual({ x: 620, y: 340, width: 360, height: 220 })

    // Moving follows the real cursor in the main process, which synthetic
    // mouse events do not move, so stand in for it there.
    const cursorAt = (x: number, y: number) => native.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point }, { x, y })
    const grip = (await box.locator('header span').boundingBox())!
    await cursorAt(placed!.bounds.x + 40, placed!.bounds.y + 15)
    await box.mouse.move(grip.x + 20, grip.y + 10)
    await box.mouse.down()
    await cursorAt(BOX.x + 40, BOX.y + 15)
    await box.mouse.move(grip.x + 30, grip.y + 12)
    await box.mouse.up()
    await expect.poll(async () => (await boxWindow(native))[0]!.bounds).toEqual({ ...placed!.bounds, x: BOX.x, y: BOX.y })
    // Resizing from a corner follows the cursor too; arrow keys nudge.
    const corner = box.getByRole('button', { name: 'Resize box from bottom right', exact: true })
    const handle = (await corner.boundingBox())!
    await cursorAt(BOX.x + 355, BOX.y + 215)
    await box.mouse.move(handle.x + 5, handle.y + 5)
    await box.mouse.down()
    await cursorAt(BOX.x + 355 + 40 + 10, BOX.y + 215 - 20 - 10)
    await box.mouse.move(handle.x + 10, handle.y + 10)
    await box.mouse.up()
    await expect.poll(async () => (await boxWindow(native))[0]!.bounds).toEqual({ ...BOX, width: 410, height: 190 })
    await corner.press('ArrowLeft')
    await corner.press('ArrowDown')
    await expect.poll(async () => (await boxWindow(native))[0]!.bounds).toEqual({ ...BOX, width: 400, height: 200 })
    await box.getByLabel(/Arrow keys move this box/).press('ArrowRight')
    await expect.poll(async () => (await boxWindow(native))[0]!.bounds.x).toBe(BOX.x + 10)
    await box.getByLabel(/Arrow keys move this box/).press('ArrowLeft')
    await expect.poll(async () => (await boxWindow(native))[0]!.bounds).toEqual(BOX)
    await box.screenshot({ path: join(desktop, 'artifacts/redaction-box.png') })

    // Share the whole screen: the boxed part is black in the published picture.
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect.poll(async () => {
      const shot = await published(mac, [...inside, ...outside])
      if (!shot) return 'no published share'
      return shot.pixels.map((pixel, i) => (i < inside.length ? black(pixel) : !black(pixel)) ? '.' : 'x').join('')
    }, { message: 'box black, everything else not' }).toBe('.'.repeat(inside.length + outside.length))
    // And as the far end decodes it.
    await expect.poll(async () => {
      const pixels = await received(web, [[0.5, 0.5].map((f, i) => i ? (BOX.y + f * BOX.height) / 900 : (BOX.x + f * BOX.width) / 1600) as [number, number], outside[0]!])
      return pixels ? [black(pixels[0]!), black(pixels[1]!)] : null
    }, { message: 'far end sees the box black' }).toEqual([true, false])
    await mac.screenshot({ path: join(desktop, 'artifacts/redaction-preview.png') })
    // The sharer's own preview shows the same black.
    console.log('PASS: whole-screen share published and received with the boxed area black')

    // A display change: the whole picture is black until windows settle,
    // then the boxed area alone is black again.
    await native.evaluate(({ screen }) => { screen.emit('display-metrics-changed', {}, screen.getAllDisplays()[0], ['scaleFactor']) })
    const settled = await published(mac, outside)
    expect(settled?.pixels.every(black), 'black everywhere while displays settle').toBe(true)
    await expect(mac.locator('#redactionNote')).toContainText('while your displays change')
    await expect.poll(async () => {
      const shot = await published(mac, [...inside, ...outside])
      return shot ? shot.pixels.map((pixel, i) => (i < inside.length ? black(pixel) : !black(pixel)) ? '.' : 'x').join('') : 'none'
    }, { message: 'box black and the rest back after the settle period' }).toBe('.'.repeat(inside.length + outside.length))
    await expect(mac.locator('#redactionNote')).toBeHidden()
    console.log('PASS: a display change sends black until it settles, then recovers')

    // Turned off on the box itself: the part is shown again.
    await box.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(box.getByText('Shown')).toBeVisible()
    await expect(mac.locator('#toggleRedaction')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => {
      const shot = await published(mac, inside)
      return shot ? shot.pixels.filter(black).length : -1
    }, { message: 'nothing inside the box is black once it is off' }).toBe(0)
    // All boxes back on from the call controls.
    await mac.locator('#toggleRedaction').click()
    await expect(box.getByText('Hidden from share')).toBeVisible()
    await expect.poll(async () => {
      const shot = await published(mac, inside)
      return shot ? shot.pixels.every(black) : false
    }).toBe(true)
    // A box added mid-share is black at once, with no track swapped.
    const trackBefore = await mac.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap(pc => pc.getSenders()).map(sender => sender.track?.id).join())
    const second = native.waitForEvent('window')
    await mac.locator('#addRedaction').click()
    await second
    const SECOND = { x: 1000, y: 600, width: 300, height: 150 }
    await expect.poll(async () => (await boxWindow(native)).length).toBe(2)
    await native.evaluate(({ BrowserWindow }, bounds) => {
      const boxes = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('kithmoot-redaction-box'))
      boxes.find(window => window.getBounds().x !== 400)!.setBounds(bounds)
    }, SECOND)
    const secondInside = grid(SECOND, DISPLAY)
    await expect.poll(async () => {
      const shot = await published(mac, [...inside, ...secondInside])
      return shot ? shot.pixels.every(black) : false
    }).toBe(true)
    expect(await mac.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap(pc => pc.getSenders()).map(sender => sender.track?.id).join())).toBe(trackBefore)
    console.log('PASS: per-box toggle, all-boxes toggle and a box added mid-share')
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')

    // A single app cannot carry boxes: refused while one is on.
    await standIn(native, { id: 'window:77:0', display_id: '' })
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#status')).toContainText('cannot follow a single app')
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    // Started with every box off, then a box turned on: the whole picture goes black.
    await mac.locator('#toggleRedaction').click()
    await expect(mac.locator('#toggleRedaction')).toHaveAttribute('aria-pressed', 'false')
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect.poll(async () => {
      const shot = await published(mac, outside)
      return shot ? shot.pixels.some(black) : true
    }).toBe(false)
    await mac.locator('#toggleRedaction').click()
    await expect.poll(async () => {
      const shot = await published(mac, [...inside, ...outside])
      return shot ? shot.pixels.every(black) : false
    }).toBe(true)
    await expect(mac.locator('#redactionNote')).toContainText('cannot follow a single app')
    await mac.locator('#toggleScreen').click()
    await expect(mac.locator('#redactionNote')).toBeHidden()
    console.log('PASS: window share refused with a box on, and black when a box turns on mid-share')

    // An area share: boxes are carried into the crop.
    await standIn(native, { id: 'screen:4242:0', display_id: '4242' })
    const AREA = { x: 100, y: 100, width: 900, height: 600 }
    const popupReady = native.waitForEvent('window', { predicate: page => page.url().includes('kithmoot-share-area') })
    await mac.locator('#shareArea').click()
    const area = await popupReady
    await area.evaluate(SYNTHETIC_SCREEN)
    await expect(area.getByRole('button', { name: 'Start sharing', exact: true })).toBeEnabled()
    await native.evaluate(({ BrowserWindow, screen }, bounds) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))!.setBounds(bounds)
      ;(globalThis as unknown as { kithmootTest: { shareArea: { display: unknown } } }).kithmootTest.shareArea.display = screen.getAllDisplays()[0]
    }, AREA)
    await area.getByRole('button', { name: 'Start sharing', exact: true }).click()
    await expect(mac.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    // The crop is the frame's hole: 8px in, 52px down, 16 and 92 smaller.
    const crop = { x: AREA.x + 8, y: AREA.y + 52, width: AREA.width - 16, height: AREA.height - 92 }
    const inCrop = grid(BOX, crop).filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)
    const outCrop: [number, number][] = [[20 / crop.width, 0.95], [0.97, 0.05]]
    await expect.poll(async () => {
      const shot = await published(mac, [...inCrop, ...outCrop])
      if (!shot) return 'no published share'
      return shot.pixels.map((pixel, i) => (i < inCrop.length ? black(pixel) : !black(pixel)) ? '.' : 'x').join('')
    }, { message: 'area crop: box black, the rest not' }).toBe('.'.repeat(inCrop.length + outCrop.length))
    await mac.locator('#toggleRedaction').click()
    await expect.poll(async () => {
      const shot = await published(mac, inCrop)
      return shot ? shot.pixels.filter(black).length : -1
    }).toBe(0)
    await area.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    console.log('PASS: area share carries boxes into its crop')

    // Leaving the call takes the boxes away with it.
    await mac.locator('#leaveCall').click()
    await expect.poll(async () => (await boxWindow(native)).length).toBe(0)
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {})
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
