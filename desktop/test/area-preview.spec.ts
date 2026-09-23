import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoom, joinWithMedia, INSTRUMENT, SYNTHETIC_MIC, SYNTHETIC_SCREEN } from '../../test/browser.js'
import { localAsset, HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relays = ['ws://127.0.0.1:17777']
process.env.E2E_RELAYS = relays.join(',')

// The Wayland preview is forced on this Mac so its chrome, selection and crop
// can be driven. The portal itself is Linux-only; a person on Wayland accepts it.
test('Wayland preview: the far end receives only the area drawn on the preview', async ({ browser }) => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-preview-'))
  const native = await electron.launch({
    executablePath: process.env.ELECTRON_EXECUTABLE ?? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [desktop, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_AREA_MODE: 'preview' },
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
      await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    }
    expect(await mac.evaluate(() => (window as any).kithmootDesktop.shareAreaMode)).toBe('preview')
    const url = await createRoom(mac, HOME, relays)
    await joinWithMedia(mac, url, 'Desktop test')
    await joinWithMedia(web, url, 'Browser test')

    const popupReady = native.waitForEvent('window')
    await mac.locator('#shareArea').click()
    const area = await popupReady
    // The synthetic 1600x900 presentation stands in for the portal's monitor.
    await area.evaluate(SYNTHETIC_SCREEN)
    expect(await native.evaluate(({ BrowserWindow }) => {
      const preview = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))!
      return { top: preview.isAlwaysOnTop(), resizable: preview.isResizable(), parent: preview.getParentWindow() }
    })).toEqual({ top: false, resizable: true, parent: null })
    await expect(area.getByRole('button', { name: 'Share this area', exact: true })).toBeDisabled()
    await area.getByRole('button', { name: 'Choose a screen', exact: true }).click()
    const selection = area.getByLabel('Shared area; arrow keys move it')
    await expect(selection).toBeVisible()
    const picture = () => area.evaluate(() => {
      const video = document.querySelector('video')!
      const stage = document.querySelector('main')!.getBoundingClientRect()
      const scale = Math.min(stage.width / video.videoWidth, stage.height / video.videoHeight)
      const width = video.videoWidth * scale, height = video.videoHeight * scale
      return { left: stage.left + (stage.width - width) / 2, top: stage.top + (stage.height - height) / 2, width, height }
    })
    const box = await picture()
    // The default is the whole picture.
    const whole = (await selection.boundingBox())!
    expect(Math.abs(whole.x - box.left)).toBeLessThan(1)
    expect(Math.abs(whole.width - box.width)).toBeLessThan(1)
    expect(Math.abs(whole.height - box.height)).toBeLessThan(1)

    // Half the width, the full height: 8:9 rather than the monitor's 16:9.
    const corner = area.getByRole('button', { name: 'Resize shared area from bottom right', exact: true })
    const handle = (await corner.boundingBox())!
    await area.mouse.move(handle.x + 14, handle.y + 14)
    await area.mouse.down()
    await area.mouse.move(handle.x + 14 - box.width / 2, handle.y + 14, { steps: 6 })
    await area.mouse.up()
    const half = (await selection.boundingBox())!
    expect(Math.abs(half.width - box.width / 2)).toBeLessThan(2)
    expect(Math.abs(half.height - box.height)).toBeLessThan(1)
    // Keyboard moves stay inside the picture.
    await selection.press('ArrowRight')
    expect((await selection.boundingBox())!.x).toBeGreaterThan(half.x)

    await area.getByRole('button', { name: 'Share this area', exact: true }).click()
    await expect(area.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
    const received = () => web.evaluate(() => [...document.querySelectorAll('video')]
      .filter(video => video.videoWidth && video.videoHeight)
      .map(video => video.videoWidth / video.videoHeight))
    await expect.poll(async () => (await received()).some(ratio => Math.abs(ratio - 8 / 9) < 0.03), { timeout: 30_000 }).toBe(true)
    await area.screenshot({ path: join(desktop, 'artifacts/share-area-preview.png') })

    // Changing the selection mid-share changes what goes out.
    const wide = area.getByRole('button', { name: 'Resize shared area from bottom left', exact: true })
    const wideHandle = (await wide.boundingBox())!
    await area.mouse.move(wideHandle.x + 14, wideHandle.y + 14)
    await area.mouse.down()
    await area.mouse.move(wideHandle.x + 14, wideHandle.y + 14 - box.height * 0.75, { steps: 6 })
    await area.mouse.up()
    await expect.poll(async () => (await received()).some(ratio => Math.abs(ratio - 32 / 9) < 0.1), { timeout: 30_000 }).toBe(true)

    // Drawing does not drag the selection.
    const before = (await selection.boundingBox())!
    await area.getByRole('button', { name: 'Draw', exact: true }).click()
    await area.mouse.move(before.x + before.width / 3, before.y + before.height / 2)
    await area.mouse.down()
    await area.mouse.move(before.x + before.width / 2, before.y + before.height / 2, { steps: 4 })
    await area.mouse.up()
    expect((await selection.boundingBox())!).toEqual(before)

    await area.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect.poll(() => native.windows().length).toBe(1)
    await expect.poll(async () => (await received()).some(ratio => Math.abs(ratio - 32 / 9) < 0.1)).toBe(false)
    console.log('PASS: Wayland preview window, whole-picture default, corner resize, keyboard move, crop received by the far end, live reselection, drawing without dragging, stop closes the preview')
  } finally {
    await context.close()
    await native.close()
    await rm(profile, { recursive: true, force: true })
  }
})
