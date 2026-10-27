// Explicit integration check, separate from dependency-free *.test.mjs tests.
// Copies the actual native entry points and uses a synthetic offline page.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { stopIsolatedApp } from './isolated-app.mjs'

const { _electron: electron, expect } = await import(process.env.KITHMOOT_TEST_PLAYWRIGHT ?? '@playwright/test')
const binary = process.env.KITHMOOT_TEST_SPRY_BINARY
const executablePath = process.env.ELECTRON_EXECUTABLE
assert.ok(binary && isAbsolute(binary), 'Supply a reviewed native test executable')
assert.ok(executablePath && isAbsolute(executablePath), 'Supply an Electron test executable')
const desktop = fileURLToPath(new URL('../', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'kithmoot-spry-lifecycle-'))
const profile = join(fixture, 'kithmoot-profile')
let app
let appChild

async function udpBind(port) {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '127.0.0.1', resolve) })
    .catch(error => { socket.close(); throw error })
  return socket
}
async function freePort() {
  const tcp = createServer()
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  const port = tcp.address().port
  await new Promise(resolve => tcp.close(resolve))
  const udp = await udpBind(port)
  udp.close()
  return port
}
const menuState = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items
  .flatMap(item => item.submenu?.items ?? []).find(item => item.label.startsWith('Local call relay:'))?.label)
async function clickMenu(prefix) {
  await app.evaluate(({ Menu }, text) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
    .find(item => item.label.startsWith(text)).click(), prefix)
}
async function start() {
  await app.evaluate(() => { globalThis.__hostingDialogResponse = 1 })
  await clickMenu('Local call relay:')
  await expect.poll(menuState).toContain('Running (local bind)')
}

