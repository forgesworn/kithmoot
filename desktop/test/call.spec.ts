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
      await isolated.routeWebSocket(relays[0]!, socket => { socket.connectToServer() })
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
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {})
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
