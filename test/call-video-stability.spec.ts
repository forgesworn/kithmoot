import { test, expect } from '@playwright/test'
import { createRoom, inbound, joinWithMedia, newDeviceContext } from './browser.js'

test('an undecoded receiver does not halve an existing camera', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(page, baseURL!)
    await joinWithMedia(page, url, 'Ada')
    const tile = page.locator('#room .participant[data-self="true"]')
    const camera = tile.locator('video').first()
    await expect.poll(() => camera.evaluate(el => (el as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    await expect.poll(() => camera.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(100)
    const cameraFraction = async () => (await camera.boundingBox())!.width / (await tile.boundingBox())!.width
    await expect.poll(cameraFraction).toBeGreaterThan(0.95)
    await tile.locator('.media').first().evaluate(holder => {
      const pending = document.createElement('video')
      pending.className = 'awaitingFrame'
      holder.append(pending)
    })
    // Give the stage's mutation observer time to process the extra sink.
    await page.waitForTimeout(500)
    expect(await cameraFraction()).toBeGreaterThan(0.95)
    // A second live camera still gets a real slot; only the pending sink
    // was excluded. Reuse the synthetic stream rather than another device.
    await camera.evaluate(el => {
      el.parentElement!.querySelector('.awaitingFrame')!.remove()
      const second = el.cloneNode() as HTMLVideoElement
      second.srcObject = (el as HTMLVideoElement).srcObject
      el.parentElement!.append(second)
      void second.play()
    })
    await expect.poll(cameraFraction).toBeCloseTo(0.5, 1)
  } finally { await context.close() }
})

test('recovery leaves a paused parked picture alone until media resumes', async ({ browser, baseURL }) => {
  test.setTimeout(150_000)
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(bob, url, 'Bob')
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.framesDecoded), { timeout: 90_000 }).toBeGreaterThan(10)
    const video = bob.locator('#room .participant[data-self="false"] video:not(.screenPreview)').first()
    await expect(video).toBeVisible()
    await video.evaluate(el => {
      const video = el as HTMLVideoElement
      const clock = video.currentTime
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock })
      const original = RTCRtpReceiver.prototype.getSynchronizationSources
      RTCRtpReceiver.prototype.getSynchronizationSources = () => []
      ;(window as unknown as { resumePicture: () => void }).resumePicture = () => {
        delete (video as unknown as Record<string, unknown>).currentTime
        RTCRtpReceiver.prototype.getSynchronizationSources = original
      }
      ;(window as unknown as { stalledPicture: HTMLVideoElement }).stalledPicture = video
    })
    await expect.poll(() => bob.evaluate(() => (window as unknown as { stalledPicture: HTMLVideoElement }).stalledPicture.parentElement?.id), { timeout: 15_000 }).toBe('parked')
    // Observe several two-second recovery ticks, including brief restores.
    const restored = await bob.evaluate(async () => {
      const video = (window as unknown as { stalledPicture: HTMLVideoElement }).stalledPicture
      // Model a browser suspending a hidden sink. Its paused state alone
      // must not let recovery counteract the watchdog's park decision.
      video.pause()
      let restored = false
      const observer = new MutationObserver(() => { if (video.parentElement?.id !== 'parked') restored = true })
      observer.observe(document.body, { childList: true, subtree: true })
      await new Promise(resolve => setTimeout(resolve, 6500))
      observer.disconnect()
      return restored
    })
    expect(restored).toBe(false)
    await bob.evaluate(() => (window as unknown as { resumePicture: () => void }).resumePicture())
    await expect.poll(() => bob.evaluate(() => (window as unknown as { stalledPicture: HTMLVideoElement }).stalledPicture.closest('.participant') !== null), { timeout: 10_000 }).toBe(true)
  } finally { await a.close(); await b.close() }
})
