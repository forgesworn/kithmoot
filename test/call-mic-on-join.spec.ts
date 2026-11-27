import { test, expect } from '@playwright/test'
import { collectAppDiagnostics } from './app-diagnostics.js'
import { createRoom, inbound, join, newDeviceContext, open, openCall } from './browser.js'

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

test('share screen from chat and add voice and video to the same call', async ({ browser, baseURL }) => {
  const presenterContext = await newDeviceContext(browser, baseURL!, { storageState: { cookies: [], origins: [] } })
  const viewerContext = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await presenterContext.newPage()
    const viewer = await viewerContext.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(viewer, link, 'Rowan'); await join(viewer)
    await expect(viewer.locator('#roomArea')).toBeVisible()

    await presenter.evaluate(() => {
      const media = navigator.mediaDevices
      const captureScreen = media.getDisplayMedia.bind(media)
      const captureInputs = media.getUserMedia.bind(media)
      let cancelled = false
      let inputRequests = 0
      document.documentElement.dataset.testInputRequests = '0'
      media.getDisplayMedia = options => {
        if (cancelled) return captureScreen(options)
        cancelled = true
        return Promise.reject(new DOMException('Share cancelled', 'NotAllowedError'))
      }
      media.getUserMedia = options => {
        document.documentElement.dataset.testInputRequests = String(++inputRequests)
        return captureInputs(options)
      }
    })

    const share = presenter.getByRole('button', { name: 'Share screen', exact: true })
    await expect(presenter.locator('#deviceControls')).toBeHidden()
    await expect(share).toBeVisible({ timeout: 5_000 })
    await share.click()
    await expect(presenter.locator('#status')).toHaveText('Share cancelled')
    await expect(presenter.locator('#callToggle')).toHaveText('Start call')
    await expect(viewer.locator('#callToggle')).toHaveText('Start call')

    await share.click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect(share).toHaveCount(0)
    await expect(presenter.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(presenter.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
    await expect(presenter.locator('html')).toHaveAttribute('data-test-input-requests', '0')

    const presenterCall = async () => JSON.parse(await collectAppDiagnostics(viewer)).participants
      .find((person: { name: string }) => person.name === 'Ada')?.call?.id
    await openCall(viewer)
    await expect(viewer.getByRole('button', { name: 'Expand screen share from Ada' })).toBeVisible()
    await expect.poll(async () => (await viewer.evaluate(inbound)).framesDecoded).toBeGreaterThan(0)
    const callId = await presenterCall()
    expect(callId).toBeTruthy()

    await presenter.locator('#toggleMic').click()
    await expect(presenter.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await presenter.locator('#toggleCamera').click()
    await expect(presenter.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    expect(await presenterCall()).toBe(callId)

    await presenter.locator('#toggleScreen').click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    await expect(viewer.getByRole('button', { name: 'Expand screen share from Ada' })).toBeHidden()
    await expect(presenter.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(presenter.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  } finally {
    await presenterContext.close(); await viewerContext.close()
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

test('screen sharing from chat releases capture when the required relay is unavailable', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  await context.addInitScript(() => localStorage.setItem('kithmoot.hide-ip.v1', '1'))
  await context.route('**/turn', route => route.fulfill({ status: 503 }))
  try {
    const page = await context.newPage()
    await createRoom(page, baseURL!)
    await page.evaluate(() => {
      const media = navigator.mediaDevices
      const capture = media.getDisplayMedia.bind(media)
      media.getDisplayMedia = async options => {
        const stream = await capture(options)
        ;(window as Window & { selectedShare?: MediaStream }).selectedShare = stream
        return stream
      }
    })

    const share = page.getByRole('button', { name: 'Share screen', exact: true })
    await share.click()
    await expect(page.locator('#status')).toContainText('Hide my IP address')
    const tracks = await page.evaluate(() => (window as Window & { selectedShare?: MediaStream }).selectedShare?.getTracks()
      .map(track => track.readyState))
    expect(tracks).toEqual(['ended'])
    await expect(page.locator('#deviceControls')).toBeHidden()
    await expect(page.locator('#callToggle')).toHaveText('Start call')
    await expect(share).toBeEnabled()
  } finally { await context.close() }
})
