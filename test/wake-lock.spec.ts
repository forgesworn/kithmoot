import { test, expect } from '@playwright/test'
import { createRoom, newDeviceContext, open, openCall } from './browser.js'

/**
 * Does the app actually ask the browser for the screen wake lock, at the
 * real API boundary?
 *
 * wake-lock.test.ts covers the whole decision - when to request, how to
 * react to visibility, when to give up - with no browser at all. What it
 * cannot cover is whether `main.ts` ever calls `navigator.wakeLock.request`
 * for real, on the actual moments a person joining a call cares about:
 * pressing the call button, and pressing Leave. So this stubs
 * `navigator.wakeLock` before the app's own script runs, and watches it get
 * called - and released - from the far end, the same way media.spec.ts
 * watches decoded frames rather than trusting the plumbing in between.
 */
test('the call requests a screen wake lock and releases it on Leave', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    // Installed before newDeviceContext's own init scripts run any app
    // code, so it is in place the moment main.ts starts.
    await page.addInitScript(() => {
      const calls: string[] = []
      ;(window as unknown as { __wakeLockCalls: string[] }).__wakeLockCalls = calls
      const sentinel = {
        released: false,
        release: async () => {
          sentinel.released = true
          calls.push('release')
        },
        addEventListener: () => {},
      }
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: { request: async (type: string) => { calls.push(`request:${type}`); return sentinel } },
      })
    })

    const url = await createRoom(page, baseURL!)
    await open(page, url, 'Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()

    const calls = () => page.evaluate(() => (window as unknown as { __wakeLockCalls: string[] }).__wakeLockCalls)
    expect(await calls()).not.toContain('request:screen')

    await openCall(page)
    await expect.poll(calls).toContain('request:screen')

    await page.locator('#leaveCall').click()
    await expect.poll(calls).toContain('release')
  } finally {
    await context.close()
  }
})