try {
  await mkdir(profile)
  const appDir = join(fixture, 'app')
  await mkdir(join(appDir, 'web'), { recursive: true })
  for (const name of await readdir(desktop)) {
    if (/\.(mjs|cjs)$/.test(name) || name === 'package.json') await copyFile(join(desktop, name), join(appDir, name))
  }
  await writeFile(join(appDir, 'web/index.html'), '<!doctype html><title>Hosting lifecycle fixture</title><h1>Hosting lifecycle fixture</h1>')
  const port = await freePort()
  const relayPort = await freePort()
  assert.notEqual(port, relayPort)
  const configPath = join(fixture, 'owner.json')
  await writeFile(configPath, JSON.stringify({ executable: binary, listenIp: '127.0.0.1', port, relayPorts: [relayPort, relayPort] }), { mode: 0o600 })
  app = await electron.launch({ executablePath, args: [appDir, `--user-data-dir=${profile}`],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_SPRY_CONFIG: configPath }, timeout: 30000 })
  appChild = app.process()
  let page = await app.firstWindow()
  // Electron's native will-prevent-unload handler owns the decision. Prevent
  // Playwright's automatic dialog handler racing the already-closed native one.
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
  await expect(page.locator('h1')).toHaveText('Hosting lifecycle fixture')
  await app.evaluate(({ dialog }) => {
    globalThis.__hostingDialogs = []
    globalThis.__hostingDialogResponse = 0
    globalThis.__hostingSyncResponse = 0
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      globalThis.__hostingDialogs.push(options)
      if (globalThis.__hostingDeferConsent && options.message.startsWith('Start a development')) {
        return new Promise(resolve => { globalThis.__hostingConsent = resolve })
      }
      return { response: globalThis.__hostingDialogResponse }
    }
    dialog.showMessageBoxSync = (...args) => {
      globalThis.__hostingDialogs.push(args.at(-1))
      return globalThis.__hostingSyncResponse
    }
  })
  assert.match(await menuState(), /Off/)
  const offSocket = await udpBind(port); offSocket.close()
  await clickMenu('Local call relay:')
  await expect.poll(() => app.evaluate(() => globalThis.__hostingDialogs.length)).toBe(1)
  assert.match(await menuState(), /Off/)
  const consent = await app.evaluate(() => globalThis.__hostingDialogs[0])
  assert.equal(consent.defaultId, 0); assert.equal(consent.cancelId, 0)
  assert.match(consent.detail, /applicable laws/)
  assert.equal(await page.evaluate(() => Object.keys(window.kithmootDesktop).some(key => /hosting|spry/i.test(key))), false)

  await start()
  await assert.rejects(udpBind(port), { code: 'EADDRINUSE' })
  await clickMenu('Stop local call relay')
  await expect.poll(menuState).toContain('Off')
  const stopped = await udpBind(port); stopped.close()

  // Invalidate a native consent still open when suspend arrives.
  await app.evaluate(() => { globalThis.__hostingDeferConsent = true })
  await clickMenu('Local call relay:')
  await expect.poll(() => app.evaluate(() => typeof globalThis.__hostingConsent)).toBe('function')
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('suspend')
    globalThis.__hostingDeferConsent = false
    globalThis.__hostingConsent({ response: 1 })
    powerMonitor.emit('resume')
  })
  await expect.poll(menuState).toContain('Off')
  await start()
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
  await expect.poll(menuState).toContain('Off')
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  assert.match(await menuState(), /Off/)

  // The real IPC update handler must stop hosting even when this dev updater refuses installation.
  await start()
  assert.equal(await page.evaluate(() => window.kithmootDesktop.installUpdate()), false)
  await expect.poll(menuState).toContain('Off')
  // Call cancellation and before-unload cancellation must keep the app usable.
  await start()
  await page.evaluate(() => window.kithmootDesktop.setCallActive(true))
  await expect.poll(() => app.evaluate(({ powerSaveBlocker }) => powerSaveBlocker.isStarted(0))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => app.evaluate(() => globalThis.__hostingDialogs.some(item => item.message.startsWith('Leave the call')))).toBe(true)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await page.evaluate(() => window.kithmootDesktop.setCallActive(false))
  await expect.poll(menuState).toContain('Off')
  await start()
  const callsBefore = await app.evaluate(() => globalThis.__hostingDialogs.filter(item => item.message.startsWith('Leave the call')).length)
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]
    // This listener runs after the app's first close handler begins awaiting
    // native Stop. Exercise a newly arriving trusted call-state notification.
    window.once('close', () => ipcMain.emit('desktop:call-state', {
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    }, true))
    window.close()
  })
  await expect.poll(() => app.evaluate(() => globalThis.__hostingDialogs.filter(item => item.message.startsWith('Leave the call')).length)).toBeGreaterThan(callsBefore)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await page.evaluate(() => window.kithmootDesktop.setCallActive(false))
  await expect.poll(menuState).toContain('Off')
  await page.locator('h1').click()
  await page.evaluate(() => { window.onbeforeunload = () => false })
  await start()
  const before = await app.evaluate(() => globalThis.__hostingDialogs.filter(item => item.message.startsWith('Close with unsent')).length)
  await app.evaluate(({ app }) => app.quit())
  await expect.poll(() => app.evaluate(() => globalThis.__hostingDialogs.filter(item => item.message.startsWith('Close with unsent')).length)).toBeGreaterThan(before)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await page.evaluate(() => { window.onbeforeunload = null })
  await expect.poll(menuState).toContain('Off')

  await start()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
  await expect.poll(menuState).toContain('Off')
  // A crashed Playwright Page cannot be reused; the next native close/reopen
  // creates a fresh BrowserWindow and automation target.
  await start()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  const closed = await udpBind(port); closed.close()
  if (process.platform === 'darwin') {
    await app.evaluate(({ app }) => app.emit('activate'))
    await expect.poll(() => app.windows().length).toBe(1)
    page = app.windows()[0]
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
    await expect(page.locator('h1')).toHaveText('Hosting lifecycle fixture')
    assert.match(await menuState(), /Off/)
    await start()
    await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
    await expect.poll(() => appChild.exitCode !== null || appChild.signalCode !== null).toBe(true)
    app = undefined
  }
  const quitSocket = await udpBind(port); quitSocket.close()
  const noConfigProfile = join(fixture, 'kithmoot-unconfigured')
  await mkdir(noConfigProfile)
  const noConfigEnv = { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: noConfigProfile }
  delete noConfigEnv.KITHMOOT_DESKTOP_SPRY_CONFIG
  const noConfigApp = await electron.launch({ executablePath, args: [appDir, `--user-data-dir=${noConfigProfile}`], env: noConfigEnv, timeout: 30000 })
  const noConfigChild = noConfigApp.process()
  try {
    await noConfigApp.firstWindow()
    const labels = await noConfigApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? []).map(item => item.label))
    assert.equal(labels.some(label => /local call relay/i.test(label)), false)
    const free = await udpBind(port); free.close()
    await noConfigApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    if (process.platform === 'darwin') await expect.poll(() => noConfigApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  } finally {
    if (noConfigChild.exitCode === null && noConfigChild.signalCode === null) await stopIsolatedApp(noConfigApp, noConfigProfile)
  }
  console.log('PASS: actual Electron/native Start, Cancel, Stop, stale consent, synthetic suspend/resume, refused update, renderer crash, new-call/unsaved quit cancellation, close/reopen, quit and unconfigured menu hiding. Offline synthetic page; no Proton, real sleep, media or packaged-update qualification.')
} finally {
  try {
    if (app && appChild?.exitCode === null && appChild?.signalCode === null) await stopIsolatedApp(app, profile)
  } finally { await rm(fixture, { recursive: true, force: true }) }
}
