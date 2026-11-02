import { test, expect } from '@playwright/test'
import { createRoom, join, newDeviceContext, openCall } from './browser.js'

// Joining a call switches the microphone on, so the browser asks for it
// there and then (1 November 2026). The rest of the suite saves
// kithmoot.call.micOnJoin = 'off' (playwright.config.ts); this device does not.
test('starting a call switches the microphone on', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(120_000)
  const context = await newDeviceContext(browser, baseURL!, { storageState: { cookies: [], origins: [] } })
  try {
    const page = await context.newPage()
    await createRoom(page, baseURL!)
    await join(page)
    await openCall(page)
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true', { timeout: 30_000 })
  } finally {
    await context.close()
  }
})
