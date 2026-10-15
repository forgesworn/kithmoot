import { test, expect } from '@playwright/test'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { TEST_RELAY_WS } from './relays.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

test('the join screen offers to open the link in the app on Android and computers, not on iPhone', async ({ browser, baseURL }) => {
  const link = encodeJoinUrl(baseURL!, generateRoomSecret(), [TEST_RELAY_WS])
  const fragment = new URL(link).hash

  const android = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', userAgent: ANDROID })
  try {
    const page = await android.newPage()
    await page.goto(link)
    await expect(page.locator('#openInApp')).toBeVisible()
    await expect(page.locator('#openInAppLink')).toHaveAttribute('href', `kithmoot://join${fragment}`)
    await expect(page.locator('#getAndroidApp')).toHaveAttribute('href', 'https://kithmoot.app/#android')
  } finally {
    await android.close()
  }

  const desktop = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', userAgent: LINUX })
  try {
    const page = await desktop.newPage()
    await page.goto(link)
    await expect(page.locator('#openInApp')).toBeVisible()
    await expect(page.locator('#openInAppLink')).toHaveAttribute('href', `kithmoot://join${fragment}`)
    await expect(page.locator('#getAndroidApp')).toHaveAttribute('href', 'https://kithmoot.app/downloads/')
  } finally {
    await desktop.close()
  }

  const iphone = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', userAgent: IPHONE })
  try {
    const page = await iphone.newPage()
    await page.goto(link)
    await expect(page.locator('#displayName')).toBeVisible()
    await expect(page.locator('#openInApp')).toBeHidden()
  } finally {
    await iphone.close()
  }
})
