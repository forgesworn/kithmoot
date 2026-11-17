import { test, expect } from '@playwright/test'
import { createRoom, inbound, joinWithMedia, newDeviceContext } from './browser.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'

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
      const quality = video.getVideoPlaybackQuality.bind(video)
      const frozenQuality = quality()
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock })
      video.getVideoPlaybackQuality = () => frozenQuality
      const original = RTCRtpReceiver.prototype.getSynchronizationSources
      RTCRtpReceiver.prototype.getSynchronizationSources = () => []
      ;(window as unknown as { resumePicture: () => void }).resumePicture = () => {
        delete (video as unknown as Record<string, unknown>).currentTime
        video.getVideoPlaybackQuality = quality
        RTCRtpReceiver.prototype.getSynchronizationSources = original
      }
      ;(window as unknown as { stalledPicture: HTMLVideoElement }).stalledPicture = video
    })
    // Let the previous RTP sample expire. Then model a meeting/leave control
    // parking the sink independently of network health; a temporary gap no
    // longer parks a camera which the sender still advertises.
    await bob.waitForTimeout(7000)
    await video.evaluate(el => document.getElementById('parked')!.append(el))
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

test('decoded video is not rebound after a stalled playback clock crosses the recovery deadline', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(bob, url, 'Bob')
    const video = bob.locator('#room .participant[data-self="false"] video:not(.screenPreview):not(.awaitingFrame)').first()
    await expect(video).toBeVisible()
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.framesDecoded)).toBeGreaterThan(10)
    const result = await video.evaluate(async el => {
      const video = el as HTMLVideoElement, source = video.srcObject, clock = video.currentTime
      const before = video.getVideoPlaybackQuality().totalVideoFrames
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock })
      try {
        // The recovery watchdog resets a decoder after 15 seconds. Keep RTP
        // and decoded frames real while withholding only its playback clock.
        await new Promise(resolve => setTimeout(resolve, 20_000))
        return { sameStream: video.srcObject === source, frames: video.getVideoPlaybackQuality().totalVideoFrames - before }
      } finally { delete (video as unknown as Record<string, unknown>).currentTime }
    })
    expect(result.sameStream, 'a healthy decoder was reset by the watchdog').toBe(true)
    expect(result.frames).toBeGreaterThan(20)
  } finally { await a.close(); await b.close() }
})

test('call connection details identify each person and observed direct media without interrupting playback', async ({ browser, baseURL }, testInfo) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(bob, url, 'Bob')
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.framesDecoded)).toBeGreaterThan(10)
    const before = await bob.evaluate(inbound).then(stats => stats.framesDecoded)
    await bob.locator('#callExtras').click()
    await bob.getByRole('menuitem', { name: 'Connection details…' }).click()
    const panel = bob.getByRole('dialog', { name: 'Connection details' })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Ada')
    await expect(panel).toContainText('Direct to the other device')
    await expect(panel).toContainText('frames decoded')
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.framesDecoded)).toBeGreaterThan(before + 20)
    for (const width of [1440, 768, 390, 320]) {
      await bob.setViewportSize({ width, height: 850 })
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await bob.screenshot({ path: testInfo.outputPath('connection-details-phone.png') })
    await panel.getByRole('button', { name: 'Close Connection details' }).click()
    await expect(panel).not.toBeVisible()
    await expect(bob.locator('#callExtras')).toBeFocused()
    await bob.waitForTimeout(2500)
    await expect(bob.locator('#callConnectionsContent')).toBeEmpty()
    await bob.locator('#callExtras').click()
    await bob.getByRole('menuitem', { name: 'Connection details…' }).click()
    await expect(panel).toContainText('Ada')
    await bob.keyboard.press('Escape')
    await expect(panel).not.toBeVisible()
    await expect(bob.locator('#callExtras')).toBeFocused()
  } finally { await a.close(); await b.close() }
})

test('an advertised camera stays visible through a temporary gap in playback and RTP telemetry', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const ada = await a.newPage(), bob = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(bob, url, 'Bob')
    const video = bob.locator('#room .participant[data-self="false"] video:not(.screenPreview):not(.awaitingFrame)').first()
    await expect(video).toBeVisible()
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.framesDecoded)).toBeGreaterThan(10)
    const before = await video.evaluate(el => (el as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)
    const result = await video.evaluate(async el => {
      const video = el as HTMLVideoElement, container = video.parentElement!
      const clock = video.currentTime
      const sources = RTCRtpReceiver.prototype.getSynchronizationSources
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock })
      RTCRtpReceiver.prototype.getSynchronizationSources = () => []
      let hidden = false
      const observer = new MutationObserver(() => { if (video.parentElement !== container || !video.checkVisibility()) hidden = true })
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
      try {
        // Beyond the six-second RTP grace and across several recovery ticks.
        await new Promise(resolve => setTimeout(resolve, 9500))
        return { hidden, frames: video.getVideoPlaybackQuality().totalVideoFrames }
      } finally {
        observer.disconnect()
        delete (video as unknown as Record<string, unknown>).currentTime
        RTCRtpReceiver.prototype.getSynchronizationSources = sources
      }
    })
    expect(result.hidden, 'the watchdog hid the caller during missing progress telemetry').toBe(false)
    expect(result.frames, 'the picture must continue decoding').toBeGreaterThan(before)
    await expect(video).toBeVisible()
  } finally { await a.close(); await b.close() }
})

test('a caller without a roster name keeps their locally saved contact name with profile lookups off', async ({ browser, baseURL }) => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  await a.addInitScript(pubkey => {
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
    const now = Math.floor(Date.now() / 1000)
    localStorage.setItem('kithmoot.contact.v1.' + pubkey, JSON.stringify({
      p: pubkey, name: 'Rowan', rz: 'a'.repeat(64), eph: 'fixture', relays: [], boxes: [],
      issued: now, expires: now + 3600, readAt: now,
    }))
  }, pubkey)
  await b.addInitScript(secret => localStorage.setItem('kithmoot.participant', secret), bytesToHex(secret))
  try {
    const ada = await a.newPage(), peer = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(peer, url, '')
    const tile = ada.locator(`#room .participant[data-participant="${pubkey}"]`)
    await expect(tile).toBeVisible()
    await expect(tile).toHaveAttribute('data-name', 'Rowan')
    await expect(tile.locator('video:not(.awaitingFrame)')).toBeVisible()
    expect(await ada.evaluate(() => localStorage.getItem('kithmoot.profiles.enabled'))).toBe('false')
  } finally { await a.close(); await b.close() }
})
