import { openSettings, closeSettings } from './browser.js'
import { test, expect } from '@playwright/test'
test('notification settings work at phone size without requesting permission on entry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', { value: class {
      static permission = 'default'
      static requestPermission() { throw new Error('Permission must follow an explicit enable action') }
    } })
    window.WebSocket = class { addEventListener() {} removeEventListener() {} close() {} send() {} } as unknown as typeof WebSocket
  })
  await page.goto('./')
  // Notifications & sound lives inline in Settings now, reached from the
  // rooms list rather than behind its own button and dialog.
  await openSettings(page, 'Notifications')
  await expect(page.locator('#settingsPane')).toBeVisible()
  await expect(page.locator('#toggleNotify')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#toggleNotifyBell')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#toggleNotifyBell').click()
  await expect(page.locator('#toggleNotifyBell')).toHaveAttribute('aria-pressed', 'false')
  await page.locator('#previewNotifyBell').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/kithmoot-notifications-phone.png' })
  await closeSettings(page)
  await expect(page.locator('#settingsPane')).not.toBeVisible()
  await openSettings(page, 'Notifications')
  await expect(page.locator('#toggleNotifyBell')).toHaveAttribute('aria-pressed', 'false')
})
