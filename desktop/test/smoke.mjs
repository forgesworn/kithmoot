import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-smoke-'))
const packaged = Boolean(process.env.DESKTOP_EXECUTABLE)
let app
const launch = () => electron.launch({
  executablePath: process.env.DESKTOP_EXECUTABLE ?? process.env.ELECTRON_EXECUTABLE ?? join(desktop, process.platform === 'linux'
    ? 'node_modules/electron/dist/electron'
    : process.platform === 'win32'
      ? 'node_modules/electron/dist/electron.exe'
      : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [...(process.env.DESKTOP_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`],
  env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile }, timeout: 30_000,
})
try {
  app = await launch()
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('#create')).toBeVisible({ timeout: 30_000 })
  const state = await page.evaluate(async () => ({
    secure: isSecureContext, node: typeof window.require, process: typeof window.process,
    bridge: Object.keys(window.kithmootDesktop ?? {}),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    workerStatus: (await fetch('/j/sw.js')).status,
    traversalStatus: (await fetch('/j/assets/..%2f..%2fpackage.json')).status,
    csp: (await fetch('/j/')).headers.get('content-security-policy'),
    notifications: Notification.permission,
  }))
  expect(state.secure).toBe(true)
  expect(state.node).toBe('undefined'); expect(state.process).toBe('undefined')
  expect(state.bridge).toEqual(['supportsShareArea', 'armShareArea', 'shareAreaState', 'shareAreaAction', 'onShareAreaState', 'setUnread', 'notify', 'onOpenRoom', 'setCallActive', 'updateState', 'installUpdate', 'onUpdateState']); expect(state.workers).toBe(0)
  expect(state.workerStatus).toBe(404); expect(state.traversalStatus).toBe(404)
  expect(state.csp).toContain("object-src 'none'")
  expect(state.notifications).not.toBe('denied')
  expect(await page.evaluate(() => window.kithmootDesktop.updateState())).toEqual({ phase: packaged ? 'idle' : 'disabled' })
  expect(await page.evaluate(() => window.kithmootDesktop.installUpdate())).toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('desktop:update-state', { phase: 'ready', version: '0.1.12' }))
  await expect(page.locator('#updateNotice')).toContainText('KithMoot 0.1.12 is ready')
  await page.locator('#updateApp').click()
  await expect(page.locator('#updateApp')).toHaveText('Try updating again')
  // Exercise the real native frame without capturing the user's desktop.
  await page.evaluate(() => { window.__area = window.open('about:blank#kithmoot-share-area', '_blank', 'popup,width=900,height=600') })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)
  expect(await page.evaluate(() => window.kithmootDesktop.armShareArea())).toBe(true)
  // Verify capture reaches our chooser from the frame's own click. Replace
  // source enumeration with an empty list so no desktop pixels are accessed.
  await app.evaluate(({ desktopCapturer }) => {
    globalThis.__originalSources = desktopCapturer.getSources
    desktopCapturer.getSources = async () => { globalThis.__areaChooserReached = true; return [] }
  })
  const areaPage = app.windows().find(window => window !== page)
  await areaPage.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Test capture gesture'
    button.onclick = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(error => { window.__captureError = error.name + ': ' + error.message })
    document.body.append(button)
  })
  await areaPage.getByRole('button', { name: 'Test capture gesture' }).click()
  try { await expect.poll(() => app.evaluate(() => globalThis.__areaChooserReached === true)).toBe(true) }
  catch (error) { console.log('Capture diagnostic:', await areaPage.evaluate(() => ({ error: window.__captureError, focused: document.hasFocus(), secure: isSecureContext })), await app.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), display: screen.getDisplayMatching(window.getBounds()).bounds })))); throw error }
  await expect.poll(() => areaPage.evaluate(() => window.__captureError)).toBeTruthy()
  await app.evaluate(({ desktopCapturer }) => { desktopCapturer.getSources = globalThis.__originalSources })
  const frame = await app.evaluate(({ BrowserWindow }) => {
    const area = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area'))
    return { top: area.isAlwaysOnTop(), background: area.getBackgroundColor(), width: area.getBounds().width }
  })
  expect(frame.top).toBe(true)
  // Electron getBackgroundColor reports RGB without the alpha channel.
  expect(frame.background).toBe('#000000')
  await page.evaluate(() => window.kithmootDesktop.shareAreaAction('resize', { width: 720, height: 480 }))
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('kithmoot-share-area')).getBounds().width)).toBe(720)
  await page.evaluate(() => window.kithmootDesktop.shareAreaAction('close'))
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await page.evaluate(() => localStorage.setItem('desktop-smoke-persistence', 'synthetic'))
  await mkdir(join(desktop, 'artifacts'), { recursive: true })
  await page.screenshot({ path: join(desktop, 'artifacts/home.png') })
  expect(errors).toEqual([])
  await app.close()
  app = await launch()
  const reopened = await app.firstWindow()
  await expect(reopened.locator('#create')).toBeVisible({ timeout: 30_000 })
  expect(await reopened.evaluate(() => localStorage.getItem('desktop-smoke-persistence'))).toBe('synthetic')
  console.log('PASS: native area frame, resize, capture chooser gesture, closure, bundled UI, secure context, sandbox bridge, no Node exposure, CSP, traversal denial, no service worker, notifications available, profile persists across app restart and screenshot')
} finally {
  if (app) await app.close()
  await rm(profile, { recursive: true, force: true })
}
