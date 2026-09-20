import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoom, joinWithMedia, INSTRUMENT, SYNTHETIC_MIC, SYNTHETIC_SCREEN, expectToSeeAndHear, inbound } from '../../test/browser.js'
import { localAsset, HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relays = ['ws://127.0.0.1:17777']
process.env.E2E_RELAYS = relays.join(',')

test('Mac desktop and browser exchange moving video, audio and chat; leaving stops only this device', async ({ browser }) => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-call-'))
  const native = await electron.launch({
    executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [desktop, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile },
  })
  const context = await browser.newContext({ permissions: ['camera', 'microphone', 'local-network-access'] })
  try {
    // Proxy only the synthetic relay, avoiding host local-network permission state.
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
    web.on('console', message => { if (message.type() === 'error') console.log('WEB:', message.text()) })
    console.log('Creating room')
    const url = await createRoom(mac, HOME, relays)
    console.log('Joining desktop')
    await joinWithMedia(mac, url, 'Desktop test')
    console.log('Joining browser')
    await joinWithMedia(web, url, 'Browser test')
    console.log('Checking media')
    await expectToSeeAndHear(mac, 'Mac desktop')
    await expectToSeeAndHear(web, 'Browser')
    await mac.locator('#chatInput').fill('Synthetic desktop hello')
    await mac.locator('#chatInput').press('Enter')
    await expect(web.locator('#chatLog')).toContainText('Synthetic desktop hello')
    await web.locator('#chatInput').fill('Synthetic browser reply')
    await web.locator('#chatInput').press('Enter')
    await expect(mac.locator('#chatLog')).toContainText('Synthetic browser reply')
    for (const [width, height] of [[1320, 852], [1024, 700], [900, 612]]) {
      await native.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!), [width, height])
      await expect.poll(() => mac.evaluate(() => {
        const ids = ['chatInput', 'leaveCall']
        return ids.every(id => {
          const rect = document.getElementById(id)!.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth
        })
      }), { message: `Composer and Leave call must fit ${width}x${height}` }).toBe(true)
    }
    await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1320, 852))
    await mac.screenshot({ path: join(desktop, 'artifacts/call.png') })
    // Exercise the actual floating frame and its pointer controls without
    // granting access to or capturing any pixels from the user's desktop.
    const popupReady = native.waitForEvent('window')
    await mac.locator('#shareArea').click()
    const area = await popupReady
    const areaBounds = () => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))!.getBounds())
    await expect(area.getByRole('button', { name: 'Start sharing', exact: true })).toBeEnabled()
    await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))!.setBounds({ x: 100, y: 100, width: 900, height: 600 }))
    const original = await areaBounds()
    const corner = area.getByRole('button', { name: 'Resize sharing area from bottom right', exact: true })
    const handle = (await corner.boundingBox())!
    expect(handle.width).toBeGreaterThanOrEqual(28)
    await area.mouse.move(handle.x + 10, handle.y + 10)
    await area.mouse.down()
    await area.mouse.move(handle.x + 70, handle.y + 50, { steps: 5 })
    await area.mouse.up()
    await expect.poll(async () => (await areaBounds()).width).toBe(original.width + 60)
    await expect.poll(async () => (await areaBounds()).height).toBe(original.height + 40)
    const moved = area.getByLabel('Move sharing area with arrow keys')
    await moved.press('ArrowRight')
    await expect.poll(async () => (await areaBounds()).x).toBe(original.x + 10)
    const northwest = area.getByRole('button', { name: 'Resize sharing area from top left', exact: true })
    const beforeNorthwest = await areaBounds()
    await northwest.press('ArrowLeft')
    await expect.poll(async () => (await areaBounds()).width).toBe(beforeNorthwest.width + 10)
    expect((await areaBounds()).x + (await areaBounds()).width).toBe(beforeNorthwest.x + beforeNorthwest.width)
    expect(await native.evaluate(({ BrowserWindow }) => {
      const frame = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))!
      return frame.isAlwaysOnTop() && frame.isVisibleOnAllWorkspaces() && frame.getParentWindow() === null
    })).toBe(true)
    await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('kithmoot-share-area'))!.minimize())
    await area.getByRole('button', { name: 'Show KithMoot', exact: true }).click()
    await expect.poll(() => native.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('kithmoot-share-area'))!
      return owner.isVisible() && !owner.isMinimized() && owner.isAlwaysOnTop()
    })).toBe(true)
    const validBounds = await areaBounds()
    await mac.evaluate(() => (window as any).kithmootDesktop.shareAreaAction('bounds', { x: NaN, y: 100, width: 700, height: 400 }))
    expect(await areaBounds()).toEqual(validBounds)
    const geometry = await area.locator('canvas').evaluate(canvas => {
      const r = canvas.getBoundingClientRect()
      return { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom }
    })
    expect(geometry).toEqual({ left: 8, top: 52, right: 8, bottom: 40 })
    await area.screenshot({ path: join(desktop, 'artifacts/share-area-controls.png') })
    await area.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => native.windows().length).toBe(1)
    console.log('PASS: native sharing frame pointer resize, keyboard move, opposite-corner anchoring, always-on-top/workspaces, invalid IPC rejection and capture insets')
    // Native close must offer to stay, without dropping this live call.
    await native.evaluate(({ dialog, BrowserWindow }) => {
      const original = dialog.showMessageBoxSync
      dialog.showMessageBoxSync = () => 0
      BrowserWindow.getAllWindows()[0]!.close()
      dialog.showMessageBoxSync = original
    })
    await expect(mac.locator('#leaveCall')).toBeVisible()
    await mac.locator('#leaveCall').click()
    await expect(mac.locator('#roomArea')).toBeVisible()
    await expect(web.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect(web.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await mac.locator('#chatInput').fill('Still here after leaving the call')
    await mac.locator('#chatInput').press('Enter')
    await expect(web.locator('#chatLog')).toContainText('Still here after leaving the call')
    console.log('PASS: native/browser bidirectional moving video, synthetic audio, chat, cancel-close, leave-call and continuing chat')
    await web.locator('#leaveCall').click()
    await expect(mac.locator('html')).toHaveAttribute('data-call-pane', 'resting')
    await mac.locator('#chatInput').fill('A draft kept while resizing the desktop')
    const expectFullWidthChat = async () => {
      await expect.poll(() => mac.evaluate(() => {
        const room = document.getElementById('roomArea')!.getBoundingClientRect()
        const chat = document.getElementById('chatLog')!.getBoundingClientRect()
        const input = document.getElementById('chatInput')!.getBoundingClientRect()
        return Math.abs(chat.right - room.right) <= 4 && Math.abs(input.right - room.right) <= 4
          && chat.width / room.width > .95 && input.width / room.width > .95
          && input.bottom <= innerHeight && input.left >= 0
      }), { message: 'Chat and composer must fill the native room without leaving the window' }).toBe(true)
      await expect(mac.locator('#chatInput')).toHaveValue('A draft kept while resizing the desktop')
    }
    for (const [width, height] of [[1920, 1120], [1320, 880], [1100, 700], [1920, 1120]]) {
      await native.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!), [width, height])
      await expectFullWidthChat()
    }
    await mac.screenshot({ path: join(desktop, 'artifacts/chat-wide.png') })
    await mac.locator('#projectsRailToggle').click()
    await expect(mac.locator('html')).toHaveAttribute('data-rail', 'collapsed')
    await expectFullWidthChat()
    await mac.locator('#openAssignments').click()
    await expect(mac.locator('#assignmentPanel')).toBeVisible()
    await expectFullWidthChat()
    await mac.locator('#assignmentClose').click()
    await mac.locator('#projectsRailToggle').click()
    await expect(mac.locator('html')).toHaveAttribute('data-rail', 'open')
    await expectFullWidthChat()
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {})
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
