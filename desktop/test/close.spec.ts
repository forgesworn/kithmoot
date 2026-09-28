import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const desktop = fileURLToPath(new URL('../', import.meta.url))

// Closing the main window takes the share frame and the redaction boxes with
// it, and each of those used to report to a window that had just gone.
// Reaching into a destroyed window throws; in the packaged app that raised
// "A JavaScript error occurred in the main process" on every close, and on
// Linux and Windows the app stayed running behind it.
for (const how of ['close', 'destroy'] as const) {
  test(`the main window going by ${how} throws nothing in the main process`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-close-'))
    const native = await electron.launch({
      executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [desktop],
      env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_AREA_MODE: 'frame' },
    })
    try {
      const mac = await native.firstWindow()
      await expect(mac.locator('#newRoom:visible, #roomName:visible').first()).toBeVisible({ timeout: 30_000 })
      // Electron's own handler raises a box that waits for an answer; this
      // one stands in for it and keeps what was thrown.
      await native.evaluate(() => {
        const thrown: string[] = []
        ;(globalThis as unknown as { thrown: string[] }).thrown = thrown
        process.on('uncaughtException', error => thrown.push(String(error.stack).split('\n').slice(0, 3).join(' | ')))
      })
      await native.evaluate(({ BrowserWindow }, how) => { const window = BrowserWindow.getAllWindows()[0]!; setTimeout(() => window[how](), 50) }, how)
      await expect.poll(() => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
      expect(await native.evaluate(() => (globalThis as unknown as { thrown: string[] }).thrown)).toEqual([])
    } finally {
      try { native.process().kill('SIGKILL') } catch { /* already gone */ }
      await rm(profile, { recursive: true, force: true })
    }
  })
}
