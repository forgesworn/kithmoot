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

test('a microphone refusal on joining offers a retry beside the call controls', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!, { viewport: { width: 393, height: 851 }, hasTouch: true, storageState: { cookies: [], origins: [] } })
  await context.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let refused = false
    navigator.mediaDevices.getUserMedia = constraints => {
      if (constraints?.audio && !refused) {
        refused = true
        return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      }
      return capture(constraints)
    }
  })
  try {
    const page = await context.newPage()
    await createRoom(page, baseURL!)
    await join(page)
    await openCall(page)
    await expect(page.locator('#mediaBlockedNote')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#mediaBlockedMessage')).toContainText('Microphone blocked')
    const screenshot = test.info().outputPath('microphone-retry-mobile.png')
    await page.screenshot({ path: screenshot })
    await test.info().attach('microphone-retry-mobile.png', { path: screenshot, contentType: 'image/png' })
    await page.getByRole('button', { name: 'Try microphone again', exact: true }).click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#mediaBlockedNote')).toBeHidden()
  } finally {
    await context.close()
  }
})

test('a relay-only call retries a temporary credential failure without reopening the room', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!, { storageState: { cookies: [], origins: [] } })
  await context.addInitScript(() => localStorage.setItem('kithmoot.hide-ip.v1', '1'))
  let available = false
  let attempts = 0
  await context.route('**/turn', route => {
    attempts++
    return available ? route.fulfill({ json: {
      urls: ['turn:relay.example:3478', 'turns:relay.example:5349'],
      username: 'synthetic-device', credential: 'synthetic-credential', ttl: 3600,
    } }) : route.fulfill({ status: 503 })
  })
  try {
    const page = await context.newPage()
    await createRoom(page, baseURL!)
    await join(page)
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect.poll(() => attempts).toBeGreaterThan(0)
    const failedAttempts = attempts
    available = true
    await openCall(page)
    await expect.poll(() => attempts, { timeout: 10_000 }).toBeGreaterThan(failedAttempts)
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#relayMissingNote')).toBeHidden()
  } finally { await context.close() }
})
