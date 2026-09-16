import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-smoke-'))
let app
const launch = () => electron.launch({
  executablePath: process.env.DESKTOP_EXECUTABLE ?? join(desktop, process.platform === 'linux' ? 'node_modules/electron/dist/electron' : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
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
  expect(state.bridge).toEqual(['setUnread', 'notify', 'onOpenRoom', 'setCallActive']); expect(state.workers).toBe(0)
  expect(state.workerStatus).toBe(404); expect(state.traversalStatus).toBe(404)
  expect(state.csp).toContain("object-src 'none'")
  expect(state.notifications).not.toBe('denied')
  await page.evaluate(() => localStorage.setItem('desktop-smoke-persistence', 'synthetic'))
  await mkdir(join(desktop, 'artifacts'), { recursive: true })
  await page.screenshot({ path: join(desktop, 'artifacts/home.png') })
  expect(errors).toEqual([])
  await app.close()
  app = await launch()
  const reopened = await app.firstWindow()
  await expect(reopened.locator('#create')).toBeVisible({ timeout: 30_000 })
  expect(await reopened.evaluate(() => localStorage.getItem('desktop-smoke-persistence'))).toBe('synthetic')
  console.log('PASS: bundled UI, secure context, sandbox bridge, no Node exposure, CSP, traversal denial, no service worker, notifications available, profile persists across app restart and screenshot')
} finally {
  if (app) await app.close()
  await rm(profile, { recursive: true, force: true })
}
