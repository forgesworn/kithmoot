import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { stopIsolatedApp } from './isolated-app.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-pairing-'))
let app
try {
  app = await electron.launch({
    executablePath: process.env.DESKTOP_EXECUTABLE ?? process.env.ELECTRON_EXECUTABLE ?? join(desktop, process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron'),
    args: [...(process.env.DESKTOP_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile }, timeout:30000,
  })
  const page = await app.firstWindow()
  const link = () => 'kithmoot://join#spry=' + Buffer.from(JSON.stringify({ v:1,endpoint:'https://relay.example:3744',code:'a'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+180 })).toString('base64url')
  // Arrival during startup must survive until the renderer subscribes.
  await app.evaluate(({app}, link) => app.emit('open-url', {preventDefault(){}}, link), link())
  const approval = page.locator('#actionDialog').filter({hasText:'Pair Spry with KithMoot?'})
  await expect(approval).toBeVisible({timeout:30000})
  await approval.getByRole('button',{name:'Cancel',exact:true}).click()
  await expect(approval).toBeHidden()
  // A running call and in-memory work must survive a warm pairing handoff.
  await page.evaluate(() => { window.__pairingKeepAlive = true; window.kithmootDesktop.setCallActive(true) })
  const before = page.url()
  await app.evaluate(({app}, link) => app.emit('open-url', {preventDefault(){}}, link), link())
  await expect(approval).toBeVisible({timeout:10000})
  expect(page.url()).toBe(before)
  expect(await page.evaluate(() => window.__pairingKeepAlive)).toBe(true)
  await approval.getByRole('button',{name:'Cancel',exact:true}).click()
  await page.evaluate(() => window.kithmootDesktop.setCallActive(false))
  console.log('Native startup and warm-call pairing approvals passed; no reload or claim.')
} finally { if (app) await stopIsolatedApp(app,profile); await rm(profile,{recursive:true,force:true}) }
